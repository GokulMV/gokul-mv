import * as THREE from 'three';
import { clamp01, cubicBezierVec3, parabolicArcVec3, remap, smootherstep, type Vec3Tuple } from '../store/scrollStore';

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

/**
 * Sub-phase boundaries inside the climbing scenes.
 *
 * The Chasm 2 sequence (Scene 6) runs from the pillar top-out (`climbOneEnd`)
 * to the start of the summit scramble (`leapTwoEnd`):
 *   climbOneEnd → leapTwoTakeoff  explosive step to the pillar's edge;
 *   leapTwoTakeoff → leapTwoCatch running dive across the abyss; at
 *                                 `leapTwoCatch` the RightHand closes on the lip;
 *   leapTwoCatch → hangEnd        one-handed hang, the body swinging below the lip;
 *   hangEnd → leapTwoEnd          muscle-up onto ledge 3;
 *   leapTwoEnd → scrambleEnd      bare-handed scramble to the summit.
 * `leapTwoEnd` keeps its meaning (the scramble starts there at the catch
 * waypoint), so the terrain route tables built from it are unchanged.
 */
export const PATH_PHASES = {
  ascentStart: 0.28,
  ascentEnd: 0.45,
  jumpOneEnd: 0.52,
  climbOneEnd: 0.62,
  leapTwoTakeoff: 0.632,
  leapTwoCatch: 0.68,
  hangEnd: 0.7,
  leapTwoEnd: 0.71,
  scrambleEnd: 0.78,
} as const;

/**
 * Geometry of the one-handed catch on the Chasm 2 lip. The rock face sits
 * 0.62 behind the catch waypoint (terrainGeometry's CATCH_LIP_Z) and the lip's
 * nose is at the waypoint's height, so the hand closes at `grip`.
 *
 * While airborne or hanging, `protagonistPositionAt` follows the body's centre
 * of mass lowered by `comHeight` — the feet when upright — so camera framing
 * (which aims 1.2 above the path) stays on the torso through the dive and the
 * swing.
 */
export const CATCH_HANG = {
  /** World point where the RightHand closes on the lip. */
  grip: [WAYPOINTS.chasmTwoCatch[0], 40.05, WAYPOINTS.chasmTwoCatch[2] - 0.6] as Vec3Tuple,
  /** Centre of mass below the grip in a dead hang (arm + torso). */
  comDrop: 1.1,
  /** Centre of mass stand-off in front of the wall (+z) in a dead hang. */
  comOut: 0.12,
  /** Path point = centre of mass − comHeight (feet level when upright). */
  comHeight: 1.0,
  /** Swing at the moment of the catch (radians): away from the wall (+z) … */
  swingOut: 0.56,
  /** … and sideways toward the takeoff side (+x). */
  swingSide: 0.31,
  /** Extra height of the dive's apex above the straight takeoff → catch line. */
  diveApex: 3.2,
  /** Length of the explosive step from the pillar top to the takeoff edge. */
  stepLength: 0.5,
} as const;

export interface CatchSwing {
  /** Swing away from the wall (radians, positive = feet out toward +z). */
  out: number;
  /** Swing along the wall (radians, positive = toward +x, the takeoff side). */
  side: number;
}

/**
 * Damped pendulum of the hanging body between the catch and the muscle-up
 * (exactly zero from `hangEnd`). Pure; shared by the path and the animator.
 */
export function catchSwingAt(progress: number, out: CatchSwing): CatchSwing {
  const P = PATH_PHASES;
  if (progress <= P.leapTwoCatch) {
    out.out = CATCH_HANG.swingOut;
    out.side = CATCH_HANG.swingSide;
    return out;
  }
  const tau = clamp01((progress - P.leapTwoCatch) / (P.hangEnd - P.leapTwoCatch));
  const settle = 1 - smootherstep(0.72, 1, tau);
  out.out = CATCH_HANG.swingOut * Math.exp(-2.6 * tau) * Math.cos(2 * Math.PI * 1.2 * tau) * settle;
  out.side = CATCH_HANG.swingSide * Math.exp(-2.2 * tau) * Math.cos(2 * Math.PI * 0.95 * tau + 0.25 * tau) * settle;
  return out;
}

const _swing: CatchSwing = { out: 0, side: 0 };

/** Body centre of mass hanging from the lip for a given swing (world space). */
export function hangingCentreOfMass(swing: CatchSwing, target: THREE.Vector3): THREE.Vector3 {
  const g = CATCH_HANG.grip;
  const r = CATCH_HANG.comDrop;
  const so = Math.sin(swing.out);
  const co = Math.cos(swing.out);
  const ss = Math.sin(swing.side);
  const cs = Math.cos(swing.side);
  return target.set(g[0] + r * ss, g[1] - r * cs * co, g[2] + CATCH_HANG.comOut + r * cs * so);
}

/* Direction of the Chasm 2 leap in the ground plane (pillar top → catch). */
const LEAP_DX = WAYPOINTS.chasmTwoCatch[0] - WAYPOINTS.chasmOneTop[0];
const LEAP_DZ = WAYPOINTS.chasmTwoCatch[2] - WAYPOINTS.chasmOneTop[2];
const LEAP_LEN = Math.hypot(LEAP_DX, LEAP_DZ);

