import * as THREE from 'three';
import { basisRotation, frameFromYZ, jointRotation } from './ik';

/* ==========================================================================
 * Pose library — the full-body pose representation the CharacterAnimator
 * builds every frame, plus blending and FK helpers. PURE (no React, no DOM).
 *
 * A BodyPose is a TARGET: positions and rotations the solver damps toward and
 * the limbs' IK goals. Every generator writes into a preallocated BodyPose, so
 * evaluating, blending and solving poses never allocates.
 *
 * Conventions (rigTypes.ts): Root faces +Z, the character's left is +X, every
 * bone's rest rotation is identity. Limb indices: 0 LeftHand, 1 RightHand,
 * 2 LeftFoot, 3 RightFoot.
 * ========================================================================== */

export const LIMB_LEFT_HAND = 0;
export const LIMB_RIGHT_HAND = 1;
export const LIMB_LEFT_FOOT = 2;
export const LIMB_RIGHT_FOOT = 3;
export type LimbIndex = 0 | 1 | 2 | 3;
export const LIMB_INDICES: readonly LimbIndex[] = [0, 1, 2, 3];

/** +1 for left limbs (+X side), −1 for right limbs. */
export const limbSide = (limb: LimbIndex): 1 | -1 => (limb === LIMB_LEFT_HAND || limb === LIMB_LEFT_FOOT ? 1 : -1);
export const isArm = (limb: LimbIndex): boolean => limb === LIMB_LEFT_HAND || limb === LIMB_RIGHT_HAND;

export interface LimbPose {
  /** 0 = forward kinematics (fk*), 1 = reach `target` with two-bone IK. */
  ik: number;
  /** World position the limb's contact point (`effector`) should reach. */
  readonly target: THREE.Vector3;
  /** World direction the elbow / knee should point toward. */
  readonly pole: THREE.Vector3;
  /**
   * Contact point offset in the END frame: arms — from the wrist in the hand
   * bone's frame (palm grip or ice-axe pick tip); legs — from the ankle in the
   * shin bone's frame (sole, ball of the foot or toe).
   */
  readonly effector: THREE.Vector3;
  /** Arms in IK: world orientation of the hand. */
  readonly hand: THREE.Quaternion;
  /** FK local rotations (upper, lower and — arms only — hand). */
  readonly fkUpper: THREE.Quaternion;
  readonly fkLower: THREE.Quaternion;
  readonly fkEnd: THREE.Quaternion;
  /** Contact weight reported to consumers (1 = planted on rock or ground). */
  plant: number;
  /** Surface normal at the contact (world). */
  readonly normal: THREE.Vector3;
}

export interface BodyPose {
  /** Facing (rotation of Root about +Y, radians; 0 faces +Z). Kept unwrapped. */
  yaw: number;
  /** Pelvis joint, world space. */
  readonly pelvisPos: THREE.Vector3;
  /** Pelvis rotation relative to the facing (Root) frame. */
  readonly pelvisRot: THREE.Quaternion;
  readonly spine: THREE.Quaternion;
  readonly chest: THREE.Quaternion;
  readonly neck: THREE.Quaternion;
  readonly head: THREE.Quaternion;
  /** World point the eyes look at, and how strongly the head follows it (0..1). */
  readonly gaze: THREE.Vector3;
  gazeWeight: number;
  /** Outward normal of the rock the body leans on (zero when free) and how far the pelvis may move toward it. */
  readonly wallNormal: THREE.Vector3;
  wallRoom: number;
  readonly limbs: readonly [LimbPose, LimbPose, LimbPose, LimbPose];
}

function createLimbPose(): LimbPose {
  return {
    ik: 0,
    target: new THREE.Vector3(),
    pole: new THREE.Vector3(0, 0, 1),
    effector: new THREE.Vector3(),
    hand: new THREE.Quaternion(),
    fkUpper: new THREE.Quaternion(),
    fkLower: new THREE.Quaternion(),
    fkEnd: new THREE.Quaternion(),
    plant: 0,
    normal: new THREE.Vector3(0, 1, 0),
  };
}

