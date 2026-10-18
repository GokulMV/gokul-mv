import * as THREE from 'three';
import type { GpuTier } from '../../store/scrollStore';
import { FOG, PALETTE, SUN_DIRECTION } from '../world/worldLayout';

/* ==========================================================================
 * Valley mist — stacked, slowly drifting horizontal mist sheets that pool in
 * the valleys between the horizon peaks (z ≈ -140 … -290, y ≈ -10 … 45).
 *
 * One instanced draw: every instance is one large horizontal sheet. The
 * fragment stage builds a domain-warped FBM density from the shared noise
 * texture and fades it
 *   - toward the field bounds (no quad edges, ever),
 *   - where the sheet meets terrain, using a baked height map of the range
 *     and the outer skirt (soft contact instead of a hard intersection line),
 *   - with the adaptive-quality layer count (the last layer cross-fades).
 * Mist pools thicker where the valley drops far below the sheet.
 *
 * Tone mapped like the rest of the world (no exposure uniform needed).
 * ========================================================================== */

/** Horizontal extent of the mist field (world units). */
export const VALLEY_MIST_FIELD = {
  x0: -470,
  x1: 470,
  z0: -300,
  z1: -128,
  yLow: -8,
  yHigh: 45,
} as const;

/** World height encoding of the R8 terrain height map used for soft contact. */
export const MIST_HEIGHT_ENCODING = {
  min: -140,
  range: 280,
} as const;

export function maxMistLayersForTier(tier: GpuTier): number {
  if (tier >= 3) return 8;
  if (tier === 2) return 6;
  if (tier === 1) return 4;
  return 3;
}

export const VALLEY_MIST_VERTEX_SHADER = /* glsl */ `
attribute vec4 aLayer;   // x altitude, y seed, z opacity, w noise frequency
attribute vec4 aDrift;   // xy drift velocity (units/s), z rank, w altitude 0 (bottom) .. 1 (top)

uniform float uCount;

varying vec3 vWorld;
varying vec4 vLayer;
varying vec4 vDrift;
varying float vDepth;
varying float vFade;

void main() {
  vec3 p = position;
  p.y += aLayer.x;
  vec4 world = modelMatrix * vec4( p, 1.0 );
  vWorld = world.xyz;
  vLayer = aLayer;
  vDrift = aDrift;
  vFade = clamp( uCount - aDrift.z, 0.0, 1.0 );
  vec4 mv = viewMatrix * world;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
  // Layers beyond the adaptive count collapse outside the clip volume (no fill cost).
  if ( vFade < 0.002 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
}
`;

export const VALLEY_MIST_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uNoise;
uniform sampler2D uHeight;
uniform vec4 uHeightRect;
uniform vec4 uBounds;
uniform vec2 uHeightEncoding;
uniform float uTime;
uniform float uOpacity;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uGlow;
uniform vec3 uFogColor;
uniform vec3 uSunDir;

varying vec3 vWorld;
varying vec4 vLayer;
varying vec4 vDrift;
varying float vDepth;
varying float vFade;

