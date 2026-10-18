import * as THREE from 'three';
import type { GpuTier } from '../../store/scrollStore';
import { CLOUD_CURTAIN, PALETTE, SUN_DIRECTION } from '../world/worldLayout';

/* ==========================================================================
 * Cloud curtain shader — instanced, camera-facing volumetric cloud puffs.
 *
 * Every instance is one soft billboard. The vertex shader moves the
 * instance centre (curtain parting, lift, drift), transforms it to view
 * space and then expands the quad there (spherical billboarding), so the
 * puff always faces the camera without ever showing an edge-on sliver.
 *
 * The fragment shader builds the cloud density from a domain-warped
 * 5-octave FBM (gradient noise baked into a tiny tileable DataTexture, so
 * every octave is one filtered fetch instead of ~20 ALU ops), carves it
 * with a radial dome so quads never show edges, self-shadows it with taps
 * marched toward the sun, and adds a warm silver lining on thin, sun-facing
 * edges boosted by a Henyey–Greenstein forward-scatter phase.
 *
 * Per-instance attributes (InstancedBufferAttribute):
 *   aCenter   vec3  base offset (curtain space = world space of the opening)
 *   aShape    vec4  x side (-1 left / +1 right), y layer depth (0 near → 1 far),
 *                   z seed (0..1), w diameter in world units
 *   aMotion   vec4  x drift speed (rad/s), y drift phase, z rotation (rad),
 *                   w aspect (width / height)
 *   aPartTune vec4  x parting delay (0..1), y lateral travel multiplier
 *                   (× uPartX), z vertical lift when parted, w importance rank
 * ========================================================================== */

/** Size of the baked noise texture (texels per side, power of two). */
export const CLOUD_NOISE_SIZE = 256;
/** Lattice cells per tile of the baked gradient noise. */
export const CLOUD_NOISE_PERIOD = 8;

export const CLOUD_CURTAIN_VERTEX_SHADER = /* glsl */ `
attribute vec3 aCenter;
attribute vec4 aShape;
attribute vec4 aMotion;
attribute vec4 aPartTune;

uniform float uTime;
uniform float uPart;
uniform float uPartX;
uniform float uScaleMul;
uniform float uCount;
uniform float uDissolve;
uniform vec3 uSunView;
uniform vec4 uFade;

varying vec2 vUv;
varying vec3 vViewPos;
varying vec4 vInst;
varying vec4 vSunLocal;
varying vec2 vUpLocal;

void main() {
  float side = aShape.x;
  float layer = aShape.y;
  float seed = aShape.z;
  float size = aShape.w * uScaleMul;

  // Staggered parting: inner clouds lead, outer ones follow, all finish at 1.
  float part = smoothstep(aPartTune.x, 1.0, uPart);
  float lateral = part * uPartX * aPartTune.y;

  vec3 center = aCenter;
  center.x += side * lateral;
  center.y += aPartTune.z * part;

  // Slow convective drift; deeper layers swing wider.
  float t = uTime * aMotion.x + aMotion.y;
  float swing = 0.35 + 0.65 * layer;
  center.x += sin(t) * 0.55 * swing + side * uDissolve * (1.5 + 2.5 * layer);
  center.y += cos(t * 0.71 + seed * 6.2831) * 0.28 * swing + uDissolve * 1.2;

  vec4 mvCenter = modelViewMatrix * vec4(center, 1.0);
  float dist = -mvCenter.z;

  // Depth fade: near-plane fade scales with the puff size so a cloud never
  // fills the screen as a flat sheet; far fade keeps distant puffs cheap.
  float nearFade = smoothstep(uFade.x + size * 0.06, uFade.y + size * 0.32, dist);
  float farFade = 1.0 - smoothstep(uFade.z, uFade.w, dist);
  // Adaptive-quality cross fade: instances beyond the damped count vanish softly.
  float rankFade = clamp(uCount - aPartTune.w, 0.0, 1.0);
  float fade = nearFade * farFade * rankFade;

  float rot = aMotion.z + uTime * (seed - 0.5) * 0.018;
  float c = cos(rot);
  float s = sin(rot);
  float stretch = 1.0 + part * 0.35 + uDissolve * 0.25;
  vec2 corner = position.xy * 2.0;
  vec2 halfExtent = vec2(aMotion.w * stretch, 1.0) * (size * 0.5);
  vec2 local = corner * halfExtent;
  vec2 offset = vec2(c * local.x - s * local.y, s * local.x + c * local.y);

  vec4 mvPosition = mvCenter + vec4(offset, 0.0, 0.0);
  gl_Position = projectionMatrix * mvPosition;
  // Fully faded instances collapse outside the clip volume: zero fill cost.
  if (fade < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);

  // Sun and view-up directions expressed in the quad's local uv frame.
  vec2 sunXY = uSunView.xy;
  vec2 sunRot = vec2(c * sunXY.x + s * sunXY.y, -s * sunXY.x + c * sunXY.y);
  vec2 sunLocal = sunRot / halfExtent;
  float sunLen = length(sunLocal);
  vSunLocal = vec4(sunLen > 1e-5 ? sunLocal / sunLen : vec2(0.0, 1.0), uSunView.z, length(sunXY));
  vec2 upLocal = vec2(s, c) / halfExtent;
  vUpLocal = normalize(upLocal);

  vUv = corner;
  vViewPos = mvPosition.xyz;
  vInst = vec4(seed, fade, part, layer);
}
`;