export function createBodyPose(): BodyPose {
  return {
    yaw: 0,
    pelvisPos: new THREE.Vector3(),
    pelvisRot: new THREE.Quaternion(),
    spine: new THREE.Quaternion(),
    chest: new THREE.Quaternion(),
    neck: new THREE.Quaternion(),
    head: new THREE.Quaternion(),
    gaze: new THREE.Vector3(0, 1.6, 10),
    gazeWeight: 0,
    wallNormal: new THREE.Vector3(),
    wallRoom: 10,
    limbs: [createLimbPose(), createLimbPose(), createLimbPose(), createLimbPose()],
  };
}

function copyLimb(src: LimbPose, dst: LimbPose): void {
  dst.ik = src.ik;
  dst.target.copy(src.target);
  dst.pole.copy(src.pole);
  dst.effector.copy(src.effector);
  dst.hand.copy(src.hand);
  dst.fkUpper.copy(src.fkUpper);
  dst.fkLower.copy(src.fkLower);
  dst.fkEnd.copy(src.fkEnd);
  dst.plant = src.plant;
  dst.normal.copy(src.normal);
}

export function copyBodyPose(src: BodyPose, dst: BodyPose): BodyPose {
  dst.yaw = src.yaw;
  dst.pelvisPos.copy(src.pelvisPos);
  dst.pelvisRot.copy(src.pelvisRot);
  dst.spine.copy(src.spine);
  dst.chest.copy(src.chest);
  dst.neck.copy(src.neck);
  dst.head.copy(src.head);
  dst.gaze.copy(src.gaze);
  dst.gazeWeight = src.gazeWeight;
  dst.wallNormal.copy(src.wallNormal);
  dst.wallRoom = src.wallRoom;
  for (let i = 0; i < 4; i += 1) copyLimb(src.limbs[i], dst.limbs[i]);
  return dst;
}

const _slerpB = new THREE.Quaternion();

function slerpInto(a: THREE.Quaternion, b: THREE.Quaternion, w: number, out: THREE.Quaternion): void {
  // Quaternion.slerpQuaternions copies `a` into `out` first, so an `out` that aliases `b` needs a copy of b.
  if (out === b) {
    _slerpB.copy(b);
    out.slerpQuaternions(a, _slerpB, w);
    return;
  }
  out.slerpQuaternions(a, b, w);
}

function blendLimb(a: LimbPose, b: LimbPose, w: number, out: LimbPose): void {
  out.ik = a.ik + (b.ik - a.ik) * w;
  out.target.lerpVectors(a.target, b.target, w);
  out.pole.lerpVectors(a.pole, b.pole, w);
  if (out.pole.lengthSq() < 1e-8) out.pole.copy(b.pole);
  out.pole.normalize();
  out.effector.lerpVectors(a.effector, b.effector, w);
  slerpInto(a.hand, b.hand, w, out.hand);
  slerpInto(a.fkUpper, b.fkUpper, w, out.fkUpper);
  slerpInto(a.fkLower, b.fkLower, w, out.fkLower);
  slerpInto(a.fkEnd, b.fkEnd, w, out.fkEnd);
  out.plant = a.plant + (b.plant - a.plant) * w;
  out.normal.lerpVectors(a.normal, b.normal, w);
  if (out.normal.lengthSq() < 1e-8) out.normal.copy(b.normal);
  out.normal.normalize();
}

/** out = blend(a, b, w); `out` may alias `a` or `b`. */
export function blendBodyPose(a: BodyPose, b: BodyPose, w: number, out: BodyPose): BodyPose {
  if (w <= 0) return out === a ? out : copyBodyPose(a, out);
  if (w >= 1) return out === b ? out : copyBodyPose(b, out);
  out.yaw = a.yaw + (b.yaw - a.yaw) * w;
  out.pelvisPos.lerpVectors(a.pelvisPos, b.pelvisPos, w);
  slerpInto(a.pelvisRot, b.pelvisRot, w, out.pelvisRot);
  slerpInto(a.spine, b.spine, w, out.spine);
  slerpInto(a.chest, b.chest, w, out.chest);
  slerpInto(a.neck, b.neck, w, out.neck);
  slerpInto(a.head, b.head, w, out.head);
  out.gaze.lerpVectors(a.gaze, b.gaze, w);
  out.gazeWeight = a.gazeWeight + (b.gazeWeight - a.gazeWeight) * w;
  out.wallNormal.lerpVectors(a.wallNormal, b.wallNormal, w);
  out.wallRoom = a.wallRoom + (b.wallRoom - a.wallRoom) * w;
  for (let i = 0; i < 4; i += 1) blendLimb(a.limbs[i], b.limbs[i], w, out.limbs[i]);
  return out;
}

