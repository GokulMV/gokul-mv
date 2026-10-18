import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GEAR_EQUIP_AT, scrollStore } from '../../store/scrollStore';
import { DEFAULT_WIND_DIRECTION } from './characterAssembly';
import { GearAssembly } from './gearAssembly';
import type { GearBuildRequest, GearBuildResponse } from './gearBuild.worker';
import {
  createGearGeometryBuilder,
  disposeGearGeometry,
  gearDetailForTier,
  unpackGearGeometry,
  type GearDetail,
  type GearGeometryBuilder,
  type GearGeometrySet,
  type PackedGearSet,
} from './gearGeometry';
import { gearTextureSteps, type GearMaterial, type GearTextures } from './gearMaterials';
import { GEAR_LOCK_ON, primeRopeFallProxies } from './gearTimeline';
import { runInBackground } from '../perf/backgroundWork';
import { createShaderWarmup, type ShaderWarmup } from '../perf/shaderWarmup';
import type { CharacterRigHandle } from './rigTypes';

export { backpackFlapOpeningWorld } from './gearAssembly';

/* ==========================================================================
 * GearSheddingSystem — the four expedition tools on the protagonist.
 *
 *   ExpeditionBackpack   on the 'backpack' socket (Chest) from 0.195 to the
 *                        end; its lid flips open in the gust (0.945 → 0.952)
 *                        so the contact paper can escape from the collar mouth
 *                        (BACKPACK_FLAP_OPENING_LOCAL → backpackFlapOpeningWorld);
 *   ClimbingRopeCoil     on 'ropeCoil' (left shoulder, across the chest);
 *                        drops at GEAR_DROP_AT.rope into the canyon;
 *   TacticalHarnessRack  belt on 'harness' (Pelvis), leg loops on the thighs,
 *                        a swaying rack; drops at GEAR_DROP_AT.harness into
 *                        chasm 1;
 *   DualCarbonIceAxes    in 'handGripL/R' while dry-tooling, racked head-down
 *                        on 'hipHolsterL/R' otherwise (smooth handoffs), fall
 *                        away at GEAR_DROP_AT.iceAxes.
 *
 * Every primary state is a pure function of scrollStore.dampedProgress (lock-on
 * springs, handoffs, rigid-body falls precomputed against mountainSdf, lid
 * angle), so scrubbing is exactly reversible. Time drives only secondary
 * motion: the rack / racked axes swing as damped pendulums under gravity and
 * the climber's acceleration, and the open lid flutters in the wind.
 *
 * Zero React re-renders on scroll; zero allocation per frame. Startup never
 * adds a long task: the geometry is built in a worker; the textures, the
 * assembly, the shader warm-up and the fall trajectories run in idle time in
 * units of a few milliseconds (gearBuildSettings). If progress needs the gear
 * before that is done (a fling right after load), the rest is built in short
 * per-frame slices and the gear appears once it is; a fall reached before its
 * precompute catches up a little per frame while the item stays hidden. The
 * frame callback must run AFTER the CharacterAnimator's: it uses priority
 * `priority` (default 0), so mount the animator with a negative priority (or
 * earlier in the tree at the same priority).
 * ========================================================================== */

/**
 * Scheduling of the build. The geometry is built in a module worker (gearBuild.worker; `useWorker: false`, or a
 * worker failure, builds it on the main thread one tool per slice instead). The textures, the assembly and the
 * fall trajectories run in idle time (runInBackground) in slices of a few milliseconds; `frameBudgetMs` adds a
 * per-frame slice while the gear is not needed yet (Infinity builds everything in the first frame: harnesses),
 * `urgentBudgetMs` is the per-frame slice once progress needs the gear and it is still not built (never one
 * long task; the gear appears when done).
 */
export const gearBuildSettings = {
  frameBudgetMs: 0,
  urgentBudgetMs: 3,
  idle: true,
  useWorker: true,
};

/** Read-only telemetry (for HUD / tests). */
export const gearSystemStats = {
  ready: false,
  detail: 'high' as GearDetail,
  triangles: 0,
  trajectoriesReady: false,
  builtBy: 'worker' as 'worker' | 'main',
  /** The build threw (a bug): the gear stays off and nothing waits for it. */
  failed: false,
};

export interface GearSheddingSystemProps {
  rig: CharacterRigHandle | null;
  /** Optional wind strength (0 calm → 1 gust, e.g. the CharacterAnimator's `wind`) for the lid flutter and rack sway. */
  wind?: { readonly current: number };
  /** Optional world wind direction (unit); defaults to DEFAULT_WIND_DIRECTION. */
  windDirection?: { readonly current: THREE.Vector3 };
  /** useFrame priority; must run after the animator. Default 0 (never > 0: that would take over rendering). */
  priority?: number;
}

/* ==========================================================================
 * Geometry worker (one build per detail level per page, shared by every
 * instance, e.g. StrictMode remounts)
 * ========================================================================== */

