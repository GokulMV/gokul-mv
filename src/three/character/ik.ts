import * as THREE from 'three';

/* ==========================================================================
 * Two-bone inverse kinematics for the protagonist's limbs — PURE module (no
 * React, no DOM; runs in Node). Zero allocation per call: every temporary is
 * module scoped.
 *
 * The rig contract (rigTypes.ts) gives every bone an IDENTITY rest rotation in
 * Root space, so a bone's world rotation maps its rest frame straight onto the
 * world. A limb is described by its rest frame: the rest direction of each
 * segment (`upperAxis`, `lowerAxis`) and the rest direction the middle joint
 * bends toward (`poleAxis`: +Z for knees, −Z for elbows). The solver places
 * the middle joint in the plane spanned by the root→target line and a world
 * pole hint, then builds each bone's world rotation as the rotation taking
 * its rest (axis, pole) basis onto the solved (direction, bend) basis — so
 * the hinge stays a hinge and the twist is fully determined.
 * ========================================================================== */

export interface TwoBoneRest {
  /** Rest direction (unit, Root space) from the upper joint to the middle joint. */
  readonly upperAxis: THREE.Vector3;
  /** Rest direction (unit, Root space) from the middle joint to the end joint. */
  readonly lowerAxis: THREE.Vector3;
  /** Rest direction (unit, Root space) toward which the middle joint bends. */
  readonly poleAxis: THREE.Vector3;
  /** Rest hinge axis of the middle joint: poleAxis × upperAxis (unit). */
  readonly hingeAxis: THREE.Vector3;
  readonly upperLength: number;
  readonly lowerLength: number;
}

export interface TwoBoneResult {
  /** World rotation of the upper bone. */
  readonly upper: THREE.Quaternion;
  /** World rotation of the lower bone. */
  readonly lower: THREE.Quaternion;
  /** World position of the middle joint (knee / elbow). */
  readonly middle: THREE.Vector3;
  /** World position the end joint actually reaches (target clamped to the reach). */
  readonly end: THREE.Vector3;
  /** Root → target distance before clamping divided by the full reach. */
  stretch: number;
}

export function createTwoBoneResult(): TwoBoneResult {
  return {
    upper: new THREE.Quaternion(),
    lower: new THREE.Quaternion(),
    middle: new THREE.Vector3(),
    end: new THREE.Vector3(),
    stretch: 0,
  };
}

const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _u = new THREE.Vector3();
const _w = new THREE.Vector3();
const _v = new THREE.Vector3();
const _restB = new THREE.Vector3();
const _restC = new THREE.Vector3();
const _worldC = new THREE.Vector3();
const _hinge = new THREE.Vector3();
const _c0 = new THREE.Vector3();
const _c1 = new THREE.Vector3();
const _c2 = new THREE.Vector3();
const _fallback = new THREE.Vector3();

/**
 * Quaternion of the rotation matrix whose COLUMNS are c0, c1, c2 (orthonormal). Written out instead of going
 * through Matrix4.makeBasis + setFromRotationMatrix: no numbers cross non-inlined calls, so nothing is boxed
 * on the heap in the per-frame solver.
 */
