import * as THREE from 'three';
import type { GpuTier } from '../../store/scrollStore';
import { createHairCardGeometry, createSilkyHairMaterials, type SilkyHairMaterials } from '../shaders/SilkyHairShader';
import { BONE_NAMES, BONE_PARENT, type BoneName, type CharacterRigHandle } from './rigTypes';
import {
  BIND_ARM_ABDUCTION,
  BIND_LEG_ABDUCTION,
  RIG_DIMENSIONS,
  SKINNED_BONES,
  createCharacterSkeleton,
  type CharacterSkeleton,
} from './characterSkeleton';
import {
  SOCKET_SPECS,
  characterDetailForTier,
  createCharacterMeshBuilder,
  primeCharacterMeshCache,
  type CharacterDetailLevel,
  type CharacterMeshBuilder,
  type CharacterMeshes,
  type GarmentName,
  type SkinnedMeshData,
} from './characterGeometry';
import { createHairBuilder, primeHairCache, type HairBuilder, type HairGeometryData } from './characterHair';
import type { CharacterBuildRequest, CharacterBuildResponse } from './characterBuild.worker';
import { createCharacterMaterials, type CharacterMaterialSet } from './characterMaterials';

/* ==========================================================================
 * Procedural protagonist assembly (no React; usable from Node for checks).
 *
 * The rig (bones + sockets) exists immediately so the animator and the gear
 * system can bind to it on the first frame. The garment meshes and the hair
 * are built OFF the main thread in a module worker (characterBuild.worker)
 * and attached on the first frame after they arrive; without Worker support,
 * or if the worker fails, the same build runs on the main thread in time
 * slices (`build(budgetMs)` each frame). Either way the result is:
 * four SkinnedMeshes (jacket, trousers, boots, skin — one draw call each)
 * sharing one Skeleton, plus the hair (two passes over one card geometry)
 * parented to the Head bone.
 *
 * Binding: the meshes are authored in the bind pose (arms abducted 40°, legs
 * 5°). Bone inverses are computed analytically from the rest pivots and the
 * bind rotations RELATIVE TO ROOT (bindMatrix = identity, the meshes are
 * children of Root), so the live bones are never touched and the Root may
 * already be placed anywhere in the world when the meshes arrive.
 * ========================================================================== */

/** Default world-space wind direction: from the next mountain (−z) toward the camera (+z), slightly from the left. */
export const DEFAULT_WIND_DIRECTION = new THREE.Vector3(0.25, 0.05, 1).normalize();

/** Build options (harnesses / tests may disable the worker to exercise the time-sliced path). */
export const characterBuildSettings = {
  useWorker: true,
};

interface WorkerBuild {
  result: { meshes: CharacterMeshes; hair: HairGeometryData } | null;
  failed: boolean;
}

/** One worker build per detail level per page (shared by every character instance, e.g. StrictMode remounts). */
const workerBuilds = new Map<CharacterDetailLevel, WorkerBuild>();

function requestWorkerBuild(detail: CharacterDetailLevel): WorkerBuild | null {
  if (!characterBuildSettings.useWorker || typeof Worker === 'undefined') return null;
  const existing = workerBuilds.get(detail);
  if (existing) return existing;
  const entry: WorkerBuild = { result: null, failed: false };
  workerBuilds.set(detail, entry);
  try {
    const worker = new Worker(new URL('./characterBuild.worker.ts', import.meta.url), { type: 'module', name: 'protagonist-build' });
    worker.onmessage = (event: MessageEvent<CharacterBuildResponse>) => {
      const data = event.data;
      if (data.ok) {
        primeCharacterMeshCache(data.meshes);
        primeHairCache(data.detail, data.hair);
        entry.result = { meshes: data.meshes, hair: data.hair };
      } else {
        console.warn('[Protagonist] build worker failed; building on the main thread.', data.error);
        entry.failed = true;
      }
      worker.terminate();
    };
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      console.warn('[Protagonist] build worker unavailable; building on the main thread.', event.message);
      entry.failed = true;
      worker.terminate();
    };
    const request: CharacterBuildRequest = { detail };
    worker.postMessage(request);
  } catch (error) {
    console.warn('[Protagonist] could not start the build worker; building on the main thread.', error);
    entry.failed = true;
  }
  return entry;
}

/** Bounding sphere (Root space) that contains the character in any pose (arms overhead, crouched, hanging). */
const POSE_BOUNDS = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 1.4);

