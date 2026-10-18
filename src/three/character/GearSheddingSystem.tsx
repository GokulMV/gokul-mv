import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GEAR_EQUIP_AT, scrollStore } from '../../store/scrollStore';
import { DEFAULT_WIND_DIRECTION } from './characterAssembly';
import { GearAssembly } from './gearAssembly';
import { createGearGeometryBuilder, disposeGearGeometry, gearDetailForTier, type GearDetail, type GearGeometryBuilder } from './gearGeometry';
import { createGearTextures, type GearMaterial } from './gearMaterials';
import { GEAR_LOCK_ON } from './gearTimeline';
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
 * Zero React re-renders on scroll; zero allocation per frame. Geometry is
 * built time-sliced (gearBuildSettings.frameBudgetMs) and finished
 * synchronously if the gear is needed first; trajectories likewise. The frame
 * callback must run AFTER the CharacterAnimator's: it uses priority
 * `priority` (default 0), so mount the animator with a negative priority (or
 * earlier in the tree at the same priority).
 * ========================================================================== */

/** Time-slicing of the geometry / trajectory build. Harnesses may set frameBudgetMs = Infinity. */
export const gearBuildSettings = {
  frameBudgetMs: 4,
};

/** Read-only telemetry (for HUD / tests). */
export const gearSystemStats = {
  ready: false,
  detail: 'high' as GearDetail,
  triangles: 0,
  trajectoriesReady: false,
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
 * Component
 * ========================================================================== */

interface RuntimeState {
  builder: GearGeometryBuilder;
  assembly: GearAssembly | null;
  warmed: boolean;
}

/** Progress after which the gear must be on screen (finish any pending build synchronously). */
const NEEDED_FROM = Math.min(...Object.values(GEAR_EQUIP_AT)) - GEAR_LOCK_ON.lead - 0.01;

function GearRuntime({ rig, wind, windDirection, priority = 0 }: GearSheddingSystemProps & { rig: CharacterRigHandle }): JSX.Element {
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  // Tier is read once at mount (like the rest of the world); a tier change remounts the Canvas.
  const state = useMemo<RuntimeState>(() => ({ builder: createGearGeometryBuilder(gearDetailForTier(scrollStore.gpuTier)), assembly: null, warmed: false }), [rig]);

  useEffect(
    () => () => {
      if (state.assembly) state.assembly.dispose();
      else if (state.builder.done) disposeGearGeometry(state.builder.result());
      state.assembly = null;
      gearSystemStats.ready = false;
      gearSystemStats.trajectoriesReady = false;
    },
    [state],
  );

  useFrame((_, delta) => {
    const progress = scrollStore.dampedProgress;
    if (!state.assembly) {
      if (!state.builder.done && progress < NEEDED_FROM) {
        state.builder.step(gearBuildSettings.frameBudgetMs);
        return;
      }
      const set = state.builder.result();
      const assembly = new GearAssembly(rig, set, createGearTextures());
      scene.add(assembly.world);
      state.assembly = assembly;
      gearSystemStats.ready = true;
      gearSystemStats.detail = set.detail;
      gearSystemStats.triangles = set.triangles;
    }
    const assembly = state.assembly;
    if (!state.warmed) {
      state.warmed = true;
      warmUp(gl, camera, scene, assembly.allMaterials());
    }
    if (!assembly.trajectoriesReady) {
      assembly.prepare(gearBuildSettings.frameBudgetMs);
      gearSystemStats.trajectoriesReady = assembly.trajectoriesReady;
    }
    assembly.update(progress, delta, scrollStore.elapsed, wind?.current ?? 0, windDirection?.current ?? DEFAULT_WIND_DIRECTION);
  }, priority);

  return <></>;
}

/** Compiles every gear material against the scene's lights before the gear first appears (no hitch at 0.19). */
function warmUp(gl: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene, materials: readonly GearMaterial[]): void {
  const temp = new THREE.Scene();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
  for (const m of materials) {
    const mesh = new THREE.Mesh(geometry, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    temp.add(mesh);
  }
  const done = (): void => geometry.dispose();
  try {
    gl.compileAsync(temp, camera, scene).then(done, done);
  } catch {
    done();
  }
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
