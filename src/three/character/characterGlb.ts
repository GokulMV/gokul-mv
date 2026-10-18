import * as THREE from 'three';
import { BONE_NAMES, CHARACTER_HEIGHT, type BoneName, type CharacterRigHandle, type GearSocketName, type RigDimensions } from './rigTypes';
import { REST_JOINTS, SKIN_BONE_INDEX, SKINNED_BONES, createCharacterSkeleton, type SocketSpec, type Vec3 } from './characterSkeleton';
import { SOCKET_SPECS } from './characterGeometry';

/* ==========================================================================
 * GLB override → contract rig (no React; testable in Node).
 *
 * Any humanoid glTF whose bones can be recognised by name (contract names,
 * Mixamo "mixamorig:*", common Unity / Blender humanoid names) is re-skinned
 * onto a FRESH contract skeleton:
 *   - the model is normalised to CHARACTER_HEIGHT with its feet on y = 0 and
 *     the pelvis over the origin (glTF faces +Z, like the contract);
 *   - contract joints are taken from the glTF bind pose (inverse bind
 *     matrices), every contract bone gets an IDENTITY rest rotation, so the
 *     animator's pose-from-identity convention holds whatever the source rig's
 *     bone orientations were;
 *   - skin weights of unmapped source joints (fingers, toes, twist / shoulder
 *     bones …) fold into their nearest mapped ancestor;
 *   - static meshes follow their nearest mapped ancestor bone.
 * Missing contract bones or meshes throw — ProtagonistModel catches that and
 * falls back to the procedural rig. The bind pose becomes the rest pose, so
 * the source should be modelled standing with the arms down (an A/T pose
 * works but the animator's rest will then have raised arms).
 * ========================================================================== */

const SYNONYMS: Readonly<Record<Exclude<BoneName, 'Root'>, readonly string[]>> = {
  Pelvis: ['pelvis', 'hips', 'hip', 'pelvisbone'],
  Spine: ['spine', 'spine1', 'spine01', 'lowerback', 'abdomen', 'spinelower'],
  Chest: ['chest', 'upperchest', 'spine2', 'spine02', 'spine3', 'spine03', 'thorax', 'spineupper'],
  Neck: ['neck', 'neck1', 'neck01'],
  Head: ['head'],
  LeftArm: ['leftarm', 'leftupperarm', 'upperarml', 'larm', 'lupperarm', 'arml', 'upperarmleft'],
  LeftForeArm: ['leftforearm', 'leftlowerarm', 'forearml', 'lowerarml', 'lforearm', 'llowerarm', 'forearmleft'],
  LeftHand: ['lefthand', 'handl', 'lhand', 'handleft'],
  RightArm: ['rightarm', 'rightupperarm', 'upperarmr', 'rarm', 'rupperarm', 'armr', 'upperarmright'],
  RightForeArm: ['rightforearm', 'rightlowerarm', 'forearmr', 'lowerarmr', 'rforearm', 'rlowerarm', 'forearmright'],
  RightHand: ['righthand', 'handr', 'rhand', 'handright'],
  LeftUpLeg: ['leftupleg', 'leftupperleg', 'leftthigh', 'thighl', 'upperlegl', 'lthigh', 'lupleg', 'thighleft'],
  LeftLeg: ['leftleg', 'leftlowerleg', 'leftshin', 'leftcalf', 'shinl', 'calfl', 'lowerlegl', 'lcalf', 'lshin', 'shinleft'],
  RightUpLeg: ['rightupleg', 'rightupperleg', 'rightthigh', 'thighr', 'upperlegr', 'rthigh', 'rupleg', 'thighright'],
  RightLeg: ['rightleg', 'rightlowerleg', 'rightshin', 'rightcalf', 'shinr', 'calfr', 'lowerlegr', 'rcalf', 'rshin', 'shinright'],
};

export function normalizeBoneName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^mixamorig\d*[:_]?/, '')
    .replace(/^(armature|rig|skeleton|root)[|:_.]/, '')
    .replace(/[^a-z0-9]/g, '');
}

