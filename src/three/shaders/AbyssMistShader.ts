import * as THREE from 'three';
import type { GpuTier } from '../../store/scrollStore';

/* ==========================================================================
 * Abyss mist + chasm particles (spindrift, dust motes, rock-fall debris).
 *
 * Mist: one instanced draw per chasm. Every instance is either
 *   - a horizontal LAYER pooled deep in the gap (a stack of them, darker and
 *     denser with depth, so looking down the gap reads as bottomless), or
 *   - a vertical VEIL (cylindrical billboard) of mist welling up out of the
 *     abyss with the updraft, for the near-horizontal hero views.
 * The fragment stage builds each sheet from a tileable FBM texture (domain
 * warped, drifting, churning) inside a noise-perturbed rounded footprint that
 * always reaches zero before the quad edge — no sheet edges, ever. Layers
 * fade out at grazing view angles; veils fade out when looked down upon, so
 * whichever reads best for the current view carries the effect.
 *
 * Particles: one instanced camera-facing quad per particle, animated entirely
 * in the vertex shader from deterministic per-particle loops (no CPU work per
 * frame). Kinds: 0 sun-glint mote, 1 spindrift puff, 2 rock-break dust puff,
 * 3 gravel, 4 wind-borne snow streak. Kinds 2/3 belong to burst slots whose
 * position / start time the CPU writes into a small uniform ring buffer when
 * a rock breaks off (or a foot kicks the lip), so the debris is synchronised
 * with the event without any per-frame buffer upload.
 *
 * All materials are tone mapped like the rest of the world and use the scene
 * fog. Mesh model matrices are identity (world-space attributes).
 * ========================================================================== */

export type ChasmFxQuality = 0 | 1 | 2;

export function chasmFxQualityFor(tier: GpuTier): ChasmFxQuality {
  if (tier >= 2) return 2;
  if (tier === 1) return 1;
  return 0;
}

/* --------------------------------------------------------------------------
 * Tileable FBM noise texture (RGBA8, generated once at mount).
 *   R, G  4-octave gradient FBM (different seeds), base period 4
 *   B     3-octave gradient FBM, base period 8 (finer)
 *   A     4-octave billow FBM (|noise|), base period 4
 * Each channel is auto-levelled to the full 0..1 range.
 * ------------------------------------------------------------------------ */

export const CHASM_NOISE_SIZE = 128;

/** Deterministic PRNG (mulberry32) returning [0, 1). */
export function chasmRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Lattice {
  period: number;
  gx: Float32Array;
  gy: Float32Array;
}

function makeLattice(period: number, rand: () => number): Lattice {
  const gx = new Float32Array(period * period);
  const gy = new Float32Array(period * period);
  for (let i = 0; i < gx.length; i += 1) {
    const angle = rand() * Math.PI * 2;
    gx[i] = Math.cos(angle);
    gy[i] = Math.sin(angle);
  }
  return { period, gx, gy };
}

/** Periodic 2D gradient noise, roughly in [-0.7, 0.7]. */
function gradientNoise(l: Lattice, x: number, y: number): number {
  const P = l.period;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const x0 = ((xi % P) + P) % P;
  const y0 = ((yi % P) + P) % P;
  const x1 = (x0 + 1) % P;
  const y1 = (y0 + 1) % P;
  const i00 = y0 * P + x0;
  const i10 = y0 * P + x1;
  const i01 = y1 * P + x0;
  const i11 = y1 * P + x1;
  const n00 = l.gx[i00] * fx + l.gy[i00] * fy;
  const n10 = l.gx[i10] * (fx - 1) + l.gy[i10] * fy;
  const n01 = l.gx[i01] * fx + l.gy[i01] * (fy - 1);
  const n11 = l.gx[i11] * (fx - 1) + l.gy[i11] * (fy - 1);
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return a + (b - a) * v;
}

interface ChannelSpec {
  basePeriod: number;
  octaves: number;
  billow: boolean;
  seed: number;
}

const NOISE_CHANNELS: readonly ChannelSpec[] = [
  { basePeriod: 4, octaves: 4, billow: false, seed: 0x1b873593 },
  { basePeriod: 4, octaves: 4, billow: false, seed: 0x7f4a7c15 },
  { basePeriod: 8, octaves: 3, billow: false, seed: 0x2545f491 },
  { basePeriod: 4, octaves: 4, billow: true, seed: 0x5bd1e995 },
];

