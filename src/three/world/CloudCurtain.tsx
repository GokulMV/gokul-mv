import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { clamp01, scrollStore, smoothstep, type GpuTier } from '../../store/scrollStore';
import { adaptiveQuality } from '../perf/adaptiveQuality';
import { sceneFx } from '../fx/sceneFx';
import {
  CLOUD_COMPOSITE_FRAGMENT_SHADER,
  CLOUD_COMPOSITE_VERTEX_SHADER,
  CLOUD_CURTAIN_FRAGMENT_SHADER,
  CLOUD_CURTAIN_RENDER_ORDER,
  CLOUD_CURTAIN_VERTEX_SHADER,
  CLOUD_MIN_VIEWPORT_FRACTION,
  applyCloudAccumulationBlending,
  cloudCurtainDefines,
  cloudCurtainResolution,
  createCloudCompositeUniforms,
  createCloudCurtainUniforms,
  createCloudNoiseTexture,
  createFullscreenTriangle,
  type CloudCompositeUniforms,
  type CloudCurtainUniforms,
} from '../shaders/CloudCurtainShader';
import { CAMERA_CLIP, CLOUD_CURTAIN, SUN_DIRECTION } from './worldLayout';

/* ==========================================================================
 * Cloud curtain — the opening, the return and the final dissolve.
 *
 * One instanced mesh of camera-facing volumetric puffs, laid out inside the
 * opening camera's frustum (eye [0,3,24] → [0,1.4,0], fov 42) between world
 * z = CLOUD_CURTAIN.zFar (26) and z = CLOUD_CURTAIN.zNear (6). Every window
 * comes from CLOUD_CURTAIN.timeline / ENDING (never hard-coded here):
 *
 *  open      openStart → openEnd (0.00 → 0.08). Closed and opaque at 0; the
 *            curtain parts like a theatre curtain (left half → −X, right
 *            half → +X, CLOUD_CURTAIN.partX) while the camera dollies through
 *            it, fades from ≈0.044 and is fully clear at 0.08.
 *  between   0.08 → returnStart: hidden (composite visible = false, so the
 *            offscreen pass is skipped too: zero cost). While hidden the
 *            layout is re-anchored from the world to the camera. This
 *            includes the Scene 8 reveal (0.86 – 0.92), the "last pull" hero
 *            shot of the protagonist before the next mountain (ENDING
 *            heroPull, 0.92 – 0.945) and the gust carrying the paper to the
 *            lens (0.945 – 0.955): all of them stay perfectly clear.
 *  return    returnStart → returnEnd (0.955 → 0.985) while the paper sits on
 *            the lens: the opening played backwards in camera space (anchor
 *            = camera.matrixWorld × inverse(opening camera)), so the two
 *            halves glide back in from the frame edges around and behind the
 *            paper, render over the mountain, and seal the view at
 *            RETURN_SEALED (80% of the window, ≈0.979).
 *  dissolve  dissolveStart → dissolveEnd (0.985 → 1.00), as the paper peels
 *            away: the clouds erode into wisps, drift apart and fade while
 *            sceneFx.exposure damps 1 → 0, leaving the #040508 void the
 *            footer scrolls in over. Scrubbing back damps exposure back to 1.
 *
 * Rendering: the puffs are fill-bound, so they accumulate (premultiplied)
 * into a reduced-resolution half-float target sized from CSS pixels per GPU
 * tier; one fullscreen triangle composites it with depthTest off at
 * CLOUD_CURTAIN_RENDER_ORDER. Adaptive quality lowers both the drawn
 * instance count (balanced prefix, soft cross-fade) and the target viewport.
 * Anything that must stay in front of the clouds (the paper on the lens)
 * needs a higher renderOrder with depthTest off, or a DOM overlay.
 *
 * Everything is driven from mutable singletons inside useFrame / the
 * composite's onBeforeRender — no React state, no per-frame allocation.
 * ========================================================================== */

/** Layout reference count: puff sizes are authored for this many instances. */
const REFERENCE_COUNT = 72;

interface TierBudget {
  /** Instances allocated once at mount. */
  max: number;
  /** Fewest instances drawn however far adaptive quality drops. */
  floor: number;
}