/** Feet at the takeoff edge of the pillar (end of the explosive step). */
export const LEAP_TWO_TAKEOFF: Vec3Tuple = [
  WAYPOINTS.chasmOneTop[0] + (LEAP_DX / LEAP_LEN) * CATCH_HANG.stepLength,
  WAYPOINTS.chasmOneTop[1],
  WAYPOINTS.chasmOneTop[2] + (LEAP_DZ / LEAP_LEN) * CATCH_HANG.stepLength,
];

/** Path point at the moment of the catch (centre of mass − comHeight). */
export const LEAP_TWO_CATCH_POINT: Vec3Tuple = (() => {
  const v = hangingCentreOfMass(catchSwingAt(PATH_PHASES.leapTwoCatch, _swing), new THREE.Vector3());
  return [v.x, v.y - CATCH_HANG.comHeight, v.z] as Vec3Tuple;
})();

/** Path point at the end of the hang (dead hang, swing settled). */
const HANG_END_POINT: Vec3Tuple = (() => {
  const v = hangingCentreOfMass(catchSwingAt(PATH_PHASES.hangEnd, _swing), new THREE.Vector3());
  return [v.x, v.y - CATCH_HANG.comHeight, v.z] as Vec3Tuple;
})();

/* Bézier control points of the three climbs (module constants: sampling allocates nothing). */
const ASCENT_C1: Vec3Tuple = [0, 6, -1.5];
const ASCENT_C2: Vec3Tuple = [0, 13, -6.5];
const PILLAR_C1: Vec3Tuple = [5, 25, -14.5];
const PILLAR_C2: Vec3Tuple = [5, 29, -15.5];
const SCRAMBLE_C1: Vec3Tuple = [-4, 46, -29];
const SCRAMBLE_C2: Vec3Tuple = [-1, 51, -33];

const setTuple = (target: THREE.Vector3, v: Vec3Tuple): THREE.Vector3 => target.set(v[0], v[1], v[2]);

/** Position of the protagonist along the journey for a given progress (feet level). Allocation free with `target`. */
export function protagonistPositionAt(progress: number, target: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
  const P = PATH_PHASES;
  const W = WAYPOINTS;
  if (progress < P.ascentStart) return setTuple(target, W.baseCamp);

  if (progress < P.ascentEnd) {
    const t = smootherstep(P.ascentStart, P.ascentEnd, progress);
    return cubicBezierVec3(W.baseCamp, ASCENT_C1, ASCENT_C2, W.firstLedge, t, target);
  }

  if (progress < P.jumpOneEnd) {
    const t = remap(progress, P.ascentEnd, P.jumpOneEnd);
    return parabolicArcVec3(W.firstLedge, W.chasmOneLanding, 4, t, target);
  }

  if (progress < P.climbOneEnd) {
    const t = smootherstep(P.jumpOneEnd, P.climbOneEnd, progress);
    return cubicBezierVec3(W.chasmOneLanding, PILLAR_C1, PILLAR_C2, W.chasmOneTop, t, target);
  }

  if (progress < P.leapTwoTakeoff) {
    // Explosive step to the edge: starts from rest, accelerating into the dive.
    const t = remap(progress, P.climbOneEnd, P.leapTwoTakeoff);
    const k = t * t;
    return target.set(
      W.chasmOneTop[0] + (LEAP_TWO_TAKEOFF[0] - W.chasmOneTop[0]) * k,
      W.chasmOneTop[1],
      W.chasmOneTop[2] + (LEAP_TWO_TAKEOFF[2] - W.chasmOneTop[2]) * k,
    );
  }

  if (progress < P.leapTwoCatch) {
    // Ballistic dive: constant horizontal speed, parabolic height.
    const t = remap(progress, P.leapTwoTakeoff, P.leapTwoCatch);
    return parabolicArcVec3(LEAP_TWO_TAKEOFF, LEAP_TWO_CATCH_POINT, CATCH_HANG.diveApex, t, target);
  }

  if (progress < P.hangEnd) {
    // One-handed hang: the body swings below the lip and settles.
    hangingCentreOfMass(catchSwingAt(progress, _swing), target);
    target.y -= CATCH_HANG.comHeight;
    return target;
  }

  if (progress < P.leapTwoEnd) {
    // Muscle-up onto ledge 3, ending at the catch waypoint where the scramble starts.
    const t = smootherstep(P.hangEnd, P.leapTwoEnd, progress);
    return target.set(
      HANG_END_POINT[0] + (W.chasmTwoCatch[0] - HANG_END_POINT[0]) * t,
      HANG_END_POINT[1] + (W.chasmTwoCatch[1] - HANG_END_POINT[1]) * t,
      HANG_END_POINT[2] + (W.chasmTwoCatch[2] - HANG_END_POINT[2]) * t,
    );
  }

  if (progress < P.scrambleEnd) {
    const t = smootherstep(P.leapTwoEnd, P.scrambleEnd, progress);
    return cubicBezierVec3(W.chasmTwoCatch, SCRAMBLE_C1, SCRAMBLE_C2, W.summit, t, target);
  }

  return setTuple(target, W.summit);
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
