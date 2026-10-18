import * as THREE from 'three';
import {
  BONE_NAMES,
  BONE_PARENT,
  CHARACTER_HEIGHT,
  GEAR_SOCKET_NAMES,
  type BoneName,
  type CharacterBones,
  type GearSocketName,
  type RigDimensions,
} from './rigTypes';

/* ==========================================================================
 * Character skeleton — PURE module (no React, no DOM; runs in Node).
 *
 * The single source of the protagonist's proportions. Every joint pivot is
 * given in ROOT space for the contract's rest pose (standing, arms hanging,
 * identity rotations, facing +Z, character's left = +X, feet on y = 0).
 *
 * Mesh authoring uses a separate BIND pose (arms abducted 40°, legs 5°) so
 * the armpits and the inner thighs are open when the garments are
 * polygonised; the skinned meshes are bound in that pose and the bones are
 * then returned to the identity rest pose required by the contract.
 * ========================================================================== */

export type Vec3 = readonly [number, number, number];

/** Rest-pose joint pivots in Root space (metres). Root is the ground point between the feet. */
export const REST_JOINTS: Readonly<Record<BoneName, Vec3>> = {
  Root: [0, 0, 0],
  Pelvis: [0, 0.95, 0],
  Spine: [0, 1.05, -0.012],
  Chest: [0, 1.22, -0.02],
  Neck: [0, 1.487, -0.03],
  Head: [0, 1.598, -0.008],
  LeftArm: [0.19, 1.415, -0.03],
  LeftForeArm: [0.212, 1.12, -0.035],
  LeftHand: [0.222, 0.866, 0.005],
  RightArm: [-0.19, 1.415, -0.03],
  RightForeArm: [-0.212, 1.12, -0.035],
  RightHand: [-0.222, 0.866, 0.005],
  LeftUpLeg: [0.092, 0.905, 0],
  LeftLeg: [0.092, 0.49, 0],
  RightUpLeg: [-0.092, 0.905, 0],
  RightLeg: [-0.092, 0.49, 0],
};

/** Skull top (without hair) in Root space; the hair volume brings the overall height to CHARACTER_HEIGHT. */
export const SKULL_TOP_Y = 1.736;
/** Ankle centre height above the sole (the boot is rigid with the Leg bone — there is no foot bone). */
export const ANKLE_HEIGHT = 0.09;

/** Bind-pose rotations (radians, about local Z) used only while authoring and binding the skinned meshes. */
export const BIND_ARM_ABDUCTION = 0.698; // 40°
export const BIND_LEG_ABDUCTION = 0.087; // 5°

/** Bones that carry skin weights, in skeleton order (Root is the placement group, not a skinned bone). */
export const SKINNED_BONES: readonly Exclude<BoneName, 'Root'>[] = BONE_NAMES.filter(
  (name): name is Exclude<BoneName, 'Root'> => name !== 'Root',
);

export const SKIN_BONE_INDEX: Readonly<Record<Exclude<BoneName, 'Root'>, number>> = Object.fromEntries(
  SKINNED_BONES.map((name, i) => [name, i]),
) as Record<Exclude<BoneName, 'Root'>, number>;