/* ==========================================================================
 * Limb rest data and FK helpers.
 * ========================================================================== */

export interface LimbRest {
  readonly upperAxis: THREE.Vector3;
  readonly lowerAxis: THREE.Vector3;
  readonly poleAxis: THREE.Vector3;
  /** Axis (in the upper bone's frame) the middle joint flexes about. */
  readonly hingeAxis: THREE.Vector3;
  readonly upperLength: number;
  readonly lowerLength: number;
}

export function makeLimbRest(upperVector: THREE.Vector3, lowerVector: THREE.Vector3, poleAxis: THREE.Vector3): LimbRest {
  const upperAxis = upperVector.clone().normalize();
  const lowerAxis = lowerVector.clone().normalize();
  const pole = poleAxis.clone().addScaledVector(upperAxis, -poleAxis.dot(upperAxis)).normalize();
  const hingeAxis = new THREE.Vector3().crossVectors(pole, upperAxis).normalize();
  return {
    upperAxis,
    lowerAxis,
    poleAxis: pole,
    hingeAxis,
    upperLength: upperVector.length(),
    lowerLength: lowerVector.length(),
  };
}

/**
 * FK for a limb: the upper bone points along `dir` (unit, PARENT frame) with
 * its middle joint bending toward `bend` (parent frame), and the middle joint
 * flexed by `flex` radians (positive folds the limb toward the bend side's
 * opposite, the anatomical flexion of an elbow or a knee).
 */
export function limbFK(
  rest: LimbRest,
  dir: THREE.Vector3,
  bend: THREE.Vector3,
  flex: number,
  outUpper: THREE.Quaternion,
  outLower: THREE.Quaternion,
): void {
  // Hinge in the parent frame: bend × dir (the rest hinge is pole × axis).
  _hingeW.crossVectors(bend, dir);
  if (_hingeW.lengthSq() < 1e-10) _hingeW.set(dir.y, -dir.x, 0).normalize();
  _hingeW.normalize();
  basisRotation(rest.upperAxis, rest.hingeAxis, dir, _hingeW, outUpper);
  outLower.setFromAxisAngle(rest.hingeAxis, flex);
}

const _hingeW = new THREE.Vector3();

const _dir = new THREE.Vector3();
const _bend = new THREE.Vector3();
const _cross = new THREE.Vector3();

/**
 * Bend direction of a limb pointing along `dir`: `base` (the derivative of the direction with respect to
 * flexion, i.e. perpendicular to the limb in its swing plane) rotated about the limb by `twist` radians.
 * Continuous for every pose, unlike a fixed reference vector.
 */
function bendAround(dir: THREE.Vector3, base: THREE.Vector3, twist: number, out: THREE.Vector3): THREE.Vector3 {
  out.copy(base).addScaledVector(dir, -base.dot(dir));
  if (out.lengthSq() < 1e-12) out.set(dir.y, -dir.x, 0);
  out.normalize();
  _cross.crossVectors(dir, out);
  return out.multiplyScalar(Math.cos(twist)).addScaledVector(_cross, Math.sin(twist)).normalize();
}

/**
 * Arm FK from intuitive angles (radians), mirrored per side:
 *  raise   — swing forward/up in the sagittal plane (0 = hanging, π/2 = pointing forward, π = overhead);
 *  spread  — swing out to the side (0 = at the side, π/2 = horizontal out);
 *  elbow   — elbow flexion (0 = straight);
 *  elbowOut — how far the elbow turns outward from its natural backward/downward direction (0..1 → 0..90°).
 */
export function armFK(
  rest: LimbRest,
  side: 1 | -1,
  raise: number,
  spread: number,
  elbow: number,
  elbowOut: number,
  outUpper: THREE.Quaternion,
  outLower: THREE.Quaternion,
): void {
  const cr = Math.cos(raise);
  const sr = Math.sin(raise);
  const cs = Math.cos(spread);
  const ss = Math.sin(spread);
  // Direction: start hanging (0,−1,0), raise toward +Z, then spread toward ±X.
  _dir.set(side * ss, -cr * cs, sr * cs).normalize();
  // The elbow points opposite to the raise motion (back when hanging, down when forward, forward overhead).
  _bend.set(0, -sr, -cr);
  bendAround(_dir, _bend, side * elbowOut * (Math.PI / 2), _bend);
  limbFK(rest, _dir, _bend, elbow, outUpper, outLower);
}

