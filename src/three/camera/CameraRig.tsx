import { useEffect, useLayoutEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { scrollStore, smoothstep } from '../../store/scrollStore';
import { adaptiveQuality } from '../perf/adaptiveQuality';
import { CAMERA_CLIP } from '../world/worldLayout';
import { CAMERA_RIG_TIMING, cameraFovAt, cameraRollAt, sampleCameraRig } from './cameraSpline';

/* ==========================================================================
 * CameraRig — drives the default R3F camera along the authored camera spline
 * and runs the adaptive-quality frame-time monitor.
 *
 * Every frame (useFrame, before every other subscriber so all systems read
 * this frame's camera):
 *   1. sample the spline at scrollStore.dampedProgress (zero allocation);
 *   2. damp the position per axis (THREE.MathUtils.damp);
 *   3. aim from the actual (damped) position at the sampled look-at point,
 *      add the keyframed Dutch roll, subtle handheld breathing (before 0.92
 *      only — the paper's DOM overlay must stay aligned afterwards) and the
 *      tiny impact nudge when the paper hits the lens; slerp towards that
 *      target with 1 − e^(−λ·dt);
 *   4. damp the field of view.
 * The first frame snaps straight to the sampled pose. Nothing here touches
 * React state, so scrolling never re-renders.
 * ========================================================================== */

const { damp, degToRad } = THREE.MathUtils;

/** Runs before default (priority 0) subscribers; negative priorities never take over rendering. */
const CAMERA_RIG_PRIORITY = -10;

const POSITION_LAMBDA = 5;
const ROTATION_LAMBDA = 6;
const FOV_LAMBDA = 4;
const NUDGE_LAMBDA = 14;
/** How long the impact knock is driven before it has fully decayed. */
const IMPACT_SECONDS = 0.9;
/** Damping steps are clamped so a long hitch never overshoots. */
const MAX_STEP_SECONDS = 0.1;

/** Handheld breathing amplitudes (before 0.92 only). */
const HANDHELD = {
  position: 0.016,
  yaw: degToRad(0.11),
  pitch: degToRad(0.085),
  roll: degToRad(0.06),
} as const;

/* ---------------------------------------------------------------------------
 * Adaptive frame-time monitor (writes adaptiveQuality, never React state).
 *
 *   Per-frame EMA of frame time (α = 0.08 ≈ a 12-frame window) →
 *   adaptiveQuality.frameMsEma. Frames > 250 ms are ignored (tab switches,
 *   long hitches) and each sample is capped at 4 × budgetMs, so a single GC
 *   hitch cannot trigger a downgrade on its own.
 *   Downgrade: EMA above adaptiveQuality.budgetMs (18) for 0.5 s → density
 *   × 0.8, then a 1.5 s cooldown.
 *   Upgrade: EMA below 13 ms for 4 s → density × 1.1 (up to maxDensity).
 *   A display's refresh caps the frame rate (16.7 ms at 60 Hz), so a
 *   vsync-locked device can never show 13 ms: the upgrade threshold is
 *   relaxed to 1.06 × the measured refresh interval (20th percentile of the
 *   last 120 frame deltas, re-measured every 2 s; bunched callbacks < 4 ms
 *   are skipped), capped at budgetMs − 0.5 — i.e. "holding the display's full
 *   frame rate with no dropped frames". At 120 Hz+ it stays 13 ms. The
 *   below-threshold timer is leaky (it drains while the EMA is above), so
 *   timing jitter does not reset it outright. If a downgrade follows an
 *   upgrade within 8 s the upgrade hold doubles (up to 32 s) so density does
 *   not oscillate; it relaxes back to 4 s after 30 s without a downgrade.
 * ------------------------------------------------------------------------- */

const MONITOR = {
  ignoreAboveMs: 250,
  emaAlpha: 0.08,
  sampleCapBudgets: 4,
  warmupSeconds: 2,
  overBudgetSeconds: 0.5,
  downgradeFactor: 0.8,
  cooldownSeconds: 1.5,
  upgradeBelowMs: 13,
  upgradeHoldSeconds: 4,
  maxUpgradeHoldSeconds: 32,
  oscillationWindowSeconds: 8,
  holdRelaxSeconds: 30,
  upgradeFactor: 1.1,
  refreshWindowSeconds: 2,
  refreshTolerance: 1.06,
  refreshSamples: 120,
  refreshPercentile: 0.2,
  minRefreshSampleMs: 4,
} as const;

interface MonitorState {
  warmup: number;
  over: number;
  under: number;
  cooldown: number;
  upgradeHold: number;
  sinceUpgrade: number;
  sinceDowngrade: number;
  /** Ring buffer of recent frame deltas (ms) for the refresh estimate. */
  ring: Float32Array;
  ringIndex: number;
  ringCount: number;
  /** Preallocated sort buffer (no per-frame allocation). */
  sorted: Float32Array;
  windowTime: number;
  refreshMs: number;
}

function createMonitorState(): MonitorState {
  return {
    warmup: MONITOR.warmupSeconds,
    over: 0,
    under: 0,
    cooldown: 0,
    upgradeHold: MONITOR.upgradeHoldSeconds,
    sinceUpgrade: Number.POSITIVE_INFINITY,
    sinceDowngrade: Number.POSITIVE_INFINITY,
    ring: new Float32Array(MONITOR.refreshSamples).fill(Number.POSITIVE_INFINITY),
    ringIndex: 0,
    ringCount: 0,
    sorted: new Float32Array(MONITOR.refreshSamples),
    windowTime: 0,
    refreshMs: 0,
  };
}

function updateFrameMonitor(m: MonitorState, delta: number): void {
  const ms = delta * 1000;
  if (!(ms > 0) || ms > MONITOR.ignoreAboveMs) return;
  const aq = adaptiveQuality;

  const sample = Math.min(ms, aq.budgetMs * MONITOR.sampleCapBudgets);
  aq.frameMsEma += (sample - aq.frameMsEma) * MONITOR.emaAlpha;

  // A low percentile of recent frame deltas ≈ the display's refresh interval.
  if (ms >= MONITOR.minRefreshSampleMs) {
    m.ring[m.ringIndex] = ms;
    m.ringIndex = (m.ringIndex + 1) % MONITOR.refreshSamples;
    m.ringCount = Math.min(MONITOR.refreshSamples, m.ringCount + 1);
  }
  m.windowTime += delta;
  if (m.windowTime >= MONITOR.refreshWindowSeconds && m.ringCount >= 30) {
    m.windowTime = 0;
    m.sorted.set(m.ring);
    m.sorted.sort();
    m.refreshMs = m.sorted[Math.floor(MONITOR.refreshPercentile * (m.ringCount - 1))];
  }

  m.cooldown = Math.max(0, m.cooldown - delta);
  m.sinceUpgrade += delta;
  m.sinceDowngrade += delta;
  if (m.sinceDowngrade > MONITOR.holdRelaxSeconds) m.upgradeHold = MONITOR.upgradeHoldSeconds;

  if (m.warmup > 0) {
    m.warmup -= delta;
    return;
  }

  const upgradeBelow =
    m.refreshMs > 0
      ? Math.max(MONITOR.upgradeBelowMs, Math.min(aq.budgetMs - 0.5, m.refreshMs * MONITOR.refreshTolerance))
      : MONITOR.upgradeBelowMs;

  if (aq.frameMsEma > aq.budgetMs) m.over += delta;
  else m.over = Math.max(0, m.over - delta);
  if (aq.frameMsEma < upgradeBelow) m.under += delta;
  else m.under = Math.max(0, m.under - delta);

  if (m.cooldown > 0) return;

  if (m.over >= MONITOR.overBudgetSeconds) {
    m.over = 0;
    m.under = 0;
    if (aq.particleDensity > aq.minDensity + 1e-4) {
      aq.setDensity(aq.particleDensity * MONITOR.downgradeFactor);
      aq.downgrades += 1;
      m.cooldown = MONITOR.cooldownSeconds;
      if (m.sinceUpgrade < MONITOR.oscillationWindowSeconds) {
        m.upgradeHold = Math.min(MONITOR.maxUpgradeHoldSeconds, m.upgradeHold * 2);
      }
      m.sinceDowngrade = 0;
    }
    return;
  }

  if (m.under >= m.upgradeHold) {
    m.under = 0;
    if (aq.particleDensity < aq.maxDensity - 1e-4) {
      aq.setDensity(Math.min(aq.maxDensity, aq.particleDensity * MONITOR.upgradeFactor));
      aq.upgrades += 1;
      m.cooldown = MONITOR.cooldownSeconds;
      m.sinceUpgrade = 0;
    }
  }
}

/* ---------------------------------------------------------------------------
 * Handheld breathing: sums of incommensurate sines (smooth, never repeats).
 * ------------------------------------------------------------------------- */

function wobble(t: number, a: number, b: number, c: number, phase: number): number {
  return 0.58 * Math.sin(t * a + phase) + 0.3 * Math.sin(t * b + phase * 1.7) + 0.12 * Math.sin(t * c + phase * 2.9);
}

/* ---------------------------------------------------------------------------
 * Scratch objects (zero per-frame allocation).
 * ------------------------------------------------------------------------- */

const UP = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const _samplePosition = new THREE.Vector3();
const _sampleLookAt = new THREE.Vector3();
const _lookMatrix = new THREE.Matrix4();
const _targetQuaternion = new THREE.Quaternion();
const _offsetQuaternion = new THREE.Quaternion();
const _rollQuaternion = new THREE.Quaternion();
const _offsetEuler = new THREE.Euler(0, 0, 0, 'YXZ');

interface RigState {
  initialised: boolean;
  nudge: number;
  previousProgress: number;
  impactAge: number;
  reducedMotion: boolean;
  monitor: MonitorState;
}

export function CameraRig(): null {
  const camera = useThree((state) => state.camera);
  const rig = useRef<RigState>({
    initialised: false,
    nudge: 0,
    previousProgress: 0,
    impactAge: Number.POSITIVE_INFINITY,
    reducedMotion: false,
    monitor: createMonitorState(),
  });

  useLayoutEffect(() => {
    if (camera instanceof THREE.PerspectiveCamera) camera.fov = CAMERA_CLIP.fov;
    camera.near = CAMERA_CLIP.near;
    camera.far = CAMERA_CLIP.far;
    camera.updateProjectionMatrix();
    rig.current.initialised = false;
  }, [camera]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      rig.current.reducedMotion = query.matches;
    };
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  useFrame((state, delta) => {
    const s = rig.current;
    updateFrameMonitor(s.monitor, delta);

    const p = scrollStore.dampedProgress;
    const perspective = camera instanceof THREE.PerspectiveCamera ? camera : null;
    const aspect = perspective ? perspective.aspect : state.size.width / Math.max(1, state.size.height);
    sampleCameraRig(p, _samplePosition, _sampleLookAt, aspect);

    // Handheld breathing — exactly zero from CAMERA_RIG_TIMING.handheldOff (< 0.92).
    const calm = s.reducedMotion || scrollStore.auditMode;
    const amp = calm ? 0 : 1 - smoothstep(CAMERA_RIG_TIMING.handheldFadeStart, CAMERA_RIG_TIMING.handheldOff, p);
    const t = state.clock.elapsedTime;
    let yaw = 0;
    let pitch = 0;
    let handRoll = 0;
    if (amp > 0) {
      _samplePosition.x += amp * HANDHELD.position * wobble(t, 0.71, 1.63, 3.9, 0.4);
      _samplePosition.y += amp * HANDHELD.position * wobble(t, 0.53, 1.37, 3.1, 2.1);
      _samplePosition.z += amp * HANDHELD.position * 0.6 * wobble(t, 0.61, 1.19, 2.7, 4.3);
      yaw = amp * HANDHELD.yaw * wobble(t, 0.47, 1.21, 2.9, 1.1);
      pitch = amp * HANDHELD.pitch * wobble(t, 0.39, 1.07, 2.3, 3.7);
      handRoll = amp * HANDHELD.roll * wobble(t, 0.33, 0.89, 2.1, 5.2);
    }

    // The paper hits the lens: a tiny time-based pitch knock (< 0.5°), only when scrolling forward past it.
    if (s.initialised && s.previousProgress < CAMERA_RIG_TIMING.impactAt && p >= CAMERA_RIG_TIMING.impactAt) {
      s.impactAge = 0;
    }
    s.previousProgress = p;
    let nudgeTarget = 0;
    if (s.impactAge <= IMPACT_SECONDS) {
      const k = s.impactAge / CAMERA_RIG_TIMING.impactRiseSeconds;
      nudgeTarget = s.reducedMotion ? 0 : -degToRad(CAMERA_RIG_TIMING.impactPitchDeg) * k * Math.exp(1 - k);
      s.impactAge += Math.min(delta, MAX_STEP_SECONDS);
    }

    const fovTarget = cameraFovAt(p);
    const rollTarget = cameraRollAt(p) + handRoll;

    if (!s.initialised) {
      camera.position.copy(_samplePosition);
      s.nudge = nudgeTarget;
    } else {
      const dt = Math.min(delta, MAX_STEP_SECONDS);
      camera.position.x = damp(camera.position.x, _samplePosition.x, POSITION_LAMBDA, dt);
      camera.position.y = damp(camera.position.y, _samplePosition.y, POSITION_LAMBDA, dt);
      camera.position.z = damp(camera.position.z, _samplePosition.z, POSITION_LAMBDA, dt);
      s.nudge = damp(s.nudge, nudgeTarget, NUDGE_LAMBDA, dt);
    }

    // Target orientation: aim from where the camera actually is at the sampled look-at point.
    _lookMatrix.lookAt(camera.position, _sampleLookAt, UP);
    _targetQuaternion.setFromRotationMatrix(_lookMatrix);
    _offsetEuler.set(pitch + s.nudge, yaw, 0, 'YXZ');
    _offsetQuaternion.setFromEuler(_offsetEuler);
    _rollQuaternion.setFromAxisAngle(AXIS_Z, rollTarget);
    _targetQuaternion.multiply(_offsetQuaternion).multiply(_rollQuaternion);

    if (!s.initialised) {
      camera.quaternion.copy(_targetQuaternion);
      if (perspective) {
        perspective.fov = fovTarget;
        perspective.updateProjectionMatrix();
      }
      s.initialised = true;
    } else {
      const dt = Math.min(delta, MAX_STEP_SECONDS);
      camera.quaternion.slerp(_targetQuaternion, 1 - Math.exp(-ROTATION_LAMBDA * dt));
      if (perspective) {
        const nextFov = damp(perspective.fov, fovTarget, FOV_LAMBDA, dt);
        if (Math.abs(nextFov - perspective.fov) > 1e-5) {
          perspective.fov = nextFov;
          perspective.updateProjectionMatrix();
        }
      }
    }
    camera.updateMatrixWorld();
  }, CAMERA_RIG_PRIORITY);

  return null;
}

export default CameraRig;