export interface ProceduralCharacterOptions {
  tier: GpuTier;
  skinTone?: THREE.ColorRepresentation;
}

export interface ProceduralCharacter {
  readonly rig: CharacterRigHandle;
  /** True once the garment meshes and hair are attached. */
  readonly ready: boolean;
  /** Advances the time-sliced mesh build (no-op once ready). Returns `ready`. */
  build(budgetMs: number): boolean;
  /**
   * Per-frame secondary motion: hair wind + idle sway and cloth flutter. `wind` is the extra wind strength
   * (0 calm, 1 gust) driven by the animator; `windDirection` is world space (defaults to DEFAULT_WIND_DIRECTION).
   */
  update(delta: number, time: number, wind: number, windDirection: THREE.Vector3 | null): void;
  /** Total triangles once ready (body + hair geometry, one pass). */
  readonly triangleCount: number;
  readonly meshes: Readonly<Partial<Record<GarmentName | 'hairOpaque' | 'hairSoft', THREE.Mesh>>>;
  /** Frees GPU resources (safe to call more than once; three re-uploads if the objects are rendered again). */
  dispose(): void;
}

function makeSkinnedGeometry(data: SkinnedMeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(data.skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(data.skinWeight, 4));
  g.setAttribute('aRest', new THREE.BufferAttribute(data.rest, 3));
  g.setAttribute('aRestNormal', new THREE.BufferAttribute(data.restNormal, 3));
  g.setAttribute('aOcclusion', new THREE.BufferAttribute(data.occlusion, 1));
  g.setAttribute('aMask', new THREE.BufferAttribute(data.mask, 2));
  const index = data.vertexCount < 65536 ? Uint16Array.from(data.indices) : data.indices;
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.boundingSphere = POSE_BOUNDS.clone();
  g.boundingBox = new THREE.Box3().setFromCenterAndSize(POSE_BOUNDS.center, new THREE.Vector3(2.8, 2.8, 2.8));
  return g;
}

/** Root-relative bind-pose matrices of the skinned bones (rest pivots + authoring abductions). */
function bindInverses(skeleton: CharacterSkeleton): THREE.Matrix4[] {
  const bind = new Map<BoneName, THREE.Matrix4>();
  const local = new THREE.Matrix4();
  const rot = new THREE.Matrix4();
  for (const name of BONE_NAMES) {
    if (name === 'Root') {
      bind.set(name, new THREE.Matrix4());
      continue;
    }
    const parent = BONE_PARENT[name] ?? 'Root';
    const rest = skeleton.restPositions[name];
    local.makeTranslation(rest.x, rest.y, rest.z);
    const angle =
      name === 'LeftArm'
        ? BIND_ARM_ABDUCTION
        : name === 'RightArm'
          ? -BIND_ARM_ABDUCTION
          : name === 'LeftUpLeg'
            ? BIND_LEG_ABDUCTION
            : name === 'RightUpLeg'
              ? -BIND_LEG_ABDUCTION
              : 0;
    if (angle !== 0) local.multiply(rot.makeRotationZ(angle));
    const parentBind = bind.get(parent) ?? new THREE.Matrix4();
    bind.set(name, parentBind.clone().multiply(local));
  }
  return SKINNED_BONES.map((name) => (bind.get(name) ?? new THREE.Matrix4()).clone().invert());
}