/** Rest position of a bone relative to its parent (identity rotations ⇒ a plain difference of pivots). */
export function restLocalPosition(name: BoneName): THREE.Vector3 {
  const parent = BONE_PARENT[name];
  const j = REST_JOINTS[name];
  if (!parent) return new THREE.Vector3(j[0], j[1], j[2]);
  const p = REST_JOINTS[parent];
  return new THREE.Vector3(j[0] - p[0], j[1] - p[1], j[2] - p[2]);
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Rig dimensions. `shinLength` runs from the knee pivot to the SOLE (ground) so a straight leg satisfies
 * hip-joint height = thighLength + shinLength (the boot is rigid with the Leg bone).
 */
export const RIG_DIMENSIONS: RigDimensions = {
  height: CHARACTER_HEIGHT,
  pelvisHeight: REST_JOINTS.Pelvis[1],
  shoulderWidth: REST_JOINTS.LeftArm[0] - REST_JOINTS.RightArm[0],
  upperArmLength: dist(REST_JOINTS.LeftArm, REST_JOINTS.LeftForeArm),
  forearmLength: dist(REST_JOINTS.LeftForeArm, REST_JOINTS.LeftHand),
  thighLength: dist(REST_JOINTS.LeftUpLeg, REST_JOINTS.LeftLeg),
  shinLength: REST_JOINTS.LeftLeg[1],
};

/* ---------------------------------------------------------------------------
 * Limb frames — rest ↔ bind transforms for authoring.
 *
 * A limb frame rotates rest-space points about its pivot (shoulder / hip) by the
 * bind abduction. `toRest` maps a BIND-space point to the REST-space point that
 * the limb's primitives are designed in; `toBind` is the inverse.
 * ------------------------------------------------------------------------- */

export interface LimbFrame {
  readonly pivot: Vec3;
  /** cos / sin of the bind rotation about +Z. */
  readonly c: number;
  readonly s: number;
}

function limbFrame(pivot: Vec3, angle: number): LimbFrame {
  return { pivot, c: Math.cos(angle), s: Math.sin(angle) };
}

export const LIMB_FRAMES = {
  armL: limbFrame(REST_JOINTS.LeftArm, BIND_ARM_ABDUCTION),
  armR: limbFrame(REST_JOINTS.RightArm, -BIND_ARM_ABDUCTION),
  legL: limbFrame(REST_JOINTS.LeftUpLeg, BIND_LEG_ABDUCTION),
  legR: limbFrame(REST_JOINTS.RightUpLeg, -BIND_LEG_ABDUCTION),
} as const;

export type LimbFrameName = keyof typeof LIMB_FRAMES;

/** Scratch output for limb transforms (avoids allocation in the SDF hot loops). */
export const limbScratch = { x: 0, y: 0, z: 0 };

/** Bind-space point → rest-space point of the limb (inverse rotation about the pivot). Writes limbScratch. */
export function limbToRest(frame: LimbFrame, x: number, y: number, z: number): typeof limbScratch {
  const dx = x - frame.pivot[0];
  const dy = y - frame.pivot[1];
  limbScratch.x = frame.pivot[0] + frame.c * dx + frame.s * dy;
  limbScratch.y = frame.pivot[1] - frame.s * dx + frame.c * dy;
  limbScratch.z = z;
  return limbScratch;
}

/** Rest-space point of the limb → bind-space point (rotation about the pivot). Writes limbScratch. */
export function limbToBind(frame: LimbFrame, x: number, y: number, z: number): typeof limbScratch {
  const dx = x - frame.pivot[0];
  const dy = y - frame.pivot[1];
  limbScratch.x = frame.pivot[0] + frame.c * dx - frame.s * dy;
  limbScratch.y = frame.pivot[1] + frame.s * dx + frame.c * dy;
  limbScratch.z = z;
  return limbScratch;
}

/** Rotates a direction from bind to rest for the limb (normals). Writes limbScratch. */
export function limbDirToRest(frame: LimbFrame, x: number, y: number, z: number): typeof limbScratch {
  limbScratch.x = frame.c * x + frame.s * y;
  limbScratch.y = -frame.s * x + frame.c * y;
  limbScratch.z = z;
  return limbScratch;
}

/** Rotates a direction from rest to bind for the limb (normals). Writes limbScratch. */
export function limbDirToBind(frame: LimbFrame, x: number, y: number, z: number): typeof limbScratch {
  limbScratch.x = frame.c * x - frame.s * y;
  limbScratch.y = frame.s * x + frame.c * y;
  limbScratch.z = z;
  return limbScratch;
}

/* ---------------------------------------------------------------------------
 * Sockets (positions in the parent bone's local frame, rest pose).
 * Values are measured against the garment surfaces built in characterGeometry
 * (see SOCKET_LAYOUT there) and kept here so the GLB path can reuse them.
 * ------------------------------------------------------------------------- */

export interface SocketSpec {
  bone: BoneName;
  /** Root-space rest position of the socket origin. */
  position: Vec3;
  /** Euler XYZ (radians) relative to the bone's rest frame. */
  rotation: Vec3;
}

/* ---------------------------------------------------------------------------
 * Skeleton construction.
 * ------------------------------------------------------------------------- */

export interface CharacterSkeleton {
  root: THREE.Group;
  bones: CharacterBones;
  /** Skinned bones in SKINNED_BONES order (THREE.Bone instances). */
  skinBones: THREE.Bone[];
  restPositions: Readonly<Record<BoneName, THREE.Vector3>>;
  sockets: Readonly<Record<GearSocketName, THREE.Object3D>>;
}

/**
 * Builds the contract hierarchy: `root` is a THREE.Group named 'Root' and is the same object as `bones.Root`;
 * every other bone is a THREE.Bone named exactly as in BONE_NAMES, parented per BONE_PARENT, at its rest pivot
 * with an identity quaternion. Sockets are attached from `sockets` specs.
 */
export function createCharacterSkeleton(
  socketSpecs: Readonly<Record<GearSocketName, SocketSpec>>,
  joints: Readonly<Record<BoneName, Vec3>> = REST_JOINTS,
): CharacterSkeleton {
  const root = new THREE.Group();
  root.name = 'Root';
  const map: Partial<Record<BoneName, THREE.Object3D>> = { Root: root };
  const restPositions = {} as Record<BoneName, THREE.Vector3>;
  restPositions.Root = new THREE.Vector3(0, 0, 0);
  const skinBones: THREE.Bone[] = [];

  for (const name of BONE_NAMES) {
    if (name === 'Root') continue;
    const parentName = BONE_PARENT[name];
    const parent = (parentName ? map[parentName] : root) ?? root;
    const bone = new THREE.Bone();
    bone.name = name;
    const j = joints[name];
    const pj = parentName ? joints[parentName] : ([0, 0, 0] as Vec3);
    bone.position.set(j[0] - pj[0], j[1] - pj[1], j[2] - pj[2]);
    bone.quaternion.identity();
    restPositions[name] = bone.position.clone();
    parent.add(bone);
    map[name] = bone;
  }
  const bones = map as Record<BoneName, THREE.Object3D>;
  for (const name of SKINNED_BONES) skinBones.push(bones[name] as THREE.Bone);

  const sockets = {} as Record<GearSocketName, THREE.Object3D>;
  for (const socketName of GEAR_SOCKET_NAMES) {
    const spec = socketSpecs[socketName];
    const bone = bones[spec.bone];
    const pivot = joints[spec.bone];
    const socket = new THREE.Object3D();
    socket.name = `socket:${socketName}`;
    socket.position.set(spec.position[0] - pivot[0], spec.position[1] - pivot[1], spec.position[2] - pivot[2]);
    socket.rotation.set(spec.rotation[0], spec.rotation[1], spec.rotation[2]);
    bone.add(socket);
    sockets[socketName] = socket;
  }

  root.updateMatrixWorld(true);
  return { root, bones, skinBones, restPositions, sockets };
}

/** Applies the authoring bind pose (arms / legs abducted about local Z). */
export function applyBindPose(bones: CharacterBones): void {
  bones.LeftArm.rotation.set(0, 0, BIND_ARM_ABDUCTION);
  bones.RightArm.rotation.set(0, 0, -BIND_ARM_ABDUCTION);
  bones.LeftUpLeg.rotation.set(0, 0, BIND_LEG_ABDUCTION);
  bones.RightUpLeg.rotation.set(0, 0, -BIND_LEG_ABDUCTION);
}

/** Returns every bone to the contract rest pose (identity rotations, rest positions). */
export function applyRestPose(bones: CharacterBones, restPositions: Readonly<Record<BoneName, THREE.Vector3>>): void {
  for (const name of BONE_NAMES) {
    if (name === 'Root') continue;
    const bone = bones[name];
    bone.quaternion.identity();
    bone.position.copy(restPositions[name]);
    bone.scale.set(1, 1, 1);
  }
}