interface WorkerBuild {
  result: PackedGearSet | null;
  failed: boolean;
}

const workerBuilds = new Map<GearDetail, WorkerBuild>();

function requestWorkerBuild(detail: GearDetail): WorkerBuild | null {
  if (!gearBuildSettings.useWorker || typeof Worker === 'undefined') return null;
  const existing = workerBuilds.get(detail);
  if (existing) return existing;
  const entry: WorkerBuild = { result: null, failed: false };
  workerBuilds.set(detail, entry);
  try {
    const worker = new Worker(new URL('./gearBuild.worker.ts', import.meta.url), { type: 'module', name: 'gear-build' });
    worker.onmessage = (event: MessageEvent<GearBuildResponse>) => {
      const data = event.data;
      if (data.ok) {
        entry.result = data.set;
        primeRopeFallProxies(data.ropeProxies);
      } else {
        console.warn('[GearSheddingSystem] build worker failed; building on the main thread.', data.error);
        entry.failed = true;
      }
      worker.terminate();
    };
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      console.warn('[GearSheddingSystem] build worker unavailable; building on the main thread.', event.message);
      entry.failed = true;
      worker.terminate();
    };
    const request: GearBuildRequest = { detail };
    worker.postMessage(request);
  } catch (error) {
    console.warn('[GearSheddingSystem] could not start the build worker; building on the main thread.', error);
    entry.failed = true;
  }
  return entry;
}

/* ==========================================================================
 * Component
 * ========================================================================== */

/** Shader warm-up of the gear materials, one material per build unit (no hitch when the gear first appears). */
interface WarmUp {
  scene: THREE.Scene;
  geometry: THREE.BufferGeometry;
  materials: readonly GearMaterial[] | null;
  next: number;
}

interface RuntimeState {
  rig: CharacterRigHandle;
  gl: THREE.WebGLRenderer;
  camera: THREE.Camera;
  scene: THREE.Scene;
  warm: WarmUp | null;
  /** Compiled programs (main pass + shadow depth) and their depth stand-ins; lives as long as the runtime. */
  shaders: ShaderWarmup | null;
  detail: GearDetail;
  worker: WorkerBuild | null;
  builder: GearGeometryBuilder | null;
  set: GearGeometrySet | null;
  textureSteps: Generator<void, GearTextures, void>;
  textures: GearTextures | null;
  assembly: GearAssembly | null;
  /** assembly.world is in the scene (the gear is live). */
  added: boolean;
  disposed: boolean;
}

/** Progress after which the gear must be on screen (the climber waits for it from here on: never seen without it). */
export const GEAR_NEEDED_FROM = Math.min(...Object.values(GEAR_EQUIP_AT)) - GEAR_LOCK_ON.lead - 0.01;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function createRuntime(rig: CharacterRigHandle, gl: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene): RuntimeState {
  // Tier is read once at mount (like the rest of the world); a tier change remounts the Canvas.
  const detail = gearDetailForTier(scrollStore.gpuTier);
  return {
    rig,
    gl,
    camera,
    scene,
    warm: null,
    shaders: null,
    detail,
    worker: requestWorkerBuild(detail),
    builder: null,
    set: null,
    textureSteps: gearTextureSteps(),
    textures: null,
    assembly: null,
    added: false,
    disposed: false,
  };
}

/**
 * Advances the build by about `budgetMs`, one small unit at a time (a few texture rows, the assembly, trajectory
 * slices; one tool on the main-thread fallback). Returns true once the assembly exists and every fall trajectory
 * is precomputed.
 */
function advanceBuild(st: RuntimeState, budgetMs: number): boolean {
  if (st.disposed) return true;
  const t0 = now();
  do {
    if (!st.set) {
      if (st.worker && !st.worker.failed) {
        if (st.worker.result) {
          st.set = unpackGearGeometry(st.worker.result);
          gearSystemStats.builtBy = 'worker';
        } else if (!st.textures) {
          // The geometry is still in the worker: build the textures meanwhile.
          const r = st.textureSteps.next();
          if (r.done) st.textures = r.value;
        } else {
          return false;
        }
      } else {
        st.builder ??= createGearGeometryBuilder(st.detail);
        if (!st.builder.done) st.builder.step(0);
        else {
          st.set = st.builder.result();
          gearSystemStats.builtBy = 'main';
        }
      }
    } else if (!st.textures) {
      const r = st.textureSteps.next();
      if (r.done) st.textures = r.value;
    } else if (!st.assembly) {
      // Attaches the (hidden) items to the rig's sockets; update() shows them.
      st.assembly = new GearAssembly(st.rig, st.set, st.textures);
      st.shaders = createShaderWarmup(st.gl, st.camera, st.scene);
      st.warm = createWarmUp();
    } else if (st.warm) {
      if (warmUpStep(st.warm, st.assembly, st.shaders)) {
        disposeWarmUp(st.warm);
        st.warm = null;
        st.shaders?.releaseTarget();
      }
    } else if (!st.assembly.trajectoriesReady) {
      st.assembly.prepare(Math.max(0.5, Math.min(4, budgetMs - (now() - t0))));
    } else {
      gearSystemStats.trajectoriesReady = true;
      return true;
    }
  } while (now() - t0 < budgetMs);
  return false;
}