export function createProceduralCharacter(options: ProceduralCharacterOptions): ProceduralCharacter {
  const tier = options.tier;
  const detail = characterDetailForTier(tier);
  const skeletonParts = createCharacterSkeleton(SOCKET_SPECS);
  const { root, bones, skinBones, restPositions, sockets } = skeletonParts;
  const rig: CharacterRigHandle = { root, bones, dimensions: RIG_DIMENSIONS, restPositions, sockets };
  root.userData.protagonist = { procedural: true, detail };

  const materials: CharacterMaterialSet = createCharacterMaterials({ skinTone: options.skinTone });
  const hairMaterials: SilkyHairMaterials = createSilkyHairMaterials({ alphaToCoverage: tier >= 3 });
  const workerBuild = requestWorkerBuild(detail);
  let builder: CharacterMeshBuilder | null = null;
  let hairBuilder: HairBuilder | null = null;
  const skeleton = new THREE.Skeleton(skinBones, bindInverses(skeletonParts));
  const identity = new THREE.Matrix4();
  const meshes: Partial<Record<GarmentName | 'hairOpaque' | 'hairSoft', THREE.Mesh>> = {};
  const geometries: THREE.BufferGeometry[] = [];
  const shadows = tier >= 2;
  let ready = false;
  let triangleCount = 0;

  // Secondary-motion state (damped).
  const motion = { hairWind: 0.12, flutter: 0 };
  const windWorld = new THREE.Vector3().copy(DEFAULT_WIND_DIRECTION);
  const windLocal = new THREE.Vector3();
  const rootQuat = new THREE.Quaternion();

  function attach(result: CharacterMeshes, hairData: HairGeometryData, builtBy: 'worker' | 'main'): void {
    const order: readonly GarmentName[] = ['jacket', 'trousers', 'boots', 'skin'];
    for (const name of order) {
      const data = result.meshes[name];
      const geometry = makeSkinnedGeometry(data);
      geometries.push(geometry);
      const mesh = new THREE.SkinnedMesh(geometry, materials[name]);
      mesh.name = `Protagonist.${name}`;
      mesh.bind(skeleton, identity);
      mesh.boundingSphere = POSE_BOUNDS.clone();
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
      mesh.frustumCulled = true;
      root.add(mesh);
      meshes[name] = mesh;
    }
    const hairGeometry = createHairCardGeometry(hairData);
    geometries.push(hairGeometry);
    const hairOpaque = new THREE.Mesh(hairGeometry, hairMaterials.opaque);
    hairOpaque.name = 'Protagonist.hair.opaque';
    hairOpaque.receiveShadow = shadows;
    hairOpaque.castShadow = false;
    const hairSoft = new THREE.Mesh(hairGeometry, hairMaterials.soft);
    hairSoft.name = 'Protagonist.hair.soft';
    hairSoft.receiveShadow = shadows;
    hairSoft.castShadow = false;
    hairSoft.renderOrder = 1;
    bones.Head.add(hairOpaque);
    bones.Head.add(hairSoft);
    meshes.hairOpaque = hairOpaque;
    meshes.hairSoft = hairSoft;
    triangleCount = result.triangleCount + hairData.triangleCount;
    root.userData.protagonist = { procedural: true, detail, triangleCount, buildMs: result.buildMs, builtBy };
    ready = true;
  }

  return {
    rig,
    get ready() {
      return ready;
    },
    get triangleCount() {
      return triangleCount;
    },
    meshes,
    build(budgetMs: number): boolean {
      if (ready) return true;
      if (workerBuild && !workerBuild.failed) {
        if (workerBuild.result) attach(workerBuild.result.meshes, workerBuild.result.hair, 'worker');
        return ready;
      }
      builder ??= createCharacterMeshBuilder(detail);
      hairBuilder ??= createHairBuilder(detail);
      const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (!builder.step(budgetMs) || !builder.result) return false;
      const spent = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
      if (!hairBuilder.step(Math.max(0.5, budgetMs - spent)) || !hairBuilder.result) return false;
      attach(builder.result, hairBuilder.result, 'main');
      return ready;
    },
    update(delta: number, time: number, wind: number, windDirection: THREE.Vector3 | null): void {
      const dt = Math.min(Math.max(delta, 0), 0.1);
      const gust = Math.max(0, wind);
      // Idle: a light, irregular mountain breeze in the hair; the cloth only moves with real wind.
      const idle = 0.1 + 0.05 * Math.sin(time * 0.63) * Math.sin(time * 0.27 + 1.3);
      motion.hairWind = THREE.MathUtils.damp(motion.hairWind, idle + gust, 5, dt);
      motion.flutter = THREE.MathUtils.damp(motion.flutter, 0.08 + gust, 6, dt);
      if (windDirection && windDirection.lengthSq() > 1e-8) windWorld.copy(windDirection).normalize();
      else windWorld.copy(DEFAULT_WIND_DIRECTION);
      const hu = hairMaterials.uniforms;
      hu.uTime.value = time;
      hu.uWind.value = motion.hairWind;
      hu.uWindDir.value.copy(windWorld);
      const cu = materials.uniforms;
      cu.uTime.value = time;
      cu.uFlutter.value = motion.flutter;
      root.getWorldQuaternion(rootQuat).invert();
      cu.uWindLocal.value.copy(windLocal.copy(windWorld).applyQuaternion(rootQuat));
    },
    dispose(): void {
      for (const g of geometries) g.dispose();
      materials.dispose();
      hairMaterials.dispose();
      skeleton.dispose();
    },
  };
}
