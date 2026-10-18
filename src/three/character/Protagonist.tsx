import { useCallback, useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { scrollStore } from '../../store/scrollStore';
import { sceneFx } from '../fx/sceneFx';
import { runInBackground } from '../perf/backgroundWork';
import { createShaderWarmup } from '../perf/shaderWarmup';
import { createCharacterAnimator, type CharacterAnimator } from './CharacterAnimator';
import { backpackFlapOpeningWorld, GEAR_NEEDED_FROM, GearSheddingSystem, gearSystemStats } from './GearSheddingSystem';
import { BACKPACK_FLAP_OPENING_LOCAL } from './gearGeometry';
import { DEFAULT_WIND_DIRECTION, ProtagonistModel } from './ProtagonistModel';
import type { CharacterRigHandle } from './rigTypes';

/* ==========================================================================
 * Protagonist — the climber in the live world: ProtagonistModel (rig, worker-
 * built meshes, hair) + the scroll-driven CharacterAnimator + the
 * GearSheddingSystem, sharing one wind / wind-direction pair of refs.
 *
 * React renders this once, and once more when the rig arrives (onRig →
 * state). Nothing re-renders on scroll: every frame reads
 * scrollStore.dampedProgress inside useFrame.
 *
 * Frame order (R3F runs lower priorities first; a POSITIVE priority would
 * take over rendering, so everything here is ≤ 0):
 *   -5  animator: poses the rig for this frame's progress, writes the wind;
 *    0  ProtagonistModel: hair / cloth secondary motion from that wind;
 *    0  GearSheddingSystem: follows the posed bones (mounted after the model).
 *
 * Startup cost (no long task): the meshes and the gear geometry are built in
 * workers; the animator's contact tables (SDF holds), the gear's textures and
 * fall trajectories and the shader warm-up (main pass and shadow depth) of
 * every garment, hair and gear program run in idle time in units of a few
 * milliseconds (runInBackground).
 *
 * The climber is first shown complete: its meshes attached, its programs
 * compiled and linked (no first draw compiles a shader), the contact tables
 * its progress needs built, and — when that first reveal is at or past
 * GEAR_NEEDED_FROM — its gear live (once seen, a late gear build no longer
 * hides it). A fling or deep link that gets there first keeps it hidden while
 * the rest is finished in short per-frame slices (tables 3 ms, gear 3 ms, one
 * mesh's programs); it then snaps straight onto the pose (identical to a
 * blocking build).
 * ========================================================================== */

/** Audit-mode (?audit) debug handle for QA scripts, like window.__ascent. Never present otherwise. */
export interface ProtagonistAuditHandle {
  rig: CharacterRigHandle;
  animator: CharacterAnimator;
  gear: typeof gearSystemStats;
  /** The climber's programs are compiled and linked. */
  readonly shadersReady: boolean;
  /** Live world position of the backpack's flap opening (where the ending's paper escapes). */
  flapOpening(out: THREE.Vector3): THREE.Vector3;
}

declare global {
  interface Window {
    __protagonist?: ProtagonistAuditHandle;
  }
}

interface SharedRefs {
  wind: { current: number };
  windDirection: { current: THREE.Vector3 };
}

/** Progress below which the climber is hidden (the opening cloud curtain still covers base camp). */
const HIDDEN_BEFORE = 0.035;

/** The procedural rig's meshes arrive from the build worker; a glTF rig has its meshes from the start. */
function meshesAttached(rig: CharacterRigHandle): boolean {
  const info = rig.root.userData.protagonist as { procedural?: boolean; triangleCount?: number } | undefined;
  return info !== undefined && (info.procedural === false || info.triangleCount !== undefined);
}

interface CharacterWarmUp {
  /** Compiles the next mesh's programs (main pass + shadow depth). Returns true once every mesh is done. */
  step(): boolean;
  /** Every mesh is compiled and every program has finished linking. */
  ready(): boolean;
  dispose(): void;
}

/**
 * Compiles the garment, skin and hair programs one mesh per step once the worker-built meshes are attached (the
 * rig is still hidden then), so the climber's first visible frame never compiles a shader.
 */
function createCharacterWarmUp(rig: CharacterRigHandle, gl: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene): CharacterWarmUp {
  const shaders = createShaderWarmup(gl, camera, scene);
  let queue: THREE.Object3D[] | null = null;
  let done = false;
  let linked = false;
  return {
    step(): boolean {
      if (done) return true;
      if (!meshesAttached(rig)) return false;
      if (!queue) {
        // The climber's own meshes (garments, skin, hair); the gear on the sockets warms up its own programs.
        const list: THREE.Object3D[] = [];
        const collect = (o: THREE.Object3D): void => {
          if (o.name.startsWith('socket:')) return;
          if ((o as THREE.Mesh).isMesh) list.push(o);
          for (const child of o.children) collect(child);
        };
        collect(rig.root);
        queue = list;
      }
      const mesh = queue.pop();
      if (mesh) {
        try {
          shaders.compile(mesh);
          shaders.compileShadowDepth(mesh);
        } catch {
          // A warm-up only: the first draw compiles anything missed.
        }
      }
      if (queue.length > 0) return false;
      shaders.releaseTarget();
      done = true;
      return true;
    },
    ready(): boolean {
      if (!linked) linked = done && shaders.ready();
      return linked;
    },
    dispose(): void {
      shaders.dispose();
    },
  };
}

/** Poses the rig every frame (priority -5: before the model's and the gear's frame callbacks). */
function AnimatorDriver({ rig, wind, windDirection }: SharedRefs & { rig: CharacterRigHandle }): null {
  const get = useThree((s) => s.get);
  const animatorRef = useRef<CharacterAnimator | null>(null);
  const warmRef = useRef<CharacterWarmUp | null>(null);
  /** The climber has been on screen: from then on a late gear build never hides it again (the gear pops in). */
  const shownRef = useRef(false);

  // One animator per rig, created and disposed in the effect, so StrictMode's mount → unmount → mount and a rig
  // change each leave exactly one live instance (and one background build).
  useEffect(() => {
    const { gl, camera, scene } = get();
    const animator = createCharacterAnimator(rig, {
      // 'high' on every tier: 'low' (one leg-IK iteration) saves ~4 µs per frame but leaves planted feet up to 20 cm
      // off their holds on the walls (and 2–5 cm sunk into the ground). The tier still sets the mesh, hair and gear
      // detail (model / gear system); the adaptive-quality monitor scales particle counts, nothing the climber has.
      detail: 'high',
      backpackFlap: { local: BACKPACK_FLAP_OPENING_LOCAL },
      hiddenBefore: HIDDEN_BEFORE,
      // Built in idle time (prepareStep below); a frame only builds (3 ms) while a climb is waiting on the tables.
      blockingPrepare: false,
      precomputeBudgetMs: 0,
      urgentBudgetMs: 3,
    });
    const warm = createCharacterWarmUp(rig, gl, camera, scene);
    animatorRef.current = animator;
    warmRef.current = warm;
    shownRef.current = false;
    // The SDF contact tables, then (in their own idle slices) one mesh's programs at a time.
    const stopTables = runInBackground((ms) => animator.prepareStep(ms));
    const stopWarmUp = runInBackground(() => warm.step());
    if (scrollStore.auditMode) {
      window.__protagonist = {
        rig,
        animator,
        gear: gearSystemStats,
        get shadersReady() {
          return warm.ready();
        },
        flapOpening: (out) => backpackFlapOpeningWorld(rig, out),
      };
    }
    return () => {
      stopTables();
      stopWarmUp();
      if (animatorRef.current === animator) animatorRef.current = null;
      if (warmRef.current === warm) warmRef.current = null;
      if (window.__protagonist?.animator === animator) delete window.__protagonist;
      warm.dispose();
      animator.dispose();
    };
  }, [rig, get]);

  useFrame((state, delta) => {
    const animator = animatorRef.current;
    const warm = warmRef.current;
    if (!animator || !warm) return;
    const progress = scrollStore.dampedProgress;
    animator.update(progress, delta, state.clock.elapsedTime);
    wind.current = animator.wind;
    windDirection.current.copy(animator.windDirection);
    // Needed on screen now but its programs are not compiled yet (a fling right after load): one mesh per frame.
    if (progress >= HIDDEN_BEFORE) warm.step();
    // First shown only complete (see above); in the final void nothing of the world is drawn, so skip its draws too.
    const visible =
      animator.visible &&
      sceneFx.exposure > 0.002 &&
      warm.ready() &&
      (shownRef.current || progress < GEAR_NEEDED_FROM || gearSystemStats.ready || gearSystemStats.failed);
    if (visible) shownRef.current = true;
    rig.root.visible = visible;
  }, -5);

  return null;
}

/** The protagonist with its animator and gear (mount inside the Canvas, within a Suspense boundary). */
export function Protagonist(): JSX.Element {
  const [rig, setRig] = useState<CharacterRigHandle | null>(null);
  // Shared by the model (hair, cloth), the gear (lid flutter, rack sway) and written by the animator.
  const [refs] = useState<SharedRefs>(() => ({ wind: { current: 0 }, windDirection: { current: DEFAULT_WIND_DIRECTION.clone() } }));

  const onRig = useCallback((next: CharacterRigHandle) => {
    // Hidden until the animator has placed and posed it (it would otherwise flash at the origin in rest pose).
    next.root.visible = false;
    setRig((prev) => (prev === next ? prev : next));
  }, []);

  return (
    <>
      <ProtagonistModel onRig={onRig} wind={refs.wind} windDirection={refs.windDirection} />
      {rig ? <AnimatorDriver key={rig.root.uuid} rig={rig} wind={refs.wind} windDirection={refs.windDirection} /> : null}
      <GearSheddingSystem rig={rig} wind={refs.wind} windDirection={refs.windDirection} priority={0} />
    </>
  );
}

export default Protagonist;