void main() {
  vec2 xz = vWorld.xz;
  vec2 drift = vDrift.xy * uTime;
  float freq = vLayer.w;
  vec2 q = ( xz + drift ) * freq + vLayer.y * 7.31;

  // Domain-warped FBM (each octave is one fetch of the tileable noise).
  vec2 warp = vec2(
    texture2D( uNoise, q * 0.41 + vec2( 0.17, 0.53 ) + uTime * 0.0021 ).r,
    texture2D( uNoise, q * 0.41 + vec2( 0.61, 0.29 ) - uTime * 0.0017 ).g
  ) - 0.5;
  float n1 = texture2D( uNoise, q + warp * 0.7 ).b;
  float n2 = texture2D( uNoise, q * 2.13 + warp * 0.45 + vec2( 0.29, 0.83 ) ).a;
#if MIST_QUALITY > 0
  float n3 = texture2D( uNoise, q * 4.7 + warp * 0.25 + vec2( 0.91, 0.37 ) ).r;
  float n = n1 * 0.6 + n2 * 0.28 + n3 * 0.12;
#else
  float n = n1 * 0.68 + n2 * 0.32;
#endif

  // Large-scale banding: the mist gathers in long drifting banks.
  float band = texture2D( uNoise, ( xz + drift * 0.35 ) * 0.0017 + vLayer.y * 1.37 ).g;
  float cover = mix( 0.6, 0.4, smoothstep( 0.32, 0.68, band ) );
  float dens = smoothstep( cover - 0.07, cover + 0.2, n );

  // Field bounds: always fade out well before the sheet ends.
  float ex = smoothstep( uBounds.x, uBounds.x + 110.0, xz.x ) * ( 1.0 - smoothstep( uBounds.y - 110.0, uBounds.y, xz.x ) );
  float ez = smoothstep( uBounds.z, uBounds.z + 55.0, xz.y ) * ( 1.0 - smoothstep( uBounds.w - 45.0, uBounds.w, xz.y ) );
  dens *= ex * ez;

  // Soft contact with the terrain below / around the sheet.
  float ground = texture2D( uHeight, ( xz - uHeightRect.xy ) * uHeightRect.zw ).r * uHeightEncoding.y + uHeightEncoding.x;
  float clearance = vLayer.x - ground;
  dens *= smoothstep( 0.0, 11.0, clearance );
  // Pooling: deep valleys under the sheet hold thicker mist.
  dens *= mix( 0.5, 1.0, smoothstep( 8.0, 70.0, clearance ) );

  float alpha = dens * vLayer.z * vFade * uOpacity;
  if ( alpha < 0.002 ) discard;

  vec3 V = normalize( vWorld - cameraPosition );
  vec3 L = normalize( uSunDir );
  float forward = pow( max( dot( V, L ), 0.0 ), 4.0 );
  float lift = vDrift.w;
  vec3 col = mix( uShade, uLit, clamp( 0.22 + 0.55 * lift + 0.35 * ( n1 - 0.4 ), 0.0, 1.0 ) );
  col += uGlow * ( forward * 0.45 + 0.07 * lift ) * ( 0.6 + 0.4 * n2 );

  float fogF = smoothstep( uFogNear, uFogFar, vDepth );
  col = mix( col, uFogColor, fogF * 0.55 );

  gl_FragColor = vec4( col, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface ValleyMistUniforms {
  [uniform: string]: THREE.IUniform;
  uNoise: THREE.IUniform<THREE.Texture>;
  uHeight: THREE.IUniform<THREE.Texture>;
  uHeightRect: THREE.IUniform<THREE.Vector4>;
  uBounds: THREE.IUniform<THREE.Vector4>;
  uHeightEncoding: THREE.IUniform<THREE.Vector2>;
  uTime: THREE.IUniform<number>;
  uOpacity: THREE.IUniform<number>;
  uCount: THREE.IUniform<number>;
  uFogNear: THREE.IUniform<number>;
  uFogFar: THREE.IUniform<number>;
  uLit: THREE.IUniform<THREE.Color>;
  uShade: THREE.IUniform<THREE.Color>;
  uGlow: THREE.IUniform<THREE.Color>;
  uFogColor: THREE.IUniform<THREE.Color>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
}

export type ValleyMistMaterial = THREE.ShaderMaterial & { uniforms: ValleyMistUniforms };

export function createValleyMistMaterial(
  noise: THREE.Texture,
  height: THREE.Texture,
  quality: 0 | 1,
): ValleyMistMaterial {
  const F = VALLEY_MIST_FIELD;
  const uniforms: ValleyMistUniforms = {
    uNoise: { value: noise },
    uHeight: { value: height },
    uHeightRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uBounds: { value: new THREE.Vector4(F.x0, F.x1, F.z0, F.z1) },
    uHeightEncoding: { value: new THREE.Vector2(MIST_HEIGHT_ENCODING.min, MIST_HEIGHT_ENCODING.range) },
    uTime: { value: 0 },
    uOpacity: { value: 0 },
    uCount: { value: 0 },
    uFogNear: { value: FOG.near },
    uFogFar: { value: FOG.far },
    uLit: { value: new THREE.Color('#8C9CBC') },
    uShade: { value: new THREE.Color('#3A4866') },
    uGlow: { value: new THREE.Color(PALETTE.cloudLining) },
    uFogColor: { value: new THREE.Color(PALETTE.fog) },
    uSunDir: { value: SUN_DIRECTION.clone().normalize() },
  };
  const material = new THREE.ShaderMaterial({
    name: 'ValleyMistMaterial',
    uniforms,
    vertexShader: VALLEY_MIST_VERTEX_SHADER,
    fragmentShader: VALLEY_MIST_FRAGMENT_SHADER,
    defines: { MIST_QUALITY: quality },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: false,
    side: THREE.DoubleSide,
  });
  return material as ValleyMistMaterial;
}

/**
 * Instanced geometry: one horizontal sheet spanning the mist field, repeated
 * `maxLayers` times (bottom → top, the order they blend in).
 */
export function createValleyMistGeometry(maxLayers: number): THREE.InstancedBufferGeometry {
  const F = VALLEY_MIST_FIELD;
  const sheet = new THREE.PlaneGeometry(F.x1 - F.x0, F.z1 - F.z0, 1, 1);
  sheet.rotateX(-Math.PI / 2);
  sheet.translate((F.x0 + F.x1) / 2, 0, (F.z0 + F.z1) / 2);

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = sheet.index;
  geometry.setAttribute('position', sheet.getAttribute('position'));
  geometry.setAttribute('uv', sheet.getAttribute('uv'));

  const layer = new Float32Array(maxLayers * 4);
  const drift = new Float32Array(maxLayers * 4);
  for (let i = 0; i < maxLayers; i += 1) {
    const t = maxLayers > 1 ? i / (maxLayers - 1) : 0.5;
    // Slight irregular spacing so layers never read as an even stack.
    const jitter = Math.sin(i * 12.9898) * 0.5 * (F.yHigh - F.yLow) / Math.max(1, maxLayers - 1) * 0.35;
    const y = F.yLow + (F.yHigh - F.yLow) * t + (i > 0 && i < maxLayers - 1 ? jitter : 0);
    layer[i * 4 + 0] = y;
    layer[i * 4 + 1] = (i * 0.618034) % 1;
    // Dense low banks, wispy high veils.
    layer[i * 4 + 2] = 0.5 - 0.3 * t;
    layer[i * 4 + 3] = 1 / (150 - 50 * t + (i % 3) * 9);
    const speed = 0.7 + 0.9 * t + (i % 2) * 0.25;
    const angle = 0.12 + (i % 3) * 0.09 - 0.1 * t;
    drift[i * 4 + 0] = Math.cos(angle) * speed;
    drift[i * 4 + 1] = Math.sin(angle) * speed;
    drift[i * 4 + 2] = i;
    drift[i * 4 + 3] = t;
  }
  geometry.setAttribute('aLayer', new THREE.InstancedBufferAttribute(layer, 4));
  geometry.setAttribute('aDrift', new THREE.InstancedBufferAttribute(drift, 4));
  geometry.instanceCount = maxLayers;
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(F.x0, F.yLow - 2, F.z0),
    new THREE.Vector3(F.x1, F.yHigh + 2, F.z1),
  );
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  // The instanced geometry now owns the sheet's attribute arrays; the sheet wrapper is not needed.
  sheet.dispose();
  return geometry;
}
