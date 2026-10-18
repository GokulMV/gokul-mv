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

/** Handle the model publishes once its bones exist (via callback or ref). */
export interface CharacterRigHandle {
  /** World-placed root group; the animator moves this along the climb route. */
  root: THREE.Group;
  bones: CharacterBones;
  dimensions: RigDimensions;
}

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
