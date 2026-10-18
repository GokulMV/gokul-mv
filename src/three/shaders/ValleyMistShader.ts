import * as THREE from 'three';
import type { GpuTier } from '../../store/scrollStore';
import { FOG, PALETTE, SUN_DIRECTION } from '../world/worldLayout';

/* ==========================================================================
 * Valley mist — layered, slowly drifting mist banks pooled in the valleys
 * between the horizon peaks (z ≈ -140 … -290, tops at y ≈ -10 … 45).
 *
 * One instanced draw: every instance is a wide vertical bank facing the climb
 * (+z) at its own depth, so the hero cameras always see them face-on (no
 * grazing-angle streaks) and the stack gives depth parallax. The fragment
 * stage shapes each bank from the shared noise texture:
 *   - a billowy, drifting top edge (domain-warped FBM), dense body below it
 *     and wisps above it,
 *   - soft contact with the terrain at the bank's depth via a height map of
 *     the range + skirt that is dilated horizontally (a cheap distance
 *     field), so banks melt into the faces instead of cutting a hard line,
 *   - fades at the field's sides and bottom (no quad edges, ever),
 *   - the adaptive-quality layer count (the last layer cross-fades).
 *
 * Tone mapped like the rest of the world (no exposure uniform needed).
 * ========================================================================== */

/** Extent of the mist banks (world units). Banks span x0..x1 and yBottom..yTop. */
export const VALLEY_MIST_FIELD = {
  x0: -470,
  x1: 470,
  /** Depth range the banks are spread over (far → near). */
  z0: -290,
  z1: -148,
  yBottom: -62,
  yTop: 90,
  /** Range of the banks' mean top heights (near banks lower, far banks higher). */
  topNear: 32,
  topFar: 45,
} as const;

/** World height encoding of the RG8 terrain height map used for soft contact. */
export const MIST_HEIGHT_ENCODING = {
  min: -140,
  range: 280,
} as const;

/** Area the terrain height map covers (a little larger than the banks' depth range). */
export const MIST_HEIGHT_RECT = {
  x0: -470,
  x1: 470,
  z0: -310,
  z1: -125,
} as const;

/** Depth of the most important bank (just in front of the next mountain's foot). */
const MIST_KEY_Z = -182;

export function maxMistLayersForTier(tier: GpuTier): number {
  if (tier >= 3) return 8;
  if (tier === 2) return 6;
  if (tier === 1) return 4;
  return 3;
}

