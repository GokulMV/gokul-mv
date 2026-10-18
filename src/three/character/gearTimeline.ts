import * as THREE from 'three';
import { GEAR_DROP_AT, GEAR_EQUIP_AT, clamp01, smoothstep, type GearId, type Vec3Tuple } from '../../store/scrollStore';
import { protagonistPositionAt } from '../protagonistPath';
import { ENDING } from '../world/worldLayout';
import { iceAxeHolsterMatrix, ropeCoilCentreline } from './gearGeometry';
import { ICE_AXES_IN_HANDS } from './rigTypes';

/* ==========================================================================
 * Gear timeline — PURE module (runs in Node): every gear state is a
 * deterministic function of scroll progress, so scrubbing back and forth
 * always gives the same picture. Time (elapsed seconds) only drives the
 * secondary motion in GearSheddingSystem (rack sway, lid flutter).
 *
 *   lock-on     each item materialises GEAR_LOCK_ON.lead before its
 *               GEAR_EQUIP_AT and snaps on with an under-damped spring whose
 *               peak lands on GEAR_EQUIP_AT (the HUD count / chime moment);
 *   ice axes    hand ↔ hip-holster handoffs at the moments the animator's
 *               hands reach the holsters (ICE_AXE_HANDOFFS), consistent with
 *               rigTypes.iceAxeModeAt outside those short windows;
 *   falls       at GEAR_DROP_AT an item detaches: its pose follows a rigid-body
 *               trajectory precomputed against the terrain SDF (gravity, drag,
 *               tumbling, multi-sphere contacts with restitution and friction),
 *               indexed by fall seconds = (progress − dropAt) · secondsPerProgress,
 *               and dissolves once it is deep in the abyss;
 *   lid         the backpack lid flips open over the gust (0.945 → 0.952).
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * Lock-on
 * ------------------------------------------------------------------------- */

export const GEAR_LOCK_ON = {
  /** Progress before GEAR_EQUIP_AT at which the item starts to materialise. */
  lead: 0.004,
  /** Progress span of the whole spring (approach + settle). */
  duration: 0.012,
} as const;

/** Approach offsets (item frame, metres): where each item flies in from. */
export const GEAR_APPROACH: Readonly<Record<GearId, Vec3Tuple>> = {
  backpack: [0, 0.14, 0.2],
  rope: [0.04, 0.26, 0.02],
  iceAxes: [0, 0.2, 0.02],
  harness: [0, -0.24, 0.04],
};

export interface LockOnState {
  /** Shown at all (false before the lead-in). */
  visible: boolean;
  /** Uniform scale (springs past 1 at the lock moment). */
  scale: number;
  /** Fraction of GEAR_APPROACH still to travel (overshoots below 0 = the snap). */
  approach: number;
  /** 0..1 emissive glint around the lock moment. */
  glint: number;
}

export function gearLockOnAt(gear: GearId, progress: number, out: LockOnState): LockOnState {
  const start = GEAR_EQUIP_AT[gear] - GEAR_LOCK_ON.lead;
  if (progress < start) {
    out.visible = false;
    out.scale = 0;
    out.approach = 1;
    out.glint = 0;
    return out;
  }
  const x = (progress - start) / GEAR_LOCK_ON.duration;
  out.visible = true;
  if (x >= 1) {
    out.scale = 1;
    out.approach = 0;
    out.glint = 0;
    return out;
  }
  const e = Math.exp(-7 * x);
  out.scale = Math.max(0, 1 - e * Math.cos(8.5 * x));
  out.approach = Math.exp(-6.2 * x) * Math.cos(9.4 * x);
  const lock = GEAR_LOCK_ON.lead / GEAR_LOCK_ON.duration;
  const g = (x - lock) / 0.13;
  out.glint = Math.exp(-g * g);
  return out;
}

/* ---------------------------------------------------------------------------
 * Ice-axe handoffs
 * ------------------------------------------------------------------------- */

export interface AxeHandoff {
  /** Centre of the handoff (the animator's hands are at the holsters). */
  readonly at: number;
  readonly half: number;
  readonly toHands: boolean;
}

