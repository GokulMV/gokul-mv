import * as THREE from 'three';
import { SUN_DIRECTION, PALETTE } from '../world/worldLayout';

/* ==========================================================================
 * Silky hair — Kajiya-Kay anisotropic hair shading for jet-black hair cards.
 *
 * Shading (all in view space, per scene directional light, shadowed):
 *   diffuse    Kajiya-Kay sin(T,L) blended with a wrapped N·L — hair is lit
 *              around the terminator, never a hard Lambert edge;
 *   primary    sharp anisotropic lobe on the strand tangent shifted toward
 *              the tip, slightly cool-tinted: the silky "angel ring" band;
 *   secondary  broader lobe shifted toward the root, tinted by the hair
 *              colour and broken up by a per-strand sparkle mask;
 *   backlight  thin strand tips transmit the sun when it is behind the hair
 *              (rim from SUN_DIRECTION — only the light aligned with it);
 *   ambient    hemisphere irradiance + a soft anisotropic sky sheen.
 * Strand jitter shifts each strand's tangent so the bands break into
 * individual fibres; inner layers and roots are darkened (self-shadowing).
 *
 * Geometry: strand cards (see character/characterHair.ts) with per-vertex
 * `aTangent` (root → tip), `aStrand` (u, v = tip weight, seed, layer) and
 * `aLength`. The vertex stage applies wind: a lean along `uWindDir` plus
 * flutter, weighted by tipWeight^1.6 × card length, with the inward (into the
 * scalp) component removed.
 *
 * Transparency without sorting artefacts — two passes over one geometry:
 *   opaque  alpha-tested at `uAlphaCut`, depth-written (alpha-to-coverage with
 *           a sharpened alpha when the target is multisampled);
 *   soft    alpha-blended fringe (alpha < cut, remapped to reach 1 at the
 *           cut), depth-tested, no depth write, drawn after the opaque pass in
 *           the static inner → outer card order. Nothing flickers because no
 *           per-frame sorting is involved.
 *
 * Standard three chunks: lights + shadows (lights: true), fog, log depth,
 * tone mapping and output colour space — correct with and without the
 * postprocessing composer.
 * ========================================================================== */

export const HAIR_BASE_COLOR = '#090a0f';

export interface SilkyHairUniforms {
  [uniform: string]: THREE.IUniform;
  uBaseColor: THREE.IUniform<THREE.Color>;
  uRootColor: THREE.IUniform<THREE.Color>;
  uTipColor: THREE.IUniform<THREE.Color>;
  uPrimaryColor: THREE.IUniform<THREE.Color>;
  uSecondaryColor: THREE.IUniform<THREE.Color>;
  uPrimaryShift: THREE.IUniform<number>;
  uSecondaryShift: THREE.IUniform<number>;
  uPrimaryExponent: THREE.IUniform<number>;
  uSecondaryExponent: THREE.IUniform<number>;
  uPrimaryStrength: THREE.IUniform<number>;
  uSecondaryStrength: THREE.IUniform<number>;
  uShiftJitter: THREE.IUniform<number>;
  uSparkle: THREE.IUniform<number>;
  uRimStrength: THREE.IUniform<number>;
  uSkySheen: THREE.IUniform<number>;
  /** World direction toward the sun (fallback key light when the scene has no directional light). */
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  /** Wind strength (0 calm, 1 strong gust; values above 1 are allowed). */
  uWind: THREE.IUniform<number>;
  /** World-space wind direction (normalised in the shader). */
  uWindDir: THREE.IUniform<THREE.Vector3>;
  /** Seconds; drives flutter only. */
  uTime: THREE.IUniform<number>;
  uAlphaCut: THREE.IUniform<number>;
  /** Strands per card across its width. */
  uStrandsPerCard: THREE.IUniform<number>;
}

export interface SilkyHairOptions {
  /** Enables alpha-to-coverage on the opaque pass (only meaningful on a multisampled target). */
  alphaToCoverage?: boolean;
}

