import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { scrollStore } from '../../store/scrollStore';
import { sceneFx } from '../fx/sceneFx';
import { createAlpineRockMaterial, type RockShaderQuality } from '../materials/alpineRockMaterial';
import { createShaderWarmup, type ShaderWarmup } from '../perf/shaderWarmup';
import { ChasmEffects } from './ChasmEffects';
import { HorizonRange } from './HorizonRange';
import { createMountainBuilder, terrainDetailForTier, type MountainBuilder, type TerrainPiece } from './terrainGeometry';

/* ==========================================================================
 * The climbed massif — one continuous granite mountain carrying every
 * milestone (base-camp shoulder, the Company-1 cliff and ledge 1, the chasm-1
 * cleft, the mid-face buttress, the chasm-2 gorge and the summit pyramid),
 * its ridges, flanks and the outer skirt falling away into the valleys.
 *
 * Geometry is generated procedurally once per GPU tier (terrainGeometry). The
 * build is time-sliced: a few milliseconds of it run per frame inside
 * useFrame (more while the cloud curtain hides the view), so the main thread
 * never stalls. On the first of those frames the rock program (main pass and
 * shadow depth) is compiled on a one-triangle stand-in, so the first visible
 * draw never waits for it. Once finished the meshes are attached imperatively
 * (no React state, no re-render), a dozen per frame to spread the GPU
 * uploads, and the rock dissolves in from the fog.
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
  /** Finished pieces attached per frame (all at once when frameBudgetMs is Infinity). */
  attachPerFrame: 12,
};

/** Frames after the last piece is attached before the warm-up's shadow-depth stand-ins are released. */
const WARMUP_HOLD_FRAMES = 30;

/** A one-triangle stand-in carrying every attribute the rock material reads. */
function createWarmupGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setAttribute('aOcclusion', new THREE.BufferAttribute(new Float32Array([1, 1, 1]), 1));
  g.setAttribute('aCurvature', new THREE.BufferAttribute(new Float32Array(3), 1));
  g.setAttribute('aFacet', new THREE.BufferAttribute(new Float32Array(3), 1));
  return g;
}

function shaderQualityFor(tier: number): RockShaderQuality {
  if (tier >= 3) return 2;
  if (tier === 2) return 1;
  return 0;
}

interface ZoneState {
  builder: MountainBuilder | null;
  meshes: THREE.Mesh[];
  /** Finished pieces not attached yet (index of the next one). */
  pieces: TerrainPiece[];
  nextPiece: number;
  reveal: number;
  warmup: ShaderWarmup | null;
  warmupMesh: THREE.Mesh | null;
  /** Frames left before the warm-up is released (-1: not started / released). */
  warmupHold: number;
  warmed: boolean;
}

function releaseWarmup(s: ZoneState): void {
  s.warmup?.dispose();
  s.warmup = null;
  s.warmupMesh?.geometry.dispose();
  s.warmupMesh = null;
  s.warmupHold = -1;
}

/** The massif only (no horizon range, no chasm effects). */
export function MountainZones(): JSX.Element {
  const tier = scrollStore.gpuTier;
  const group = useRef<THREE.Group>(null);
  const material = useMemo(
    () => createAlpineRockMaterial({ vertexOcclusion: true, vertexCurvature: true, vertexFacet: true, quality: shaderQualityFor(tier) }),
    [tier],
  );
  const state = useRef<ZoneState>({
    builder: null,
    meshes: [],
    pieces: [],
    nextPiece: 0,
    reveal: 0,
    warmup: null,
    warmupMesh: null,
    warmupHold: -1,
    warmed: false,
  });

  useLayoutEffect(() => () => material.dispose(), [material]);

  useEffect(() => {
    const s = state.current;
    s.builder = createMountainBuilder(terrainDetailForTier(tier));
    s.reveal = 0;
    s.warmed = false;
    material.userData.rockUniforms.uReveal.value = 0;
    const owner = group.current;
    return () => {
      for (const mesh of s.meshes) {
        owner?.remove(mesh);
        mesh.geometry.dispose();
      }
      // Built but never attached.
      for (let i = s.nextPiece; i < s.pieces.length; i += 1) s.pieces[i].geometry.dispose();
      s.meshes = [];
      s.pieces = [];
      s.nextPiece = 0;
      s.builder = null;
      releaseWarmup(s);
    };
  }, [tier, material]);

  useFrame((frame, delta) => {
    const g = group.current;
    if (!g) return;
    const s = state.current;
    const uniforms = material.userData.rockUniforms;

    if (!s.warmed && s.builder && !s.builder.done) {
      // Once, while the build runs (under the curtain): compile the rock program for the main pass and
      // the shadow depth pass on a stand-in carrying the pieces' shadow flags, so the first draw of the
      // finished rock never compiles it. The depth stand-ins stay alive until the rock has been drawn.
      s.warmed = true;
      const warmup = createShaderWarmup(frame.gl, frame.camera, frame.scene);
      const dummy = new THREE.Mesh(createWarmupGeometry(), material);
      dummy.receiveShadow = tier >= 2;
      dummy.castShadow = tier >= 2;
      dummy.frustumCulled = false;
      warmup.compile(dummy);
      warmup.compileShadowDepth(dummy);
      warmup.releaseTarget();
      s.warmup = warmup;
      s.warmupMesh = dummy;
    }

    if (s.builder && !s.builder.done) {
      const covered = sceneFx.curtainOpacity > 0.6 && sceneFx.curtainPart < 0.3;
      const budget = covered
        ? Math.max(mountainBuildSettings.frameBudgetMs, mountainBuildSettings.coveredFrameBudgetMs)
        : mountainBuildSettings.frameBudgetMs;
      if (s.builder.step(budget)) {
        s.pieces = s.builder.pieces ?? [];
        s.nextPiece = 0;
      }
    }

    if (s.nextPiece < s.pieces.length) {
      // A dozen pieces per frame: their buffers upload on their first draw, spread over a few frames.
      const perFrame = Number.isFinite(mountainBuildSettings.frameBudgetMs) ? mountainBuildSettings.attachPerFrame : Infinity;
      const end = Math.min(s.pieces.length, s.nextPiece + perFrame);
      for (; s.nextPiece < end; s.nextPiece += 1) {
        const piece = s.pieces[s.nextPiece];
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
      if (s.nextPiece >= s.pieces.length) {
        s.pieces = [];
        s.nextPiece = 0;
        if (s.warmup) s.warmupHold = WARMUP_HOLD_FRAMES;
      }
    }
    if (s.warmupHold > 0) {
      s.warmupHold -= 1;
      if (s.warmupHold === 0) releaseWarmup(s);
    }

    const attached = s.meshes.length > 0;
    const ready = attached && s.pieces.length === 0;
    s.reveal = damp(s.reveal, ready ? 1 : 0, 2.2, delta);
    if (s.reveal > 0.999) s.reveal = 1;
    uniforms.uReveal.value = s.reveal;
    // Fully black (Scene 10 void) or not yet built: skip all draw calls. Pieces draw (still fully
    // fogged, uReveal 0) while they are being attached, so their uploads spread over those frames.
    g.visible = attached && sceneFx.exposure > 0.002;
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