/**
 * Hand ↔ holster transfers. They sit on the CharacterAnimator's handsToHolsters windows: the draw before wall 1
 * happens while the hands touch the holsters at 0.2855 (the animator raises them, axes drawn, before 0.29), the
 * holsters at the ledge-1 top-out (0.445), the draw on the ledge-2 landing (0.5245) and the holster on the pillar
 * top (0.615). Outside these windows the result equals `iceAxeModeAt(...) === 'hands'` except 0.2864–0.29, where
 * the axes are already in the raised hands.
 */
export const ICE_AXE_HANDOFFS: readonly AxeHandoff[] = [
  { at: 0.2855, half: 0.0009, toHands: true },
  { at: ICE_AXES_IN_HANDS[0][1], half: 0.0011, toHands: false },
  { at: 0.5245, half: 0.0008, toHands: true },
  { at: ICE_AXES_IN_HANDS[1][1], half: 0.001, toHands: false },
];

/** 0 = racked at the hips, 1 = in the hands (smooth through the handoffs). */
export function iceAxeHandBlend(progress: number): number {
  if (progress < GEAR_EQUIP_AT.iceAxes || progress >= GEAR_DROP_AT.iceAxes) return 0;
  let value = 0;
  for (const h of ICE_AXE_HANDOFFS) {
    const s = smoothstep(h.at - h.half, h.at + h.half, progress);
    value += ((h.toHands ? 1 : 0) - value) * s;
  }
  return value;
}

/* ---------------------------------------------------------------------------
 * Falls
 * ------------------------------------------------------------------------- */

export const GEAR_FALL = {
  /**
   * Simulated fall seconds per unit of progress: 60 → the 3.15 s fall + dissolve spans 0.0525 progress (~74 vh of
   * the 1400 vh track), so the first second — the part the authored camera frames before the item drops below
   * the picture — lasts ~0.017 progress and reads as a fall at a normal scroll pace instead of a flash.
   */
  secondsPerProgress: 60,
  /** Seconds over which a detaching item blends from its live socket onto the trajectory. */
  detachSeconds: 0.2,
  /** Dissolve window (seconds into the fall). */
  fadeStart: 2.35,
  fadeEnd: 3.15,
  /** Simulated length of every trajectory (seconds). */
  duration: 3.3,
  /** Integration step (seconds). */
  dt: 1 / 120,
  gravity: 9.81,
} as const;

/** Seconds since the item was dropped (negative while attached; Infinity for the backpack). */
export function gearFallSeconds(gear: GearId, progress: number): number {
  const drop = GEAR_DROP_AT[gear];
  if (!Number.isFinite(drop)) return Number.NEGATIVE_INFINITY;
  return (progress - drop) * GEAR_FALL.secondsPerProgress;
}

/** Opacity of a falling item (1 → 0). */
export function gearFallOpacity(seconds: number): number {
  return 1 - smoothstep(GEAR_FALL.fadeStart, GEAR_FALL.fadeEnd, seconds);
}

/** Weight of the trajectory against the live socket pose (0 attached → 1 free). */
export function gearDetachWeight(seconds: number): number {
  return smoothstep(0, GEAR_FALL.detachSeconds, seconds);
}

export type FallBodyId = 'rope' | 'harness' | 'axeL' | 'axeR';

export interface FallProxy {
  /** Sphere centre in the item frame. */
  p: Vec3Tuple;
  r: number;
}

export interface FallBodySpec {
  id: FallBodyId;
  gear: GearId;
  /**
   * Nominal item-frame pose at the drop: world offset from protagonistPositionAt(dropAt) and an orientation
   * (Euler 'YXZ'). Measured from the CharacterAnimator at the drop moment; GearSheddingSystem blends from the
   * live socket over GEAR_FALL.detachSeconds, so these only need to be close.
   */
  startOffset: Vec3Tuple;
  startEuler: Vec3Tuple;
  /** Extra item-local transform applied after the start pose (the racked axe hang), or null. */
  local: THREE.Matrix4 | null;
  /** World velocity (m/s) and angular velocity (rad/s) at release. */
  velocity: Vec3Tuple;
  spin: Vec3Tuple;
  /** Centre of mass in the item frame. */
  com: Vec3Tuple;
  /** Radius of gyration (isotropic inertia). */
  gyration: number;
  proxies: readonly FallProxy[];
  restitution: number;
  friction: number;
}

/** Samples of the coil centreline used as the rope's fall proxies (socket frame). */
export const ROPE_FALL_PROXY_SAMPLES = 10;

let ropeProxyPoints: Vec3Tuple[] | null = null;