const TIER_BUDGET: Readonly<Record<GpuTier, TierBudget>> = {
  0: { max: 16, floor: 12 },
  1: { max: 28, floor: 20 },
  2: { max: 48, floor: 30 },
  3: { max: 72, floor: 40 },
};

/** The opening shot the curtain layout is authored against. */
const OPENING_EYE = new THREE.Vector3(0, 3, 24);
const OPENING_TARGET = new THREE.Vector3(0, 1.4, 0);
const OPENING_ASPECT_COVER = 1.9;
/** Distance from the opening camera to the deepest layer (world z = zNear). */
const LAYER_SPAN = OPENING_EYE.z - CLOUD_CURTAIN.zNear;

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

/** World matrix of the opening camera (camera convention: looks down −Z). */
const OPENING_MATRIX = new THREE.Matrix4().lookAt(OPENING_EYE, OPENING_TARGET, WORLD_UP).setPosition(OPENING_EYE);
const OPENING_INVERSE = OPENING_MATRIX.clone().invert();

const DAMP = {
  part: 6.5,
  opacity: 6.5,
  dissolve: 6,
  exposure: 6,
  anchor: 10,
  count: 2.5,
} as const;

/* ---------------------------------------------------------------------------
 * Timeline
 * ------------------------------------------------------------------------- */

export interface CurtainTargets {
  /** 0 = closed across the viewport, 1 = fully parted. */
  part: number;
  opacity: number;
  /** 0 = world-anchored opening layout, 1 = camera-anchored return layout. */
  anchor: number;
  /** Scene 10 erosion, 0 → 1. */
  dissolve: number;
  /** Renderer exposure written to sceneFx, 1 → 0 at the very end. */
  exposure: number;
}

const T = CLOUD_CURTAIN.timeline;
const OPEN_SPAN = T.openEnd - T.openStart;
const RETURN_SPAN = T.returnEnd - T.returnStart;
const DISSOLVE_SPAN = T.dissolveEnd - T.dissolveStart;
/** Progress at which the returning curtain has fully sealed the view. */
const RETURN_SEALED = T.returnStart + RETURN_SPAN * 0.8;
/** Mid-journey window (curtain hidden) in which the anchor moves to the camera. */
const HIDDEN_START = T.openEnd;
const HIDDEN_SPAN = T.returnStart - T.openEnd;
const HIDDEN_MID = HIDDEN_START + HIDDEN_SPAN * 0.5;

/**
 * Parting profile (cubic, monotonic, f(0) = 0, f(1) = 1). It eases out so the
 * seam cracks open quickly, glides through the middle of the scene so the
 * two halves stay framed like a theatre curtain (≈0.3 / 0.45 / 0.62 at a
 * quarter / half / three quarters), then accelerates off-frame.
 */
function partingProfile(t: number): number {
  const k = clamp01(t);
  return clamp01(k * (1.747 + k * (-2.667 + k * 1.92)));
}

/** Target curtain state for a given (damped) progress. Pure; writes into `out`. */
export function curtainTargetsAt(progress: number, out: CurtainTargets): CurtainTargets {
  const p = clamp01(progress);
  if (p < HIDDEN_MID) {
    // Opening: part and fade while the camera dollies through the curtain.
    out.part = partingProfile((p - T.openStart) / OPEN_SPAN);
    out.opacity = 1 - smoothstep(T.openStart + OPEN_SPAN * 0.55, T.openEnd - OPEN_SPAN * 0.025, p);
    out.dissolve = 0;
  } else {
    // Return: the opening played in reverse — the halves glide back in from
    // the frame edges and seal the view by RETURN_SEALED. Dissolve: the clouds
    // erode, then fade, while the exposure falls to the void.
    out.part = partingProfile(1 - (p - T.returnStart) / (RETURN_SEALED - T.returnStart));
    out.opacity =
      smoothstep(T.returnStart, T.returnStart + RETURN_SPAN * 0.33, p) *
      (1 - smoothstep(T.dissolveStart + DISSOLVE_SPAN * 0.15, T.dissolveEnd - DISSOLVE_SPAN * 0.1, p));
    out.dissolve = smoothstep(T.dissolveStart, T.dissolveEnd - DISSOLVE_SPAN * 0.15, p);
  }
  // Re-anchor from the world to the camera while nothing is visible.
  out.anchor = smoothstep(HIDDEN_START + HIDDEN_SPAN * 0.25, HIDDEN_START + HIDDEN_SPAN * 0.75, p);
  out.exposure = 1 - smoothstep(T.dissolveStart + DISSOLVE_SPAN * 0.05, T.dissolveEnd - DISSOLVE_SPAN * 0.1, p);
  return out;
}