export interface SilkyHairMaterials {
  /** Alpha-tested, depth-writing pass (render first). */
  opaque: THREE.ShaderMaterial;
  /** Blended soft-fringe pass (render after `opaque`, same geometry). */
  soft: THREE.ShaderMaterial;
  /** Uniforms shared by both passes (update these; both materials see the change). */
  uniforms: SilkyHairUniforms;
  dispose: () => void;
}

export const SILKY_HAIR_VERTEX_SHADER = /* glsl */ `
attribute vec3 aTangent;
attribute vec4 aStrand;
attribute float aLength;

uniform float uWind;
uniform vec3 uWindDir;
uniform float uTime;

varying vec3 vViewPosition;
varying vec3 vNormalV;
varying vec3 vTangentV;
varying vec4 vStrand;

#include <common>
#include <fog_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>

// Wind offset (world space) for a vertex of a strand card.
vec3 hairWindOffset( vec3 worldPos, vec3 scalpNormalW, float tip, float len, float seed ) {
  float w = max( uWind, 0.0 );
  vec3 dir = uWindDir;
  float dl = length( dir );
  dir = dl > 1e-4 ? dir / dl : vec3( 0.0, 0.0, 1.0 );
  vec3 side = cross( dir, vec3( 0.0, 1.0, 0.0 ) );
  float sl = length( side );
  side = sl > 1e-4 ? side / sl : vec3( 1.0, 0.0, 0.0 );
  float ph = seed * 37.0 + dot( worldPos, vec3( 23.0, 31.0, 17.0 ) );
  float f1 = sin( uTime * ( 6.5 + 4.0 * seed ) + ph );
  float f2 = sin( uTime * ( 11.0 + 6.0 * seed ) + ph * 1.7 );
  float sway = sin( uTime * 1.3 + seed * 6.2831 );
  vec3 offset = dir * ( 0.62 + 0.38 * f1 ) * w
              + side * ( 0.28 * f2 * w + 0.06 * sway )
              + vec3( 0.0, 1.0, 0.0 ) * ( 0.22 * w * ( 0.6 + 0.4 * f1 ) );
  float weight = pow( clamp( tip, 0.0, 1.0 ), 1.6 ) * len * 0.55;
  offset *= weight;
  // Never push strands into the scalp.
  float into = dot( offset, scalpNormalW );
  offset -= scalpNormalW * min( into, 0.0 ) * 0.9;
  return offset;
}

void main() {
  vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
  vec3 normalW = normalize( mat3( modelMatrix ) * normal );
  worldPosition.xyz += hairWindOffset( worldPosition.xyz, normalW, aStrand.y, aLength, aStrand.z );
  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;
  vViewPosition = - mvPosition.xyz;
  vec3 transformedNormal = normalize( mat3( viewMatrix ) * normalW );
  vNormalV = transformedNormal;
  vTangentV = normalize( mat3( viewMatrix ) * normalize( mat3( modelMatrix ) * aTangent ) );
  vStrand = aStrand;
  #include <logdepthbuf_vertex>
  #include <shadowmap_vertex>
  // The sun's shadow texels are coarser than the hair volume: look shadows up a little off the scalp so the
  // head never self-shadows the hair into blotches (terrain shadows still land).
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
      vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * ( worldPosition + vec4( shadowWorldNormal * ( directionalLightShadows[ i ].shadowNormalBias + 0.03 ), 0.0 ) );
    }
    #pragma unroll_loop_end
  #endif
  #include <fog_vertex>
}
`;

export const SILKY_HAIR_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uBaseColor;
uniform vec3 uRootColor;
uniform vec3 uTipColor;
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform float uPrimaryShift;
uniform float uSecondaryShift;
uniform float uPrimaryExponent;
uniform float uSecondaryExponent;
uniform float uPrimaryStrength;
uniform float uSecondaryStrength;
uniform float uShiftJitter;
uniform float uSparkle;
uniform float uRimStrength;
uniform float uSkySheen;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uAlphaCut;
uniform float uStrandsPerCard;

