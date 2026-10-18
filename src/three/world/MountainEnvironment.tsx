import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { scrollStore } from '../../store/scrollStore';
import { sceneFx } from '../fx/sceneFx';
import { createAlpineRockMaterial, type RockShaderQuality } from '../materials/alpineRockMaterial';
import { ChasmEffects } from './ChasmEffects';
import { HorizonRange } from './HorizonRange';
import { createMountainBuilder, terrainDetailForTier, type MountainBuilder } from './terrainGeometry';

/* ==========================================================================
 * The climbed massif — one continuous granite mountain carrying every
 * milestone (base-camp shoulder, the Company-1 cliff and ledge 1, the chasm-1
 * cleft, the mid-face buttress, the chasm-2 gorge and the summit pyramid),
 * its ridges, flanks and the outer skirt falling away into the valleys.
 *
 * Geometry is generated procedurally once per GPU tier (terrainGeometry). The
 * build is time-sliced: a few milliseconds of it run per frame inside
 * useFrame (more while the cloud curtain hides the view), so the main thread
 * never stalls; once finished the meshes are attached imperatively (no React
 * state, no re-render) and the rock dissolves in from the fog.
 * ========================================================================== */

const { damp } = THREE.MathUtils;

/**
 * Mutable build settings. `frameBudgetMs` is the CPU time spent on the
 * terrain build per frame while the world is visible; `coveredFrameBudgetMs`
 * applies while the cloud curtain covers the view (the intro), where a longer
 * frame goes unnoticed. Set `frameBudgetMs` to Infinity to build in the first
 * frame (e.g. for screenshots / tests).
 */
export const mountainBuildSettings = {
  frameBudgetMs: 6,
  coveredFrameBudgetMs: 12,
};

function shaderQualityFor(tier: number): RockShaderQuality {
  if (tier >= 3) return 2;
  if (tier === 2) return 1;
  return 0;
}

interface ZoneState {
  builder: MountainBuilder | null;
  meshes: THREE.Mesh[];
  reveal: number;
}

/** The massif only (no horizon range, no chasm effects). */
export function MountainZones(): JSX.Element {
  const tier = scrollStore.gpuTier;
  const group = useRef<THREE.Group>(null);
  const material = useMemo(
    () => createAlpineRockMaterial({ vertexOcclusion: true, vertexCurvature: true, quality: shaderQualityFor(tier) }),
    [tier],
  );
  const state = useRef<ZoneState>({ builder: null, meshes: [], reveal: 0 });

  useLayoutEffect(() => () => material.dispose(), [material]);

  useEffect(() => {
    const s = state.current;
    s.builder = createMountainBuilder(terrainDetailForTier(tier));
    s.reveal = 0;
    material.userData.rockUniforms.uReveal.value = 0;
    const owner = group.current;
    return () => {
      for (const mesh of s.meshes) {
        owner?.remove(mesh);
        mesh.geometry.dispose();
      }
      s.meshes = [];
      s.builder = null;
    };
  }, [tier, material]);

  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;
    const s = state.current;
    const uniforms = material.userData.rockUniforms;

    if (s.builder && !s.builder.done) {
      const covered = sceneFx.curtainOpacity > 0.6 && sceneFx.curtainPart < 0.3;
      const budget = covered
        ? Math.max(mountainBuildSettings.frameBudgetMs, mountainBuildSettings.coveredFrameBudgetMs)
        : mountainBuildSettings.frameBudgetMs;
      if (s.builder.step(budget)) {
        const pieces = s.builder.pieces ?? [];
        for (const piece of pieces) {
          const mesh = new THREE.Mesh(piece.geometry, material);
          mesh.name = piece.name;
          mesh.receiveShadow = tier >= 2;
          // Only the climb's fine surface casts shadows on mid-range GPUs; the flanks and the skirt
          // (whose huge bounds would put it in every shadow pass) only on high-end ones.
          mesh.castShadow = tier >= 2 && (piece.kind === 'massif' || tier >= 3);
          mesh.matrixAutoUpdate = false;
          mesh.updateMatrix();
          mesh.updateMatrixWorld();
          g.add(mesh);
          s.meshes.push(mesh);
        }
      }
    }

    const ready = s.meshes.length > 0;
    s.reveal = damp(s.reveal, ready ? 1 : 0, 2.2, delta);
    if (s.reveal > 0.999) s.reveal = 1;
    uniforms.uReveal.value = s.reveal;
    // Fully black (Scene 10 void) or not yet built: skip all draw calls.
    g.visible = ready && sceneFx.exposure > 0.002;
  });

  return <group ref={group} name="mountain-zones" />;
}

/** The whole mountain environment: the massif, the horizon range and the chasm effects. */
export function MountainEnvironment(): JSX.Element {
  return (
    <>
      <MountainZones />
      <HorizonRange />
      <ChasmEffects />
    </>
  );
}

export default MountainEnvironment;