/**
 * Seeds the rope's fall-proxy centreline (ropeCoilCentreline(ROPE_FALL_PROXY_SAMPLES), flattened x, y, z), e.g.
 * computed by the gear build worker, so the main thread skips the coil wrap (it marches the torso field).
 */
export function primeRopeFallProxies(flat: ArrayLike<number>): void {
  const points: Vec3Tuple[] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) points.push([flat[i], flat[i + 1], flat[i + 2]]);
  ropeProxyPoints = points;
}

function ropeProxies(): FallProxy[] {
  if (!ropeProxyPoints) {
    const { points } = ropeCoilCentreline(ROPE_FALL_PROXY_SAMPLES);
    ropeProxyPoints = points.map((p) => [p.x, p.y, p.z] as Vec3Tuple);
  }
  return ropeProxyPoints.map((p) => ({ p, r: 0.032 }));
}

export function fallBodySpecs(): FallBodySpec[] {
  const axe = (side: 1 | -1): FallBodySpec => ({
    id: side > 0 ? 'axeL' : 'axeR',
    gear: 'iceAxes',
    startOffset: side > 0 ? [-0.178, 0.894, -0.738] : [0.193, 0.884, -0.742],
    startEuler: [0.409, -3.119, 0.031],
    local: iceAxeHolsterMatrix(side),
    velocity: side > 0 ? [1.2, 1.0, 2.2] : [1.0, 1.3, 2.8],
    spin: side > 0 ? [3.4, 0.6, 1.3] : [-2.8, -0.9, 0.8],
    com: [0, 0.008, 0.24],
    gyration: 0.15,
    proxies: [
      { p: [0, -0.017, -0.13], r: 0.02 },
      { p: [0, 0, -0.08], r: 0.022 },
      { p: [0, 0.018, 0.1], r: 0.02 },
      { p: [0, 0.03, 0.26], r: 0.02 },
      { p: [0, 0.006, 0.448], r: 0.035 },
      { p: [0, -0.1, 0.43], r: 0.014 },
      { p: [0, 0.05, 0.45], r: 0.018 },
    ],
    restitution: 0.42,
    friction: 0.35,
  });
  return [
    {
      id: 'rope',
      gear: 'rope',
      startOffset: [-0.118, 1.145, -0.286],
      startEuler: [0.47, 3.092, 0.053],
      local: null,
      velocity: [3.6, 1.1, 0.55],
      spin: [2.1, 0.7, -1.6],
      com: [-0.14, -0.22, -0.1],
      gyration: 0.2,
      proxies: ropeProxies(),
      restitution: 0.22,
      friction: 0.55,
    },
    {
      id: 'harness',
      gear: 'harness',
      startOffset: [0.026, 0.967, -0.397],
      startEuler: [-0.022, 3.114, 0],
      local: null,
      velocity: [-0.55, 1.2, 2.9],
      spin: [-2.4, 1.1, 0.9],
      com: [0, -0.06, 0],
      gyration: 0.17,
      proxies: [
        { p: [0, 0, 0.14], r: 0.035 },
        { p: [0.17, 0, 0.03], r: 0.035 },
        { p: [-0.17, 0, 0.03], r: 0.035 },
        { p: [0.11, 0, -0.13], r: 0.035 },
        { p: [-0.11, 0, -0.13], r: 0.035 },
        { p: [0.1, -0.2, 0.01], r: 0.09 },
        { p: [-0.1, -0.2, 0.01], r: 0.09 },
        { p: [0.19, -0.2, 0.06], r: 0.04 },
        { p: [-0.19, -0.2, 0.06], r: 0.04 },
      ],
      restitution: 0.28,
      friction: 0.5,
    },
    axe(1),
    axe(-1),
  ];
}

export type SdfFunction = (x: number, y: number, z: number) => number;

/** A precomputed, resumable rigid-body fall. Samples are item-frame poses (position + quaternion) per step. */
export interface FallTrajectory {
  readonly spec: FallBodySpec;
  /** Seconds simulated so far. */
  readonly simulated: number;
  readonly done: boolean;
  /** Advances the simulation for at most `budgetMs` (at least one step). */
  step(budgetMs: number): void;
  /** Item-frame world pose at `seconds` into the fall (simulates synchronously if needed). Allocation free. */
  sample(seconds: number, position: THREE.Vector3, quaternion: THREE.Quaternion): void;
  /** Deepest proxy penetration found so far (m, ≥ 0) and the number of contacts. */
  readonly maxPenetration: number;
  readonly contacts: number;
}

