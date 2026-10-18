import * as THREE from 'three';
import { clamp01, smoothstep, type Vec3Tuple } from '../../store/scrollStore';
import { PATH_PHASES, protagonistPositionAt } from '../protagonistPath';
import { CAMERA_CLIP, ENDING, HORIZON_AIM } from '../world/worldLayout';

/* ==========================================================================
 * Camera spline — PURE module (no React, no DOM; runs in Node).
 *
 * The whole 10-scene camera move is authored as progress-stamped keyframes
 * (position, look-at, fov, roll). Two THREE.CatmullRomCurve3 splines are built
 * from them once, at module load:
 *
 *   cameraPath  — centripetal Catmull-Rom through the keyframe positions.
 *                 Centripetal parameterisation never forms cusps or loops and
 *                 keeps overshoot tiny even where keyframe spacing changes a
 *                 lot (fast swings next to slow drifts).
 *   lookAtPath  — centripetal Catmull-Rom through the keyframe VIEW
 *                 DIRECTIONS: unit vectors (lookAt - position) / |…|, i.e.
 *                 points on the unit sphere around the origin. The Scene 8
 *                 aim (HORIZON_AIM) is ~158 units away while its neighbours
 *                 are 6–8 units away; interpolating look-at POINTS would race
 *                 the aim towards the far point within the first few percent
 *                 of the segment (a whip pan). Interpolating directions spreads
 *                 the angular change smoothly across the segment no matter how
 *                 far the subject is. The sampled direction is renormalised,
 *                 and the look-at point handed back to callers is
 *                 position + direction × focusDistance, where focusDistance is
 *                 the keyframe |lookAt - position| interpolated in log space —
 *                 so at every keyframe the authored look-at point is returned
 *                 exactly.
 *
 * Progress → curve parameter (piecewise, exact at every keyframe):
 *   three's non-closed CatmullRomCurve3.getPoint(t) maps t·(n−1) uniformly to
 *   segments, so keyframe i sits at t = i/(n−1). Inside a segment, three's
 *   centripetal curve is a cubic in the local weight u that is C¹ in the
 *   centripetal knot parameter τ (cumulative |Pᵢ₊₁ − Pᵢ|^½), not in u. So
 *   progress is first mapped to τ with a monotone piecewise-cubic Hermite
 *   (Fritsch–Carlson / PCHIP) through (progressᵢ, τᵢ), then τ → (i + u)/(n−1).
 *   Result: every keyframe is reached exactly at its progress, the camera
 *   never moves backwards along the path, and its velocity is continuous
 *   across keyframes (no speed kinks). Keyframes flagged `settle` get a zero
 *   slope in that mapping, i.e. the move eases in/out of them.
 *
 * After the last keyframe (the end of the "last pull", 0.945) the pose is held
 * exactly until 1.0: the paper flies onto the lens at 0.955 and is locked to
 * the camera until 0.985, so the frame must not drift.
 * ========================================================================== */

const DEG = Math.PI / 180;

export interface CameraKeyframe {
  /** Scroll progress (0 → 1) at which the rig passes exactly through this pose. */
  readonly progress: number;
  readonly position: Vec3Tuple;
  readonly lookAt: Vec3Tuple;
  /** Vertical field of view, degrees. */
  readonly fov: number;
  /** Dutch roll about the view axis, radians (positive = counter-clockwise on screen). */
  readonly roll: number;
  /** Ease the progress → curve mapping to a standstill at this keyframe. */
  readonly settle: boolean;
  /** scrollStore scene index (0 → 9) this keyframe belongs to. */
  readonly scene: number;
  readonly label: string;
}

interface KeyframeOptions {
  fov?: number;
  /** Degrees. */
  rollDeg?: number;
  settle?: boolean;
}

const BASE_FOV = CAMERA_CLIP.fov;
/** Chest height on the ~1.8 tall climber that tracking shots aim at. */
const CLIMBER_AIM_HEIGHT = 1.2;

const _route = new THREE.Vector3();

function routeOffset(progress: number, dx: number, dy: number, dz: number): Vec3Tuple {
  protagonistPositionAt(progress, _route);
  return [_route.x + dx, _route.y + dy, _route.z + dz];
}