export function createChasmNoiseTexture(size = CHASM_NOISE_SIZE): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const values = new Float32Array(size * size);
  for (let c = 0; c < NOISE_CHANNELS.length; c += 1) {
    const spec = NOISE_CHANNELS[c];
    const rand = chasmRandom(spec.seed);
    const lattices: Lattice[] = [];
    for (let o = 0; o < spec.octaves; o += 1) lattices.push(makeLattice(spec.basePeriod << o, rand));
    let min = Infinity;
    let max = -Infinity;
    for (let py = 0; py < size; py += 1) {
      const v = py / size;
      for (let px = 0; px < size; px += 1) {
        const u = px / size;
        let sum = 0;
        let amp = 1;
        for (let o = 0; o < lattices.length; o += 1) {
          const l = lattices[o];
          const n = gradientNoise(l, u * l.period, v * l.period);
          sum += amp * (spec.billow ? Math.abs(n) : n);
          amp *= 0.5;
        }
        const index = py * size + px;
        values[index] = sum;
        if (sum < min) min = sum;
        if (sum > max) max = sum;
      }
    }
    const range = Math.max(1e-6, max - min);
    for (let i = 0; i < values.length; i += 1) {
      data[i * 4 + c] = Math.round(((values[i] - min) / range) * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/* --------------------------------------------------------------------------
 * Shared GLSL
 * ------------------------------------------------------------------------ */

const SAFETY_GLSL = /* glsl */ `
// Hard guarantee that a sheet is fully transparent before its quad edge.
float quadSafety( vec2 q ) {
  return ( 1.0 - smoothstep( 0.8, 0.97, abs( q.x ) ) ) * ( 1.0 - smoothstep( 0.8, 0.97, abs( q.y ) ) );
}
`;

/* --------------------------------------------------------------------------
 * Abyss mist
 * ------------------------------------------------------------------------ */

export const ABYSS_MIST_VERTEX_SHADER = /* glsl */ `
attribute vec4 aFrame;  // chasm frame: origin.xz, axis.xz (unit; across = (axis.y, -axis.x))
attribute vec4 aBox;    // layer: centre a, centre n, half a, half n | veil: anchor a, anchor n, half width (top), bottom width fraction
attribute vec4 aLayer;  // y (layer height | veil bottom), seed, opacity, kind (0 layer, 1 veil)
attribute vec4 aShape;  // taper (layer) | height (veil), depth 0 (top) .. 1 (deepest), rank, drift (layer) | rise (veil) speed

uniform float uCount;

varying vec3 vWorld;
varying vec2 vLocal;
varying vec4 vBox;
varying vec4 vLayer;
varying vec4 vShape;
varying vec2 vAxis;
varying float vRank;

#include <fog_pars_vertex>

void main() {
  vec2 axis = aFrame.zw;
  vec2 across = vec2( axis.y, -axis.x );
  vec2 q = position.xy;
  vec3 world;
  if ( aLayer.w < 0.5 ) {
    vec2 xz = aFrame.xy + axis * ( aBox.x + q.x * aBox.z ) + across * ( aBox.y + q.y * aBox.w );
    world = vec3( xz.x, aLayer.x, xz.y );
  } else {
    vec2 anchor = aFrame.xy + axis * aBox.x + across * aBox.y;
    vec2 toCam = cameraPosition.xz - anchor;
    float len = length( toCam );
    vec2 dir = len > 1e-4 ? toCam / len : vec2( 0.0, 1.0 );
    vec2 side = vec2( -dir.y, dir.x );
    vec2 xz = anchor + side * ( q.x * aBox.z );
    world = vec3( xz.x, aLayer.x + ( q.y * 0.5 + 0.5 ) * aShape.x, xz.y );
  }
  vWorld = world;
  vLocal = q;
  vBox = aBox;
  vLayer = aLayer;
  vShape = aShape;
  vAxis = axis;
  vRank = clamp( uCount - aShape.z, 0.0, 1.0 );
  vec4 mvPosition = modelViewMatrix * vec4( world, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  // Sheets beyond the adaptive count collapse outside the clip volume (no fill cost).
  if ( vRank < 0.002 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
  #include <fog_vertex>
}
`;

export const ABYSS_MIST_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uNoise;
uniform float uTime;
uniform float uIntensity;
uniform vec3 uTopColor;
uniform vec3 uDeepColor;
uniform vec3 uLitColor;
uniform vec2 uSunXZ;

varying vec3 vWorld;
varying vec2 vLocal;
varying vec4 vBox;
varying vec4 vLayer;
varying vec4 vShape;
varying vec2 vAxis;
varying float vRank;

#include <fog_pars_fragment>
${SAFETY_GLSL}

void main() {
  float seed = vLayer.y;
  float depth = vShape.y;
  float t = uTime;
  vec3 toCam = cameraPosition - vWorld;
  float dist = length( toCam );
  vec3 viewDir = toCam / max( dist, 1e-4 );

  float alpha;
  vec3 col;

  if ( vLayer.w < 0.5 ) {
    /* ---- Horizontal layer: churning pool, darker and denser with depth. ---- */
    float taper = mix( 1.0 - vShape.x, 1.0, vLocal.x * 0.5 + 0.5 );
    vec2 q = vec2( vLocal.x, vLocal.y / max( taper, 0.05 ) );
    // Drift along the chasm axis; each layer its own speed (parallax between layers).
    vec2 p = vWorld.xz - vAxis * ( vShape.w * t );
    vec2 uv = p * 0.075 + vec2( seed * 7.13, seed * 3.71 );
    vec2 warp = texture2D( uNoise, uv * 0.43 + vec2( t * 0.012, -t * 0.009 ) ).rg - 0.5;
    vec2 wuv = uv + warp * 0.62;
    float d1 = texture2D( uNoise, wuv ).r;
#if QUALITY > 0
    float d2 = texture2D( uNoise, uv * 2.7 - warp * 0.4 + vec2( 0.31, t * 0.019 ) ).a;
    float dens = d1 * 0.64 + d2 * 0.36;
#else
    float dens = d1;
#endif
    // Billowy rounded footprint (the walls swallow its fringe; never a straight edge).
    vec2 e = abs( q ) + ( vec2( d1, dens ) - 0.5 ) * 0.34;
    float box = length( max( e - vec2( 0.4 ), 0.0 ) ) / 0.56;
    float foot = ( 1.0 - smoothstep( 0.0, 1.0, box ) ) * quadSafety( vLocal );
    // Top layers are patchy wisps, deep layers an almost solid churning floor.
    float lo = mix( 0.44, 0.06, depth );
    float m = smoothstep( lo, lo + mix( 0.3, 0.5, depth ), dens );
#if QUALITY > 1
    // Fake self-shadowing: brighter where the density falls off toward the sun.
    float ds = texture2D( uNoise, wuv + uSunXZ * 0.045 ).r;
    float lit = clamp( 0.78 + ( d1 - ds ) * 3.2, 0.4, 1.45 );
#else
    float lit = 0.8 + 0.4 * d1;
#endif
    col = mix( uTopColor, uDeepColor, depth ) * lit;
    col += uLitColor * ( 1.0 - depth ) * ( 1.0 - depth ) * max( lit - 0.95, 0.0 ) * 0.9;
    // Thin sheets vanish at grazing angles instead of collapsing into lines.
    float viewFade = smoothstep( 0.1, 0.4, abs( viewDir.y ) );
    alpha = m * foot * vLayer.z * viewFade;
  } else {
    /* ---- Vertical veil: mist welling up the gap, wispy and churning at its top. ---- */
    float yN = vLocal.y * 0.5 + 0.5;
    float x = vLocal.x / max( mix( vBox.w, 1.0, yN ), 0.05 );
    float riseT = t * vShape.w;
    vec2 uv = vec2( vLocal.x * vBox.z * 0.12 + seed * 5.1, vWorld.y * 0.085 - riseT );
    vec2 warp = texture2D( uNoise, uv * 0.47 + vec2( -t * 0.011, seed - riseT * 0.35 ) ).rg - 0.5;
    vec2 wuv = uv + warp * vec2( 0.55, 0.8 );
    float d1 = texture2D( uNoise, wuv ).r;
#if QUALITY > 0
    float d2 = texture2D( uNoise, wuv * 2.3 + vec2( 0.53, -riseT * 0.6 ) ).a;
    float dens = d1 * 0.6 + d2 * 0.4;
#else
    float dens = d1;
#endif
    float topEdge = 1.0 - smoothstep( 0.2 + 0.45 * dens, 0.97, yN );
    float sideEdge = 1.0 - smoothstep( 0.25, 0.95, abs( x ) + ( d1 - 0.5 ) * 0.4 );
    float bottom = smoothstep( 0.0, 0.14, yN );
    float m = smoothstep( 0.22, 0.72, dens * mix( 1.3, 0.85, yN ) );
    // Looking steeply down the gap, the horizontal layers carry the mist.
    float viewFade = 1.0 - smoothstep( 0.62, 0.9, abs( viewDir.y ) );
    alpha = m * topEdge * sideEdge * bottom * quadSafety( vLocal ) * vLayer.z * viewFade;
    float lift = smoothstep( 0.05, 0.85, yN );
    col = mix( uDeepColor, uTopColor, lift ) * ( 0.82 + 0.36 * dens );
    col += uLitColor * smoothstep( 0.55, 1.0, yN ) * dens * 0.35;
  }

  // Never a blurry sheet right on the lens.
  alpha *= smoothstep( 1.0, 5.0, dist ) * uIntensity * vRank;
  if ( alpha < 0.002 ) discard;
  gl_FragColor = vec4( col, min( alpha, 1.0 ) );
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export type AbyssMistUniforms = {
  uNoise: THREE.IUniform<THREE.Texture>;
  uTime: THREE.IUniform<number>;
  uIntensity: THREE.IUniform<number>;
  uCount: THREE.IUniform<number>;
  uTopColor: THREE.IUniform<THREE.Color>;
  uDeepColor: THREE.IUniform<THREE.Color>;
  uLitColor: THREE.IUniform<THREE.Color>;
  uSunXZ: THREE.IUniform<THREE.Vector2>;
};

export interface AbyssMistColors {
  top: THREE.ColorRepresentation;
  deep: THREE.ColorRepresentation;
  lit: THREE.ColorRepresentation;
}

export interface AbyssMistMaterial {
  material: THREE.ShaderMaterial;
  uniforms: AbyssMistUniforms;
}

export function createAbyssMistMaterial(
  noise: THREE.Texture,
  quality: ChasmFxQuality,
  colors: AbyssMistColors,
  sunDirection: THREE.Vector3,
): AbyssMistMaterial {
  const sunXZ = new THREE.Vector2(sunDirection.x, sunDirection.z);
  if (sunXZ.lengthSq() > 1e-8) sunXZ.normalize();
  const uniforms: AbyssMistUniforms = {
    uNoise: { value: noise },
    uTime: { value: 0 },
    uIntensity: { value: 0 },
    uCount: { value: 0 },
    uTopColor: { value: new THREE.Color(colors.top) },
    uDeepColor: { value: new THREE.Color(colors.deep) },
    uLitColor: { value: new THREE.Color(colors.lit) },
    uSunXZ: { value: sunXZ },
  };
  const material = new THREE.ShaderMaterial({
    name: 'AbyssMist',
    vertexShader: ABYSS_MIST_VERTEX_SHADER,
    fragmentShader: ABYSS_MIST_FRAGMENT_SHADER,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...uniforms },
    defines: { QUALITY: quality },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: true,
  });
  return { material, uniforms };
}

/** One mist sheet, in the chasm's local frame (see aFrame / aBox docs above). */
export interface MistSheetSpec {
  kind: 'layer' | 'veil';
  /** Layer: height. Veil: bottom height. */
  y: number;
  /** Local centre / anchor along the chasm axis and across it. */
  a: number;
  n: number;
  /** Layer: half extents along / across. Veil: top half width and bottom width fraction. */
  halfA: number;
  halfN: number;
  /** Layer: across-taper toward the -axis end (0 = rectangle). Veil: height. */
  shape: number;
  /** 0 = top layer .. 1 = deepest. */
  depth: number;
  opacity: number;
  /** Adaptive-quality rank: the sheet is drawn while rank < count. */
  rank: number;
  /** Layer drift (units/s along the axis) or veil rise speed (noise units/s). */
  speed: number;
  seed: number;
}

export interface ChasmFrameSpec {
  originX: number;
  originZ: number;
  axisX: number;
  axisZ: number;
}

function createUnitQuad(geometry: THREE.BufferGeometry): void {
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
}

/** Instanced sheets for one chasm (draw order = array order; put the deepest first). */
export function createAbyssMistGeometry(
  frame: ChasmFrameSpec,
  sheets: readonly MistSheetSpec[],
  bounds: THREE.Sphere,
): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  createUnitQuad(geometry);
  const count = sheets.length;
  const aFrame = new Float32Array(count * 4);
  const aBox = new Float32Array(count * 4);
  const aLayer = new Float32Array(count * 4);
  const aShape = new Float32Array(count * 4);
  sheets.forEach((s, i) => {
    aFrame.set([frame.originX, frame.originZ, frame.axisX, frame.axisZ], i * 4);
    aBox.set([s.a, s.n, s.halfA, s.halfN], i * 4);
    aLayer.set([s.y, s.seed, s.opacity, s.kind === 'layer' ? 0 : 1], i * 4);
    aShape.set([s.shape, s.depth, s.rank, s.speed], i * 4);
  });
  geometry.setAttribute('aFrame', new THREE.InstancedBufferAttribute(aFrame, 4));
  geometry.setAttribute('aBox', new THREE.InstancedBufferAttribute(aBox, 4));
  geometry.setAttribute('aLayer', new THREE.InstancedBufferAttribute(aLayer, 4));
  geometry.setAttribute('aShape', new THREE.InstancedBufferAttribute(aShape, 4));
  geometry.instanceCount = count;
  geometry.boundingSphere = bounds.clone();
  geometry.boundingBox = new THREE.Box3().setFromCenterAndSize(bounds.center, new THREE.Vector3().setScalar(bounds.radius * 2));
  return geometry;
}

/* --------------------------------------------------------------------------
 * Chasm particles
 * ------------------------------------------------------------------------ */

export const PARTICLE_KIND = {
  mote: 0,
  puff: 1,
  dust: 2,
  gravel: 3,
  windSnow: 4,
} as const;

export type ParticleKind = (typeof PARTICLE_KIND)[keyof typeof PARTICLE_KIND];

/** Burst ring-buffer size per particle material. */
export const BURST_SLOTS = 10;

export const CHASM_PARTICLE_VERTEX_SHADER = /* glsl */ `
#define BURST_SLOTS ${BURST_SLOTS}
const float GRAVITY = 9.81;

attribute vec4 aStart;   // ambient: start position, kind | burst: offset within the source, kind
attribute vec4 aVel;     // ambient: velocity, period | burst: velocity spread, unused
attribute vec4 aSeed;    // x phase, y size, z swirl (ambient) | launch speed (gravel), w burst slot
attribute float aRank;

uniform float uTime;
uniform float uFade;
uniform float uCount;
uniform float uGlint;
uniform vec4 uBurstPos[ BURST_SLOTS ];   // xyz source, w start time
uniform vec4 uBurstDir[ BURST_SLOTS ];   // xyz launch direction (unit), w source size
uniform vec3 uWind;
uniform vec3 uSunDir;
uniform vec3 uSnowColor;
uniform vec3 uDustColor;
uniform vec3 uGravelColor;
uniform vec3 uSunColor;

varying vec2 vQuad;
varying vec4 vColor;
varying float vSoft;
varying vec2 vNoiseUv;

#include <fog_pars_vertex>

void main() {
  float kind = aStart.w;
  vec3 center;
  vec3 vel;
  float size;
  float alpha;
  vec3 color;
  float soft = 0.0;

  if ( kind < 1.5 || kind > 3.5 ) {
    // Ambient loops: motes, spindrift puffs, wind-borne snow.
    float period = aVel.w;
    float life = fract( uTime / period + aSeed.x );
    float tt = life * period;
    float ph = aSeed.x * 6.2831853;
    float sw = aSeed.z;
    vec3 swirl = vec3( sin( tt * 1.31 + ph ), 0.45 * sin( tt * 0.87 + ph * 1.7 ), cos( tt * 1.07 + ph * 2.3 ) ) * sw;
    center = aStart.xyz + aVel.xyz * tt + swirl;
    vel = aVel.xyz;
    alpha = smoothstep( 0.0, 0.16, life ) * ( 1.0 - smoothstep( 0.6, 1.0, life ) );
    if ( kind < 0.5 ) {
      size = aSeed.y;
      float tw = 0.5 + 0.5 * sin( uTime * 5.3 + aSeed.x * 61.0 );
      color = uSnowColor * ( 0.75 + uGlint * tw * tw * tw );
      alpha *= 0.85;
    } else if ( kind < 1.5 ) {
      size = aSeed.y * mix( 0.45, 1.3, life );
      color = uSnowColor * 0.92;
      alpha *= 0.2;
      soft = 1.0;
    } else {
      size = aSeed.y;
      color = uSnowColor;
      alpha *= 0.55;
    }
  } else {
    int slot = int( aSeed.w + 0.5 );
    vec4 bp = uBurstPos[ slot ];
    vec4 bd = uBurstDir[ slot ];
    float tt = uTime - bp.w;
    if ( kind < 2.5 ) {
      // Dust cloud blooming where the rock tore loose; the wind takes it.
      float grow = 1.0 - exp( -max( tt, 0.0 ) * 1.7 );
      center = bp.xyz + aStart.xyz * bd.w + bd.xyz * ( 0.35 + 1.2 * grow ) * ( 0.6 + bd.w ) + aVel.xyz * grow
        + uWind * ( tt * 0.45 ) + vec3( 0.0, -0.45 * tt, 0.0 );
      vel = uWind * 0.45;
      size = ( 0.35 + bd.w ) * ( 0.55 + 2.1 * grow ) * aSeed.y;
      alpha = 0.5 * smoothstep( 0.0, 0.07, tt ) * ( 1.0 - smoothstep( 0.25, 2.3, tt ) );
      color = uDustColor;
      soft = 1.0;
    } else {
      // Gravel spraying off with the rock, falling under gravity.
      vec3 v0 = bd.xyz * aSeed.z + aVel.xyz;
      center = bp.xyz + aStart.xyz * bd.w + v0 * tt + vec3( 0.0, -0.5 * GRAVITY * tt * tt, 0.0 );
      vel = v0 + vec3( 0.0, -GRAVITY * tt, 0.0 );
      size = aSeed.y;
      alpha = 0.95 * ( 1.0 - smoothstep( 1.5, 2.3, tt ) );
      color = uGravelColor;
    }
    if ( tt < 0.0 ) alpha = 0.0;
  }

  alpha *= uFade * clamp( uCount - aRank, 0.0, 1.0 );

  // Forward scattering: snow and dust light up when seen against the sun.
  vec3 viewDir = normalize( center - cameraPosition );
  float fwd = pow( max( dot( viewDir, uSunDir ), 0.0 ), 5.0 );
  color += uSunColor * fwd * ( kind > 2.5 && kind < 3.5 ? 0.15 : 0.7 );

  vec4 mvPosition = modelViewMatrix * vec4( center, 1.0 );
  vec2 quad = position.xy;
  // Fast particles stretch along their screen-space motion (motion blur).
  vec3 vView = ( modelViewMatrix * vec4( vel, 0.0 ) ).xyz;
  float speed = length( vView.xy );
  vec2 along = speed > 1e-3 ? vView.xy / speed : vec2( 0.0, 1.0 );
  vec2 perp = vec2( -along.y, along.x );
  float stretch = soft > 0.5 ? 0.0 : speed * 0.024;
  mvPosition.xy += along * ( quad.y * ( size + stretch ) ) + perp * ( quad.x * size );
  alpha *= size / ( size + stretch * 0.6 );
  // Nothing smears across the lens.
  alpha *= smoothstep( 0.6, 2.4, -mvPosition.z );

  gl_Position = projectionMatrix * mvPosition;
  if ( alpha < 0.002 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );

  vQuad = quad;
  vColor = vec4( color, alpha );
  vSoft = soft;
  vNoiseUv = quad * 0.32 + aSeed.xy * 7.0;
  #include <fog_vertex>
}
`;

export const CHASM_PARTICLE_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uNoise;

varying vec2 vQuad;
varying vec4 vColor;
varying float vSoft;
varying vec2 vNoiseUv;

#include <fog_pars_fragment>

void main() {
  float r = length( vQuad );
  float a;
  if ( vSoft > 0.5 ) {
    float n = texture2D( uNoise, vNoiseUv ).a;
    a = 1.0 - smoothstep( 0.1, 1.0, r + ( n - 0.5 ) * 0.55 );
    a *= a;
  } else {
    a = 1.0 - smoothstep( 0.3, 1.0, r );
  }
  a *= vColor.a;
  if ( a < 0.003 ) discard;
  gl_FragColor = vec4( vColor.rgb, a );
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export type ChasmParticleUniforms = {
  uNoise: THREE.IUniform<THREE.Texture>;
  uTime: THREE.IUniform<number>;
  uFade: THREE.IUniform<number>;
  uCount: THREE.IUniform<number>;
  uGlint: THREE.IUniform<number>;
  uBurstPos: THREE.IUniform<THREE.Vector4[]>;
  uBurstDir: THREE.IUniform<THREE.Vector4[]>;
  uWind: THREE.IUniform<THREE.Vector3>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSnowColor: THREE.IUniform<THREE.Color>;
  uDustColor: THREE.IUniform<THREE.Color>;
  uGravelColor: THREE.IUniform<THREE.Color>;
  uSunColor: THREE.IUniform<THREE.Color>;
};

export interface ChasmParticleColors {
  snow: THREE.ColorRepresentation;
  dust: THREE.ColorRepresentation;
  gravel: THREE.ColorRepresentation;
  sun: THREE.ColorRepresentation;
}

export interface ChasmParticleMaterial {
  material: THREE.ShaderMaterial;
  uniforms: ChasmParticleUniforms;
}

/** Burst slots start far in the past so nothing is drawn until the first event. */
const BURST_IDLE_TIME = -1e4;

export function createChasmParticleMaterial(
  noise: THREE.Texture,
  colors: ChasmParticleColors,
  sunDirection: THREE.Vector3,
  wind: THREE.Vector3,
): ChasmParticleMaterial {
  const uniforms: ChasmParticleUniforms = {
    uNoise: { value: noise },
    uTime: { value: 0 },
    uFade: { value: 0 },
    uCount: { value: 0 },
    uGlint: { value: 1 },
    uBurstPos: { value: Array.from({ length: BURST_SLOTS }, () => new THREE.Vector4(0, -1000, 0, BURST_IDLE_TIME)) },
    uBurstDir: { value: Array.from({ length: BURST_SLOTS }, () => new THREE.Vector4(0, -1, 0, 0.3)) },
    uWind: { value: wind.clone() },
    uSunDir: { value: sunDirection.clone().normalize() },
    uSnowColor: { value: new THREE.Color(colors.snow) },
    uDustColor: { value: new THREE.Color(colors.dust) },
    uGravelColor: { value: new THREE.Color(colors.gravel) },
    uSunColor: { value: new THREE.Color(colors.sun) },
  };
  const material = new THREE.ShaderMaterial({
    name: 'ChasmParticles',
    vertexShader: CHASM_PARTICLE_VERTEX_SHADER,
    fragmentShader: CHASM_PARTICLE_FRAGMENT_SHADER,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...uniforms },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: true,
  });
  return { material, uniforms };
}

export interface ChasmParticleSpec {
  kind: ParticleKind;
  /** Ambient: start position. Burst: offset within the source (scaled by the source size). */
  x: number;
  y: number;
  z: number;
  /** Ambient: velocity. Burst: velocity spread added to the launch. */
  vx: number;
  vy: number;
  vz: number;
  /** Ambient loop period (s); ignored by bursts. */
  period: number;
  /** Loop phase 0..1. */
  phase: number;
  size: number;
  /** Ambient swirl radius, or gravel launch speed along the burst direction. */
  swirl: number;
  /** Burst slot index (kinds dust / gravel). */
  slot: number;
  /** Adaptive-quality rank: drawn while rank < count. */
  rank: number;
}

export function createChasmParticleGeometry(
  particles: readonly ChasmParticleSpec[],
  bounds: THREE.Sphere,
): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  createUnitQuad(geometry);
  const count = particles.length;
  const aStart = new Float32Array(count * 4);
  const aVel = new Float32Array(count * 4);
  const aSeed = new Float32Array(count * 4);
  const aRank = new Float32Array(count);
  particles.forEach((p, i) => {
    aStart.set([p.x, p.y, p.z, p.kind], i * 4);
    aVel.set([p.vx, p.vy, p.vz, p.period], i * 4);
    aSeed.set([p.phase, p.size, p.swirl, p.slot], i * 4);
    aRank[i] = p.rank;
  });
  geometry.setAttribute('aStart', new THREE.InstancedBufferAttribute(aStart, 4));
  geometry.setAttribute('aVel', new THREE.InstancedBufferAttribute(aVel, 4));
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 4));
  geometry.setAttribute('aRank', new THREE.InstancedBufferAttribute(aRank, 1));
  geometry.instanceCount = count;
  geometry.boundingSphere = bounds.clone();
  geometry.boundingBox = new THREE.Box3().setFromCenterAndSize(bounds.center, new THREE.Vector3().setScalar(bounds.radius * 2));
  return geometry;
}
