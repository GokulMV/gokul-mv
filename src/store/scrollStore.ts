import * as THREE from 'three';

/* ==========================================================================
 * Scroll store — a mutable singleton.
 *
 * Lenis writes `rawProgress` at display refresh rate (up to 120Hz) and the
 * store's `tick()` derives every other value. Nothing here is React state:
 * R3F `useFrame` callbacks and DOM `requestAnimationFrame` loops read the
 * fields directly, so scrolling never triggers a React re-render.
 * ========================================================================== */

export type GpuTier = 0 | 1 | 2 | 3;

export type SceneId =
  | 'clouds'
  | 'baseCamp'
  | 'equipped'
  | 'firstAscent'
  | 'firstChasm'
  | 'extremeLeap'
  | 'summit'
  | 'horizon'
  | 'paperThrow'
  | 'blownAway';

export interface SceneDefinition {
  index: number;
  id: SceneId;
  title: string;
  start: number;
  end: number;
}

/** Exact normalized timeline over the 1400vh scroll track. */
export const SCENES: readonly SceneDefinition[] = [
  { index: 0, id: 'clouds', title: 'Volumetric Clouds & Welcome', start: 0.0, end: 0.08 },
  { index: 1, id: 'baseCamp', title: 'Base Camp', start: 0.08, end: 0.18 },
  { index: 2, id: 'equipped', title: 'Getting Equipped', start: 0.18, end: 0.28 },
  { index: 3, id: 'firstAscent', title: 'First Ascent', start: 0.28, end: 0.45 },
  { index: 4, id: 'firstChasm', title: 'First Chasm Jump', start: 0.45, end: 0.62 },
  { index: 5, id: 'extremeLeap', title: 'Extreme Chasm Leap', start: 0.62, end: 0.78 },
  { index: 6, id: 'summit', title: 'The Summit', start: 0.78, end: 0.86 },
  { index: 7, id: 'horizon', title: 'Horizon Reveal', start: 0.86, end: 0.92 },
  { index: 8, id: 'paperThrow', title: 'Paper Throw & Returning Clouds', start: 0.92, end: 0.98 },
  { index: 9, id: 'blownAway', title: 'Blown Away into Nothingness', start: 0.98, end: 1.0 },
] as const;

export const SCROLL_TRACK_VH = 1400;
export const TOTAL_GEAR = 4;

export type GearId = 'backpack' | 'rope' | 'iceAxes' | 'harness';

/** Order in which gear locks on during Scene 3 (0.18 – 0.28). */
export const GEAR_EQUIP_ORDER: readonly GearId[] = ['backpack', 'rope', 'iceAxes', 'harness'];

/** Progress at which each piece of gear locks onto the character. */
export const GEAR_EQUIP_AT: Readonly<Record<GearId, number>> = {
  backpack: 0.195,
  rope: 0.215,
  iceAxes: 0.235,
  harness: 0.255,
};

/** Progress at which each piece of gear detaches and falls away. */
export const GEAR_DROP_AT: Readonly<Record<GearId, number>> = {
  backpack: 0.42,
  rope: 0.56,
  iceAxes: 0.72,
  harness: 0.72,
};

/* ---------------------------------------------------------------------------
 * Math helpers
 * ------------------------------------------------------------------------- */

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Maps `value` from [inMin, inMax] to [outMin, outMax]. Clamped by default. */
export function remap(
  value: number,
  inMin: number,
  inMax: number,
  outMin = 0,
  outMax = 1,
  clamp = true,
): number {
  if (inMax === inMin) return value >= inMax ? outMax : outMin;
  let t = (value - inMin) / (inMax - inMin);
  if (clamp) t = clamp01(t);
  return outMin + (outMax - outMin) * t;
}

