import * as THREE from 'three';
import { SUN_DIRECTION } from './worldLayout';

/* ==========================================================================
 * Key light: the sun as it lights the climbed massif.
 *
 * SUN_DIRECTION (low golden-hour sun to the right, slightly ahead, -z) stays
 * the sun of the sky, the horizon range, the clouds, the chasm effects and
 * the lens paper. During the climb the camera mostly looks north (-z) at the
 * massif's south face, which that sun only grazes or backlights, so the rock
 * in frame sat in shade. The key light swings the sun's azimuth toward the
 * south (+z) by `climbYawDeg` so the faces the camera sees are raked by it,
 * then eases back to the true sun for the summit and the horizon reveal.
 *
 * Pure and Node-safe (three only, no DOM). WorldLighting writes
 * `keyLight.direction` every frame from scrollStore.dampedProgress; the rock
 * material's uRockSun uniform shares that Vector3 by reference, so the
 * material, the shadow map and the climber's lighting always agree.
 * ========================================================================== */

export interface KeyLightConfig {
  /** Azimuth swing toward the south (+z) during the climb, in degrees (tuned within 18-28). */
  climbYawDeg: number;
  /** The swing eases back to the true sun between these progress values (summit, horizon reveal). */
  returnStart: number;
  returnEnd: number;
  /**
   * Optional ramp-in of the swing over [start, end] (null: constant from p = 0, so the light never moves
   * during the opening crane-down).
   */
  rampIn: readonly [number, number] | null;
}

export const KEY_LIGHT: KeyLightConfig = {
  climbYawDeg: 25,
  returnStart: 0.75,
  returnEnd: 0.86,
  rampIn: null,
};

function smooth(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const SUN = SUN_DIRECTION.clone().normalize();

/** Key-light azimuth swing (radians, toward +z) at scroll progress p. */
export function keyYawAt(p: number): number {
  let w = 1 - smooth(KEY_LIGHT.returnStart, KEY_LIGHT.returnEnd, p);
  if (KEY_LIGHT.rampIn) w *= smooth(KEY_LIGHT.rampIn[0], KEY_LIGHT.rampIn[1], p);
  return ((KEY_LIGHT.climbYawDeg * Math.PI) / 180) * w;
}

/**
 * Unit direction toward the key light at progress p, written into `out` (no allocation): SUN_DIRECTION
 * rotated about +Y so its azimuth moves toward +z. 25 degrees gives about (0.855, 0.520, 0.080).
 */
export function keyDirectionAt(p: number, out: THREE.Vector3): THREE.Vector3 {
  const a = keyYawAt(p);
  const c = Math.cos(a);
  const s = Math.sin(a);
  return out.set(SUN.x * c - SUN.z * s, SUN.y, SUN.x * s + SUN.z * c);
}

/** Weight of the baked key-light visibility (aSunVis, baked for the climb's key): 1 during the climb, 0 once back on the true sun. */
export function keyBakeWeightAt(p: number): number {
  return 1 - smooth(KEY_LIGHT.returnStart, KEY_LIGHT.returnEnd, p);
}

/**
 * Mutable singleton written by WorldLighting each frame: the current key direction, and the baked-visibility
 * weight as a shader-uniform object (materials share both by reference).
 */
export const keyLight = {
  direction: keyDirectionAt(0, new THREE.Vector3()),
  bakeWeight: { value: 1 },
};