function lerpTuple(a: Vec3Tuple, b: Vec3Tuple, t: number): Vec3Tuple {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function key(
  progress: number,
  scene: number,
  label: string,
  position: Vec3Tuple,
  lookAt: Vec3Tuple,
  options: KeyframeOptions = {},
): CameraKeyframe {
  return {
    progress,
    position,
    lookAt,
    fov: options.fov ?? BASE_FOV,
    roll: (options.rollDeg ?? 0) * DEG,
    settle: options.settle ?? false,
    scene,
    label,
  };
}

/** Keyframe whose look-at follows the climber (route position + chest height). */
function trackKey(
  progress: number,
  scene: number,
  label: string,
  position: Vec3Tuple,
  options: KeyframeOptions = {},
): CameraKeyframe {
  return key(progress, scene, label, position, routeOffset(progress, 0, CLIMBER_AIM_HEIGHT, 0), options);
}

/* ---------------------------------------------------------------------------
 * Scene 4 — parallel tracking up cliff 1. The camera rides alongside the
 * climber with an offset that slides from the base-camp framing [0,1.8,6]
 * to the ledge framing [3.5,0.5,6] (→ [3.5,18.5,-2] at 0.45), so the climber
 * stays planted in frame while the wall streams past.
 * ------------------------------------------------------------------------- */

const ASCENT_OFFSET_START: Vec3Tuple = [0, 1.8, 6.0];
const ASCENT_OFFSET_END: Vec3Tuple = [3.5, 0.5, 6.0];

function ascentKey(progress: number): CameraKeyframe {
  const s = smoothstep(PATH_PHASES.ascentStart, PATH_PHASES.ascentEnd, progress);
  const o = lerpTuple(ASCENT_OFFSET_START, ASCENT_OFFSET_END, s);
  const lookHeight = 1.3 + (CLIMBER_AIM_HEIGHT - 1.3) * s;
  return key(
    progress,
    3,
    `ascent ${progress.toFixed(2)}`,
    routeOffset(progress, o[0], o[1], o[2]),
    routeOffset(progress, 0, lookHeight, 0),
  );
}

const ASCENT_KEYS: CameraKeyframe[] = [];
for (let p = 0.3; p < 0.4449; p += 0.02) ASCENT_KEYS.push(ascentKey(Math.round(p * 1000) / 1000));

/* ---------------------------------------------------------------------------
 * The authored timeline.
 * ------------------------------------------------------------------------- */

/** Final "last pull" composition: the climber before the next mountain. */
export const LAST_PULL_POSITION: Vec3Tuple = [0, 56.5, -27.0];
export const LAST_PULL_LOOK_AT: Vec3Tuple = [0, 62, -120];

export const CAMERA_HOLD = {
  /** The pose is frozen from here (end of the last pull) … */
  start: ENDING.heroPullEnd,
  /** … to the end of the 3D track. */
  end: 1,
} as const;

export const CAMERA_KEYFRAMES: readonly CameraKeyframe[] = [
  /* Scene 1 (0.00–0.08) — dolly through the parting cloud curtain. */
  key(0.0, 0, 'opening above the clouds', [0, 3, 24], [0, 1.4, 0], { settle: true }),
  key(0.04, 0, 'through the curtain', [0, 2.55, 15.4], [0, 1.4, 0]),
  key(0.08, 0, 'arrive at base camp', [0, 2.2, 7.5], [0, 1.4, 0]),

  /* Scenes 2–3 (0.08–0.28) — heroic base-camp framing, slow orbit while gearing up. */
  key(0.12, 1, 'heroic base camp', [2.4, 1.7, 5.2], [0, 1.3, 0]),
  key(0.18, 2, 'gear-up orbit', [1.72, 1.66, 5.56], [0, 1.3, 0]),
  key(0.23, 2, 'gear-up orbit', [0.84, 1.72, 5.86], [0, 1.3, 0]),
  key(0.28, 3, 'ready to climb', [0, 1.8, 6.0], [0, 1.3, 0]),

  /* Scene 4 (0.28–0.45) — parallel tracking up cliff 1. */
  ...ASCENT_KEYS,
  trackKey(0.45, 4, 'ledge 1 — chasm 1 takeoff', [3.5, 18.5, -2.0]),

  /* Scene 5 (0.45–0.62) — swing out to a side profile of the chasm-1 jump, then crane up the pillar. */
  trackKey(0.465, 4, 'swing to side profile', [7.2, 19.9, -4.6], { fov: 43 }),
  trackKey(0.48, 4, 'side profile — jump', [9.5, 21.0, -9.0], { fov: 44, rollDeg: -1.2 }),
  trackKey(0.5, 4, 'side profile — apex', [9.9, 22.0, -10.5], { fov: 44, rollDeg: -1.0 }),
  trackKey(0.52, 4, 'side profile — landing', [10.2, 23.2, -11.7], { fov: 44 }),
  trackKey(0.545, 4, 'pillar climb', [9.9, 25.4, -12.3], { fov: 43 }),
  trackKey(0.57, 4, 'pillar climb', [9.2, 28.0, -12.8], { fov: 43 }),
  trackKey(0.595, 4, 'crane up the pillar', [7.4, 31.4, -13.4], { fov: 43 }),

  /* Scene 6 (0.62–0.78) — dramatic low-angle tracking of the chasm-2 leap, the catch and the scramble. */
  trackKey(0.62, 5, 'pillar top — chasm 2 takeoff', [4.0, 36.0, -14.0], { fov: 44 }),
  trackKey(0.64, 5, 'leap — low angle', [2.2, 36.5, -14.6], { fov: 46, rollDeg: 1.5 }),
  trackKey(0.66, 5, 'leap — apex', [-0.5, 38.4, -15.4], { fov: 47, rollDeg: 2.4 }),
  trackKey(0.68, 5, 'leap — descent', [-3.6, 40.1, -17.4], { fov: 46, rollDeg: 1.6 }),
  trackKey(0.7, 5, 'the catch', [-6.6, 41.3, -19.1], { fov: 45, rollDeg: 0.6 }),
  trackKey(0.72, 5, 'hanging on — axes fall', [-8.0, 42.0, -20.0], { fov: 44 }),
  trackKey(0.74, 5, 'scramble', [-6.6, 46.4, -22.6], { fov: 43 }),
  trackKey(0.76, 5, 'scramble to the top', [-2.4, 52.0, -25.6], { fov: 42 }),

  /* Scene 7 (0.78–0.86) — summit, front three-quarter, slow drift. */
  key(0.78, 6, 'summit — front three-quarter', [2.8, 56.8, -28.5], [0.8, 56.0, -35.0]),
  key(0.82, 6, 'summit drift', [2.55, 56.85, -28.75], [0.75, 56.02, -35.0]),
  key(0.855, 6, 'summit drift', [2.2, 56.88, -29.05], [0.7, 56.04, -35.0]),

  /* Scene 8 (0.86–0.92) — over-the-shoulder reveal of the next mountain. */
  key(0.885, 7, 'over the shoulder — next mountain', [-1.2, 56.7, -32.2], HORIZON_AIM),
  key(0.905, 7, 'over the shoulder — breathe in', [-1.1, 56.71, -32.35], HORIZON_AIM),
  key(0.92, 8, 'last pull begins', [-0.98, 56.72, -32.45], HORIZON_AIM),

  /* 0.92–0.945 — the last pull: standing before the next big mountain. Held to 1.0. */
  key(CAMERA_HOLD.start, 8, 'last pull — ready for another journey', LAST_PULL_POSITION, LAST_PULL_LOOK_AT, {
    settle: true,
  }),
];

/* ==========================================================================
 * Monotone piecewise-cubic Hermite interpolation (Fritsch–Carlson / PCHIP).
 * Never overshoots between knots; flat knots get a zero slope.
 * ========================================================================== */

class MonotoneCubic {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  private readonly ms: Float64Array;

  constructor(xs: ArrayLike<number>, ys: ArrayLike<number>, flat?: ArrayLike<boolean>) {
    const n = xs.length;
    if (n < 2 || ys.length !== n) throw new Error('MonotoneCubic needs at least two matching knots');
    this.xs = Float64Array.from(xs);
    this.ys = Float64Array.from(ys);
    this.ms = new Float64Array(n);
    const h = new Float64Array(n - 1);
    const d = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i += 1) {
      h[i] = this.xs[i + 1] - this.xs[i];
      if (!(h[i] > 0)) throw new Error(`MonotoneCubic knots must strictly increase (index ${i})`);
      d[i] = (this.ys[i + 1] - this.ys[i]) / h[i];
    }
    if (n === 2) {
      this.ms[0] = d[0];
      this.ms[1] = d[0];
    } else {
      for (let i = 1; i < n - 1; i += 1) {
        const a = d[i - 1];
        const b = d[i];
        if (a * b <= 0) {
          this.ms[i] = 0;
        } else {
          const w1 = 2 * h[i] + h[i - 1];
          const w2 = h[i] + 2 * h[i - 1];
          this.ms[i] = (w1 + w2) / (w1 / a + w2 / b);
        }
      }
      this.ms[0] = MonotoneCubic.endSlope(h[0], h[1], d[0], d[1]);
      this.ms[n - 1] = MonotoneCubic.endSlope(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
    }
    if (flat) {
      for (let i = 0; i < n; i += 1) if (flat[i]) this.ms[i] = 0;
    }
  }

  /** Shape-preserving three-point end slope (as in MATLAB's pchip). */
  private static endSlope(h0: number, h1: number, d0: number, d1: number): number {
    let m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if (Math.sign(m) !== Math.sign(d0)) m = 0;
    else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(m) > Math.abs(3 * d0)) m = 3 * d0;
    return m;
  }

  /** Index of the segment containing x (clamped to [0, n − 2]). */
  segment(x: number): number {
    const xs = this.xs;
    let lo = 0;
    let hi = xs.length - 2;
    if (x <= xs[0]) return 0;
    if (x >= xs[hi]) return hi;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  evaluate(x: number): number {
    const xs = this.xs;
    const n = xs.length;
    if (x <= xs[0]) return this.ys[0];
    if (x >= xs[n - 1]) return this.ys[n - 1];
    const i = this.segment(x);
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * this.ys[i] +
      (t3 - 2 * t2 + t) * h * this.ms[i] +
      (-2 * t3 + 3 * t2) * this.ys[i + 1] +
      (t3 - t2) * h * this.ms[i + 1]
    );
  }
}

