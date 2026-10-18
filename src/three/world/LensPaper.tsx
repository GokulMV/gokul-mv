import { useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { clamp01, remap, scrollStore, smootherstep, smoothstep } from '../../store/scrollStore';
import { usePortfolioStore } from '../../store/portfolioStore';
import { sceneFx } from '../fx/sceneFx';
import { CLOUD_CURTAIN, ENDING, SUN_DIRECTION } from './worldLayout';
import { buildLensNote, paintLensNote, PAPER_ASPECT, PAPER_UNITS } from './lensPaperNote';
import {
  createLensHaloMaterial,
  createLensHaloUniforms,
  createLensPaperMaterial,
  createLensPaperUniforms,
  LENS_HALO_RENDER_ORDER,
  LENS_PAPER_RENDER_ORDER,
} from '../shaders/LensPaperShader';

/* ==========================================================================
 * Lens paper — the ending's contact sheet.
 *
 *  pack    (< paperGustStart)            folded in quarters inside the pack
 *  flight  (paperGustStart → paperStick)  the gust tears it out: it unfolds,
 *                                          tumbles, flexes, drifts sideways,
 *                                          speeds up and slaps onto the lens
 *  stuck   (paperStick → paperHoldEnd)    pressed on the glass, locked to the
 *                                          camera, corners fluttering; the DOM
 *                                          overlay shows the crisp contact text
 *  peel    (paperHoldEnd → paperPeelEnd)  the top-right corner peels off and
 *                                          the wind carries it out of frame
 *  gone    (≥ paperPeelEnd)
 *
 * Every pose is a pure function of scrollStore.dampedProgress; flutter, the
 * slap ripple and the text fade are damped, time-based secondary motion.
 * Scrolling back up re-sticks the sheet and returns it to the pack.
 *
 * The final pose is composed in onBeforeRender from the camera's final
 * matrix, so the stuck sheet never lags a damped camera move.
 * ========================================================================== */

export type LensPaperPhase = 'pack' | 'flight' | 'stuck' | 'peel' | 'gone';

export interface LensPaperScreenRect {
  /** Centre, CSS px in viewport coordinates. */
  x: number;
  y: number;
  /** Projected edge lengths, CSS px. */
  width: number;
  height: number;
  /** Radians, clockwise on screen. */
  rotation: number;
}

export interface LensPaperState {
  phase: LensPaperPhase;
  /** 0 = loose in the air, 1 = pressed flat on the lens. */
  stick: number;
  visible: boolean;
  screenRect: LensPaperScreenRect;
  /** Projected sheet corners TL, TR, BR, BL as x, y pairs (viewport CSS px). */
  quad: Float64Array;
  /** Sheet height in CSS px when resting on the lens (type scale for the overlay). */
  restHeight: number;
  /** Opacity the DOM contact text should have (cross-fades with the ink texture). */
  textOpacity: number;
  /** True while the sheet is on the lens and its links can be used. */
  interactive: boolean;
  /** Set by LensPaperOverlay; while true the WebGL ink yields to the DOM text. */
  overlayMounted: boolean;
  /** Increments every rendered frame. */
  frame: number;
}

export const lensPaperState: LensPaperState = {
  phase: 'pack',
  stick: 0,
  visible: false,
  screenRect: { x: 0, y: 0, width: 0, height: 0, rotation: 0 },
  quad: new Float64Array(8),
  restHeight: 0,
  textOpacity: 0,
  interactive: false,
  overlayMounted: false,
  frame: 0,
};

const frameListeners = new Set<() => void>();

/** Called synchronously after LensPaper updates `lensPaperState` (same frame, no lag). */
export function subscribeLensPaper(listener: () => void): () => void {
  frameListeners.add(listener);
  return () => {
    frameListeners.delete(listener);
  };
}

const notify = () => frameListeners.forEach((listener) => listener());

export function lensPaperPhaseAt(progress: number): LensPaperPhase {
  if (progress < ENDING.paperGustStart) return 'pack';
  if (progress < ENDING.paperStick) return 'flight';
  if (progress < ENDING.paperHoldEnd) return 'stuck';
  if (progress < ENDING.paperPeelEnd) return 'peel';
  return 'gone';
}

/** Distance in front of the near plane where the glass is. */
const REST_GAP = 0.4;
const REST_HEIGHT_FRACTION = 0.76;
const REST_WIDTH_FRACTION = 0.86;
const REST_TILT = -0.042;
const HALO_MARGIN = 0.22;
const TWO_PI = Math.PI * 2;

const lerp = THREE.MathUtils.lerp;
const { damp } = THREE.MathUtils;

const ORIGIN = new THREE.Vector3(...ENDING.paperOrigin);
/** The gust first lifts the sheet up and back over the climber's shoulder. */
const GUST_LIFT = new THREE.Vector3(0.35, 1.25, 1.1);

const BACKLIGHT_SUNSET = new THREE.Color('#F7D9BC');
const BACKLIGHT_CLOUD = new THREE.Color('#EEF1F6');

/** Smooth 0 → 1 wind gusts (two beating sines). */
const gustAt = (time: number, a: number, b: number): number =>
  0.5 + 0.5 * Math.sin(time * a + b) * Math.sin(time * a * 0.61 + b * 1.7);

const _corner = new THREE.Vector3();

/** Projects a sheet-local corner into viewport CSS px and writes it to `quad[i]`. */
function projectCorner(
  quad: Float64Array,
  i: number,
  lx: number,
  ly: number,
  local: THREE.Matrix4,
  camera: THREE.Camera,
  size: { width: number; height: number; left: number; top: number },
): void {
  _corner.set(lx, ly, 0).applyMatrix4(local).applyMatrix4(camera.projectionMatrix);
  quad[i * 2] = size.left + (_corner.x * 0.5 + 0.5) * size.width;
  quad[i * 2 + 1] = size.top + (0.5 - _corner.y * 0.5) * size.height;
}

function useReducedMotion(): MutableRefObject<boolean> {
  const ref = useRef(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    ref.current = query.matches;
    const onChange = (event: MediaQueryListEvent) => {
      ref.current = event.matches;
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return ref;
}

export function LensPaper(): JSX.Element {
  const contact = usePortfolioStore((s) => s.contact);
  const profile = usePortfolioStore((s) => s.profile);
  const gl = useThree((s) => s.gl);
  const tier = scrollStore.gpuTier;
  const reduced = useReducedMotion();

  const layout = useMemo(() => buildLensNote(contact, profile), [contact, profile]);

  const ink = useMemo(() => {
    const scale = tier >= 2 ? 2 : 1.4;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(PAPER_UNITS.width * scale);
    canvas.height = Math.round(PAPER_UNITS.height * scale);
    const ctx = canvas.getContext('2d');
    if (ctx) paintLensNote(ctx, layout, scale);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    return texture;
  }, [layout, gl, tier]);

  const parts = useMemo(() => {
    const uniforms = createLensPaperUniforms(null);
    uniforms.uDetail.value = tier >= 2 ? 1 : 0.6;
    const material = createLensPaperMaterial(uniforms, tier);
    const segments = tier >= 2 ? [44, 60] : [26, 36];
    const geometry = new THREE.PlaneGeometry(1, 1, segments[0], segments[1]);
    const paper = new THREE.Mesh(geometry, material);
    paper.name = 'LensPaper';
    paper.renderOrder = LENS_PAPER_RENDER_ORDER;
    paper.frustumCulled = false;
    paper.matrixAutoUpdate = false;
    paper.matrixWorldAutoUpdate = false;
    paper.visible = false;

    const haloUniforms = createLensHaloUniforms();
    const haloMaterial = createLensHaloMaterial(haloUniforms);
    const haloGeometry = new THREE.PlaneGeometry(1, 1, 1, 1);
    const halo = new THREE.Mesh(haloGeometry, haloMaterial);
    halo.name = 'LensPaperHalo';
    halo.renderOrder = LENS_HALO_RENDER_ORDER;
    halo.frustumCulled = false;
    halo.matrixAutoUpdate = false;
    halo.matrixWorldAutoUpdate = false;
    halo.visible = false;

    const paperLocal = new THREE.Matrix4();
    const haloLocal = new THREE.Matrix4();
    // Compose against the camera's final matrix for this render: zero lag.
    paper.onBeforeRender = (_renderer, _scene, camera) => {
      paper.matrixWorld.multiplyMatrices(camera.matrixWorld, paperLocal);
    };
    halo.onBeforeRender = (_renderer, _scene, camera) => {
      halo.matrixWorld.multiplyMatrices(camera.matrixWorld, haloLocal);
    };

    return { uniforms, material, geometry, paper, haloUniforms, haloMaterial, haloGeometry, halo, paperLocal, haloLocal };
  }, [tier]);

  useLayoutEffect(() => {
    parts.uniforms.tInk.value = ink;
    return () => {
      parts.uniforms.tInk.value = null;
      ink.dispose();
    };
  }, [ink, parts]);

  useLayoutEffect(
    () => () => {
      parts.geometry.dispose();
      parts.material.dispose();
      parts.haloGeometry.dispose();
      parts.haloMaterial.dispose();
    },
    [parts],
  );

  useEffect(
    () => () => {
      lensPaperState.phase = 'pack';
      lensPaperState.visible = false;
      lensPaperState.textOpacity = 0;
      lensPaperState.interactive = false;
      lensPaperState.stick = 0;
      lensPaperState.frame += 1;
      notify();
    },
    [],
  );

  const work = useMemo(
    () => ({
      p0: new THREE.Vector3(),
      p1: new THREE.Vector3(),
      p2: new THREE.Vector3(),
      p3: new THREE.Vector3(),
      pos: new THREE.Vector3(),
      rest: new THREE.Vector3(),
      euler: new THREE.Euler(0, 0, 0, 'YXZ'),
      quat: new THREE.Quaternion(),
      scale: new THREE.Vector3(1, 1, 1),
      haloPos: new THREE.Vector3(),
      haloQuat: new THREE.Quaternion(),
      haloEuler: new THREE.Euler(0, 0, 0, 'YXZ'),
      haloScale: new THREE.Vector3(1, 1, 1),
      resolution: new THREE.Vector2(),
      backLight: new THREE.Color(),
    }),
    [],
  );

  const sim = useRef({
    time: 0,
    impactAge: 99,
    impactAmp: 0,
    textOpacity: 0,
    stick: 0,
    prevPhase: 'pack' as LensPaperPhase,
  });

  useFrame((state, delta) => {
    const dt = Math.min(Math.max(delta, 0), 0.1);
    const s = sim.current;
    const u = parts.uniforms;
    const hu = parts.haloUniforms;
    const w0 = work;
    s.time += dt;
    s.impactAge += dt;

    const camera = state.camera as THREE.PerspectiveCamera;
    camera.updateMatrixWorld();
    const reduce = reduced.current;
    const p = scrollStore.dampedProgress;
    const E = ENDING;
    const phase = lensPaperPhaseAt(p);

    if (phase === 'stuck' && (s.prevPhase === 'flight' || s.prevPhase === 'pack')) {
      s.impactAge = 0;
      s.impactAmp = reduce ? 0 : Math.min(1, Math.max(0.45, 0.45 + Math.abs(scrollStore.velocity) * 25));
    }
    s.prevPhase = phase;

    // ---- Where the glass is, and how big the sheet is on it.
    const fov = camera.isPerspectiveCamera ? camera.getEffectiveFOV() : 42;
    const aspect = state.size.width / Math.max(1, state.size.height);
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(fov) * 0.5);
    const near = camera.isPerspectiveCamera ? camera.near : 0.1;
    const d = near + REST_GAP;
    const halfH = d * tanHalf;
    const halfW = halfH * aspect;
    const h = Math.min(REST_HEIGHT_FRACTION * 2 * halfH, (REST_WIDTH_FRACTION * 2 * halfW) / PAPER_ASPECT);
    const w = h * PAPER_ASPECT;
    u.uSize.value.set(w, h);
    w0.rest.set(0, 0.004 * halfH, -d);

    // Defaults: pressed flat on the glass.
    let opacity = 1;
    let squash = 1;
    let contact = 0;
    let scalePulse = 1;
    let fold1 = 0;
    let fold2 = 0;
    let bendX = 0;
    let bendY = 0;
    let waveAmp = 0;
    let haloStrength = 0;
    let ripple = 0;
    let impact = 0;
    let peelFront = 0;
    let peelAngle = 0;
    let peelRadius = 0.05 * h;
    let peelFlutter = 0;
    u.uCornerLift.value.set(0, 0, 0, 0);
    w0.pos.copy(w0.rest);
    w0.euler.set(0, 0, REST_TILT);

    const cloudIn = smoothstep(CLOUD_CURTAIN.timeline.returnStart, CLOUD_CURTAIN.timeline.returnStart + 0.014, p);

    if (phase === 'flight') {
      const t = remap(p, E.paperGustStart, E.paperStick);
      if (reduce) {
        opacity = smoothstep(0.3, 1, t);
      } else {
        // Path: out of the pack, lifted by the gust, swung wide to the left,
        // then accelerating straight into the lens.
        const emerge = 1 - smoothstep(0, 0.12, t);
        w0.p0.copy(ORIGIN);
        w0.p0.y -= 0.12 * emerge;
        w0.p0.applyMatrix4(camera.matrixWorldInverse);
        w0.p1.copy(ORIGIN).add(GUST_LIFT).applyMatrix4(camera.matrixWorldInverse);
        const z2 = 2.8;
        w0.p2.set(-0.42 * z2 * tanHalf * aspect, 0.12 * z2 * tanHalf, -z2);
        w0.p3.copy(w0.rest);
        const k = 0.5 * t + 0.5 * t * t * t;
        const a = 1 - k;
        const b0 = a * a * a;
        const b1 = 3 * a * a * k;
        const b2 = 3 * a * k * k;
        const b3 = k * k * k;
        w0.pos.set(
          w0.p0.x * b0 + w0.p1.x * b1 + w0.p2.x * b2 + w0.p3.x * b3,
          w0.p0.y * b0 + w0.p1.y * b1 + w0.p2.y * b2 + w0.p3.y * b3,
          w0.p0.z * b0 + w0.p1.z * b1 + w0.p2.z * b2 + w0.p3.z * b3,
        );
        // Sideways drift and bobbing in the turbulent gust, proportional to distance.
        const env = Math.sin(Math.PI * t);
        const dist = Math.max(0.5, -w0.pos.z);
        w0.pos.x += dist * env * (0.035 * Math.sin(t * 19 + 0.7) + 0.008 * Math.sin(s.time * 7.3));
        w0.pos.y += dist * env * (0.025 * Math.sin(t * 23 + 1.9) + 0.006 * Math.sin(s.time * 5.9 + 1.3));

        // Tumble: one back-flip, a yaw swing and a roll, settling face-on.
        const settle = 1 - smoothstep(0.55, 0.96, t);
        w0.euler.set(
          -TWO_PI * smootherstep(0.1, 0.8, t) + 0.3 * Math.sin(t * 17 + 0.4) * (1 - t) * env + 0.1 * Math.sin(s.time * 5.1) * env,
          0.75 * Math.sin(t * 7.2 + 0.3) * settle + 0.08 * Math.sin(s.time * 4.3 + 1) * env,
          REST_TILT * smoothstep(0.6, 1, t) + 0.6 * Math.sin(t * 5.1 + 0.2) * (1 - smoothstep(0.5, 0.95, t)),
        );

        // Unfold: the second fold opens first, then the first; the first crease
        // keeps a memory of the fold until the glass presses it flat.
        fold2 = Math.PI * (1 - smootherstep(0.05, 0.28, t));
        fold1 = fold2 > 1e-4 ? Math.PI : Math.PI * (1 - smootherstep(0.28, 0.55, t));
        fold1 = Math.max(fold1, 0.22 * (1 - smoothstep(0.8, 0.97, t)));

        // Flex in the air, then bow (edges trailing) just before the slap.
        const flex = smoothstep(0.3, 0.5, t) * (1 - smoothstep(0.8, 0.96, t));
        const bow = 0.075 * smoothstep(0.74, 0.96, t);
        bendX = 0.11 * Math.sin(t * 15 + 0.6 + s.time * 1.5) * flex + bow;
        bendY = 0.07 * Math.sin(t * 12 + 2 + s.time * 1.1) * flex + bow * 0.7;
        waveAmp = 0.04 * smoothstep(0.3, 0.55, t) * (1 - smoothstep(0.82, 0.98, t));
        u.uWaveDir.value.set(Math.cos(t * 3 + 0.9), Math.sin(t * 3 + 0.9));
        squash = smoothstep(0.06, 0.3, t);
      }
    } else if (phase === 'stuck') {
      const settle = 1 - smoothstep(E.paperStick, E.paperStick + 0.0014, p);
      contact = 1 - settle;
      haloStrength = 0.4 * (1 - settle);
      if (!reduce) {
        bendX = 0.075 * settle;
        bendY = 0.0525 * settle;
        const k = s.impactAmp * Math.exp(-s.impactAge * 5.5);
        impact = 0.03 * k;
        scalePulse = 1 + 0.02 * s.impactAmp * Math.exp(-s.impactAge * 9) * Math.cos(s.impactAge * 22);
        w0.pos.y -= 0.01 * h * s.impactAmp * Math.exp(-s.impactAge * 10) * Math.sin(s.impactAge * 30);
        const lift = 1 - settle;
        const anticipation = 0.11 * smoothstep(E.paperHoldEnd - 0.009, E.paperHoldEnd, p);
        u.uCornerLift.value.set(
          lift * (0.01 + 0.012 * gustAt(s.time, 1.9, 0.3)),
          lift * (0.016 + 0.02 * gustAt(s.time, 2.3, 1.1)) + anticipation,
          lift * (0.006 + 0.01 * gustAt(s.time, 1.6, 2.4)),
          lift * (0.022 + 0.014 * gustAt(s.time, 2.1, 3.3)),
        );
        ripple = 0.004 * lift;
      }
    } else if (phase === 'peel') {
      const t = remap(p, E.paperHoldEnd, E.paperPeelEnd);
      contact = 1 - smoothstep(0.2, 0.7, t);
      haloStrength = 0.4 * (1 - smoothstep(0, 0.45, t));
      if (reduce) {
        opacity = 1 - smoothstep(0, 0.6, t);
        w0.pos.x -= 0.15 * halfW * t;
      } else {
        const diag = Math.hypot(w, h);
        peelFront = diag * 1.12 * smootherstep(0, 0.6, t);
        peelAngle = 0.25 + 1.35 * smoothstep(0, 0.65, t);
        peelRadius = h * (0.05 + 0.05 * t);
        peelFlutter = 0.14;
        const exit = Math.pow(smoothstep(0.32, 1, t), 1.5);
        const depth = d + 0.6 * exit;
        w0.pos.set(
          w0.rest.x - (depth * tanHalf * aspect + w) * 1.2 * exit,
          w0.rest.y + 0.55 * halfH * exit,
          -depth,
        );
        w0.euler.set(0.5 * exit, -1.3 * exit, REST_TILT + 0.9 * exit);
        const fadeCorners = 1 - smoothstep(0, 0.2, t);
        u.uCornerLift.value.set(0.015 * fadeCorners, 0.11 * fadeCorners, 0.01 * fadeCorners, 0.025 * fadeCorners);
        ripple = 0.004 * fadeCorners;
        opacity = 1 - smoothstep(0.9, 1, t);
      }
    }

    // ---- Stick, text cross-fade and interactivity.
    if (phase === 'stuck') s.stick = damp(s.stick, 1, 10, dt);
    else if (phase === 'peel') s.stick = Math.min(s.stick, 1 - smoothstep(0, 0.3, remap(p, E.paperHoldEnd, E.paperPeelEnd)));
    else s.stick = 0;

    const wantText = phase === 'stuck' && p >= E.paperStick + 0.0004 && (s.impactAge > 0.12 || s.impactAmp === 0);
    const target = wantText ? 1 : 0;
    s.textOpacity = damp(s.textOpacity, target, target > s.textOpacity ? 6 : 16, dt);
    if (Math.abs(s.textOpacity - target) < 0.002) s.textOpacity = target;

    const visible = (phase === 'flight' || phase === 'stuck' || phase === 'peel') && opacity > 0.001 && sceneFx.exposure > 0.003;
    parts.paper.visible = visible;
    parts.halo.visible = visible && haloStrength > 0.001;

    // ---- Uniforms.
    u.uTime.value = s.time;
    u.uFold.value.set(fold1, fold2);
    u.uBend.value.set(bendX, bendY);
    u.uWave.value.set(waveAmp, 1.7, 11, 0);
    u.uEdgeRipple.value = ripple;
    u.uImpact.value.set(impact, s.impactAge);
    u.uPeel.value.set(peelFront, peelAngle, peelRadius, peelFlutter);
    u.uDepthSquash.value = squash;
    u.uContact.value = contact;
    u.uOpacity.value = opacity;
    u.uExposure.value = sceneFx.exposure;
    u.uInk.value = lensPaperState.overlayMounted ? 1 - s.textOpacity : 1;
    u.uSunView.value.copy(SUN_DIRECTION).transformDirection(camera.matrixWorldInverse);
    u.uSunIntensity.value = lerp(1.45, 0.3, cloudIn);
    u.uAmbient.value = lerp(0.8, 0.95, cloudIn);
    u.uBackLight.value.copy(w0.backLight.copy(BACKLIGHT_SUNSET).multiplyScalar(0.95).lerp(BACKLIGHT_CLOUD, cloudIn));
    if (cloudIn > 0) u.uBackLight.value.multiplyScalar(lerp(1, 1.2, cloudIn));
    state.gl.getDrawingBufferSize(w0.resolution);
    u.uResolution.value.copy(w0.resolution);

    // ---- Camera-space transforms (composed with the camera in onBeforeRender).
    w0.quat.setFromEuler(w0.euler);
    w0.scale.setScalar(scalePulse);
    parts.paperLocal.compose(w0.pos, w0.quat, w0.scale);

    const margin = HALO_MARGIN * h;
    w0.haloPos.set(w0.rest.x, w0.rest.y - 0.012 * h, -d - 0.002);
    w0.haloEuler.set(0, 0, REST_TILT);
    w0.haloQuat.setFromEuler(w0.haloEuler);
    w0.haloScale.set(w + 2 * margin, h + 2 * margin, 1);
    parts.haloLocal.compose(w0.haloPos, w0.haloQuat, w0.haloScale);
    hu.uPaperSize.value.set(w, h);
    hu.uHaloSize.value.set(w + 2 * margin, h + 2 * margin);
    hu.uSoftness.value = 0.12 * h;
    hu.uStrength.value = haloStrength;
    hu.uExposure.value = sceneFx.exposure;

    // ---- Publish the projected sheet for the DOM overlay.
    const st = lensPaperState;
    projectCorner(st.quad, 0, -w / 2, h / 2, parts.paperLocal, camera, state.size);
    projectCorner(st.quad, 1, w / 2, h / 2, parts.paperLocal, camera, state.size);
    projectCorner(st.quad, 2, w / 2, -h / 2, parts.paperLocal, camera, state.size);
    projectCorner(st.quad, 3, -w / 2, -h / 2, parts.paperLocal, camera, state.size);
    const q = st.quad;
    st.screenRect.x = (q[0] + q[2] + q[4] + q[6]) * 0.25;
    st.screenRect.y = (q[1] + q[3] + q[5] + q[7]) * 0.25;
    st.screenRect.width = Math.hypot(q[2] - q[0], q[3] - q[1]);
    st.screenRect.height = Math.hypot(q[6] - q[0], q[7] - q[1]);
    st.screenRect.rotation = Math.atan2(q[3] - q[1], q[2] - q[0]);
    st.restHeight = (h / (2 * halfH)) * state.size.height;
    st.phase = phase;
    st.stick = clamp01(s.stick);
    st.visible = visible;
    st.textOpacity = visible ? s.textOpacity * Math.min(1, sceneFx.exposure * 1.5) : 0;
    st.interactive = visible && phase === 'stuck' && s.textOpacity > 0.6;
    st.frame += 1;
    notify();
  });

  return (
    <>
      <primitive object={parts.halo} dispose={null} />
      <primitive object={parts.paper} dispose={null} />
    </>
  );
}

export default LensPaper;