/* ---------------------------------------------------------------------------
 * Layout
 * ------------------------------------------------------------------------- */

interface Band {
  /** Fraction of the instance budget. */
  share: number;
  /** Distance in front of the opening camera (negative = behind it). */
  dMin: number;
  dMax: number;
  sizeMin: number;
  sizeMax: number;
  /** Lateral reach in units of the frustum half-width. */
  spreadX: number;
  spreadY: number;
  aspectMin: number;
  aspectMax: number;
  /** Peripheral bands hug the frame edges instead of filling the frustum. */
  peripheral: boolean;
}

const BANDS: readonly Band[] = [
  // Backstop: broad stratiform masses that guarantee full coverage at p = 0.
  { share: 0.26, dMin: 12.5, dMax: 18, sizeMin: 8.5, sizeMax: 12, spreadX: 1.1, spreadY: 1.2, aspectMin: 1.3, aspectMax: 1.8, peripheral: false },
  // Body of the curtain: mid-sized cumulus puffs.
  { share: 0.34, dMin: 7, dMax: 12.5, sizeMin: 4.2, sizeMax: 6.6, spreadX: 1.15, spreadY: 1.25, aspectMin: 1.1, aspectMax: 1.5, peripheral: false },
  // Foreground puffs the camera flies through.
  { share: 0.26, dMin: 3, dMax: 7, sizeMin: 1.8, sizeMax: 2.9, spreadX: 1.2, spreadY: 1.3, aspectMin: 1.0, aspectMax: 1.4, peripheral: false },
  // Wisps around (and just behind) the camera, streaming past the frame edges.
  { share: 0.14, dMin: -2, dMax: 3, sizeMin: 1.0, sizeMax: 1.8, spreadX: 1.0, spreadY: 1.2, aspectMin: 1.0, aspectMax: 1.3, peripheral: true },
];