export interface GlbRig {
  rig: CharacterRigHandle;
  meshes: THREE.Mesh[];
  dispose(): void;
}

interface SourceJoint {
  bone: THREE.Object3D;
  /** Bind-pose world position (before normalisation). */
  position: THREE.Vector3;
}

/** Maps every source bone to a contract bone: by name, else its nearest mapped ancestor. */
function mapBones(sourceBones: readonly THREE.Object3D[]): {
  mapped: Map<Exclude<BoneName, 'Root'>, THREE.Object3D>;
  owner: Map<THREE.Object3D, Exclude<BoneName, 'Root'>>;
} {
  const mapped = new Map<Exclude<BoneName, 'Root'>, THREE.Object3D>();
  const byName = new Map<string, THREE.Object3D>();
  for (const b of sourceBones) {
    const key = normalizeBoneName(b.name);
    if (!byName.has(key)) byName.set(key, b);
  }
  for (const name of SKINNED_BONES) {
    for (const syn of [normalizeBoneName(name), ...SYNONYMS[name]]) {
      const hit = byName.get(syn);
      if (hit && ![...mapped.values()].includes(hit)) {
        mapped.set(name, hit);
        break;
      }
    }
  }
  const missing = SKINNED_BONES.filter((n) => !mapped.has(n));
  if (missing.length > 0) throw new Error(`GLB rig is missing contract bones: ${missing.join(', ')}`);
  const direct = new Map<THREE.Object3D, Exclude<BoneName, 'Root'>>();
  mapped.forEach((bone, name) => direct.set(bone, name));
  const owner = new Map<THREE.Object3D, Exclude<BoneName, 'Root'>>();
  for (const b of sourceBones) {
    let cur: THREE.Object3D | null = b;
    let found: Exclude<BoneName, 'Root'> | undefined;
    while (cur) {
      found = direct.get(cur);
      if (found) break;
      cur = cur.parent;
    }
    owner.set(b, found ?? 'Pelvis');
  }
  return { mapped, owner };
}

