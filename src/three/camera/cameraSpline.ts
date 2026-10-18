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
 *                 keeps overshoot small even where keyframe spacing changes a
 *                 lot (fast swings next to slow drifts).
 *   lookAtPath  — centripetal Catmull-Rom through the keyframe VIEW
 *                 DIRECTIONS: unit vectors (lookAt − position)/|…|, i.e.
 *                 points on the unit sphere around the origin.
 *
 * Why directions: the Scene 8 aim (HORIZON_AIM) is ~158 units from the camera
 * while its neighbours are 3–8 units away. Interpolating look-at POINTS would
 * race the aim towards the far point within the first few percent of the
 * segment (a whip pan). Interpolating directions spreads the angular change
 * evenly over the segment however far the subject is. The sampled direction is
 * renormalised, and the look-at point handed to callers is
 * position + direction × focusDistance, where focusDistance is the keyframe
 * |lookAt − position| interpolated in log space — so at every keyframe the
 * authored look-at point comes back exactly.
 *
 * Subject tracking: keyframes made with trackKey() aim at the climber —
 * subjectAt(p) = protagonistPositionAt(p) + [0, 1.2, 0], lightly smoothed (a
 * 5-tap binomial filter over ±0.005 progress, tabulated at load removes the velocity kinks at the
 * route's phase boundaries). Between two tracked keyframes the spline direction
 * is blended towards the live subject direction by a monotone-interpolated
 * track weight, so the climber stays centred through jumps the keyframes alone
 * could only approximate. At tracked keyframes the two coincide exactly.
 *
 * Progress → curve parameter (piecewise, exact at every keyframe):
 *   three's non-closed CatmullRomCurve3.getPoint(t) maps t·(n−1) uniformly to
 *   segments, so keyframe i sits at t = i/(n−1). Inside a segment three's
 *   centripetal curve is a cubic in the local weight u that is C¹ in the
 *   centripetal knot parameter τ (cumulative |Pᵢ₊₁ − Pᵢ|^½), not in u. So
 *   progress is first mapped to τ with a monotone piecewise-cubic Hermite
 *   (Fritsch–Carlson / PCHIP) through (progressᵢ, τᵢ), then τ → (i + u)/(n−1).
 *   Every keyframe is reached exactly at its progress, the camera never moves
 *   backwards along the path, and its velocity is continuous across keyframes.
 *   Keyframes flagged `settle` get a zero slope there (ease in/out).
 *
 * Aspect: narrow (portrait) viewports only see a ~20° horizontal field at fov
 * 42, so a few keyframes carry a portrait variant (the over-the-shoulder shot
 * moves directly behind the climber). Separate portrait splines are built and
 * blended by aspect; every other keyframe is identical in both.
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
  /** Pose used on portrait viewports (equal to position / lookAt unless overridden). */
  readonly portraitPosition: Vec3Tuple;
  readonly portraitLookAt: Vec3Tuple;
  /** Vertical field of view, degrees. */
  readonly fov: number;
  /** Dutch roll about the view axis, radians (positive = counter-clockwise on screen). */
  readonly roll: number;
  /** 1 when the look-at is the climber (subjectAt), 0 for an authored look-at. */
  readonly track: number;
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
  portraitPosition?: Vec3Tuple;
  portraitLookAt?: Vec3Tuple;
}

const BASE_FOV = CAMERA_CLIP.fov;

/** Chest height on the ~1.8 tall climber that tracking shots aim at. */
export const SUBJECT_AIM_HEIGHT = 1.2;
/** Spacing (progress) of the taps of the subject smoothing filter. */
const SUBJECT_SMOOTH_STEP = 0.0025;
const SUBJECT_WEIGHTS = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16] as const;
/** The smoothed subject path is tabulated once (zero-allocation, cheap lookups at runtime). */
const SUBJECT_TABLE_STEPS = 4000;

const _route = new THREE.Vector3();

function smoothedSubject(progress: number, out: THREE.Vector3): THREE.Vector3 {
  out.set(0, 0, 0);
  for (let k = 0; k < SUBJECT_WEIGHTS.length; k += 1) {
    protagonistPositionAt(progress + (k - 2) * SUBJECT_SMOOTH_STEP, _route);
    out.addScaledVector(_route, SUBJECT_WEIGHTS[k]);
  }
  out.y += SUBJECT_AIM_HEIGHT;
  return out;
}