interface CloudLayout {
  count: number;
  /** Size multiplier baked into every diameter (sparser layouts use larger puffs). */
  sizeMul: number;
  /** vec3 per instance — base centre in curtain (opening world) space. */
  center: Float32Array;
  /** vec4 — side, layer, seed, diameter. */
  shape: Float32Array;
  /** vec4 — drift speed, drift phase, rotation, aspect. */
  motion: Float32Array;
  /** vec4 — parting delay, lateral multiplier, lift, importance rank. */
  partTune: Float32Array;
  /** Distance in front of the opening camera; draw order is far → near. */
  depth: Float32Array;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Radical inverse — low-discrepancy, so every prefix of a band is well spread. */
function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/** Splits `total` across the bands by share (largest remainder). */
function bandQuotas(total: number): number[] {
  const raw = BANDS.map((band) => band.share * total);
  const quotas = raw.map((value) => Math.floor(value));
  let remaining = total - quotas.reduce((sum, q) => sum + q, 0);
  const byRemainder = raw.map((value, i) => ({ i, rem: value - Math.floor(value) })).sort((a, b) => b.rem - a.rem);
  for (let k = 0; remaining > 0; k = (k + 1) % byRemainder.length) {
    quotas[byRemainder[k].i] += 1;
    remaining -= 1;
  }
  return quotas;
}

/**
 * Builds `count` puffs in importance order: bands are interleaved by quota
 * and each band walks a Halton sequence, so any prefix (what adaptive
 * quality draws) keeps a balanced left/right and front/back distribution.
 */
export function buildCloudLayout(count: number, seed = 20241018): CloudLayout {
  const rand = mulberry32(seed);
  const sizeMul = Math.min(1.9, Math.sqrt(REFERENCE_COUNT / Math.max(1, count)));
  const layout: CloudLayout = {
    count,
    sizeMul,
    center: new Float32Array(count * 3),
    shape: new Float32Array(count * 4),
    motion: new Float32Array(count * 4),
    partTune: new Float32Array(count * 4),
    depth: new Float32Array(count),
  };

  const forward = new THREE.Vector3().subVectors(OPENING_TARGET, OPENING_EYE).normalize();
  const right = new THREE.Vector3().crossVectors(forward, WORLD_UP).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const tanV = Math.tan(THREE.MathUtils.degToRad(CAMERA_CLIP.fov * 0.5));
  const tanH = tanV * OPENING_ASPECT_COVER;
  const point = new THREE.Vector3();

  const quotas = bandQuotas(count);
  const emitted = BANDS.map(() => 0);

  for (let rank = 0; rank < count; rank += 1) {
    // Pick the band furthest behind its quota (ties → the deeper band).
    let bandIndex = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let b = 0; b < BANDS.length; b += 1) {
      if (emitted[b] >= quotas[b]) continue;
      const fill = (emitted[b] + 0.5) / quotas[b];
      if (fill < best - 1e-9) {
        best = fill;
        bandIndex = b;
      }
    }
    const band = BANDS[bandIndex];
    const k = emitted[bandIndex];
    emitted[bandIndex] += 1;

    const hy = halton(k + 1, 3);
    const hd = halton(k + 1, 5);

    // Sides alternate within every band, and successive bands start on
    // opposite sides, so any prefix is balanced left/right.
    const side = (k + bandIndex) % 2 === 0 ? -1 : 1;
    const pair = (k >> 1) + 1 + (side > 0 ? 1 : 0);
    const reach01 = halton(pair, 2);
    const nx = band.peripheral
      ? side * (0.78 + reach01 * 0.55)
      : side * (0.04 + reach01 * band.spreadX) + (rand() - 0.5) * 0.08;
    const ny = (hy * 2 - 1) * band.spreadY + (rand() - 0.5) * 0.08;
    const d = band.dMin + (band.dMax - band.dMin) * hd;
    const reach = Math.max(d, 2.2);

    point
      .copy(OPENING_EYE)
      .addScaledVector(forward, d)
      .addScaledVector(right, nx * tanH * reach)
      .addScaledVector(up, ny * tanV * reach);

    const layer = THREE.MathUtils.clamp(d / LAYER_SPAN, 0, 1);
    const size = (band.sizeMin + (band.sizeMax - band.sizeMin) * rand()) * sizeMul;
    const aspect = band.aspectMin + (band.aspectMax - band.aspectMin) * rand();
    const inner = Math.min(1, Math.abs(nx) / Math.max(band.spreadX, 1e-3));

    layout.center[rank * 3] = point.x;
    layout.center[rank * 3 + 1] = point.y;
    layout.center[rank * 3 + 2] = point.z;

    layout.shape[rank * 4] = side;
    layout.shape[rank * 4 + 1] = layer;
    layout.shape[rank * 4 + 2] = rand();
    layout.shape[rank * 4 + 3] = size;

    layout.motion[rank * 4] = 0.05 + rand() * 0.12;
    layout.motion[rank * 4 + 1] = rand() * Math.PI * 2;
    layout.motion[rank * 4 + 2] = (rand() - 0.5) * 0.5;
    layout.motion[rank * 4 + 3] = aspect;

    // Inner edges lead the parting; the shader scales travel by view depth.
    layout.partTune[rank * 4] = inner * 0.2 + rand() * 0.06;
    layout.partTune[rank * 4 + 1] = 0.95 + rand() * 0.15;
    layout.partTune[rank * 4 + 2] = (-1.2 + rand() * 3.6) * (0.5 + layer);
    layout.partTune[rank * 4 + 3] = rank;

    layout.depth[rank] = d;
  }

  return layout;
}

/* ---------------------------------------------------------------------------
 * GPU system
 * ------------------------------------------------------------------------- */