export const CLOUD_CURTAIN_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uNoise;
uniform float uTime;
uniform float uCurtainOpacity;
uniform float uCoverage;
uniform float uDensity;
uniform float uShadowK;
uniform float uDissolve;
uniform float uLiningStrength;
uniform vec3 uSunView;
uniform vec3 uLitColor;
uniform vec3 uShadowColor;
uniform vec3 uLiningColor;
uniform vec3 uSunColor;
uniform vec3 uAmbientColor;
uniform vec3 uHazeColor;

varying vec2 vUv;
varying vec3 vViewPos;
varying vec4 vInst;
varying vec4 vSunLocal;
varying vec2 vUpLocal;

const mat2 OCTAVE_ROT = mat2(0.80, -0.60, 0.60, 0.80);
const float NOISE_FREQ = 0.17;

// 5-octave FBM over the baked gradient noise (red channel).
float fbm5(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    sum += amp * texture2D(uNoise, p).r;
    p = OCTAVE_ROT * p * 2.03 + vec2(0.137, 0.291);
    amp *= 0.5;
  }
  return sum * (1.0 / 0.96875);
}

// Low-octave FBM used by the self-shadow taps (same octave basis as fbm5).
float fbmLow(vec2 p) {
  float sum = 0.5 * texture2D(uNoise, p).r;
  p = OCTAVE_ROT * p * 2.03 + vec2(0.137, 0.291);
  sum += 0.25 * texture2D(uNoise, p).r;
#if CLOUD_SHADOW_OCTAVES > 2
  p = OCTAVE_ROT * p * 2.03 + vec2(0.137, 0.291);
  sum += 0.125 * texture2D(uNoise, p).r;
  return sum * (1.0 / 0.875);
#else
  return sum * (1.0 / 0.75);
#endif
}

// Vector field for domain warping (green / blue channels).
vec2 warpField(vec2 p) {
  vec2 w = texture2D(uNoise, p).gb - 0.5;
#if CLOUD_WARP_OCTAVES > 1
  w += (texture2D(uNoise, OCTAVE_ROT * p * 2.07 + vec2(0.53, 0.17)).gb - 0.5) * 0.5;
#endif
  return w;
}

float shapeDensity(float n, float r2, float bias) {
  float dome = 1.0 - r2;
  float edge = 1.0 - smoothstep(0.55, 1.0, r2);
  float d = dome * 1.05 + (n - 0.5) * 2.6 - 0.46 + bias;
  return clamp(d, 0.0, 1.0) * edge;
}

float henyeyGreenstein(float cosTheta, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5);
}