const SUBJECT_TABLE = (() => {
  const table = new Float64Array((SUBJECT_TABLE_STEPS + 1) * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i <= SUBJECT_TABLE_STEPS; i += 1) {
    smoothedSubject(i / SUBJECT_TABLE_STEPS, v);
    table[i * 3] = v.x;
    table[i * 3 + 1] = v.y;
    table[i * 3 + 2] = v.z;
  }
  return table;
})();

/**
 * Point the tracking shots aim at: the climber's chest
 * (protagonistPositionAt + [0, 1.2, 0]) smoothed over ±0.005 progress.
 * Zero allocation.
 */
export function subjectAt(progress: number, out: THREE.Vector3): THREE.Vector3 {
  const x = clamp01(progress) * SUBJECT_TABLE_STEPS;
  const i = Math.min(SUBJECT_TABLE_STEPS - 1, Math.floor(x));
  const f = x - i;
  const a = i * 3;
  const b = a + 3;
  const t = SUBJECT_TABLE;
  return out.set(t[a] + (t[b] - t[a]) * f, t[a + 1] + (t[b + 1] - t[a + 1]) * f, t[a + 2] + (t[b + 2] - t[a + 2]) * f);
}

const _subject = new THREE.Vector3();

function subjectTuple(progress: number): Vec3Tuple {
  subjectAt(progress, _subject);
  return [_subject.x, _subject.y, _subject.z];
}

function routeOffset(progress: number, dx: number, dy: number, dz: number): Vec3Tuple {
  protagonistPositionAt(progress, _route);
  return [_route.x + dx, _route.y + dy, _route.z + dz];
}