interface CloudSystem {
  budget: TierBudget;
  layout: CloudLayout;
  /** Private scene holding the puffs; rendered offscreen, never part of the main graph. */
  cloudScene: THREE.Scene;
  cloudMesh: THREE.Mesh;
  geometry: THREE.InstancedBufferGeometry;
  material: THREE.ShaderMaterial;
  uniforms: CloudCurtainUniforms;
  noise: THREE.DataTexture;
  attributes: {
    center: THREE.InstancedBufferAttribute;
    shape: THREE.InstancedBufferAttribute;
    motion: THREE.InstancedBufferAttribute;
    partTune: THREE.InstancedBufferAttribute;
  };
  /** Premultiplied cloud accumulation target (reduced resolution). */
  target: THREE.WebGLRenderTarget;
  /** Target size = CSS size × this, clamped to the drawing buffer. */
  resolution: number;
  compositeGeometry: THREE.BufferGeometry;
  compositeMaterial: THREE.ShaderMaterial;
  compositeUniforms: CloudCompositeUniforms;
  /** Scratch draw order (layout indices), preallocated. */
  order: Int32Array;
  /** Number of instances currently written to the GPU buffers. */
  built: number;
}

/** Half-float targets keep the premultiplied HDR stack free of banding. */
function supportsHalfFloatTarget(renderer: THREE.WebGLRenderer): boolean {
  return renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
}

function createCloudSystem(tier: GpuTier, halfFloat: boolean): CloudSystem {
  const budget = TIER_BUDGET[tier];
  const layout = buildCloudLayout(budget.max);

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);

  const makeAttribute = (itemSize: number): THREE.InstancedBufferAttribute => {
    const attribute = new THREE.InstancedBufferAttribute(new Float32Array(budget.max * itemSize), itemSize);
    attribute.setUsage(THREE.DynamicDrawUsage);
    return attribute;
  };
  const attributes = {
    center: makeAttribute(3),
    shape: makeAttribute(4),
    motion: makeAttribute(4),
    partTune: makeAttribute(4),
  };
  geometry.setAttribute('aCenter', attributes.center);
  geometry.setAttribute('aShape', attributes.shape);
  geometry.setAttribute('aMotion', attributes.motion);
  geometry.setAttribute('aPartTune', attributes.partTune);
  geometry.instanceCount = 0;
  // Billboards are expanded in the shader; culling is handled per instance there.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), CAMERA_CLIP.far);

  const noise = createCloudNoiseTexture();
  const uniforms = createCloudCurtainUniforms(noise);
  // Depth/size metadata in the layout (layer = depth / LAYER_SPAN) and the
  // shader's parting + approach fade share one reference distance.
  uniforms.uPartDepth.value = LAYER_SPAN;
  uniforms.uLayoutScale.value = layout.sizeMul;
  if (tier <= 1) uniforms.uCoverage.value += 0.05;

  const material = new THREE.ShaderMaterial({
    name: 'CloudCurtainMaterial',
    vertexShader: CLOUD_CURTAIN_VERTEX_SHADER,
    fragmentShader: CLOUD_CURTAIN_FRAGMENT_SHADER,
    uniforms,
    defines: cloudCurtainDefines(tier),
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.FrontSide,
    fog: false,
    // Rendering into a render target never tone-maps (three uses
    // NoToneMapping + linear output there); the composite applies both once.
    toneMapped: true,
  });
  applyCloudAccumulationBlending(material);

  const cloudMesh = new THREE.Mesh(geometry, material);
  cloudMesh.name = 'CloudCurtainPuffs';
  cloudMesh.frustumCulled = false;
  cloudMesh.matrixAutoUpdate = false;
  const cloudScene = new THREE.Scene();
  cloudScene.name = 'CloudCurtainOffscreen';
  cloudScene.add(cloudMesh);

  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false,
    colorSpace: THREE.NoColorSpace,
  });
  target.texture.name = 'CloudCurtainTarget';

  const compositeUniforms = createCloudCompositeUniforms();
  compositeUniforms.uClouds.value = target.texture;
  const compositeMaterial = new THREE.ShaderMaterial({
    name: 'CloudCurtainComposite',
    vertexShader: CLOUD_COMPOSITE_VERTEX_SHADER,
    fragmentShader: CLOUD_COMPOSITE_FRAGMENT_SHADER,
    uniforms: compositeUniforms,
    transparent: true,
    depthWrite: false,
    // The curtain always sits between the camera and the world it hides.
    depthTest: false,
    blending: THREE.NormalBlending,
    fog: false,
    toneMapped: true,
  });

  return {
    budget,
    layout,
    cloudScene,
    cloudMesh,
    geometry,
    material,
    uniforms,
    noise,
    attributes,
    target,
    resolution: cloudCurtainResolution(tier),
    compositeGeometry: createFullscreenTriangle(),
    compositeMaterial,
    compositeUniforms,
    order: new Int32Array(budget.max),
    built: -1,
  };
}