export function createFallTrajectory(spec: FallBodySpec, sdf: SdfFunction): FallTrajectory {
  const dt = GEAR_FALL.dt;
  const steps = Math.ceil(GEAR_FALL.duration / dt) + 1;
  // Per sample: item origin (3) + quaternion (4).
  const samples = new Float32Array(steps * 7);
  const g = GEAR_FALL.gravity;

  const dropAt = GEAR_DROP_AT[spec.gear];
  const path = protagonistPositionAt(dropAt, new THREE.Vector3());
  const startPos = path.clone().add(new THREE.Vector3(...spec.startOffset));
  const startQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(spec.startEuler[0], spec.startEuler[1], spec.startEuler[2], 'YXZ'));
  if (spec.local) {
    const m = new THREE.Matrix4().compose(startPos, startQ, new THREE.Vector3(1, 1, 1)).multiply(spec.local);
    m.decompose(startPos, startQ, new THREE.Vector3());
  }
  const com = new THREE.Vector3(...spec.com);
  const proxies = spec.proxies.map((p) => ({ p: new THREE.Vector3(...p.p).sub(com), r: p.r }));
  let bound = 0;
  for (const p of proxies) bound = Math.max(bound, p.p.length() + p.r);
  const invInertia = 1 / (spec.gyration * spec.gyration);

  // State: centre of mass c, orientation q, velocities.
  const q = startQ.clone();
  const c = startPos.clone().add(com.clone().applyQuaternion(q));
  const v = new THREE.Vector3(...spec.velocity);
  const w = new THREE.Vector3(...spec.spin);
  const tmpQ = new THREE.Quaternion();
  const r = new THREE.Vector3();
  const pw = new THREE.Vector3();
  const n = new THREE.Vector3();
  const vp = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const vt = new THREE.Vector3();
  const origin = new THREE.Vector3();

  let index = 0;
  let maxPen = 0;
  let contacts = 0;

  const gradient = (p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 => {
    const h = 0.02;
    const a = sdf(p.x + h, p.y - h, p.z - h);
    const b = sdf(p.x - h, p.y - h, p.z + h);
    const cc = sdf(p.x - h, p.y + h, p.z - h);
    const d = sdf(p.x + h, p.y + h, p.z + h);
    out.set(a - b - cc + d, -a - b + cc + d, -a + b - cc + d);
    const l = out.length();
    return l > 1e-9 ? out.multiplyScalar(1 / l) : out.set(0, 1, 0);
  };

  const record = (): void => {
    origin.copy(com).applyQuaternion(q).negate().add(c);
    const k = index * 7;
    samples[k] = origin.x;
    samples[k + 1] = origin.y;
    samples[k + 2] = origin.z;
    samples[k + 3] = q.x;
    samples[k + 4] = q.y;
    samples[k + 5] = q.z;
    samples[k + 6] = q.w;
    index += 1;
  };

  const integrate = (): void => {
    v.y -= g * dt;
    v.multiplyScalar(Math.exp(-0.06 * dt));
    w.multiplyScalar(Math.exp(-0.08 * dt));
    c.addScaledVector(v, dt);
    // q += ½ dt (ω ⊗ q)
    tmpQ.set(w.x, w.y, w.z, 0).multiply(q);
    q.set(q.x + 0.5 * dt * tmpQ.x, q.y + 0.5 * dt * tmpQ.y, q.z + 0.5 * dt * tmpQ.z, q.w + 0.5 * dt * tmpQ.w).normalize();
    // Contacts (broad phase on the bounding sphere first).
    if (sdf(c.x, c.y, c.z) > bound + 0.15) return;
    for (let iter = 0; iter < 2; iter += 1) {
      let deepest = 0;
      let hit = -1;
      for (let i = 0; i < proxies.length; i += 1) {
        pw.copy(proxies[i].p).applyQuaternion(q).add(c);
        const d = sdf(pw.x, pw.y, pw.z) - proxies[i].r;
        if (d < deepest) {
          deepest = d;
          hit = i;
        }
      }
      if (hit < 0) return;
      contacts += 1;
      maxPen = Math.max(maxPen, -deepest);
      pw.copy(proxies[hit].p).applyQuaternion(q).add(c);
      gradient(pw, n);
      // Push the body out of the rock along the contact normal (bounded per step so a start pose that is
      // already touching the rock eases out instead of jumping).
      c.addScaledVector(n, Math.min(-deepest, 0.06) + 1e-4);
      r.copy(pw).sub(c);
      vp.crossVectors(w, r).add(v);
      const vn = vp.dot(n);
      if (vn >= 0) continue;
      // Normal impulse (unit mass, isotropic inertia).
      tmp.crossVectors(r, n);
      const kN = 1 + tmp.lengthSq() * invInertia;
      const jn = (-(1 + spec.restitution) * vn) / kN;
      v.addScaledVector(n, jn);
      w.addScaledVector(tmp, jn * invInertia);
      // Coulomb friction impulse.
      vp.crossVectors(w, r).add(v);
      vt.copy(vp).addScaledVector(n, -vp.dot(n));
      const vtl = vt.length();
      if (vtl > 1e-6) {
        vt.multiplyScalar(1 / vtl);
        tmp.crossVectors(r, vt);
        const kT = 1 + tmp.lengthSq() * invInertia;
        const jt = Math.min(spec.friction * jn, vtl / kT);
        v.addScaledVector(vt, -jt);
        w.addScaledVector(tmp, -jt * invInertia);
      }
    }
  };

  record();
  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const api: FallTrajectory = {
    spec,
    get simulated() {
      return (index - 1) * dt;
    },
    get done() {
      return index >= steps;
    },
    get maxPenetration() {
      return maxPen;
    },
    get contacts() {
      return contacts;
    },
    step(budgetMs: number) {
      const t0 = now();
      do {
        if (index >= steps) return;
        integrate();
        record();
      } while (now() - t0 < budgetMs);
    },
    sample(seconds: number, position: THREE.Vector3, quaternion: THREE.Quaternion) {
      const s = THREE.MathUtils.clamp(seconds, 0, GEAR_FALL.duration) / dt;
      const need = Math.min(steps - 1, Math.ceil(s) + 1);
      while (index <= need && index < steps) {
        integrate();
        record();
      }
      const i0 = Math.min(Math.floor(s), index - 1);
      const i1 = Math.min(i0 + 1, index - 1);
      const k = clamp01(s - i0);
      const a = i0 * 7;
      const b = i1 * 7;
      position.set(
        samples[a] + (samples[b] - samples[a]) * k,
        samples[a + 1] + (samples[b + 1] - samples[a + 1]) * k,
        samples[a + 2] + (samples[b + 2] - samples[a + 2]) * k,
      );
      quaternion.set(samples[a + 3], samples[a + 4], samples[a + 5], samples[a + 6]);
      tmpQ.set(samples[b + 3], samples[b + 4], samples[b + 5], samples[b + 6]);
      quaternion.slerp(tmpQ, k);
    },
  };
  return api;
}