function lerpTuple(a: Vec3Tuple, b: Vec3Tuple, t: number): Vec3Tuple {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function makeKey(
  progress: number,
  scene: number,
  label: string,
  position: Vec3Tuple,
  lookAt: Vec3Tuple,
  track: number,
  options: KeyframeOptions,
): CameraKeyframe {
  return {
    progress,
    position,
    lookAt,
    portraitPosition: options.portraitPosition ?? position,
    portraitLookAt: options.portraitLookAt ?? lookAt,
    fov: options.fov ?? BASE_FOV,
    roll: (options.rollDeg ?? 0) * DEG,
    track,
    settle: options.settle ?? false,
    scene,
    label,
  };
}

/** Keyframe with an authored look-at point. */
function key(
  progress: number,
  scene: number,
  label: string,
  position: Vec3Tuple,
  lookAt: Vec3Tuple,
  options: KeyframeOptions = {},
): CameraKeyframe {
  return makeKey(progress, scene, label, position, lookAt, 0, options);
}

/** Keyframe whose look-at follows the climber (subjectAt). */
function trackKey(
  progress: number,
  scene: number,
  label: string,
  position: Vec3Tuple,
  options: KeyframeOptions = {},
): CameraKeyframe {
  const subject = subjectTuple(progress);
  return makeKey(progress, scene, label, position, subject, 1, { ...options, portraitLookAt: subject });
}

/* ---------------------------------------------------------------------------
 * Scene 4 — parallel tracking up cliff 1. The camera rides alongside the
 * climber with an offset that slides from the base-camp framing [0,1.8,6]
 * to the ledge framing [3.5,0.5,6] (→ [3.5,18.5,-2] at 0.45), so the climber
 * stays planted in frame while the wall streams past.
 * ------------------------------------------------------------------------- */

const ASCENT_OFFSET_START: Vec3Tuple = [0, 1.8, 6.0];
const ASCENT_OFFSET_END: Vec3Tuple = [3.5, 0.5, 6.0];
const ASCENT_KEY_PROGRESS = [0.3, 0.32, 0.34, 0.36, 0.38, 0.4, 0.42] as const;

function ascentKey(progress: number): CameraKeyframe {
  const s = smoothstep(PATH_PHASES.ascentStart, PATH_PHASES.ascentEnd, progress);
  const o = lerpTuple(ASCENT_OFFSET_START, ASCENT_OFFSET_END, s);
  return trackKey(progress, 3, `ascent ${progress.toFixed(2)}`, routeOffset(progress, o[0], o[1], o[2]));
}

/* ---------------------------------------------------------------------------
 * The authored timeline.
 * ------------------------------------------------------------------------- */

/** Final "last pull" composition: the climber standing before the next mountain. */
export const LAST_PULL_POSITION: Vec3Tuple = [0, 56.5, -27.0];
export const LAST_PULL_LOOK_AT: Vec3Tuple = [0, 62, -120];

export const CAMERA_HOLD = {
  /** The pose is frozen from here (end of the last pull) … */
  start: ENDING.heroPullEnd,
  /** … to the end of the 3D track. */
  end: 1,
} as const;

export const CAMERA_KEYFRAMES: readonly CameraKeyframe[] = [
  /* Scene 1 (0.00–0.08) — dolly through the parting cloud curtain onto base camp. */
  key(0.0, 0, 'opening above the clouds', [0, 3, 24], [0, 1.4, 0], { settle: true }),
  key(0.04, 0, 'through the curtain', [0, 2.55, 15.4], [0, 1.4, 0]),
  key(0.08, 0, 'arrive at base camp', [0, 2.2, 7.5], [0, 1.4, 0]),

  /* Scenes 2–3 (0.08–0.28) — heroic base-camp framing, slow orbit while gearing up. */
  key(0.1, 1, 'settle into base camp', [0.8, 1.97, 6.45], [0, 1.34, 0]),
  key(0.125, 1, 'heroic base camp', [2.4, 1.7, 5.2], [0, 1.3, 0]),
  key(0.18, 2, 'gear-up orbit', [1.72, 1.66, 5.56], [0, 1.3, 0]),
  key(0.23, 2, 'gear-up orbit', [0.84, 1.72, 5.86], [0, 1.3, 0]),
  key(0.28, 3, 'ready to climb', [0, 1.8, 6.0], [0, 1.3, 0]),

  /* Scene 4 (0.28–0.45) — parallel tracking up cliff 1. */
  ...ASCENT_KEY_PROGRESS.map(ascentKey),
  trackKey(0.45, 4, 'ledge 1 — chasm 1 takeoff', [3.5, 18.5, -2.0]),

  /* Scene 5 (0.45–0.62) — swing out to a side profile of the chasm-1 jump, then rise up the pillar. */
  trackKey(0.465, 4, 'swing to side profile', [6.9, 19.85, -4.3], { fov: 43 }),
  trackKey(0.485, 4, 'side profile — jump apex', [9.5, 21.0, -9.0], { fov: 44, rollDeg: -1.2 }),
  trackKey(0.505, 4, 'side profile — descent', [9.95, 22.2, -10.8], { fov: 44, rollDeg: -0.8 }),
  trackKey(0.525, 4, 'side profile — landing', [10.2, 23.6, -11.8], { fov: 44 }),
  trackKey(0.55, 4, 'pillar climb', [9.8, 25.9, -12.4], { fov: 43 }),
  trackKey(0.575, 4, 'pillar climb', [9.1, 28.6, -12.8], { fov: 43 }),
  trackKey(0.6, 4, 'pillar top-out', [8.2, 31.0, -12.9], { fov: 43 }),

  /* Scene 6 (0.62–0.78) — dramatic low-angle tracking of the chasm-2 leap, the catch and the scramble. */
  trackKey(0.62, 5, 'chasm 2 takeoff', [7.4, 32.4, -11.4], { fov: 44 }),
  trackKey(0.64, 5, 'leap — rising', [4.7, 34.6, -13.3], { fov: 46, rollDeg: 1.4 }),
  trackKey(0.655, 5, 'leap — low angle', [4.0, 36.0, -14.0], { fov: 47, rollDeg: 2.2 }),
  trackKey(0.67, 5, 'leap — overhead', [1.6, 37.6, -15.6], { fov: 47, rollDeg: 2.0 }),
  trackKey(0.685, 5, 'leap — descent', [-2.4, 39.4, -17.6], { fov: 46, rollDeg: 1.2 }),
  trackKey(0.7, 5, 'the catch', [-6.0, 41.0, -19.3], { fov: 45, rollDeg: 0.4 }),
  trackKey(0.715, 5, 'hanging on — axes fall', [-8.0, 42.0, -20.0], { fov: 44 }),
  trackKey(0.735, 5, 'scramble', [-6.9, 47.0, -22.0], { fov: 43 }),
  trackKey(0.755, 5, 'scramble to the top', [-3.0, 52.6, -25.0], { fov: 42 }),
  trackKey(0.77, 5, 'cresting the summit', [1.2, 55.6, -27.6]),

  /* Scene 7 (0.78–0.86) — summit, front three-quarter, slow drift. */
  key(0.78, 6, 'summit — front three-quarter', [2.8, 56.8, -28.5], [0.8, 56.0, -35.0], {
    portraitLookAt: [0.35, 56.0, -35.0],
  }),
  key(0.82, 6, 'summit drift', [2.55, 56.85, -28.75], [0.75, 56.02, -35.0], {
    portraitLookAt: [0.3, 56.02, -35.0],
  }),
  key(0.855, 6, 'summit drift', [2.2, 56.88, -29.05], [0.7, 56.04, -35.0], {
    portraitLookAt: [0.25, 56.04, -35.0],
  }),

  /* Scene 8 (0.86–0.92) — over-the-shoulder reveal of the next mountain. */
  key(0.885, 7, 'over the shoulder — next mountain', [-1.2, 56.7, -32.2], HORIZON_AIM, {
    portraitPosition: [-0.14, 56.85, -31.6],
  }),
  key(0.905, 7, 'over the shoulder — breathe in', [-1.1, 56.71, -32.35], HORIZON_AIM, {
    portraitPosition: [-0.13, 56.86, -31.72],
  }),
  key(0.92, 8, 'last pull begins', [-0.98, 56.72, -32.45], HORIZON_AIM, {
    portraitPosition: [-0.12, 56.86, -31.8],
  }),

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

const KEY_PROGRESS = CAMERA_KEYFRAMES.map((k) => k.progress);
const KEY_SETTLE = CAMERA_KEYFRAMES.map((k) => k.settle);

const toVector = (t: Vec3Tuple): THREE.Vector3 => new THREE.Vector3(t[0], t[1], t[2]);

interface RigVariant {
  position: ProgressKeyedCurve;
  aim: ProgressKeyedCurve;
  focus: MonotoneCubic;
}

function buildVariant(portrait: boolean): RigVariant {
  const name = portrait ? ' (portrait)' : '';
  const positions = CAMERA_KEYFRAMES.map((k) => toVector(portrait ? k.portraitPosition : k.position));
  const looks = CAMERA_KEYFRAMES.map((k) => toVector(portrait ? k.portraitLookAt : k.lookAt));
  const aims = looks.map((l, i) => l.clone().sub(positions[i]).normalize());
  const focusLogs = looks.map((l, i) => Math.log(l.distanceTo(positions[i])));
  return {
    position: new ProgressKeyedCurve(positions, KEY_PROGRESS, KEY_SETTLE, `cameraPath${name}`),
    aim: new ProgressKeyedCurve(aims, KEY_PROGRESS, KEY_SETTLE, `lookAtPath${name}`),
    focus: new MonotoneCubic(KEY_PROGRESS, focusLogs),
  };
}

const LANDSCAPE = buildVariant(false);
const PORTRAIT = buildVariant(true);
const trackCurve = new MonotoneCubic(
  KEY_PROGRESS,
  CAMERA_KEYFRAMES.map((k) => k.track),
);
const fovCurve = new MonotoneCubic(
  KEY_PROGRESS,
  CAMERA_KEYFRAMES.map((k) => k.fov),
);
const rollCurve = new MonotoneCubic(
  KEY_PROGRESS,
  CAMERA_KEYFRAMES.map((k) => k.roll),
);

/** Centripetal Catmull-Rom through the keyframe camera positions (landscape). */
export const cameraPath: THREE.CatmullRomCurve3 = LANDSCAPE.position.curve;

/**
 * Centripetal Catmull-Rom through the keyframe VIEW DIRECTIONS (unit vectors,
 * camera → look-at; landscape). Renormalise a sampled point to get the aim.
 */
export const lookAtPath: THREE.CatmullRomCurve3 = LANDSCAPE.aim.curve;

/** Portrait variants (identical to the above except at the keyframes that override them). */
export const portraitCameraPath: THREE.CatmullRomCurve3 = PORTRAIT.position.curve;
export const portraitLookAtPath: THREE.CatmullRomCurve3 = PORTRAIT.aim.curve;

/** Viewport aspect assumed when none is given (16:9). */
export const DEFAULT_ASPECT = 16 / 9;

/**
 * Weight of the portrait variant for a viewport aspect (width / height):
 * 0 at ≥ 1.2 (landscape and square-ish), 1 at ≤ 0.7 (phones in portrait).
 */
export function portraitWeight(aspect: number): number {
  return 1 - smoothstep(0.7, 1.2, aspect);
}

/** cameraPath.getPoint() parameter for a progress value. */
export function cameraPathParameterAt(progress: number): number {
  return LANDSCAPE.position.parameterAt(progress);
}

/** lookAtPath.getPoint() parameter for a progress value. */
export function lookAtPathParameterAt(progress: number): number {
  return LANDSCAPE.aim.parameterAt(progress);
}

/** Weight (0 → 1) with which the aim follows the live climber at a progress value. */
export function cameraTrackWeightAt(progress: number): number {
  return clamp01(trackCurve.evaluate(clamp01(progress)));
}

/** Vertical field of view (degrees) at a progress value. */
export function cameraFovAt(progress: number): number {
  return fovCurve.evaluate(clamp01(progress));
}

/** Dutch roll (radians) at a progress value. */
export function cameraRollAt(progress: number): number {
  return rollCurve.evaluate(clamp01(progress));
}

const _posB = new THREE.Vector3();
const _dirA = new THREE.Vector3();
const _dirB = new THREE.Vector3();
const _toSubject = new THREE.Vector3();
const _aimPosition = new THREE.Vector3();

function normalizeOr(v: THREE.Vector3): THREE.Vector3 {
  const len = v.length();
  return len < 1e-9 ? v.set(0, 0, -1) : v.multiplyScalar(1 / len);
}

/** Samples one variant: position, unit aim and focus distance (returned). */
function sampleVariant(variant: RigVariant, p: number, outPosition: THREE.Vector3, outDirection: THREE.Vector3): number {
  variant.position.sample(p, outPosition);
  normalizeOr(variant.aim.sample(p, outDirection));
  return Math.exp(variant.focus.evaluate(p));
}

/**
 * Samples the rig at `progress` (clamped to 0 → 1) without allocating:
 * `outPosition` ← camera position, `outLookAt` ← look-at point
 * (position + aim direction × focus distance). `aspect` (viewport
 * width / height, default 16:9) blends in the portrait framing. Exactly the
 * authored pose at every keyframe; the final pose is held from
 * CAMERA_HOLD.start to 1.0.
 */
export function sampleCameraRig(
  progress: number,
  outPosition: THREE.Vector3,
  outLookAt: THREE.Vector3,
  aspect: number = DEFAULT_ASPECT,
): void {
  const p = clamp01(progress);
  const w = portraitWeight(aspect);
  let focus: number;
  if (w <= 0) {
    focus = sampleVariant(LANDSCAPE, p, outPosition, _dirA);
  } else if (w >= 1) {
    focus = sampleVariant(PORTRAIT, p, outPosition, _dirA);
  } else {
    const fa = sampleVariant(LANDSCAPE, p, outPosition, _dirA);
    const fb = sampleVariant(PORTRAIT, p, _posB, _dirB);
    outPosition.lerp(_posB, w);
    normalizeOr(_dirA.lerp(_dirB, w));
    focus = Math.exp(Math.log(fa) + (Math.log(fb) - Math.log(fa)) * w);
  }

  const track = cameraTrackWeightAt(p);
  if (track > 0) {
    subjectAt(p, _toSubject).sub(outPosition);
    const subjectDistance = _toSubject.length();
    if (subjectDistance > 1e-6) {
      _toSubject.multiplyScalar(1 / subjectDistance);
      normalizeOr(_dirA.lerp(_toSubject, track));
      focus += (subjectDistance - focus) * track;
    }
  }
  outLookAt.copy(outPosition).addScaledVector(_dirA, focus);
}

/** Unit view direction at a progress value (zero allocation). */
export function cameraAimAt(progress: number, outDirection: THREE.Vector3, aspect: number = DEFAULT_ASPECT): THREE.Vector3 {
  sampleCameraRig(progress, _aimPosition, outDirection, aspect);
  return normalizeOr(outDirection.sub(_aimPosition));
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
