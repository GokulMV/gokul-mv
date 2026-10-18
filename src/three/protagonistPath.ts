import * as THREE from 'three';
import { cubicBezierVec3, parabolicArcVec3, remap, smootherstep, type Vec3Tuple } from '../store/scrollStore';

/* Waypoints of the climb, straight from the scene timeline. */
export const WAYPOINTS = {
  baseCamp: [0, 0, 0],
  firstLedge: [0, 18, -8],
  chasmOneLanding: [5, 22, -14],
  chasmOneTop: [5, 32, -16],
  chasmTwoCatch: [-4, 40, -26],
  summit: [0, 55, -35],
} as const satisfies Record<string, Vec3Tuple>;

export const SUMMIT_ALTITUDE = WAYPOINTS.summit[1];

/** Sub-phase boundaries inside the climbing scenes. */
export const PATH_PHASES = {
  ascentStart: 0.28,
  ascentEnd: 0.45,
  jumpOneEnd: 0.52,
  climbOneEnd: 0.62,
  leapTwoEnd: 0.7,
  scrambleEnd: 0.78,
} as const;

/** Position of the protagonist along the journey for a given progress. */
export function protagonistPositionAt(progress: number, target: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
  const P = PATH_PHASES;
  const W = WAYPOINTS;
  if (progress < P.ascentStart) return target.set(...W.baseCamp);

  if (progress < P.ascentEnd) {
    const t = smootherstep(P.ascentStart, P.ascentEnd, progress);
    return cubicBezierVec3(W.baseCamp, [0, 6, -1.5], [0, 13, -6.5], W.firstLedge, t, target);
  }

  if (progress < P.jumpOneEnd) {
    const t = remap(progress, P.ascentEnd, P.jumpOneEnd);
    return parabolicArcVec3(W.firstLedge, W.chasmOneLanding, 4, t, target);
  }

  if (progress < P.climbOneEnd) {
    const t = smootherstep(P.jumpOneEnd, P.climbOneEnd, progress);
    return cubicBezierVec3(W.chasmOneLanding, [5, 25, -14.5], [5, 29, -15.5], W.chasmOneTop, t, target);
  }

  if (progress < P.leapTwoEnd) {
    const t = remap(progress, P.climbOneEnd, P.leapTwoEnd);
    return parabolicArcVec3(W.chasmOneTop, W.chasmTwoCatch, 6, t, target);
  }

  if (progress < P.scrambleEnd) {
    const t = smootherstep(P.leapTwoEnd, P.scrambleEnd, progress);
    return cubicBezierVec3(W.chasmTwoCatch, [-4, 46, -29], [-1, 51, -33], W.summit, t, target);
  }

  return target.set(...W.summit);
}

/** Normalised altitude 0 → 1 for audio and atmosphere. */
export function altitudeAt(progress: number): number {
  return THREE.MathUtils.clamp(protagonistPositionAt(progress, _tmp).y / SUMMIT_ALTITUDE, 0, 1);
}

const _tmp = new THREE.Vector3();

/** Pre-sampled path, used by audit-mode debug rendering. */
export function samplePath(samples = 240): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= samples; i += 1) {
    points.push(protagonistPositionAt(i / samples));
  }
  return points;
}