/**
 * Frees every GPU resource. The CPU-side objects stay intact, so a system
 * reused after a StrictMode effect replay simply re-uploads on its next draw.
 */
function disposeCloudSystem(system: CloudSystem): void {
  system.geometry.dispose();
  system.material.dispose();
  system.noise.dispose();
  system.target.dispose();
  system.compositeGeometry.dispose();
  system.compositeMaterial.dispose();
}

/**
 * Writes the first `count` instances (by importance) into the GPU buffers,
 * sorted far → near along the opening view so alpha blending composites
 * correctly. Runs only when the drawn count changes; allocation free.
 */
function writeInstances(system: CloudSystem, count: number): void {
  const { layout, order, attributes } = system;
  for (let i = 0; i < count; i += 1) order[i] = i;
  for (let i = 1; i < count; i += 1) {
    const value = order[i];
    const key = layout.depth[value];
    let j = i - 1;
    while (j >= 0 && layout.depth[order[j]] < key) {
      order[j + 1] = order[j];
      j -= 1;
    }
    order[j + 1] = value;
  }

  const center = attributes.center.array as Float32Array;
  const shape = attributes.shape.array as Float32Array;
  const motion = attributes.motion.array as Float32Array;
  const partTune = attributes.partTune.array as Float32Array;
  for (let slot = 0; slot < count; slot += 1) {
    const src = order[slot];
    center[slot * 3] = layout.center[src * 3];
    center[slot * 3 + 1] = layout.center[src * 3 + 1];
    center[slot * 3 + 2] = layout.center[src * 3 + 2];
    for (let c = 0; c < 4; c += 1) {
      shape[slot * 4 + c] = layout.shape[src * 4 + c];
      motion[slot * 4 + c] = layout.motion[src * 4 + c];
      partTune[slot * 4 + c] = layout.partTune[src * 4 + c];
    }
  }
  attributes.center.needsUpdate = true;
  attributes.shape.needsUpdate = true;
  attributes.motion.needsUpdate = true;
  attributes.partTune.needsUpdate = true;
  system.geometry.instanceCount = count;
  system.built = count;
}

interface CurtainState {
  initialized: boolean;
  part: number;
  opacity: number;
  dissolve: number;
  exposure: number;
  anchor: number;
  /** Damped drawn-instance count (float, for soft cross-fades). */
  count: number;
  /** Damped fraction of the cloud target's viewport in use (adaptive quality). */
  resolution: number;
  time: number;
}

const _targets: CurtainTargets = { part: 0, opacity: 1, anchor: 0, dissolve: 0, exposure: 1 };
const _relative = new THREE.Matrix4();
const _relativePosition = new THREE.Vector3();
const _relativeQuaternion = new THREE.Quaternion();
const _relativeScale = new THREE.Vector3();
const _anchorPosition = new THREE.Vector3();
const _anchorQuaternion = new THREE.Quaternion();
const _cameraPosition = new THREE.Vector3();
const _cssSize = new THREE.Vector2();
const _bufferSize = new THREE.Vector2();
const _savedClearColor = new THREE.Color();

/**
 * Resolves the anchor and camera-dependent uniforms, then renders the puffs
 * into the reduced-resolution target. Called from the composite's
 * onBeforeRender, i.e. after every useFrame (including the camera rig) has
 * moved the camera this frame, and only while the curtain is visible.
 * Every piece of renderer state it touches is restored. Allocation free.
 */