/* ==========================================================================
 * Progress-keyed centripetal Catmull-Rom curve.
 * ========================================================================== */

/** three.js's centripetal knot interval between two points (incl. its repeated-point guard). */
function centripetalInterval(a: THREE.Vector3, b: THREE.Vector3): number {
  const dt = Math.pow(a.distanceToSquared(b), 0.25);
  return dt < 1e-4 ? 1 : dt;
}

class ProgressKeyedCurve {
  readonly curve: THREE.CatmullRomCurve3;
  private readonly knots: Float64Array;
  private readonly map: MonotoneCubic;

  constructor(points: THREE.Vector3[], progress: ArrayLike<number>, settle: ArrayLike<boolean>, name: string) {
    const n = points.length;
    for (let i = 0; i < n - 1; i += 1) {
      if (points[i].distanceToSquared(points[i + 1]) < 1e-10) {
        throw new Error(`${name}: keyframes ${i} and ${i + 1} coincide; merge them or move one`);
      }
    }
    this.curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    this.knots = new Float64Array(n);
    for (let i = 1; i < n; i += 1) this.knots[i] = this.knots[i - 1] + centripetalInterval(points[i - 1], points[i]);
    this.map = new MonotoneCubic(progress, this.knots, settle);
  }

  /** getPoint() parameter for a progress value; exactly i/(n−1) at keyframe i. */
  parameterAt(progress: number): number {
    const n = this.knots.length;
    const p = clamp01(progress);
    const xs = this.map.xs;
    if (p <= xs[0]) return 0;
    if (p >= xs[n - 1]) return 1;
    // Exact hit on a keyframe's progress → exact knot parameter.
    const seg = this.map.segment(p);
    if (p === xs[seg]) return seg / (n - 1);
    const tau = this.map.evaluate(p);
    const knots = this.knots;
    let i = seg;
    while (i > 0 && tau < knots[i]) i -= 1;
    while (i < n - 2 && tau >= knots[i + 1]) i += 1;
    const u = clamp01((tau - knots[i]) / (knots[i + 1] - knots[i]));
    return (i + u) / (n - 1);
  }