/* ---------------------------------------------------------------------------
 * Backpack lid
 * ------------------------------------------------------------------------- */

export const BACKPACK_FLAP = {
  /** The gust hits (ENDING.paperGustStart) and the lid starts to flip open … */
  start: ENDING.paperGustStart,
  /** … and is open by here. */
  open: 0.952,
  /** Resting open angle (rad, about the side hinge's +Z, applied negatively): flipped over, hanging beside the pack. */
  restAngle: 3.42,
  /** Hard limit (the lid never folds back into the pack's side). */
  maxAngle: 3.78,
} as const;

/** Deterministic lid angle (rad, ≥ 0 = open) for progress. */
export function backpackFlapAngle(progress: number): number {
  if (progress <= BACKPACK_FLAP.start) return 0;
  const x = (progress - BACKPACK_FLAP.start) / (BACKPACK_FLAP.open - BACKPACK_FLAP.start);
  const a = BACKPACK_FLAP.restAngle * (1 - Math.exp(-3.4 * x) * Math.cos(4.6 * x));
  return Math.min(BACKPACK_FLAP.maxAngle, Math.max(0, a));
}

/** Gust strength envelope for the lid flutter when no wind source is wired (0..1). */
export function backpackGustAt(progress: number): number {
  return smoothstep(BACKPACK_FLAP.start, BACKPACK_FLAP.open, progress) * (1 - 0.45 * smoothstep(ENDING.paperStick, ENDING.paperHoldEnd, progress));
}