function renderCloudTarget(
  system: CloudSystem,
  s: CurtainState,
  renderer: THREE.WebGLRenderer,
  renderCamera: THREE.Camera,
  mainCamera: THREE.Camera,
): void {
  const { cloudMesh, uniforms, target, compositeUniforms } = system;

  // World-anchored opening layout → camera-anchored return layout
  // (camera.matrixWorld × inverse(opening camera)), blended by s.anchor.
  if (s.anchor <= 1e-4) {
    cloudMesh.matrix.identity();
  } else {
    _relative.multiplyMatrices(mainCamera.matrixWorld, OPENING_INVERSE);
    _relative.decompose(_relativePosition, _relativeQuaternion, _relativeScale);
    _anchorPosition.copy(_relativePosition).multiplyScalar(s.anchor);
    _anchorQuaternion.identity().slerp(_relativeQuaternion, s.anchor);
    cloudMesh.matrix.compose(_anchorPosition, _anchorQuaternion, UNIT_SCALE);
  }
  cloudMesh.matrixWorldNeedsUpdate = true;

  // Opening dolly (world-anchored phase only): how far the camera has moved
  // from the opening eye, consumed by the per-layer parallax follow.
  _cameraPosition.setFromMatrixPosition(mainCamera.matrixWorld);
  uniforms.uDolly.value.subVectors(_cameraPosition, OPENING_EYE).multiplyScalar(1 - s.anchor);
  uniforms.uSunView.value.copy(SUN_DIRECTION).transformDirection(renderCamera.matrixWorldInverse);

  // Target size follows the canvas in CSS pixels; the used viewport shrinks
  // with adaptive quality (no reallocation, the composite rescales its uvs).
  renderer.getSize(_cssSize);
  renderer.getDrawingBufferSize(_bufferSize);
  const fullWidth = Math.max(1, Math.min(_bufferSize.x, Math.round(_cssSize.x * system.resolution)));
  const fullHeight = Math.max(1, Math.min(_bufferSize.y, Math.round(_cssSize.y * system.resolution)));
  if (target.width !== fullWidth || target.height !== fullHeight) target.setSize(fullWidth, fullHeight);
  const usedWidth = Math.max(1, Math.round(fullWidth * s.resolution));
  const usedHeight = Math.max(1, Math.round(fullHeight * s.resolution));
  target.viewport.set(0, 0, usedWidth, usedHeight);
  compositeUniforms.uUvScale.value.set(usedWidth / fullWidth, usedHeight / fullHeight);
  compositeUniforms.uUvMax.value.set((usedWidth - 0.5) / fullWidth, (usedHeight - 0.5) / fullHeight);

  const previousTarget = renderer.getRenderTarget();
  const previousCubeFace = renderer.getActiveCubeFace();
  const previousMipmapLevel = renderer.getActiveMipmapLevel();
  const previousAutoClear = renderer.autoClear;
  const previousClearAlpha = renderer.getClearAlpha();
  renderer.getClearColor(_savedClearColor);
  const previousInfoReset = renderer.info.autoReset;
  const previousXr = renderer.xr.enabled;
  const previousShadowAutoUpdate = renderer.shadowMap.autoUpdate;

  renderer.xr.enabled = false;
  renderer.shadowMap.autoUpdate = false;
  // Count the cloud draw in this frame's stats instead of resetting them.
  renderer.info.autoReset = false;
  renderer.autoClear = false;
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  renderer.render(system.cloudScene, renderCamera);

  renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
  renderer.setClearColor(_savedClearColor, previousClearAlpha);
  renderer.autoClear = previousAutoClear;
  renderer.info.autoReset = previousInfoReset;
  renderer.shadowMap.autoUpdate = previousShadowAutoUpdate;
  renderer.xr.enabled = previousXr;
}

/* ---------------------------------------------------------------------------
 * Component
 * ------------------------------------------------------------------------- */