  sample(progress: number, out: THREE.Vector3): THREE.Vector3 {
    return this.curve.getPoint(this.parameterAt(progress), out);
  }
}

/* ==========================================================================
 * Build the rig from the keyframes (once, at module load).
 * ========================================================================== */

const KEY_COUNT = CAMERA_KEYFRAMES.length;
const KEY_PROGRESS = CAMERA_KEYFRAMES.map((k) => k.progress);
const KEY_SETTLE = CAMERA_KEYFRAMES.map((k) => k.settle);

const positionPoints = CAMERA_KEYFRAMES.map((k) => new THREE.Vector3(k.position[0], k.position[1], k.position[2]));
const aimPoints = CAMERA_KEYFRAMES.map((k, i) =>
  new THREE.Vector3(k.lookAt[0], k.lookAt[1], k.lookAt[2]).sub(positionPoints[i]).normalize(),
);
const focusLogs = CAMERA_KEYFRAMES.map((k, i) =>
  Math.log(new THREE.Vector3(k.lookAt[0], k.lookAt[1], k.lookAt[2]).distanceTo(positionPoints[i])),
);

const positionCurve = new ProgressKeyedCurve(positionPoints, KEY_PROGRESS, KEY_SETTLE, 'cameraPath');
const aimCurve = new ProgressKeyedCurve(aimPoints, KEY_PROGRESS, KEY_SETTLE, 'lookAtPath');
const focusCurve = new MonotoneCubic(KEY_PROGRESS, focusLogs);
const fovCurve = new MonotoneCubic(
  KEY_PROGRESS,
  CAMERA_KEYFRAMES.map((k) => k.fov),
);
const rollCurve = new MonotoneCubic(
  KEY_PROGRESS,
  CAMERA_KEYFRAMES.map((k) => k.roll),
);