varying vec3 vViewPosition;
varying vec3 vNormalV;
varying vec3 vTangentV;
varying vec4 vStrand;

#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <logdepthbuf_pars_fragment>

float hairHash( float n ) {
  return fract( sin( n * 127.1 + 311.7 ) * 43758.5453 );
}

// Kajiya-Kay specular: sin(T,H)^p, faded where the half vector points behind the strand.
float kkSpecular( vec3 T, vec3 H, float exponent ) {
  float th = dot( T, H );
  float sinTH = sqrt( max( 1.0 - th * th, 0.0 ) );
  return smoothstep( -1.0, 0.0, th ) * pow( sinTH, exponent );
}

vec3 shiftTangent( vec3 T, vec3 N, float shift ) {
  return normalize( T + N * shift );
}

void main() {
  #include <logdepthbuf_fragment>

  float u = vStrand.x;
  float v = vStrand.y;
  float seed = vStrand.z;
  float layer = vStrand.w;

  // ---- Strand coverage (procedural, filtered to its pixel footprint) ----
  float lanes = uStrandsPerCard;
  float x = u * lanes + seed * 17.0;
  float strandId = floor( x );
  float strandRand = hairHash( strandId + seed * 113.0 );
  float fx = fract( x );
  float fw = fwidth( x );
  float core = 1.0 - smoothstep( 0.22 - fw * 0.5, 0.5 + fw * 0.5, abs( fx - 0.5 ) );
  core = mix( core, 0.68, smoothstep( 0.3, 1.1, fw ) );
  // Strands end at different lengths: tapered, uneven tips.
  float strandLen = mix( 0.74, 1.0, strandRand );
  float fv = fwidth( v );
  float tips = 1.0 - smoothstep( strandLen - 0.32 - fv, strandLen + fv, v );
  float edges = smoothstep( 0.0, 0.2 + fw * 0.15, u ) * smoothstep( 0.0, 0.2 + fw * 0.15, 1.0 - u );
  // Roots thin out so the hairline and partings read soft against the (hair-coloured) scalp.
  float roots = mix( 0.5, 1.0, smoothstep( 0.0, 0.16, v ) );
  float alpha = core * tips * edges * roots;

  #if defined( HAIR_PASS_OPAQUE )
    #ifdef ALPHA_TO_COVERAGE
      float fa = max( fwidth( alpha ), 1e-4 );
      alpha = clamp( ( alpha - uAlphaCut ) / fa + 0.5, 0.0, 1.0 );
      if ( alpha <= 0.0 ) discard;
    #else
      if ( alpha < uAlphaCut ) discard;
      alpha = 1.0;
    #endif
  #else
    if ( alpha >= uAlphaCut || alpha < 0.02 ) discard;
    alpha = alpha / uAlphaCut;
  #endif

  // ---- Frame ----
  vec3 N = normalize( vNormalV ) * ( gl_FrontFacing ? 1.0 : -1.0 );
  vec3 T = normalize( vTangentV );
  vec3 V = normalize( vViewPosition );

  float jitter = ( strandRand - 0.5 ) * uShiftJitter + ( hairHash( strandId * 3.1 + floor( v * 9.0 ) + seed * 7.0 ) - 0.5 ) * uShiftJitter * 0.35;
  vec3 T1 = shiftTangent( T, N, uPrimaryShift + jitter );
  vec3 T2 = shiftTangent( T, N, uSecondaryShift + jitter );
  float sparkle = mix( 1.0 - uSparkle, 1.0 + uSparkle, step( 0.62, hairHash( strandId * 7.7 + floor( v * 23.0 ) * 1.3 + seed * 3.0 ) ) );

  // Albedo: darker roots, a hint of cool sheen toward the tips, per-strand variation.
  vec3 albedo = mix( uRootColor, uBaseColor, smoothstep( 0.0, 0.45, v ) );
  albedo = mix( albedo, uTipColor, smoothstep( 0.55, 1.0, v ) );
  albedo *= 0.75 + 0.5 * strandRand;
  // Self-shadowing: inner layers and roots sit in the shade of the hair above them.
  float selfShadow = mix( 0.42, 1.0, layer ) * mix( 0.5, 1.0, smoothstep( 0.0, 0.55, v ) );

  vec3 sunDirV = normalize( ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz );
  vec3 diffuse = vec3( 0.0 );
  vec3 specular = vec3( 0.0 );
  vec3 rim = vec3( 0.0 );

  #if NUM_DIR_LIGHTS > 0
    DirectionalLight directionalLight;
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      DirectionalLightShadow directionalLightShadow;
    #endif
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
      {
      directionalLight = directionalLights[ i ];
      vec3 L = directionalLight.direction;
      vec3 lightColor = directionalLight.color;
      #if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
        directionalLightShadow = directionalLightShadows[ i ];
        lightColor *= receiveShadow ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
      #endif
      float NL = dot( N, L );
      float TL = dot( T, L );
      float kkDiffuse = sqrt( max( 1.0 - TL * TL, 0.0 ) );
      float wrapped = clamp( ( NL + 0.45 ) / 1.45, 0.0, 1.0 );
      diffuse += lightColor * mix( kkDiffuse * wrapped, wrapped, 0.5 );
      vec3 H = normalize( L + V );
      float facing = smoothstep( -0.25, 0.35, NL );
      specular += lightColor * facing * (
        uPrimaryColor * ( uPrimaryStrength * kkSpecular( T1, H, uPrimaryExponent ) ) +
        uSecondaryColor * ( uSecondaryStrength * sparkle * kkSpecular( T2, H, uSecondaryExponent ) ) );
      float sunness = smoothstep( 0.9, 0.99, dot( L, sunDirV ) );
      float transmit = pow( max( dot( -V, L ), 0.0 ), 4.0 ) * v * pow( 1.0 - abs( dot( N, V ) ), 2.0 );
      rim += lightColor * sunness * transmit;
      }
    }
    #pragma unroll_loop_end
  #else
    {
      vec3 L = sunDirV;
      float NL = dot( N, L );
      float TL = dot( T, L );
      float wrapped = clamp( ( NL + 0.45 ) / 1.45, 0.0, 1.0 );
      diffuse += uSunColor * mix( sqrt( max( 1.0 - TL * TL, 0.0 ) ) * wrapped, wrapped, 0.5 );
      vec3 H = normalize( L + V );
      float facing = smoothstep( -0.25, 0.35, NL );
      specular += uSunColor * facing * (
        uPrimaryColor * ( uPrimaryStrength * kkSpecular( T1, H, uPrimaryExponent ) ) +
        uSecondaryColor * ( uSecondaryStrength * sparkle * kkSpecular( T2, H, uSecondaryExponent ) ) );
      rim += uSunColor * pow( max( dot( -V, L ), 0.0 ), 4.0 ) * v * pow( 1.0 - abs( dot( N, V ) ), 2.0 );
    }
  #endif

  // Ambient: hemisphere irradiance and a soft anisotropic sky sheen from above.
  vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );
  vec3 skyColor = vec3( 0.0 );
  #if NUM_HEMI_LIGHTS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
      irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], N );
      skyColor += hemisphereLights[ i ].skyColor;
    }
    #pragma unroll_loop_end
  #endif
  vec3 upV = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  float skySheen = kkSpecular( T1, normalize( upV + V ), 24.0 ) * smoothstep( -0.2, 0.6, dot( N, upV ) );

  vec3 color = albedo * RECIPROCAL_PI * ( diffuse + irradiance ) * selfShadow;
  color += specular * mix( 0.55, 1.0, selfShadow );
  color += skyColor * ( uSkySheen * skySheen * selfShadow );
  color += rim * uRimStrength * vec3( 0.42, 0.3, 0.24 );

  gl_FragColor = vec4( color, alpha );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