/** advanceBuild that never throws into the frame loop / idle pump: a failed build turns the gear off. */
function safeAdvance(st: RuntimeState, budgetMs: number): boolean {
  try {
    return advanceBuild(st, budgetMs);
  } catch (error) {
    if (!gearSystemStats.failed) console.error('[GearSheddingSystem] gear build failed; continuing without gear.', error);
    gearSystemStats.failed = true;
    st.disposed = true;
    return true;
  }
}

function disposeRuntime(st: RuntimeState): void {
  st.disposed = true;
  if (st.warm) disposeWarmUp(st.warm);
  st.warm = null;
  st.shaders?.dispose();
  st.shaders = null;
  if (st.assembly) st.assembly.dispose();
  else {
    if (st.set) disposeGearGeometry(st.set);
    st.textures?.dispose();
  }
  st.assembly = null;
  st.set = null;
  st.textures = null;
}

function GearRuntime({ rig, wind, windDirection, priority = 0 }: GearSheddingSystemProps & { rig: CharacterRigHandle }): JSX.Element {
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  // Created in the effect (not during render) so StrictMode's mount → unmount → mount builds exactly one runtime.
  const runtime = useRef<RuntimeState | null>(null);

  useEffect(() => {
    const st = createRuntime(rig, gl, camera, scene);
    runtime.current = st;
    gearSystemStats.failed = false;
    const stop = gearBuildSettings.idle ? runInBackground((ms) => safeAdvance(st, ms)) : () => undefined;
    return () => {
      stop();
      if (st.added) st.assembly?.world.parent?.remove(st.assembly.world);
      disposeRuntime(st);
      if (runtime.current === st) runtime.current = null;
      gearSystemStats.ready = false;
      gearSystemStats.trajectoriesReady = false;
    };
  }, [rig, gl, camera, scene]);

  useFrame((_, delta) => {
    const st = runtime.current;
    if (!st) return;
    const progress = scrollStore.dampedProgress;
    if (!st.added) {
      const budget = progress >= GEAR_NEEDED_FROM ? Math.max(gearBuildSettings.frameBudgetMs, gearBuildSettings.urgentBudgetMs) : gearBuildSettings.frameBudgetMs;
      if (budget > 0) safeAdvance(st, budget);
      // Live once the items exist and their programs are compiled and linked (a first draw never compiles shaders).
      if (st.disposed || !st.assembly || st.warm || !st.shaders?.ready()) return;
      scene.add(st.assembly.world);
      st.added = true;
      gearSystemStats.ready = true;
      gearSystemStats.detail = st.detail;
      gearSystemStats.triangles = st.set?.triangles ?? 0;
    }
    const assembly = st.assembly;
    if (!assembly) return;
    assembly.update(progress, delta, scrollStore.elapsed, wind?.current ?? 0, windDirection?.current ?? DEFAULT_WIND_DIRECTION);
  }, priority);

  return <></>;
}

function createWarmUp(): WarmUp {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
  return { scene: new THREE.Scene(), geometry, materials: null, next: 0 };
}

function disposeWarmUp(warm: WarmUp): void {
  warm.geometry.dispose();
}

/**
 * Compiles the next gear material (the variant the first draw will use: the scene's lights, fog and output
 * target, plus its shadow-pass depth variant) on a stand-in mesh. Returns true when every material is done.
 */
function warmUpStep(warm: WarmUp, assembly: GearAssembly, shaders: ShaderWarmup | null): boolean {
  warm.materials ??= assembly.allMaterials();
  if (!shaders || warm.next >= warm.materials.length) return true;
  const mesh = new THREE.Mesh(warm.geometry, warm.materials[warm.next]);
  warm.next += 1;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  warm.scene.add(mesh);
  try {
    shaders.compile(warm.scene);
    shaders.compileShadowDepth(mesh);
  } catch {
    // A warm-up only: the first draw compiles anything missed.
  }
  warm.scene.remove(mesh);
  return false;
}

/**
 * Builds the four expedition tools on the rig's gear sockets and drives them from scroll progress
 * (lock-on 0.18–0.28, rope drop 0.42, harness drop 0.56, ice-axe drop 0.72, backpack to the end, lid open in the
 * gust). Renders nothing until the rig exists.
 */
export function GearSheddingSystem({ rig, wind, windDirection, priority }: GearSheddingSystemProps): JSX.Element {
  if (!rig) return <></>;
  return <GearRuntime key={rig.root.uuid} rig={rig} wind={wind} windDirection={windDirection} priority={priority} />;
}

export default GearSheddingSystem;