/** Centripetal Catmull-Rom through the keyframe camera positions. */
export const cameraPath: THREE.CatmullRomCurve3 = positionCurve.curve;

/**
 * Centripetal Catmull-Rom through the keyframe VIEW DIRECTIONS (unit vectors,
 * camera → look-at). Renormalise a sampled point to get the aim direction.
 */
export const lookAtPath: THREE.CatmullRomCurve3 = aimCurve.curve;

/** Number of keyframes (points on both splines). */
export const CAMERA_KEYFRAME_COUNT = KEY_COUNT;

/** cameraPath.getPoint() parameter for a progress value. */
export function cameraPathParameterAt(progress: number): number {
  return positionCurve.parameterAt(progress);
}

/** lookAtPath.getPoint() parameter for a progress value. */
export function lookAtPathParameterAt(progress: number): number {
  return aimCurve.parameterAt(progress);
}

/** Unit view direction at a progress value (zero allocation). */
export function cameraAimAt(progress: number, outDirection: THREE.Vector3): THREE.Vector3 {
  aimCurve.sample(progress, outDirection);
  const len = outDirection.length();
  if (len < 1e-6) return outDirection.set(0, 0, -1);
  return outDirection.multiplyScalar(1 / len);
}

/** Distance from the camera to its look-at point at a progress value. */
export function cameraFocusDistanceAt(progress: number): number {
  return Math.exp(focusCurve.evaluate(clamp01(progress)));
}

/** Vertical field of view (degrees) at a progress value. */
export function cameraFovAt(progress: number): number {
  return fovCurve.evaluate(clamp01(progress));
}

/** Dutch roll (radians) at a progress value. */
export function cameraRollAt(progress: number): number {
  return rollCurve.evaluate(clamp01(progress));
}

/**
 * Samples the rig at `progress` (clamped to 0 → 1) without allocating:
 * `outPosition` ← camera position, `outLookAt` ← look-at point
 * (position + aim direction × focus distance). Exactly the authored pose at
 * every keyframe; the final pose is held from CAMERA_HOLD.start to 1.0.
 */
export function sampleCameraRig(progress: number, outPosition: THREE.Vector3, outLookAt: THREE.Vector3): void {
  const p = clamp01(progress);
  positionCurve.sample(p, outPosition);
  cameraAimAt(p, outLookAt);
  outLookAt.multiplyScalar(cameraFocusDistanceAt(p)).add(outPosition);
}

/* ==========================================================================
 * Rig timing shared with CameraRig (pure numbers, Node-safe).
 * ========================================================================== */

export const CAMERA_RIG_TIMING = {
  /** Handheld breathing fades out over this window and is exactly zero from `handheldOff`. */
  handheldFadeStart: 0.895,
  handheldOff: 0.915,
  /** The paper hits the lens: tiny damped pitch nudge (< 0.5°). */
  impactStart: ENDING.paperStick - 0.003,
  impactPeak: ENDING.paperStick + 0.001,
  impactEnd: ENDING.paperStick + 0.011,
  impactPitchDeg: 0.3,
} as const;