function createUniforms(): SilkyHairUniforms {
  return {
    uBaseColor: { value: new THREE.Color(HAIR_BASE_COLOR) },
    uRootColor: { value: new THREE.Color('#040407') },
    uTipColor: { value: new THREE.Color('#10131b') },
    uPrimaryColor: { value: new THREE.Color('#eef2fa') },
    uSecondaryColor: { value: new THREE.Color('#4b505d') },
    uPrimaryShift: { value: 0.07 },
    uSecondaryShift: { value: -0.09 },
    uPrimaryExponent: { value: 180 },
    uSecondaryExponent: { value: 40 },
    uPrimaryStrength: { value: 0.15 },
    uSecondaryStrength: { value: 0.075 },
    uShiftJitter: { value: 0.13 },
    uSparkle: { value: 0.65 },
    uRimStrength: { value: 0.2 },
    uSkySheen: { value: 0.05 },
    uSunDir: { value: SUN_DIRECTION.clone() },
    uSunColor: { value: new THREE.Color(PALETTE.sun).multiplyScalar(3) },
    uWind: { value: 0.1 },
    uWindDir: { value: new THREE.Vector3(0.3, 0.05, 1).normalize() },
    uTime: { value: 0 },
    uAlphaCut: { value: 0.5 },
    uStrandsPerCard: { value: 13 },
  };
}