export function CloudCurtain(): JSX.Element {
  const meshRef = useRef<THREE.Mesh>(null);
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);
  const cameraRef = useRef<THREE.Camera>(camera);
  cameraRef.current = camera;

  // Detail is fixed by the GPU tier at mount; density changes never rebuild GPU resources.
  const system = useMemo(() => createCloudSystem(scrollStore.gpuTier, supportsHalfFloatTarget(gl)), [gl]);
  const state = useRef<CurtainState>({
    initialized: false,
    part: 0,
    opacity: 1,
    dissolve: 0,
    exposure: 1,
    anchor: 0,
    count: system.budget.max,
    resolution: 1,
    time: 0,
  });

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return undefined;
    // Inspection handle for tooling (overdraw / debug views); never read at runtime.
    mesh.userData.cloudScene = system.cloudScene;
    mesh.onBeforeRender = (renderer, _scene, renderCamera) => {
      renderCloudTarget(system, state.current, renderer, renderCamera, cameraRef.current);
    };
    return () => {
      mesh.onBeforeRender = NOOP_BEFORE_RENDER;
      delete mesh.userData.cloudScene;
    };
  }, [system]);

  // Compile the offscreen variant (linear, no tone mapping) up front so the
  // return at the end of the journey never hitches on a shader compile.
  useLayoutEffect(() => {
    const previousTarget = gl.getRenderTarget();
    gl.setRenderTarget(system.target);
    gl.compile(system.cloudScene, camera);
    gl.setRenderTarget(previousTarget);
  }, [gl, camera, system]);

  useLayoutEffect(
    () => () => {
      disposeCloudSystem(system);
      // Without a curtain nothing may keep the world dimmed or covered.
      sceneFx.exposure = 1;
      sceneFx.curtainOpacity = 0;
      sceneFx.curtainPart = 1;
    },
    [system],
  );

  useFrame((_frame, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dt = Math.min(Math.max(delta, 0), 0.1);
    const s = state.current;
    const targets = curtainTargetsAt(scrollStore.dampedProgress, _targets);
    const targetCount = adaptiveQuality.countFor(system.budget.max, system.budget.floor);
    const densityRange = adaptiveQuality.maxDensity - adaptiveQuality.minDensity;
    const densityK =
      densityRange > 1e-3 ? clamp01((adaptiveQuality.particleDensity - adaptiveQuality.minDensity) / densityRange) : 1;
    const targetResolution = CLOUD_MIN_VIEWPORT_FRACTION + (1 - CLOUD_MIN_VIEWPORT_FRACTION) * densityK;

    if (!s.initialized) {
      // First frame: start from the state the current progress implies.
      s.initialized = true;
      s.part = targets.part;
      s.opacity = targets.opacity;
      s.dissolve = targets.dissolve;
      s.exposure = targets.exposure;
      s.anchor = targets.anchor;
      s.count = targetCount;
      s.resolution = targetResolution;
    } else {
      s.part = THREE.MathUtils.damp(s.part, targets.part, DAMP.part, dt);
      s.opacity = THREE.MathUtils.damp(s.opacity, targets.opacity, DAMP.opacity, dt);
      s.dissolve = THREE.MathUtils.damp(s.dissolve, targets.dissolve, DAMP.dissolve, dt);
      s.exposure = THREE.MathUtils.damp(s.exposure, targets.exposure, DAMP.exposure, dt);
      s.anchor = THREE.MathUtils.damp(s.anchor, targets.anchor, DAMP.anchor, dt);
      s.count = THREE.MathUtils.damp(s.count, targetCount, DAMP.count, dt);
      s.resolution = THREE.MathUtils.damp(s.resolution, targetResolution, DAMP.count, dt);
    }
    s.time += dt;

    sceneFx.curtainOpacity = s.opacity;
    sceneFx.curtainPart = s.part;
    sceneFx.exposure = s.exposure;

    // Hidden → the composite is skipped and so is the offscreen pass: zero cost.
    const visible = s.opacity > 0.003;
    mesh.visible = visible;
    if (!visible) return;

    const drawCount = Math.min(system.budget.max, Math.max(1, Math.ceil(s.count - 1e-3)));
    if (drawCount !== system.built) writeInstances(system, drawCount);

    const u = system.uniforms;
    u.uTime.value = s.time;
    u.uPart.value = s.part;
    u.uCurtainOpacity.value = s.opacity;
    u.uDissolve.value = s.dissolve;
    u.uCount.value = s.count;
    u.uScaleMul.value = Math.min(1.6, Math.sqrt(system.budget.max / Math.max(1, s.count)));
  });

  return (
    <mesh
      ref={meshRef}
      name="CloudCurtainComposite"
      geometry={system.compositeGeometry}
      material={system.compositeMaterial}
      frustumCulled={false}
      renderOrder={CLOUD_CURTAIN_RENDER_ORDER}
      castShadow={false}
      receiveShadow={false}
      raycast={NOOP_RAYCAST}
    />
  );
}

function NOOP_BEFORE_RENDER(): void {}

/** The composite triangle lives in clip space; it must never be hit by scene raycasts. */
function NOOP_RAYCAST(): void {}

export default CloudCurtain;