/**
 * Leg FK from angles (radians), mirrored per side:
 *  hipFlex — thigh forward/up (0 = straight down, π/2 = horizontal forward; negative = behind);
 *  hipOut  — thigh out to the side;
 *  knee    — knee flexion (0 = straight);
 *  kneeOut — knee turned out (0..1 → 0..90°).
 */
export function legFK(
  rest: LimbRest,
  side: 1 | -1,
  hipFlex: number,
  hipOut: number,
  knee: number,
  kneeOut: number,
  outUpper: THREE.Quaternion,
  outLower: THREE.Quaternion,
): void {
  const cf = Math.cos(hipFlex);
  const sf = Math.sin(hipFlex);
  const co = Math.cos(hipOut);
  const so = Math.sin(hipOut);
  _dir.set(side * so, -cf * co, sf * co).normalize();
  // The knee points along the flexion motion (forward when standing, up when the thigh is horizontal).
  _bend.set(0, sf, cf);
  bendAround(_dir, _bend, -side * kneeOut * (Math.PI / 2), _bend);
  limbFK(rest, _dir, _bend, knee, outUpper, outLower);
}

/** Torso / neck / head rotation from forward bend, side bend (toward +X) and twist (toward +X), radians. */
export function torsoRotation(bend: number, sideBend: number, twist: number, out: THREE.Quaternion): THREE.Quaternion {
  // Forward bend tips the up-pointing bone toward +Z: +X rotation. Side bend toward +X: −Z rotation.
  return jointRotation(bend, twist, -sideBend, out);
}

/** Hand FK: wrist flexion (palm side), deviation and pronation, radians. */
export function handRotation(flex: number, deviate: number, pronate: number, side: 1 | -1, out: THREE.Quaternion): THREE.Quaternion {
  return jointRotation(-flex, side * pronate, side * deviate, out);
}

/* ==========================================================================
 * Hand frames.
 *
 * Hand bone rest frame (arm hanging relaxed): fingers along −Y, thumb +Z,
 * palm normal +X for the RightHand (facing the thigh) and −X for the LeftHand.
 * ========================================================================== */

const _y = new THREE.Vector3();
const _z = new THREE.Vector3();

/**
 * World orientation of a hand pressed onto a surface: fingers along `fingers`
 * (world), palm facing `palmNormal` (world, i.e. INTO the surface).
 */
export function palmFrame(side: 1 | -1, fingers: THREE.Vector3, palmNormal: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _y.copy(fingers).negate();
  // Right hand: local +X = palm normal, Z = X × Y; left hand: local −X = palm normal.
  if (side < 0) _z.crossVectors(palmNormal, _y);
  else _z.crossVectors(_y, palmNormal);
  return frameFromYZ(_y, _z, out);
}

/**
 * Ice-axe grip convention, binding for GearSheddingSystem (both hands, in the
 * HAND bone's local frame, metres): the shaft runs through the fist along
 * local +Z (out of the thumb side) from the palm grip point; the head sits
 * `shaftLength` up the shaft and the pick points along local −Y (the
 * knuckles' direction) to its tip `pickReach` beyond the shaft axis.
 * pickTip = grip + (0, −pickReach, shaftLength).
 */
export const ICE_AXE_GRIP = {
  shaftAxis: [0, 0, 1] as const,
  pickAxis: [0, -1, 0] as const,
  shaftLength: 0.43,
  pickReach: 0.11,
} as const;

/** Pick tip offset from the wrist in the hand frame, for a given palm grip offset. */
export function iceAxePickTip(grip: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.set(grip.x, grip.y - ICE_AXE_GRIP.pickReach, grip.z + ICE_AXE_GRIP.shaftLength);
}

/** World orientation of a hand holding an ice axe with the shaft along `shaft` and the pick along `pick` (world). */
export function axeFrame(shaft: THREE.Vector3, pick: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _y.copy(pick).negate();
  return frameFromYZ(_y, shaft, out);
}