function makePass(shared: SilkyHairUniforms, pass: 'opaque' | 'soft', alphaToCoverage: boolean): THREE.ShaderMaterial {
  const uniforms: Record<string, THREE.IUniform> = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    ...shared,
  };
  const material = new THREE.ShaderMaterial({
    name: pass === 'opaque' ? 'SilkyHair.opaque' : 'SilkyHair.soft',
    uniforms,
    vertexShader: SILKY_HAIR_VERTEX_SHADER,
    fragmentShader: SILKY_HAIR_FRAGMENT_SHADER,
    defines: pass === 'opaque' ? { HAIR_PASS_OPAQUE: '' } : { HAIR_PASS_SOFT: '' },
    lights: true,
    fog: true,
    side: THREE.DoubleSide,
    transparent: pass === 'soft',
    depthWrite: pass === 'opaque',
    depthTest: true,
    alphaToCoverage: pass === 'opaque' && alphaToCoverage,
  });
  if (pass === 'soft') {
    material.depthFunc = THREE.LessEqualDepth;
  }
  return material;
}

/** Creates the two hair passes sharing one uniform set. */
export function createSilkyHairMaterials(options: SilkyHairOptions = {}): SilkyHairMaterials {
  const uniforms = createUniforms();
  const opaque = makePass(uniforms, 'opaque', options.alphaToCoverage ?? false);
  const soft = makePass(uniforms, 'soft', false);
  return {
    opaque,
    soft,
    uniforms,
    dispose: () => {
      opaque.dispose();
      soft.dispose();
    },
  };
}

/**
 * Builds the BufferGeometry for strand cards from flat arrays (attribute names match the shader).
 */
export function createHairCardGeometry(data: {
  positions: Float32Array;
  normals: Float32Array;
  tangents: Float32Array;
  strand: Float32Array;
  lengths: Float32Array;
  indices: Uint16Array | Uint32Array;
  boundingCenter: readonly [number, number, number];
  boundingRadius: number;
}): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('aTangent', new THREE.BufferAttribute(data.tangents, 3));
  geometry.setAttribute('aStrand', new THREE.BufferAttribute(data.strand, 4));
  geometry.setAttribute('aLength', new THREE.BufferAttribute(data.lengths, 1));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(data.boundingCenter[0], data.boundingCenter[1], data.boundingCenter[2]),
    data.boundingRadius,
  );
  return geometry;
}