export function quaternionFromColumns(c0: THREE.Vector3, c1: THREE.Vector3, c2: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  const m11 = c0.x;
  const m21 = c0.y;
  const m31 = c0.z;
  const m12 = c1.x;
  const m22 = c1.y;
  const m32 = c1.z;
  const m13 = c2.x;
  const m23 = c2.y;
  const m33 = c2.z;
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return out.set((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s);
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    return out.set(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s);
  }
  if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    return out.set((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s);
  }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
  return out.set((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s);
}

/**
 * Rotation that takes the orthonormalised rest basis (axis, pole) onto the
 * world basis (dir, bend). Both pairs must be non-parallel; `bend` is
 * re-orthogonalised against `dir` here.
 */
export function basisRotation(
  restAxis: THREE.Vector3,
  restPole: THREE.Vector3,
  dir: THREE.Vector3,
  bend: THREE.Vector3,
  out: THREE.Quaternion,
): THREE.Quaternion {
  _restB.copy(restPole).addScaledVector(restAxis, -restPole.dot(restAxis)).normalize();
  _restC.crossVectors(restAxis, _restB);
  _v.copy(bend).addScaledVector(dir, -bend.dot(dir));
  if (_v.lengthSq() < 1e-12) {
    // Bend hint parallel to the bone: any perpendicular will do.
    _fallback.set(Math.abs(dir.x) < 0.9 ? 1 : 0, Math.abs(dir.x) < 0.9 ? 0 : 1, 0);
    _v.copy(_fallback).addScaledVector(dir, -_fallback.dot(dir));
  }
  _v.normalize();
  _worldC.crossVectors(dir, _v);
  // R = World · Restᵀ (the rest basis is orthonormal, so its transpose is its inverse); column j of R is
  // dir·restAxis_j + v·restB_j + worldC·restC_j.
  _c0.copy(dir).multiplyScalar(restAxis.x).addScaledVector(_v, _restB.x).addScaledVector(_worldC, _restC.x);
  _c1.copy(dir).multiplyScalar(restAxis.y).addScaledVector(_v, _restB.y).addScaledVector(_worldC, _restC.y);
  _c2.copy(dir).multiplyScalar(restAxis.z).addScaledVector(_v, _restB.z).addScaledVector(_worldC, _restC.z);
  return quaternionFromColumns(_c0, _c1, _c2, out);
}

/**
 * Two-bone IK. `root` is the upper joint's world position, `target` the world
 * position the end joint should reach and `poleHint` a world direction the
 * middle joint should bend toward. Unreachable targets are clamped to 99.95%
 * of the reach (and never closer than the folded length).
 */
export function solveTwoBone(
  rest: TwoBoneRest,
  root: THREE.Vector3,
  target: THREE.Vector3,
  poleHint: THREE.Vector3,
  out: TwoBoneResult,
  poleFallback: THREE.Vector3 | null = null,
  softness = SOFT_IK,
): TwoBoneResult {
  const l1 = rest.upperLength;
  const l2 = rest.lowerLength;
  _d.subVectors(target, root);
  let dist = _d.length();
  const reach = l1 + l2;
  out.stretch = dist / reach;
  if (dist < 1e-6) {
    _d.copy(rest.upperAxis);
    dist = 1e-6;
  } else {
    _d.multiplyScalar(1 / dist);
  }
  const minDist = Math.abs(l1 - l2) + 1e-4;
  // Soft IK: over the last `softness` of the reach the distance is compressed exponentially, so the limb
  // approaches full extension smoothly instead of snapping straight (the middle joint would otherwise jump
  // as the goal crosses the reach).
  const softStart = reach * (1 - softness);
  if (softness > 0 && dist > softStart) {
    const band = reach - softStart;
    dist = softStart + band * (1 - Math.exp(-(dist - softStart) / band));
  }
  const maxDist = reach * 0.9995;
  dist = dist < minDist ? minDist : dist > maxDist ? maxDist : dist;

  // Bend direction: the pole hint with its component along the root→target line removed. When the hint
  // nearly lines up with that line its projection is unstable, so a fallback hint is blended in smoothly.
  _p.copy(poleHint).addScaledVector(_d, -poleHint.dot(_d));
  if (poleFallback) {
    const k = 1 - THREE.MathUtils.smoothstep(_p.length(), 0.08, 0.4);
    if (k > 0) {
      _fallback.copy(poleFallback).addScaledVector(_d, -poleFallback.dot(_d));
      _p.addScaledVector(_fallback, k);
    }
  }
  if (_p.lengthSq() < 1e-10) {
    _fallback.set(Math.abs(_d.x) < 0.9 ? 1 : 0, Math.abs(_d.x) < 0.9 ? 0 : 1, 0);
    _p.copy(_fallback).addScaledVector(_d, -_fallback.dot(_d));
  }
  _p.normalize();

  // Law of cosines: angle at the root between the root→target line and the upper bone.
  const cosA = THREE.MathUtils.clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  _u.copy(_d).multiplyScalar(cosA).addScaledVector(_p, sinA);
  out.middle.copy(root).addScaledVector(_u, l1);
  out.end.copy(root).addScaledVector(_d, dist);
  _w.subVectors(out.end, out.middle).normalize();

  // Both bones share the hinge (the bend plane's normal), so the twist of the lower bone stays consistent
  // through any amount of flexion (a pole-referenced basis would flip by 180° past 90° of flexion).
  _hinge.crossVectors(_p, _d).normalize();
  basisRotation(rest.upperAxis, rest.hingeAxis, _u, _hinge, out.upper);
  basisRotation(rest.lowerAxis, rest.hingeAxis, _w, _hinge, out.lower);
  return out;
}

/** Fraction of a limb's reach over which two-bone IK softens toward full extension. */
export const SOFT_IK = 0.06;

/* ==========================================================================
 * Frame-rate independent damping helpers.
 * ========================================================================== */

/** 1 − e^(−λΔt): the per-frame blend factor of an exponential approach. */
export function dampFactor(lambda: number, delta: number): number {
  return 1 - Math.exp(-lambda * delta);
}

/** Damps `current` toward `target` in place (THREE.MathUtils.damp per component). */
export function dampVector3(current: THREE.Vector3, target: THREE.Vector3, lambda: number, delta: number): THREE.Vector3 {
  const k = dampFactor(lambda, delta);
  current.x += (target.x - current.x) * k;
  current.y += (target.y - current.y) * k;
  current.z += (target.z - current.z) * k;
  return current;
}

/** Frame-rate independent slerp of `current` toward `target` in place; snaps once within 1e-7 rad. */
export function dampQuaternion(current: THREE.Quaternion, target: THREE.Quaternion, lambda: number, delta: number): THREE.Quaternion {
  const dot = Math.abs(current.dot(target));
  if (dot > 1 - 1e-14) return current.copy(target);
  return current.slerp(target, dampFactor(lambda, delta));
}

/* ==========================================================================
 * Small rotation helpers.
 * ========================================================================== */

const _e = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * Local rotation from flexion (about X), twist (about Y) and abduction (about Z)
 * in radians, applied twist → flexion → abduction (Euler order YXZ: yaw, then
 * pitch, then roll), matching the rig contract's axis convention.
 */
export function jointRotation(flex: number, twist: number, abduct: number, out: THREE.Quaternion): THREE.Quaternion {
  _e.set(flex, twist, abduct, 'YXZ');
  return out.setFromEuler(_e);
}

/** Yaw (rotation about +Y) as a quaternion. */
export function yawRotation(yaw: number, out: THREE.Quaternion): THREE.Quaternion {
  const h = yaw * 0.5;
  return out.set(0, Math.sin(h), 0, Math.cos(h));
}

const _fx = new THREE.Vector3();
const _fy = new THREE.Vector3();
const _fz = new THREE.Vector3();

/**
 * World rotation whose local +Z points along `forward` and whose local +Y is
 * as close as possible to `up` (a "look rotation" in the rig's +Z-forward
 * convention).
 */
export function lookRotation(forward: THREE.Vector3, up: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _fz.copy(forward).normalize();
  _fx.crossVectors(up, _fz);
  if (_fx.lengthSq() < 1e-10) {
    _fallback.set(1, 0, 0);
    _fx.copy(_fallback).addScaledVector(_fz, -_fallback.dot(_fz));
  }
  _fx.normalize();
  _fy.crossVectors(_fz, _fx);
  return quaternionFromColumns(_fx, _fy, _fz, out);
}

/**
 * World rotation whose local axes map: local +Y → `yAxis`, local +Z as close
 * as possible to `zHint` (orthogonalised). Used for hand orientations.
 */
export function frameFromYZ(yAxis: THREE.Vector3, zHint: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _fy.copy(yAxis).normalize();
  _fz.copy(zHint).addScaledVector(_fy, -zHint.dot(_fy));
  if (_fz.lengthSq() < 1e-10) {
    _fallback.set(Math.abs(_fy.z) < 0.9 ? 0 : 1, 0, Math.abs(_fy.z) < 0.9 ? 1 : 0);
    _fz.copy(_fallback).addScaledVector(_fy, -_fallback.dot(_fy));
  }
  _fz.normalize();
  _fx.crossVectors(_fy, _fz);
  return quaternionFromColumns(_fx, _fy, _fz, out);
}