/** Builds a contract rig from a loaded glTF scene (the scene is not modified). Throws on unusable input. */
export function createRigFromGltf(source: THREE.Object3D): GlbRig {
  const scene = source.clone(true);
  // Object3D.clone keeps SkinnedMesh skeletons pointing at the ORIGINAL bones; rebind to the cloned ones.
  rebindClonedSkeletons(source, scene);
  scene.updateMatrixWorld(true);

  const skinned: THREE.SkinnedMesh[] = [];
  const statics: THREE.Mesh[] = [];
  const sourceBones: THREE.Object3D[] = [];
  scene.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh);
    else if ((o as THREE.Mesh).isMesh) statics.push(o as THREE.Mesh);
    if ((o as THREE.Bone).isBone) sourceBones.push(o);
  });
  if (skinned.length === 0) throw new Error('GLB contains no skinned mesh');
  const { mapped, owner } = mapBones(sourceBones);

  // Bind-pose joint positions (world at bind) from the inverse bind matrices.
  const joints = new Map<THREE.Object3D, SourceJoint>();
  const m = new THREE.Matrix4();
  for (const mesh of skinned) {
    const sk = mesh.skeleton;
    sk.bones.forEach((bone, j) => {
      if (joints.has(bone)) return;
      m.copy(sk.boneInverses[j]).invert();
      joints.set(bone, { bone, position: new THREE.Vector3().setFromMatrixPosition(m) });
    });
  }
  const jointOf = (bone: THREE.Object3D): THREE.Vector3 =>
    joints.get(bone)?.position.clone() ?? new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);

  // Bind-pose bounds → normalisation (height, feet on the ground, pelvis over the origin).
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const mesh of skinned) {
    const pos = mesh.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i += 1) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix));
  }
  for (const mesh of statics) {
    mesh.geometry.computeBoundingBox();
    const b = mesh.geometry.boundingBox;
    if (b) box.union(b.clone().applyMatrix4(mesh.matrixWorld));
  }
  const height = box.max.y - box.min.y;
  if (!Number.isFinite(height) || height < 1e-4) throw new Error('GLB has degenerate bounds');
  const scale = CHARACTER_HEIGHT / height;
  const pelvisWorld = jointOf(mapped.get('Pelvis') as THREE.Object3D);
  const normalise = new THREE.Matrix4()
    .makeScale(scale, scale, scale)
    .premultiply(new THREE.Matrix4().makeTranslation(-pelvisWorld.x * scale, -box.min.y * scale, -pelvisWorld.z * scale));

  // Contract joints in Root space.
  const jointEntries: Array<[BoneName, Vec3]> = [['Root', [0, 0, 0]]];
  for (const name of SKINNED_BONES) {
    const p = jointOf(mapped.get(name) as THREE.Object3D).applyMatrix4(normalise);
    jointEntries.push([name, [p.x, p.y, p.z]]);
  }
  const contractJoints = Object.fromEntries(jointEntries) as Record<BoneName, Vec3>;
  // Sockets keep their procedural offsets from their bone's pivot.
  const socketSpecs = {} as Record<GearSocketName, SocketSpec>;
  (Object.keys(SOCKET_SPECS) as GearSocketName[]).forEach((key) => {
    const spec = SOCKET_SPECS[key];
    const from = REST_JOINTS[spec.bone];
    const to = contractJoints[spec.bone];
    socketSpecs[key] = {
      bone: spec.bone,
      rotation: spec.rotation,
      position: [to[0] + spec.position[0] - from[0], to[1] + spec.position[1] - from[1], to[2] + spec.position[2] - from[2]],
    };
  });
  const skeletonParts = createCharacterSkeleton(socketSpecs, contractJoints);
  const { root, bones, skinBones, restPositions, sockets } = skeletonParts;
  const inverses = SKINNED_BONES.map((name) => {
    const j = contractJoints[name];
    return new THREE.Matrix4().makeTranslation(-j[0], -j[1], -j[2]);
  });
  const skeleton = new THREE.Skeleton(skinBones, inverses);
  const identity = new THREE.Matrix4();
  const out: THREE.Mesh[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const ownedMaterials: THREE.Material[] = [];
  const cloneMaterial = (mat: THREE.Material | THREE.Material[]): THREE.Material | THREE.Material[] => {
    if (Array.isArray(mat)) return mat.map((x) => cloneMaterial(x) as THREE.Material);
    const c = mat.clone();
    ownedMaterials.push(c);
    return c;
  };

  for (const mesh of skinned) {
    const geometry = mesh.geometry.clone();
    const toRoot = new THREE.Matrix4().multiplyMatrices(normalise, mesh.bindMatrix);
    geometry.applyMatrix4(toRoot);
    const idx = geometry.getAttribute('skinIndex');
    const wgt = geometry.getAttribute('skinWeight');
    if (!idx || !wgt) throw new Error(`Skinned mesh "${mesh.name}" has no skin attributes`);
    const newIndex = new Uint16Array(idx.count * 4);
    const newWeight = new Float32Array(idx.count * 4);
    const acc = new Float64Array(SKINNED_BONES.length);
    for (let i = 0; i < idx.count; i += 1) {
      acc.fill(0);
      for (let k = 0; k < 4; k += 1) {
        const w = wgt.getComponent(i, k);
        if (w <= 0) continue;
        const sourceBone = mesh.skeleton.bones[idx.getComponent(i, k)];
        const target = sourceBone ? owner.get(sourceBone) ?? 'Pelvis' : 'Pelvis';
        acc[SKIN_BONE_INDEX[target]] += w;
      }
      let sum = 0;
      for (let slot = 0; slot < 4; slot += 1) {
        let best = -1;
        for (let b = 0; b < acc.length; b += 1) if (acc[b] > 0 && (best < 0 || acc[b] > acc[best])) best = b;
        if (best < 0) break;
        newIndex[i * 4 + slot] = best;
        newWeight[i * 4 + slot] = acc[best];
        sum += acc[best];
        acc[best] = 0;
      }
      if (sum <= 0) {
        newIndex[i * 4] = SKIN_BONE_INDEX.Pelvis;
        newWeight[i * 4] = 1;
        sum = 1;
      }
      for (let k = 0; k < 4; k += 1) newWeight[i * 4 + k] /= sum;
    }
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(newIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(newWeight, 4));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, CHARACTER_HEIGHT * 0.54, 0), CHARACTER_HEIGHT * 0.8);
    const target = new THREE.SkinnedMesh(geometry, cloneMaterial(mesh.material));
    target.name = mesh.name;
    target.bind(skeleton, identity);
    target.boundingSphere = geometry.boundingSphere.clone();
    target.castShadow = mesh.castShadow;
    target.receiveShadow = mesh.receiveShadow;
    root.add(target);
    out.push(target);
    geometries.push(geometry);
  }

  for (const mesh of statics) {
    let cur: THREE.Object3D | null = mesh.parent;
    let boneName: Exclude<BoneName, 'Root'> | null = null;
    while (cur) {
      if ((cur as THREE.Bone).isBone) {
        boneName = owner.get(cur) ?? null;
        break;
      }
      cur = cur.parent;
    }
    const geometry = mesh.geometry.clone();
    const world = new THREE.Matrix4().multiplyMatrices(normalise, mesh.matrixWorld);
    const target = new THREE.Mesh(geometry, cloneMaterial(mesh.material));
    target.name = mesh.name;
    target.castShadow = mesh.castShadow;
    target.receiveShadow = mesh.receiveShadow;
    if (boneName) {
      const j = contractJoints[boneName];
      world.premultiply(new THREE.Matrix4().makeTranslation(-j[0], -j[1], -j[2]));
      bones[boneName].add(target);
    } else {
      root.add(target);
    }
    world.decompose(target.position, target.quaternion, target.scale);
    out.push(target);
    geometries.push(geometry);
  }

  const dims = dimensionsFrom(contractJoints);
  root.userData.protagonist = { procedural: false, source: 'glb', scale };
  root.updateMatrixWorld(true);
  return {
    rig: { root, bones, dimensions: dims, restPositions, sockets },
    meshes: out,
    dispose: () => {
      for (const g of geometries) g.dispose();
      for (const mat of ownedMaterials) mat.dispose();
      skeleton.dispose();
    },
  };
}