/** Hermite smoothstep between two edges (GLSL semantics). */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(edge0 === edge1 ? (x >= edge1 ? 1 : 0) : (x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Ken Perlin's smootherstep — zero 1st and 2nd derivatives at the edges. */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(edge0 === edge1 ? (x >= edge1 ? 1 : 0) : (x - edge0) / (edge1 - edge0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export type Vec3Tuple = readonly [number, number, number];

const toVec3 = (v: THREE.Vector3 | Vec3Tuple, out: THREE.Vector3): THREE.Vector3 =>
  v instanceof THREE.Vector3 ? out.copy(v) : out.set(v[0], v[1], v[2]);

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();

/**
 * Point on a parabolic arc between `start` and `end` at parameter `t`.
 * `apexHeight` is the extra height above the straight line at t = 0.5,
 * giving a ballistic jump regardless of the height difference.
 */
export function parabolicArcVec3(
  start: THREE.Vector3 | Vec3Tuple,
  end: THREE.Vector3 | Vec3Tuple,
  apexHeight: number,
  t: number,
  target: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 {
  const k = clamp01(t);
  toVec3(start, _a);
  toVec3(end, _b);
  target.lerpVectors(_a, _b, k);
  target.y += 4 * apexHeight * k * (1 - k);
  return target;
}

/** Point on a cubic Bézier curve at parameter `t`. */
export function cubicBezierVec3(
  p0: THREE.Vector3 | Vec3Tuple,
  p1: THREE.Vector3 | Vec3Tuple,
  p2: THREE.Vector3 | Vec3Tuple,
  p3: THREE.Vector3 | Vec3Tuple,
  t: number,
  target: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 {
  const k = clamp01(t);
  const u = 1 - k;
  const b0 = u * u * u;
  const b1 = 3 * u * u * k;
  const b2 = 3 * u * k * k;
  const b3 = k * k * k;
  toVec3(p0, _a);
  toVec3(p1, _b);
  toVec3(p2, _c);
  toVec3(p3, _d);
  return target.set(
    _a.x * b0 + _b.x * b1 + _c.x * b2 + _d.x * b3,
    _a.y * b0 + _b.y * b1 + _c.y * b2 + _d.y * b3,
    _a.z * b0 + _b.z * b1 + _c.z * b2 + _d.z * b3,
  );
}

/** Frame-rate independent exponential damping (re-exported for convenience). */
export const damp = THREE.MathUtils.damp;

/* ---------------------------------------------------------------------------
 * Timeline queries
 * ------------------------------------------------------------------------- */

export function sceneIndexAt(progress: number): number {
  const p = clamp01(progress);
  for (let i = 0; i < SCENES.length; i += 1) {
    if (p < SCENES[i].end) return i;
  }
  return SCENES.length - 1;
}

/** 0 → 1 progress within a given scene. */
export function sceneLocalProgress(index: number, progress: number): number {
  const scene = SCENES[Math.max(0, Math.min(SCENES.length - 1, index))];
  return remap(progress, scene.start, scene.end);
}

/** Whether a given piece of gear is attached at `progress`. */
export function isGearAttached(gear: GearId, progress: number): boolean {
  return progress >= GEAR_EQUIP_AT[gear] && progress < GEAR_DROP_AT[gear];
}

export function gearCountAt(progress: number): number {
  let count = 0;
  for (const gear of GEAR_EQUIP_ORDER) {
    if (isGearAttached(gear, progress)) count += 1;
  }
  return count;
}

/* ---------------------------------------------------------------------------
 * Singleton
 * ------------------------------------------------------------------------- */

export interface ScrollToOptions {
  /** Seconds. Defaults to a distance-scaled duration. */
  duration?: number;
  immediate?: boolean;
}

/** Minimal contract the store needs from Lenis (kept narrow for testability). */
export interface ScrollDriver {
  readonly limit: number;
  scrollTo(target: number, options?: { duration?: number; immediate?: boolean; force?: boolean }): void;
}

export type SceneChangeListener = (next: number, prev: number) => void;
export type GearChangeListener = (next: number, prev: number) => void;

export interface ScrollStore {
  /** Undamped progress written by Lenis, 0 → 1. */
  rawProgress: number;
  /** Progress damped toward `rawProgress`; drive all visuals from this. */
  dampedProgress: number;
  /** Signed progress units per second (positive when scrolling down). */
  velocity: number;
  activeSceneIndex: number;
  activeGearCount: number;
  gpuTier: GpuTier;
  audioEnabled: boolean;
  auditMode: boolean;
  /** Damping factor used for `dampedProgress` (higher = snappier). */
  progressLambda: number;
  /** Total seconds elapsed since boot, advanced by `tick`. */
  elapsed: number;
  scrollToProgress: (target: number, options?: ScrollToOptions) => void;
  setRawProgress: (progress: number) => void;
  tick: (delta: number) => void;
  registerDriver: (driver: ScrollDriver | null) => void;
  onSceneChange: (listener: SceneChangeListener) => () => void;
  onGearChange: (listener: GearChangeListener) => () => void;
}

let driver: ScrollDriver | null = null;
let lastRaw = 0;
let rawDeltaAccumulator = 0;
const sceneListeners = new Set<SceneChangeListener>();
const gearListeners = new Set<GearChangeListener>();

export const scrollStore: ScrollStore = {
  rawProgress: 0,
  dampedProgress: 0,
  velocity: 0,
  activeSceneIndex: 0,
  activeGearCount: 0,
  gpuTier: 2,
  audioEnabled: false,
  auditMode: false,
  progressLambda: 6,
  elapsed: 0,

  scrollToProgress(target: number, options: ScrollToOptions = {}): void {
    const p = clamp01(target);
    if (driver) {
      const distance = Math.abs(p - scrollStore.rawProgress);
      const duration = options.duration ?? Math.min(3.2, 0.8 + distance * 6);
      driver.scrollTo(p * driver.limit, { duration, immediate: options.immediate ?? false, force: true });
      return;
    }
    if (typeof window !== 'undefined') {
      const limit = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: p * limit, behavior: options.immediate ? 'auto' : 'smooth' });
    }
  },

  setRawProgress(progress: number): void {
    const p = clamp01(progress);
    rawDeltaAccumulator += p - lastRaw;
    lastRaw = p;
    scrollStore.rawProgress = p;
  },

  tick(delta: number): void {
    // Guard against tab-switch spikes so damping never overshoots.
    const dt = Math.min(Math.max(delta, 0), 0.1);
    scrollStore.elapsed += dt;

    if (dt > 0) {
      const instantaneous = rawDeltaAccumulator / dt;
      scrollStore.velocity = damp(scrollStore.velocity, instantaneous, 10, dt);
    }
    rawDeltaAccumulator = 0;

    scrollStore.dampedProgress = damp(
      scrollStore.dampedProgress,
      scrollStore.rawProgress,
      scrollStore.progressLambda,
      dt,
    );
    if (Math.abs(scrollStore.dampedProgress - scrollStore.rawProgress) < 1e-5) {
      scrollStore.dampedProgress = scrollStore.rawProgress;
    }

    const p = scrollStore.dampedProgress;

    const nextScene = sceneIndexAt(p);
    if (nextScene !== scrollStore.activeSceneIndex) {
      const prev = scrollStore.activeSceneIndex;
      scrollStore.activeSceneIndex = nextScene;
      sceneListeners.forEach((listener) => listener(nextScene, prev));
    }

    const nextGear = gearCountAt(p);
    if (nextGear !== scrollStore.activeGearCount) {
      const prev = scrollStore.activeGearCount;
      scrollStore.activeGearCount = nextGear;
      gearListeners.forEach((listener) => listener(nextGear, prev));
    }
  },

  registerDriver(next: ScrollDriver | null): void {
    driver = next;
  },

  onSceneChange(listener: SceneChangeListener): () => void {
    sceneListeners.add(listener);
    return () => {
      sceneListeners.delete(listener);
    };
  },

  onGearChange(listener: GearChangeListener): () => void {
    gearListeners.add(listener);
    return () => {
      gearListeners.delete(listener);
    };
  },
};

export default scrollStore;