export const VALLEY_MIST_VERTEX_SHADER = /* glsl */ `
attribute vec4 aLayer;   // x depth (world z), y seed, z opacity, w mean top height
attribute vec4 aDrift;   // x drift speed (units/s), y importance rank (0 = kept longest), z noise frequency, w 0 (near) .. 1 (far)

uniform float uCount;

varying vec3 vWorld;
varying vec4 vLayer;
varying vec4 vDrift;
varying float vDepth;
varying float vFade;

void main() {
  vec3 p = position;
  p.z += aLayer.x;
  vec4 world = modelMatrix * vec4( p, 1.0 );
  vWorld = world.xyz;
  vLayer = aLayer;
  vDrift = aDrift;
  vFade = clamp( uCount - aDrift.y, 0.0, 1.0 );
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
  float seed = vLayer.y;
  float freq = vDrift.z;
  float x = vWorld.x + uTime * vDrift.x;
  float y = vWorld.y;

  // Billowy top edge: two drifting octaves, the second warped by the first.
  float t1 = texture2D( uNoise, vec2( x * freq * 0.55, seed ) ).r;
  float t2 = texture2D( uNoise, vec2( x * freq * 1.7 + t1 * 0.6, seed + 0.41 ) ).g;
  float top = min( vLayer.w + ( t1 - 0.5 ) * 30.0 + ( t2 - 0.5 ) * 12.0, uBounds.w - 34.0 );

  // Internal billows (gently warped, slowly churning).
  vec2 q = vec2( x * freq * 0.75, y * freq * 1.3 ) + seed * 3.7;
  vec2 warp = vec2(
    texture2D( uNoise, q * 0.37 + vec2( 0.17, uTime * 0.0025 ) ).b,
    texture2D( uNoise, q * 0.37 + vec2( 0.63, -uTime * 0.002 ) ).a
  ) - 0.5;
  float n1 = texture2D( uNoise, q + warp * 0.35 ).b;
#if MIST_QUALITY > 0
  float n2 = texture2D( uNoise, q * 2.1 + warp * 0.25 + vec2( 0.29, 0.83 ) ).a;
  float n = n1 * 0.7 + n2 * 0.3;
#else
  float n = n1;
#endif

  float edge = top + ( n - 0.5 ) * 12.0;
  float body = 1.0 - smoothstep( edge - 20.0, edge + 2.0, y );
  float wisps = smoothstep( 0.55, 0.75, n ) * ( 1.0 - smoothstep( edge, edge + 14.0, y ) ) * 0.35;
  float dens = max( body * mix( 0.62, 1.0, smoothstep( 0.32, 0.68, n ) ), wisps );

  // Field sides and bottom: always fade out before the quad ends.
  dens *= smoothstep( uBounds.x, uBounds.x + 120.0, vWorld.x ) * ( 1.0 - smoothstep( uBounds.y - 120.0, uBounds.y, vWorld.x ) );
  dens *= smoothstep( uBounds.z, uBounds.z + 24.0, y ) * ( 1.0 - smoothstep( uBounds.w - 24.0, uBounds.w - 6.0, y ) );

  // Soft contact with the terrain at this depth (R = ground dilated horizontally).
  vec2 g = texture2D( uHeight, ( vWorld.xz - uHeightRect.xy ) * uHeightRect.zw ).rg * uHeightEncoding.y + uHeightEncoding.x;
  dens *= smoothstep( 0.0, 7.0, y - g.x );

  float alpha = dens * vLayer.z * vFade * uOpacity;
  if ( alpha < 0.002 ) discard;

  // Lit billow tops, cooler shaded body; forward scattering toward the sun.
  vec3 V = normalize( vWorld - cameraPosition );
  vec3 L = normalize( uSunDir );
  float forward = pow( max( dot( V, L ), 0.0 ), 4.0 );
  float lit = smoothstep( edge - 22.0, edge + 2.0, y );
  vec3 col = mix( uShade, uLit, clamp( 0.25 + 0.6 * lit + 0.25 * ( n - 0.5 ), 0.0, 1.0 ) );
  col += uGlow * ( forward * 0.5 + 0.1 * lit * vDrift.w ) * ( 0.6 + 0.4 * n );

  float fogF = smoothstep( uFogNear, uFogFar, vDepth );
  col = mix( col, uFogColor, fogF * 0.5 );

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
  const R = MIST_HEIGHT_RECT;
  const uniforms: ValleyMistUniforms = {
    uNoise: { value: noise },
    uHeight: { value: height },
    uHeightRect: { value: new THREE.Vector4(R.x0, R.z0, 1 / (R.x1 - R.x0), 1 / (R.z1 - R.z0)) },
    uBounds: { value: new THREE.Vector4(F.x0, F.x1, F.yBottom, F.yTop) },
    uHeightEncoding: { value: new THREE.Vector2(MIST_HEIGHT_ENCODING.min, MIST_HEIGHT_ENCODING.range) },
    uTime: { value: 0 },
    uOpacity: { value: 0 },
    uCount: { value: 0 },
    uFogNear: { value: FOG.near },
    uFogFar: { value: FOG.far },
    uLit: { value: new THREE.Color('#9AA9C6') },
    uShade: { value: new THREE.Color('#3E4C6B') },
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
 * Instanced geometry: one wide vertical bank (XY plane, facing +z), repeated
 * `maxLayers` times from far to near — the order they blend in.
 */
export function createValleyMistGeometry(maxLayers: number): THREE.InstancedBufferGeometry {
  const F = VALLEY_MIST_FIELD;
  const bank = new THREE.PlaneGeometry(F.x1 - F.x0, F.yTop - F.yBottom, 1, 1);
  bank.translate((F.x0 + F.x1) / 2, (F.yBottom + F.yTop) / 2, 0);

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = bank.index;
  geometry.setAttribute('position', bank.getAttribute('position'));
  geometry.setAttribute('uv', bank.getAttribute('uv'));

  const layer = new Float32Array(maxLayers * 4);
  const drift = new Float32Array(maxLayers * 4);
  // Banks are drawn far → near (blend order) but dropped by importance: the
  // banks framing the hero's foot (z ≈ MIST_KEY_Z) are kept longest when the
  // adaptive density falls; the faded ones collapse in the vertex shader.
  const depths: number[] = [];
  for (let i = 0; i < maxLayers; i += 1) {
    const t = maxLayers > 1 ? i / (maxLayers - 1) : 0.5;
    depths.push(F.z0 + (F.z1 - F.z0) * t + Math.sin(i * 7.31) * 4);
  }
  const ranks = depths
    .map((z, i) => ({ i, d: Math.abs(z - MIST_KEY_Z) }))
    .sort((a, b) => a.d - b.d)
    .reduce<number[]>((acc, entry, rank) => {
      acc[entry.i] = rank;
      return acc;
    }, []);
  for (let i = 0; i < maxLayers; i += 1) {
    // i = 0 is the farthest bank; drawn first.
    const t = maxLayers > 1 ? i / (maxLayers - 1) : 0.5;
    const z = depths[i];
    const far = 1 - t;
    layer[i * 4 + 0] = z;
    layer[i * 4 + 1] = (i * 0.618034 + 0.13) % 1;
    layer[i * 4 + 2] = 0.5 + 0.1 * t;
    layer[i * 4 + 3] = F.topNear + (F.topFar - F.topNear) * far + Math.sin(i * 3.7) * 4;
    drift[i * 4 + 0] = (0.9 + 0.8 * far) * (i % 2 === 0 ? 1 : 0.75);
    drift[i * 4 + 1] = ranks[i];
    drift[i * 4 + 2] = 1 / (150 + 50 * far + (i % 3) * 14);
    drift[i * 4 + 3] = far;
  }
  geometry.setAttribute('aLayer', new THREE.InstancedBufferAttribute(layer, 4));
  geometry.setAttribute('aDrift', new THREE.InstancedBufferAttribute(drift, 4));
  geometry.instanceCount = maxLayers;
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(F.x0, F.yBottom, F.z0 - 6),
    new THREE.Vector3(F.x1, F.yTop, F.z1 + 6),
  );
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  // The instanced geometry now owns the bank's attribute arrays; the wrapper is not needed.
  bank.dispose();
  return geometry;
}