void main() {
  vec2 uv = vUv;
  float r2 = dot(uv, uv);
  if (r2 >= 1.0) discard;

  float seed = vInst.x;
  float part = vInst.z;
  float layer = vInst.w;

  // Coverage thins as the curtain parts and erodes away during the dissolve.
  float bias = uCoverage - part * 0.16 - uDissolve * 0.85;

  vec2 seedOffset = vec2(seed * 7.31, seed * 3.17);
  vec2 flow = vec2(uTime * 0.0042, -uTime * 0.0017) * (0.6 + seed * 0.8);
  vec2 base = uv * NOISE_FREQ + seedOffset;
  vec2 warp = warpField(base * 0.55 + flow * 1.6 + seed * 1.93);
  vec2 warpOffset = warp * 0.12 + flow;

  float n = fbm5(base + warpOffset);
  float density = shapeDensity(n, r2, bias);
  if (density < 0.002) discard;

  // ---- self-shadowing: march toward the sun in the quad's local frame ----
  vec2 sunDir = vSunLocal.xy;
  vec2 uvA = uv + sunDir * 0.14;
  float dA = shapeDensity(fbmLow(uvA * NOISE_FREQ + seedOffset + warpOffset), dot(uvA, uvA), bias);
  float shadowDepth = dA;
#if CLOUD_SHADOW_TAPS > 1
  vec2 uvB = uv + sunDir * 0.34;
  float dB = shapeDensity(fbmLow(uvB * NOISE_FREQ + seedOffset + warpOffset), dot(uvB, uvB), bias);
  shadowDepth += dB * 0.75;
#endif
  float transmittance = exp(-shadowDepth * uShadowK);

  // ---- pseudo-spherical normal of the puff for broad sun shading ----
  float rr = sqrt(r2);
  vec3 puffNormal = normalize(vec3(uv * 0.85, sqrt(max(1.0 - r2, 0.0)) + 0.2));
  vec3 sunLocal3 = vec3(sunDir * vSunLocal.w, vSunLocal.z);
  float ndl = dot(puffNormal, sunLocal3);
  float wrapLight = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);

  // Forward scattering when the view ray points toward the sun.
  vec3 viewRay = normalize(vViewPos);
  float cosTheta = dot(viewRay, uSunView);
  float phase = clamp(henyeyGreenstein(cosTheta, 0.62) * 0.22 + henyeyGreenstein(cosTheta, -0.18) * 0.12, 0.0, 3.0);

  // Ambient: skylight from above, darker undersides.
  float height = dot(uv, vUpLocal) * 0.5 + 0.5;
  float ambientTerm = mix(0.55, 1.05, height);
  float powder = 1.0 - exp(-density * 2.4);

  float sunLight = transmittance * mix(0.28, 1.0, wrapLight);
  vec3 shadowBody = mix(uShadowColor * 0.62, uShadowColor, height) * mix(1.0, 0.82, powder);
  vec3 litBody = mix(uLitColor, uSunColor, 0.22);
  vec3 color = mix(shadowBody, litBody, sunLight);
  color += uAmbientColor * ambientTerm * 0.14;
  color += uSunColor * transmittance * phase * 0.22;

  // ---- silver lining: thin, sun-facing edges glow warm ----
  float thin = exp(-density * 4.2);
  float gradFacing = clamp((density - dA) * 4.5, 0.0, 1.0);
  float rimFacing = smoothstep(0.35, 0.95, rr) * clamp(dot(uv / max(rr, 1e-3), sunDir), 0.0, 1.0);
  float facing = max(gradFacing, rimFacing * 0.85);
  float silver = thin * facing * (0.55 + phase * 1.6) * mix(0.6, 1.0, transmittance);
  color += uLiningColor * silver * uLiningStrength;

  // Aerial perspective: deeper layers sink into the twilight haze.
  color = mix(color, uHazeColor, layer * 0.22);

  float alpha = (1.0 - exp(-density * uDensity)) * vInst.y * uCurtainOpacity;
  if (alpha < 0.002) discard;

  gl_FragColor = vec4(color, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export type CloudCurtainUniforms = {
  uNoise: THREE.IUniform<THREE.Texture>;
  uTime: THREE.IUniform<number>;
  /** 0 = closed across the viewport, 1 = fully parted. */
  uPart: THREE.IUniform<number>;
  /** Lateral travel of a fully parted cloud (world units). */
  uPartX: THREE.IUniform<number>;
  /** Curtain opacity (0 → 1). */
  uCurtainOpacity: THREE.IUniform<number>;
  /** Global puff size multiplier (adaptive-quality coverage compensation). */
  uScaleMul: THREE.IUniform<number>;
  /** Damped drawn-instance count; instances with rank ≥ this fade out. */
  uCount: THREE.IUniform<number>;
  /** Coverage bias added to the density field. */
  uCoverage: THREE.IUniform<number>;
  /** Beer–Lambert extinction applied to the density for alpha. */
  uDensity: THREE.IUniform<number>;
  /** Extinction of the self-shadow taps. */
  uShadowK: THREE.IUniform<number>;
  /** Scene 10 erosion (0 → 1). */
  uDissolve: THREE.IUniform<number>;
  uLiningStrength: THREE.IUniform<number>;
  /** Direction toward the sun in view space (normalized). */
  uSunView: THREE.IUniform<THREE.Vector3>;
  /** x near fade start, y near fade end, z far fade start, w far fade end. */
  uFade: THREE.IUniform<THREE.Vector4>;
  uLitColor: THREE.IUniform<THREE.Color>;
  uShadowColor: THREE.IUniform<THREE.Color>;
  uLiningColor: THREE.IUniform<THREE.Color>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uAmbientColor: THREE.IUniform<THREE.Color>;
  uHazeColor: THREE.IUniform<THREE.Color>;
};

/** Creates a fresh uniform set (one per material). */
export function createCloudCurtainUniforms(noise: THREE.Texture): CloudCurtainUniforms {
  return {
    uNoise: { value: noise },
    uTime: { value: 0 },
    uPart: { value: 0 },
    uPartX: { value: CLOUD_CURTAIN.partX },
    uCurtainOpacity: { value: 1 },
    uScaleMul: { value: 1 },
    uCount: { value: 1e4 },
    uCoverage: { value: 0.12 },
    uDensity: { value: 3.4 },
    uShadowK: { value: 1.9 },
    uDissolve: { value: 0 },
    uLiningStrength: { value: 2.4 },
    uSunView: { value: SUN_DIRECTION.clone() },
    uFade: { value: new THREE.Vector4(0.35, 1.6, 70, 120) },
    uLitColor: { value: new THREE.Color(PALETTE.cloudLit) },
    uShadowColor: { value: new THREE.Color(PALETTE.cloudShadow) },
    uLiningColor: { value: new THREE.Color(PALETTE.cloudLining) },
    uSunColor: { value: new THREE.Color(PALETTE.sun) },
    uAmbientColor: { value: new THREE.Color(PALETTE.hemisphereSky) },
    uHazeColor: { value: new THREE.Color(PALETTE.skyHorizon) },
  };
}

export interface CloudCurtainDefines {
  [define: string]: number;
  /** 1 or 2 self-shadow taps toward the sun. */
  CLOUD_SHADOW_TAPS: number;
  /** 2 or 3 octaves in each self-shadow tap. */
  CLOUD_SHADOW_OCTAVES: number;
  /** 1 or 2 octaves of domain warping. */
  CLOUD_WARP_OCTAVES: number;
}

/** Shader quality switches per GPU tier (fixed at mount). */
export function cloudCurtainDefines(tier: GpuTier): CloudCurtainDefines {
  if (tier >= 3) return { CLOUD_SHADOW_TAPS: 2, CLOUD_SHADOW_OCTAVES: 3, CLOUD_WARP_OCTAVES: 2 };
  if (tier === 2) return { CLOUD_SHADOW_TAPS: 2, CLOUD_SHADOW_OCTAVES: 2, CLOUD_WARP_OCTAVES: 2 };
  return { CLOUD_SHADOW_TAPS: 1, CLOUD_SHADOW_OCTAVES: 2, CLOUD_WARP_OCTAVES: 1 };
}

/* ---------------------------------------------------------------------------
 * Baked tileable gradient noise
 * ------------------------------------------------------------------------- */

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

const quintic = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Fills `out` (RGBA, size × size) with four independent tileable 2D gradient
 * noise fields, one per channel, encoded around 0.5. Pure CPU, no DOM.
 */
export function fillCloudNoise(out: Uint8Array, size: number, period: number, seed: number): void {
  const cells = period * period;
  const gx = new Float32Array(cells);
  const gy = new Float32Array(cells);
  for (let channel = 0; channel < 4; channel += 1) {
    const rand = mulberry32(seed + channel * 7919);
    for (let i = 0; i < cells; i += 1) {
      const angle = rand() * Math.PI * 2;
      gx[i] = Math.cos(angle);
      gy[i] = Math.sin(angle);
    }
    for (let y = 0; y < size; y += 1) {
      const v = ((y + 0.5) / size) * period;
      const iy = Math.floor(v);
      const fy = v - iy;
      const y0 = iy % period;
      const y1 = (iy + 1) % period;
      const sy = quintic(fy);
      for (let x = 0; x < size; x += 1) {
        const u = ((x + 0.5) / size) * period;
        const ix = Math.floor(u);
        const fx = u - ix;
        const x0 = ix % period;
        const x1 = (ix + 1) % period;
        const sx = quintic(fx);

        const i00 = y0 * period + x0;
        const i10 = y0 * period + x1;
        const i01 = y1 * period + x0;
        const i11 = y1 * period + x1;
        const n00 = gx[i00] * fx + gy[i00] * fy;
        const n10 = gx[i10] * (fx - 1) + gy[i10] * fy;
        const n01 = gx[i01] * fx + gy[i01] * (fy - 1);
        const n11 = gx[i11] * (fx - 1) + gy[i11] * (fy - 1);
        const nx0 = n00 + (n10 - n00) * sx;
        const nx1 = n01 + (n11 - n01) * sx;
        const n = nx0 + (nx1 - nx0) * sy;

        const encoded = Math.round((n * 0.78 + 0.5) * 255);
        out[(y * size + x) * 4 + channel] = encoded < 0 ? 0 : encoded > 255 ? 255 : encoded;
      }
    }
  }
}

/** Builds the mip-mapped, repeat-wrapped noise texture the cloud shader samples. */
export function createCloudNoiseTexture(
  size: number = CLOUD_NOISE_SIZE,
  period: number = CLOUD_NOISE_PERIOD,
  seed = 1337,
): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  fillCloudNoise(data, size, period, seed);
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = 1;
  texture.needsUpdate = true;
  return texture;
}