function dimensionsFrom(j: Readonly<Record<BoneName, Vec3>>): RigDimensions {
  const d = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  return {
    height: CHARACTER_HEIGHT,
    pelvisHeight: j.Pelvis[1],
    shoulderWidth: d(j.LeftArm, j.RightArm),
    upperArmLength: d(j.LeftArm, j.LeftForeArm),
    forearmLength: d(j.LeftForeArm, j.LeftHand),
    thighLength: d(j.LeftUpLeg, j.LeftLeg),
    shinLength: j.LeftLeg[1],
  };
}

/** After Object3D.clone(true), points each cloned SkinnedMesh's skeleton at the cloned bones (like SkeletonUtils.clone). */
function rebindClonedSkeletons(source: THREE.Object3D, clone: THREE.Object3D): void {
  const map = new Map<THREE.Object3D, THREE.Object3D>();
  const walk = (a: THREE.Object3D, b: THREE.Object3D) => {
    map.set(a, b);
    for (let i = 0; i < a.children.length && i < b.children.length; i += 1) walk(a.children[i], b.children[i]);
  };
  walk(source, clone);
  clone.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (!sm.isSkinnedMesh) return;
    const sk = sm.skeleton;
    const clonedBones = sk.bones.map((b) => (map.get(b) as THREE.Bone | undefined) ?? b);
    sm.skeleton = new THREE.Skeleton(clonedBones, sk.boneInverses.map((x) => x.clone()));
  });
}

/** Contract bone names present in a scene (diagnostics). */
export function listContractBones(scene: THREE.Object3D): BoneName[] {
  const bones: THREE.Object3D[] = [];
  scene.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.push(o);
  });
  try {
    const { mapped } = mapBones(bones);
    return BONE_NAMES.filter((n) => n === 'Root' || mapped.has(n as Exclude<BoneName, 'Root'>));
  } catch {
    return [];
  }
}
