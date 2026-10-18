import type * as THREE from 'three';

/* ==========================================================================
 * Character rig contract shared by ProtagonistModel, CharacterAnimator and
 * GearSheddingSystem. The model builds the bone hierarchy; the animator poses
 * it from scroll progress; the gear system parents tools to bones.
 * ========================================================================== */

/** Standing height of the protagonist in world units (metres): 5'9". */
export const CHARACTER_HEIGHT = 1.75;

/** Hierarchical bones, parent before child. */
export const BONE_NAMES = [
  'Root',
  'Pelvis',
  'Spine',
  'Chest',
  'Neck',
  'Head',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'RightArm',
  'RightForeArm',
  'RightHand',
  'LeftUpLeg',
  'LeftLeg',
  'RightUpLeg',
  'RightLeg',
] as const;

export type BoneName = (typeof BONE_NAMES)[number];

/** Parent of each bone (Root has none). */
export const BONE_PARENT: Readonly<Record<BoneName, BoneName | null>> = {
  Root: null,
  Pelvis: 'Root',
  Spine: 'Pelvis',
  Chest: 'Spine',
  Neck: 'Chest',
  Head: 'Neck',
  LeftArm: 'Chest',
  LeftForeArm: 'LeftArm',
  LeftHand: 'LeftForeArm',
  RightArm: 'Chest',
  RightForeArm: 'RightArm',
  RightHand: 'RightForeArm',
  LeftUpLeg: 'Pelvis',
  LeftLeg: 'LeftUpLeg',
  RightUpLeg: 'Pelvis',
  RightLeg: 'RightUpLeg',
};

export type CharacterBones = Readonly<Record<BoneName, THREE.Object3D>>;

/** Rest-pose measurements the animator and gear system rely on (metres, local to Root). */
export interface RigDimensions {
  height: number;
  pelvisHeight: number;
  shoulderWidth: number;
  upperArmLength: number;
  forearmLength: number;
  thighLength: number;
  shinLength: number;
}

/**
 * AXIS + REST-POSE CONVENTION (binding for model, animator and gear):
 * - Root space: +Y up, the character faces +Z, the character's LEFT side is +X (so `Left*` bones sit at +X).
 * - Root's origin is on the ground between the feet; the animator places Root at protagonistPositionAt(progress)
 *   (feet level) and yaws it to face the travel/scene direction.
 * - In the REST POSE every bone's local quaternion is IDENTITY: all bone frames are aligned with Root space and only
 *   translated to their joint pivot (Pelvis at the hip centre, Spine at the lumbar joint, Chest at the thoracic joint,
 *   Neck at the base of the neck, Head at the skull base, *Arm at the shoulder, *ForeArm at the elbow, *Hand at the wrist,
 *   *UpLeg at the hip joint, *Leg at the knee). The rest pose is standing upright with the arms hanging relaxed at the sides.
 * - The animator expresses every pose as a local rotation applied to that identity rest frame:
 *   rotation about local X = pitch/flexion (positive tips the bone's child end toward +Z, i.e. forward),
 *   about local Y = yaw/twist, about local Z = roll/abduction (positive swings the child end toward +X).
 *   Because rest rotations are identity, `bone.quaternion` IS the pose rotation; positions stay at rest except Root/Pelvis.
 * - Rest joint positions (local to the parent) live in `restPositions` so the animator and gear can reason about lengths.
 */
export interface CharacterRigHandle {
  /** World-placed root group; the animator moves this along the climb route. */
  root: THREE.Group;
  bones: CharacterBones;
  dimensions: RigDimensions;
  /** Rest-pose local position of each bone relative to its parent (identity rotations at rest). */
  restPositions: Readonly<Record<BoneName, THREE.Vector3>>;
  /**
   * Named attachment sockets for gear (Object3D children of bones, posed at rest): e.g. 'backpack' on Chest (between the
   * shoulder blades; the character's back faces -Z), 'ropeCoil' over the left shoulder, 'hipHolsterL' /
   * 'hipHolsterR' on Pelvis, 'harness' around Pelvis, 'handGripL' / 'handGripR' in the palms.
   */
  sockets: Readonly<Record<GearSocketName, THREE.Object3D>>;
}

/** Gear attachment sockets the model must provide (see CharacterRigHandle.sockets). */
export type GearSocketName = 'backpack' | 'ropeCoil' | 'harness' | 'hipHolsterL' | 'hipHolsterR' | 'handGripL' | 'handGripR';

export const GEAR_SOCKET_NAMES: readonly GearSocketName[] = [
  'backpack',
  'ropeCoil',
  'harness',
  'hipHolsterL',
  'hipHolsterR',
  'handGripL',
  'handGripR',
] as const;

/** Animation states (Phase 2 prompt, adapted: no paper throw — see docs/prompts/PHASE_02_PROTAGONIST.md). */
export type AnimationState =
  | 'HERO_IDLE'
  | 'EQUIPPING_STANCE'
  | 'CLIMB_WALL_1'
  | 'JUMP_CHASM_1'
  | 'CLIMB_WALL_2'
  | 'EXTREME_LEAP_CHASM_2'
  | 'PURE_SKILL_SCRAMBLE'
  | 'SUMMIT_MASTERY'
  | 'LAST_PULL'
  | 'GUST';

/**
 * Where the dual ice axes are (shared by CharacterAnimator hand poses and GearSheddingSystem attachment):
 * in the hands while dry-tooling the two walls, holstered on the hips for the base camp, the jumps and the
 * Chasm 2 leap (so the 0.68–0.70 one-handed catch is bare-handed), and gone after they drop at 0.72
 * (GEAR_DROP_AT.iceAxes). Before they lock on (GEAR_EQUIP_AT.iceAxes) they are not on the body at all.
 */
export type IceAxeMode = 'unequipped' | 'holstered' | 'hands' | 'dropped';

export const ICE_AXES_IN_HANDS: ReadonlyArray<readonly [number, number]> = [
  [0.29, 0.445],
  [0.525, 0.615],
] as const;

export function iceAxeModeAt(progress: number, equipAt: number, dropAt: number): IceAxeMode {
  if (progress < equipAt) return 'unequipped';
  if (progress >= dropAt) return 'dropped';
  for (const [start, end] of ICE_AXES_IN_HANDS) {
    if (progress >= start && progress < end) return 'hands';
  }
  return 'holstered';
}
