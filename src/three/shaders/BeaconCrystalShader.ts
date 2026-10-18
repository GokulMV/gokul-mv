import * as THREE from 'three';
import type { GpuTier } from '../../store/scrollStore';
import { PALETTE, SUN_DIRECTION } from '../world/worldLayout';

/* ==========================================================================
 * Project beacon shaders + procedural geometry (pure module, runs in Node).
 *
 *   Crystal  — an opaque, flat-faceted cluster (one elongated hexagonal
 *              bipyramid + satellite shards) in ONE draw call. Per-vertex
 *              shard attributes let the vertex stage float the satellites
 *              apart and spin them about their own axes. The fragment stage
 *              layers: dark tinted glass + sky/sun reflections (Schlick
 *              fresnel), a refracted "core filament" whose closest approach
 *              to each shard axis is evaluated per wavelength (dispersion
 *              fringes), refraction bands seen through the facets, rising
 *              energy veins, an iridescent thin-film sweep, a fresnel rim and
 *              anti-aliased glowing facet edges (barycentric, diagonal-free).
 *   Beam     — two nested open cylinders, additive, view-profiled.
 *   Halo     — a camera-facing soft glow + faint anamorphic streak.
 *   Ground   — a soft light pool laid on the rock below (oriented to its
 *              normal), with shock rings emitted on the activation flare.
 *   Sparkles — GPU-animated orbiting / rising points (draw range per frame).
 *   Fit      — fitBeaconToTerrain() sizes a cluster to the free space in
 *              front of the rock using the terrain's signed distance field.
 *
 * Every material is tone mapped like the rest of the world AND multiplies its
 * output by `uExposure` (fed from sceneFx.exposure), so the Scene 10 dissolve
 * empties the frame on both the composer and the no-composer paths. Additive
 * materials fade with fog towards black (they add nothing in the haze) while
 * the opaque crystal fogs towards the fog colour like the rock.
 * ========================================================================== */

export type CrystalQuality = 0 | 1;

export function crystalQualityFor(tier: GpuTier): CrystalQuality {
  return tier >= 2 ? 1 : 0;
}

/* ---------------------------------------------------------------------------
 * Shared GLSL
 * ------------------------------------------------------------------------- */

const BEACON_COMMON = /* glsl */ `
float bcHash13( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.zyx + 31.32 );
  return fract( ( p.x + p.y ) * p.z );
}

// Linear / exp2 fog factor (0 = clear, 1 = fully fogged). Needs fog_pars_fragment.
float bcFogFactor() {
#ifdef USE_FOG
  #ifdef FOG_EXP2
    return 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    return smoothstep( fogNear, fogFar, vFogDepth );
  #endif
#else
  return 0.0;
#endif
}
`;

interface FogUniforms {
  fogColor: THREE.IUniform<THREE.Color>;
  fogNear: THREE.IUniform<number>;
  fogFar: THREE.IUniform<number>;
  fogDensity: THREE.IUniform<number>;
}

/** Fog uniforms the renderer refreshes when `material.fog` is true. */
function fogUniforms(): FogUniforms {
  return {
    fogColor: { value: new THREE.Color(PALETTE.fog) },
    fogNear: { value: 1 },
    fogFar: { value: 2000 },
    fogDensity: { value: 0.00025 },
  };
}

/* ---------------------------------------------------------------------------
 * Crystal
 * ------------------------------------------------------------------------- */

export const CRYSTAL_VERTEX_SHADER = /* glsl */ `
attribute vec3 aBary;
attribute vec3 aCenter;
attribute vec3 aAxis;
attribute vec4 aShape; // x radius, y half length (centre → top tip), z phase (0 = main shard), w facet random

uniform float uTime;
uniform float uSpread;
uniform float uSatSpin;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vObjPos;
varying vec3 vObjNormal;
varying vec3 vBary;
varying vec3 vCenter;
varying vec3 vAxis;
varying vec4 vShape;

#include <fog_pars_vertex>

vec3 bcRotate( vec3 v, vec3 axis, float angle ) {
  float c = cos( angle );
  float s = sin( angle );
  return v * c + cross( axis, v ) * s + axis * dot( axis, v ) * ( 1.0 - c );
}

void main() {
  float phase = aShape.z;
  float sat = step( 0.001, phase );
  vec3 axis = normalize( aAxis );

  // Satellites spin slowly about their own long axis (alternating direction).
  float dir = mod( floor( phase * 10.0 ), 2.0 ) * 2.0 - 1.0;
  float spin = uSatSpin * ( 0.55 + 0.9 * phase ) * dir * sat;
  vec3 local = bcRotate( position - aCenter, axis, spin );
  vec3 objNormal = bcRotate( normal, axis, spin );

  // ...float away from the cluster centre when the beacon is energised, and bob.
  vec3 away = aCenter / max( length( aCenter ), 1e-3 );
  float bob = sin( uTime * ( 0.7 + 0.6 * phase ) + phase * 23.0 ) * 0.045;
  vec3 center = aCenter + ( away * 0.15 * uSpread + vec3( 0.0, bob, 0.0 ) ) * sat;
  vec3 objPos = center + local;

  vec4 world = modelMatrix * vec4( objPos, 1.0 );
  vWorldPos = world.xyz;
  vWorldNormal = normalize( mat3( modelMatrix ) * objNormal );
  vObjPos = objPos;
  vObjNormal = objNormal;
  vBary = aBary;
  vCenter = center;
  vAxis = axis;
  vShape = aShape;

  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

export const CRYSTAL_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uSatColor;
uniform vec3 uCoreColor;
uniform vec3 uDeepColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
uniform vec3 uCamLocal;
uniform float uTime;
uniform float uEnergy;
uniform float uFlare;
uniform float uPulse;
uniform float uExposure;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vObjPos;
varying vec3 vObjNormal;
varying vec3 vBary;
varying vec3 vCenter;
varying vec3 vAxis;
varying vec4 vShape;

#include <fog_pars_fragment>
${BEACON_COMMON}

// IQ cosine palette: thin-film style iridescence.
vec3 bcIridescence( float t ) {
  return 0.5 + 0.5 * cos( 6.28318 * ( t + vec3( 0.0, 0.33, 0.67 ) ) );
}

// Closest distance between the refracted ray R entering at P and the shard
// axis A, normalised by the shard radius: 0 = the ray grazes the filament.
float bcAxisDistance( vec3 P, vec3 R, vec3 A, float radius ) {
  vec3 c = cross( R, A );
  float len = length( c );
  float d = len > 1e-4 ? abs( dot( P, c ) ) / len : length( P - A * dot( P, A ) );
  return d / radius;
}

// Thin, hot inner filament.
float bcCore( vec3 P, vec3 R, vec3 A, float radius ) {
  float k = bcAxisDistance( P, R, A, radius ) / 0.24;
  return exp( - k * k );
}

// Refraction bands: irregular oblique planes inside the shard (growth
// phantoms), sampled mid-way along the refracted ray R.
float bcBands( vec3 P, vec3 R, float radius, float freq, float drift, vec3 plane ) {
  vec3 inside = P + R * radius * 1.25;
  float x = dot( inside, plane ) * freq + drift;
  // Warp the spacing so the planes never read as regular stripes.
  x += 0.35 * sin( x * 2.3 + dot( inside, vec3( 3.1, 0.7, -2.3 ) ) / radius );
  return pow( 0.5 + 0.5 * cos( 6.28318 * x ), 7.0 );
}

void main() {
  vec3 N = normalize( vWorldNormal );
  vec3 V = normalize( cameraPosition - vWorldPos );
  float NoV = clamp( dot( N, V ), 0.0, 1.0 );
  float grazing = 1.0 - NoV;
  float fres = grazing * grazing * grazing;

  float radius = vShape.x;
  float halfLen = vShape.y;
  float phase = vShape.z;
  float facet = vShape.w;

  vec3 A = normalize( vAxis );
  vec3 P = vObjPos - vCenter;
  float along = dot( P, A ) / halfLen;
  float tipFade = 1.0 - smoothstep( 0.3, 1.0, abs( along ) );

  vec3 Vo = normalize( uCamLocal - vObjPos );
  vec3 No = normalize( vObjNormal );

  float E = uEnergy * ( 0.8 + 0.2 * uPulse ) + uFlare * 0.85;
  // Hot parts (filament, flashes, edges) respond super-linearly: a claimed
  // beacon glows steadily, only the active one burns.
  float E2 = E * E;

  // ---- Fake refraction: inner filament + bands, per wavelength when allowed.
  float bandFreq = ( 0.75 + 0.5 * fract( phase * 5.3 ) ) / radius;
  float drift = uTime * 0.07 + phase * 3.0;
  vec3 plane = normalize( vec3( 0.42 + phase * 0.6, 1.0, -0.27 + phase * 0.9 ) );
#if CRYSTAL_QUALITY > 0
  vec3 Rr = refract( - Vo, No, 1.0 / 1.495 );
  vec3 Rg = refract( - Vo, No, 1.0 / 1.52 );
  vec3 Rb = refract( - Vo, No, 1.0 / 1.555 );
  // Dispersion stays a fringe: each channel is pulled back toward green.
  float coreG = bcCore( P, Rg, A, radius );
  vec3 core = mix( vec3( coreG ), vec3( bcCore( P, Rr, A, radius ), coreG, bcCore( P, Rb, A, radius ) ), 0.4 );
  float bandG = bcBands( P, Rg, radius, bandFreq, drift, plane );
  vec3 bands = mix(
    vec3( bandG ),
    vec3( bcBands( P, Rr, radius, bandFreq, drift, plane ), bandG, bcBands( P, Rb, radius, bandFreq, drift, plane ) ),
    0.55
  );
#else
  vec3 Rg = refract( - Vo, No, 1.0 / 1.52 );
  float c0 = bcCore( P, Rg, A, radius );
  vec3 core = vec3( c0 );
  vec3 bands = vec3( bcBands( P, Rg, radius, bandFreq, drift, plane ) ) * vec3( 0.85, 1.0, 1.15 );
#endif
  // Soft luminous volume around the filament.
  float vk = bcAxisDistance( P, Rg, A, radius ) / 0.8;
  float volume = exp( - vk * vk );

  // Scintillation: each facet hides an internal mirror; as the cluster turns,
  // the refracted ray sweeps across it and the facet flashes.
  vec3 mirror = normalize( vec3( fract( facet * 13.17 ) - 0.5, fract( facet * 7.31 ) - 0.5, fract( facet * 3.71 ) - 0.5 ) + 1e-4 );
  float flash = pow( max( dot( Rg, mirror ), 0.0 ), 22.0 );

  // ---- Dark tinted glass body.
  vec3 col = uDeepColor * ( 0.35 + 1.3 * facet );
  col += uColor * 0.02 * max( dot( N, uSunDir ), 0.0 );

  // ---- Inner light: facets fill with colour, the filament burns, bands refract.
  float fill = 0.05 + 0.95 * facet * facet * facet;
  vec3 inner = uSatColor * fill * ( 0.012 + 0.42 * E );
  inner += uColor * volume * tipFade * ( 0.01 + 0.24 * E );
  inner += uCoreColor * core * tipFade * ( 0.1 + 0.35 * E + 1.9 * E2 );
  inner += mix( uSatColor, uCoreColor, 0.4 ) * bands * tipFade * ( 0.012 + 0.06 * E + 0.24 * E2 );
  inner += mix( uSatColor, uCoreColor, 0.55 ) * flash * ( 0.16 + 0.4 * E + 1.1 * E2 );
  float veins = pow( 0.5 + 0.5 * sin( along * 7.0 - uTime * ( 1.2 + 2.8 * E ) + facet * 6.28318 ), 14.0 );
  inner += uCoreColor * veins * tipFade * E * 0.4;
  col += inner * ( 0.45 + 0.55 * NoV );

  // ---- Reflections: procedural twilight sky + low sun glints.
  vec3 Rw = reflect( - V, N );
  vec3 sky = mix( uSkyHorizon, uSkyZenith, smoothstep( 0.0, 0.7, Rw.y ) );
  sky = mix( uSkyGround, sky, smoothstep( - 0.25, 0.02, Rw.y ) );
  vec2 rh = normalize( Rw.xz + vec2( 1e-5, 0.0 ) );
  float sunAz = max( dot( rh, normalize( uSunDir.xz ) ), 0.0 );
  sky += uSunColor * pow( sunAz, 6.0 ) * exp( - abs( Rw.y - uSunDir.y ) * 4.0 ) * 0.22;
  float F = 0.045 + 0.955 * pow( grazing, 5.0 );
  col += sky * F * 1.5;
  float RoL = max( dot( Rw, uSunDir ), 0.0 );
  col += uSunColor * ( pow( RoL, 260.0 ) * 7.0 + pow( RoL, 28.0 ) * 0.22 ) * ( 0.35 + 0.65 * F );

  // ---- Fresnel rim and the iridescent sweep travelling up each shard.
  col += mix( uColor, uCoreColor, 0.45 ) * fres * ( 0.05 + 0.3 * E + 0.6 * E2 );
  float sweepPos = fract( uTime * 0.09 + phase * 0.61 ) * 3.2 - 1.6;
  float sweep = exp( - pow( ( along - sweepPos ) * 2.6, 2.0 ) );
  vec3 irid = bcIridescence( fres * 1.3 + facet * 0.45 + along * 0.25 + uTime * 0.025 );
  col += irid * mix( uColor, vec3( 1.0 ), 0.5 ) * ( fres * 0.22 + sweep * 0.4 ) * ( 0.03 + 0.3 * E );

  // ---- Glowing facet edges (anti-aliased; fade out when facets get tiny).
  float d = min( min( vBary.x, vBary.y ), vBary.z );
  float fw = max( fwidth( d ), 1e-5 );
  float line = 1.0 - smoothstep( fw * 0.35, fw * 1.6, d );
  float bevel = 1.0 - smoothstep( 0.0, 0.06, d );
  float lineFade = 1.0 - smoothstep( 0.06, 0.3, fw );
  vec3 edgeColor = mix( uColor, vec3( 1.0 ), 0.22 );
  col += edgeColor * ( line * 0.62 * lineFade + bevel * 0.12 ) * ( 0.1 + 0.3 * E + 0.7 * E2 );

  col = min( col, vec3( 16.0 ) ) * uExposure;

#ifdef USE_FOG
  col = mix( col, fogColor * uExposure, bcFogFactor() );
#endif

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface CrystalUniforms extends FogUniforms {
  [uniform: string]: THREE.IUniform;
  uColor: THREE.IUniform<THREE.Color>;
  uSatColor: THREE.IUniform<THREE.Color>;
  uCoreColor: THREE.IUniform<THREE.Color>;
  uDeepColor: THREE.IUniform<THREE.Color>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSkyZenith: THREE.IUniform<THREE.Color>;
  uSkyHorizon: THREE.IUniform<THREE.Color>;
  uSkyGround: THREE.IUniform<THREE.Color>;
  uCamLocal: THREE.IUniform<THREE.Vector3>;
  uTime: THREE.IUniform<number>;
  uEnergy: THREE.IUniform<number>;
  uFlare: THREE.IUniform<number>;
  uPulse: THREE.IUniform<number>;
  uSpread: THREE.IUniform<number>;
  uSatSpin: THREE.IUniform<number>;
  uExposure: THREE.IUniform<number>;
}

export type BeaconCrystalMaterial = THREE.ShaderMaterial & { uniforms: CrystalUniforms };

/**
 * Deeper, more saturated version of a beacon colour (same luminance) for the
 * facet fill, so tone mapping keeps the jewel's hue instead of whitening it.
 */
function saturatedColorFor(color: THREE.Color): THREE.Color {
  const sat = new THREE.Color(Math.pow(color.r, 1.6), Math.pow(color.g, 1.6), Math.pow(color.b, 1.6));
  return sat.multiplyScalar(luminance(color) / Math.max(luminance(sat), 1e-4));
}

/** Bright, slightly desaturated version of a beacon colour for the inner filament. */
function coreColorFor(color: THREE.Color): THREE.Color {
  return color.clone().lerp(new THREE.Color(1, 1, 1), 0.2).multiplyScalar(1.15);
}

const luminance = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** Luminance of the reference beacon colour (violet #A78BFA, linear). */
const REFERENCE_LUMINANCE = 0.336;

/**
 * Emissive gain that evens out the beacon colours' very different luminance
 * (teal and gold are ~2× the violet), so every beacon blooms alike and none
 * tone-maps to a white blob.
 */
export function beaconEmissiveGain(color: THREE.ColorRepresentation): number {
  const lum = Math.max(luminance(new THREE.Color(color)), 1e-3);
  return THREE.MathUtils.clamp(Math.pow(REFERENCE_LUMINANCE / lum, 0.75), 0.5, 1.4);
}

/** The colour triple every beacon material uses, gain-normalised. */
function emissiveColors(color: THREE.ColorRepresentation): { base: THREE.Color; color: THREE.Color; sat: THREE.Color; core: THREE.Color } {
  const base = new THREE.Color(color);
  const gain = beaconEmissiveGain(base);
  return {
    base,
    color: base.clone().multiplyScalar(gain),
    sat: saturatedColorFor(base).multiplyScalar(gain),
    core: coreColorFor(base).multiplyScalar(gain),
  };
}

export function createBeaconCrystalMaterial(color: THREE.ColorRepresentation, quality: CrystalQuality): BeaconCrystalMaterial {
  const c = emissiveColors(color);
  const base = c.base;
  const uniforms: CrystalUniforms = {
    ...fogUniforms(),
    uColor: { value: c.color },
    uSatColor: { value: c.sat },
    uCoreColor: { value: c.core },
    uDeepColor: { value: base.clone().lerp(new THREE.Color(PALETTE.skyZenith), 0.55).multiplyScalar(0.07) },
    uSunDir: { value: SUN_DIRECTION.clone().normalize() },
    uSunColor: { value: new THREE.Color(PALETTE.sun) },
    uSkyZenith: { value: new THREE.Color(PALETTE.skyZenith) },
    uSkyHorizon: { value: new THREE.Color(PALETTE.skyHorizon) },
    uSkyGround: { value: new THREE.Color(PALETTE.hemisphereGround) },
    uCamLocal: { value: new THREE.Vector3(0, 0, 10) },
    uTime: { value: 0 },
    uEnergy: { value: 0 },
    uFlare: { value: 0 },
    uPulse: { value: 0.5 },
    uSpread: { value: 0 },
    uSatSpin: { value: 0 },
    uExposure: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({
    name: 'BeaconCrystal',
    uniforms,
    vertexShader: CRYSTAL_VERTEX_SHADER,
    fragmentShader: CRYSTAL_FRAGMENT_SHADER,
    defines: { CRYSTAL_QUALITY: quality },
    fog: true,
    toneMapped: true,
  });
  return material as BeaconCrystalMaterial;
}

/* ---------------------------------------------------------------------------
 * Beam (light shaft)
 * ------------------------------------------------------------------------- */

const BEAM_VERTEX_SHADER = /* glsl */ `
attribute float aLayer;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying float vLayer;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vLayer = aLayer;
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vWorldPos = world.xyz;
  vWorldNormal = normalize( mat3( modelMatrix ) * normal );
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const BEAM_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform float uTime;
uniform float uIntensity;
uniform float uLength;
uniform float uHeight;
uniform float uExposure;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying float vLayer;
#include <fog_pars_fragment>
${BEACON_COMMON}
void main() {
  vec3 V = normalize( cameraPosition - vWorldPos );
  vec3 N = normalize( vWorldNormal );
  // Column profile: bright where the view ray crosses the most light.
  vec2 nr = normalize( N.xz + vec2( 1e-5, 0.0 ) );
  vec2 vr = normalize( V.xz + vec2( 1e-5, 0.0 ) );
  float facing = abs( dot( nr, vr ) );
  float isCore = 1.0 - step( 0.5, vLayer );
  float profile = mix( pow( facing, 2.2 ), pow( facing, 1.6 ), isCore );

  float h = vUv.y;
  float len = max( uLength, 1e-3 );
  float lengthMask = 1.0 - smoothstep( len * 0.3, len, h );
  float base = smoothstep( 0.0, 0.03, h );
  float decay = exp( - h * 3.4 );
  float wy = h * uHeight;
  float streak = 0.7 + 0.3 * sin( wy * 1.7 - uTime * 5.0 + vUv.x * 6.28318 * 3.0 );
  float packet = exp( - pow( ( h - fract( uTime * 0.2 + vLayer * 0.13 ) * 1.25 + 0.08 ) * 10.0, 2.0 ) );
  float flicker = 0.93 + 0.07 * sin( uTime * 11.0 + wy * 0.9 );
  float k = profile * lengthMask * base * ( decay * streak + packet * 0.6 ) * flicker;

  vec3 col = mix( uColor * 0.42, uCoreColor * 0.4, isCore );
  col *= k * uIntensity * uExposure * ( 1.0 - bcFogFactor() );
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface BeamUniforms extends FogUniforms {
  [uniform: string]: THREE.IUniform;
  uColor: THREE.IUniform<THREE.Color>;
  uCoreColor: THREE.IUniform<THREE.Color>;
  uTime: THREE.IUniform<number>;
  uIntensity: THREE.IUniform<number>;
  uLength: THREE.IUniform<number>;
  uHeight: THREE.IUniform<number>;
  uExposure: THREE.IUniform<number>;
}

export type BeaconBeamMaterial = THREE.ShaderMaterial & { uniforms: BeamUniforms };

export function createBeaconBeamMaterial(color: THREE.ColorRepresentation, height: number): BeaconBeamMaterial {
  const c = emissiveColors(color);
  const uniforms: BeamUniforms = {
    ...fogUniforms(),
    uColor: { value: c.color },
    uCoreColor: { value: c.core },
    uTime: { value: 0 },
    uIntensity: { value: 0 },
    uLength: { value: 0 },
    uHeight: { value: height },
    uExposure: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({
    name: 'BeaconBeam',
    uniforms,
    vertexShader: BEAM_VERTEX_SHADER,
    fragmentShader: BEAM_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
    fog: true,
    toneMapped: true,
  });
  return material as BeaconBeamMaterial;
}

export interface BeamGeometryOptions {
  height: number;
  coreRadius: number;
  hazeRadius: number;
  radialSegments: number;
}

/** Two nested open cylinders (core + haze) standing on y = 0, tagged by `aLayer`. */
export function createBeaconBeamGeometry(options: BeamGeometryOptions): THREE.BufferGeometry {
  const { height, coreRadius, hazeRadius, radialSegments } = options;
  const layers = [
    new THREE.CylinderGeometry(coreRadius * 0.7, coreRadius, height, radialSegments, 8, true),
    new THREE.CylinderGeometry(hazeRadius * 1.9, hazeRadius, height, radialSegments, 8, true),
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const layerIds: number[] = [];
  const indices: number[] = [];
  let offset = 0;
  layers.forEach((layer, id) => {
    layer.translate(0, height / 2, 0);
    const pos = layer.getAttribute('position') as THREE.BufferAttribute;
    const nor = layer.getAttribute('normal') as THREE.BufferAttribute;
    const uv = layer.getAttribute('uv') as THREE.BufferAttribute;
    const index = layer.getIndex();
    for (let i = 0; i < pos.count; i += 1) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      uvs.push(uv.getX(i), uv.getY(i));
      layerIds.push(id);
    }
    if (index) {
      for (let i = 0; i < index.count; i += 1) indices.push(index.getX(i) + offset);
    }
    offset += pos.count;
    layer.dispose();
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('aLayer', new THREE.Float32BufferAttribute(layerIds, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

/* ---------------------------------------------------------------------------
 * Halo (camera-facing glow)
 * ------------------------------------------------------------------------- */

const HALO_VERTEX_SHADER = /* glsl */ `
uniform float uScale;
varying vec2 vUv;
#include <fog_pars_vertex>
void main() {
  vUv = uv - 0.5;
  vec4 mvPosition = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
  mvPosition.xy += position.xy * uScale;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const HALO_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform float uIntensity;
uniform float uStreak;
uniform float uRotation;
uniform float uExposure;
varying vec2 vUv;
#include <fog_pars_fragment>
${BEACON_COMMON}
void main() {
  float r = length( vUv ) * 2.0;
  if ( r >= 1.0 ) discard;
  float edge = 1.0 - smoothstep( 0.62, 1.0, r );
  float glow = ( exp( - r * r * 14.0 ) * 0.55 + exp( - r * 5.5 ) * 0.45 ) * edge;
  // Faint anamorphic streak + soft six-point rays (lens character, not a blob).
  float streak = exp( - abs( vUv.y ) * 120.0 ) * ( 1.0 - smoothstep( 0.0, 0.5, abs( vUv.x ) ) ) * uStreak;
  float ang = atan( vUv.y, vUv.x );
  float rays = pow( 0.5 + 0.5 * cos( ang * 6.0 + uRotation ), 24.0 ) * exp( - r * 4.0 ) * edge * 0.35 * uStreak;
  vec3 col = uColor * glow + uCoreColor * ( streak + rays );
  col *= uIntensity * uExposure * ( 1.0 - bcFogFactor() );
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface HaloUniforms extends FogUniforms {
  [uniform: string]: THREE.IUniform;
  uColor: THREE.IUniform<THREE.Color>;
  uCoreColor: THREE.IUniform<THREE.Color>;
  uScale: THREE.IUniform<number>;
  uIntensity: THREE.IUniform<number>;
  uStreak: THREE.IUniform<number>;
  uRotation: THREE.IUniform<number>;
  uExposure: THREE.IUniform<number>;
}

export type BeaconHaloMaterial = THREE.ShaderMaterial & { uniforms: HaloUniforms };

export function createBeaconHaloMaterial(color: THREE.ColorRepresentation): BeaconHaloMaterial {
  const c = emissiveColors(color);
  const uniforms: HaloUniforms = {
    ...fogUniforms(),
    uColor: { value: c.color },
    uCoreColor: { value: c.core },
    uScale: { value: 2 },
    uIntensity: { value: 0 },
    uStreak: { value: 0 },
    uRotation: { value: 0 },
    uExposure: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({
    name: 'BeaconHalo',
    uniforms,
    vertexShader: HALO_VERTEX_SHADER,
    fragmentShader: HALO_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
    toneMapped: true,
  });
  return material as BeaconHaloMaterial;
}

/* ---------------------------------------------------------------------------
 * Ground glow (light pool on the rock below + flare shock rings)
 * ------------------------------------------------------------------------- */

const GROUND_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
#include <fog_pars_vertex>
void main() {
  vUv = uv - 0.5;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const GROUND_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform float uIntensity;
uniform float uRing;
uniform float uRingPhase;
uniform float uTime;
uniform float uExposure;
varying vec2 vUv;
#include <fog_pars_fragment>
${BEACON_COMMON}
void main() {
  float r = length( vUv ) * 2.0;
  if ( r >= 1.0 ) discard;
  float edge = 1.0 - smoothstep( 0.55, 1.0, r );
  float pool = ( exp( - r * r * 6.0 ) * 0.6 + exp( - r * 3.2 ) * 0.4 ) * edge;
  // A faint circle that breathes (only while energised)...
  float ang = atan( vUv.y, vUv.x );
  float dash = 0.55 + 0.45 * smoothstep( 0.2, 0.8, 0.5 + 0.5 * sin( ang * 18.0 + uTime * 0.4 ) );
  float circle = exp( - pow( ( r - 0.42 ) / 0.012, 2.0 ) ) * dash * 0.12;
  // ...and shock rings emitted outwards (driven by uRing: the activation flare).
  float rings = 0.0;
  for ( int i = 0; i < 2; i ++ ) {
    float ph = fract( uRingPhase + float( i ) * 0.5 );
    float rr = 0.12 + ph * 0.85;
    rings += exp( - pow( ( r - rr ) / ( 0.018 + 0.03 * ph ), 2.0 ) ) * ( 1.0 - ph ) * ( 1.0 - ph );
  }
  vec3 col = uColor * pool + uCoreColor * ( circle * uRing + rings * uRing * 0.55 ) * edge;
  col *= uIntensity * uExposure * ( 1.0 - bcFogFactor() );
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface GroundUniforms extends FogUniforms {
  [uniform: string]: THREE.IUniform;
  uColor: THREE.IUniform<THREE.Color>;
  uCoreColor: THREE.IUniform<THREE.Color>;
  uIntensity: THREE.IUniform<number>;
  uRing: THREE.IUniform<number>;
  uRingPhase: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  uExposure: THREE.IUniform<number>;
}

export type BeaconGroundMaterial = THREE.ShaderMaterial & { uniforms: GroundUniforms };

export function createBeaconGroundMaterial(color: THREE.ColorRepresentation): BeaconGroundMaterial {
  const c = emissiveColors(color);
  const uniforms: GroundUniforms = {
    ...fogUniforms(),
    uColor: { value: c.color },
    uCoreColor: { value: c.core },
    uIntensity: { value: 0 },
    uRing: { value: 0 },
    uRingPhase: { value: 0 },
    uTime: { value: 0 },
    uExposure: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({
    name: 'BeaconGround',
    uniforms,
    vertexShader: GROUND_VERTEX_SHADER,
    fragmentShader: GROUND_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: true,
    toneMapped: true,
  });
  return material as BeaconGroundMaterial;
}

/* ---------------------------------------------------------------------------
 * Sparkles (orbiting / rising points)
 * ------------------------------------------------------------------------- */

const SPARKLE_VERTEX_SHADER = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uOrbit;
uniform float uRise;
uniform float uEnergy;
uniform float uPointScale;
uniform float uSize;
varying float vAlpha;
varying float vStar;
#include <fog_pars_vertex>
void main() {
  float t = fract( aSeed.z + uRise * ( 0.55 + 0.9 * aSeed.w ) );
  float dir = aSeed.w > 0.3 ? 1.0 : - 1.0;
  float ang = aSeed.x * 6.28318 + uOrbit * ( 0.55 + 0.9 * aSeed.y ) * dir;
  float baseR = mix( 0.55, 2.0, aSeed.y * aSeed.y );
  // Dormant: a loose halo hovering around the cluster. Active: a spiral drawn
  // into the beam, rising and tightening.
  float r = baseR * mix( 1.0, mix( 1.05, 0.28, t ), uEnergy );
  float hover = mix( - 1.25, 1.45, fract( aSeed.w * 7.31 ) ) + sin( uTime * 0.6 + aSeed.x * 31.0 ) * 0.14;
  float rise = mix( - 1.4, 6.5, t );
  float y = mix( hover, rise, uEnergy );
  vec3 p = vec3( cos( ang ) * r, y, sin( ang ) * r );
  vec4 mvPosition = modelViewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  float size = uSize * ( 0.45 + 0.9 * fract( aSeed.y * 13.7 ) ) * uPointScale / max( - mvPosition.z, 0.1 );
  float clamped = clamp( size, 1.5, 26.0 );
  gl_PointSize = clamped;
  // Keep sub-pixel sparkles energy-conserving instead of fat and bright.
  float coverage = min( 1.0, ( size * size ) / ( clamped * clamped ) );
  float twinkle = 0.55 + 0.45 * sin( uTime * ( 2.0 + 5.0 * aSeed.y ) + aSeed.z * 40.0 );
  vAlpha = sin( 3.14159 * t ) * twinkle * coverage;
  vStar = step( 0.72, fract( aSeed.x * 17.3 ) );
  #include <fog_vertex>
}
`;

const SPARKLE_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform float uIntensity;
uniform float uExposure;
varying float vAlpha;
varying float vStar;
#include <fog_pars_fragment>
${BEACON_COMMON}
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot( c, c ) * 4.0;
  if ( d2 >= 1.0 ) discard;
  float soft = exp( - d2 * 7.0 ) * ( 1.0 - d2 );
  float star = ( exp( - abs( c.x ) * 26.0 ) + exp( - abs( c.y ) * 26.0 ) ) * ( 1.0 - d2 ) * 0.45 * vStar;
  vec3 col = mix( uColor, uCoreColor, 0.6 ) * ( soft + star );
  col *= vAlpha * uIntensity * uExposure * ( 1.0 - bcFogFactor() );
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface SparkleUniforms extends FogUniforms {
  [uniform: string]: THREE.IUniform;
  uColor: THREE.IUniform<THREE.Color>;
  uCoreColor: THREE.IUniform<THREE.Color>;
  uTime: THREE.IUniform<number>;
  uOrbit: THREE.IUniform<number>;
  uRise: THREE.IUniform<number>;
  uEnergy: THREE.IUniform<number>;
  uPointScale: THREE.IUniform<number>;
  uSize: THREE.IUniform<number>;
  uIntensity: THREE.IUniform<number>;
  uExposure: THREE.IUniform<number>;
}

export type BeaconSparkleMaterial = THREE.ShaderMaterial & { uniforms: SparkleUniforms };

export function createBeaconSparkleMaterial(color: THREE.ColorRepresentation): BeaconSparkleMaterial {
  const c = emissiveColors(color);
  const uniforms: SparkleUniforms = {
    ...fogUniforms(),
    uColor: { value: c.color },
    uCoreColor: { value: c.core },
    uTime: { value: 0 },
    uOrbit: { value: 0 },
    uRise: { value: 0 },
    uEnergy: { value: 0 },
    uPointScale: { value: 600 },
    uSize: { value: 0.07 },
    uIntensity: { value: 0 },
    uExposure: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({
    name: 'BeaconSparkles',
    uniforms,
    vertexShader: SPARKLE_VERTEX_SHADER,
    fragmentShader: SPARKLE_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
    toneMapped: true,
  });
  return material as BeaconSparkleMaterial;
}

/** Seeded points for the sparkle shader; `position` only drives the draw count. */
export function createBeaconSparkleGeometry(maxCount: number, seed: number): THREE.BufferGeometry {
  const rand = mulberry32(seed);
  const positions = new Float32Array(maxCount * 3);
  const seeds = new Float32Array(maxCount * 4);
  for (let i = 0; i < maxCount; i += 1) {
    seeds[i * 4] = rand();
    seeds[i * 4 + 1] = rand();
    seeds[i * 4 + 2] = rand();
    seeds[i * 4 + 3] = rand();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  // The shader moves every point within ~2 units of the axis, from y −1.6 to 6.8.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2.6, 0), 5.2);
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-2.2, -1.8, -2.2), new THREE.Vector3(2.2, 7, 2.2));
  return geometry;
}

/* ---------------------------------------------------------------------------
 * Crystal cluster geometry
 * ------------------------------------------------------------------------- */

/** Small deterministic PRNG (same seed → same cluster on every device). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ShardSpec {
  center: THREE.Vector3;
  axis: THREE.Vector3;
  radius: number;
  /** Half height of the prism band. */
  prismHalf: number;
  topCap: number;
  bottomCap: number;
  sides: number;
  /** Twist of the upper ring relative to the lower one (radians). */
  twist: number;
  /** Relative radial jitter per vertex. */
  jitter: number;
  /** 0 for the main shard, (0, 1] for satellites. */
  phase: number;
}

export interface CrystalClusterOptions {
  seed: number;
  /** Satellite shards around the main bipyramid (clamped to 2 – 4). */
  satellites: number;
  /** Uniform scale of the whole cluster. */
  scale?: number;
}

export interface CrystalClusterGeometry {
  geometry: THREE.BufferGeometry;
  shards: readonly ShardSpec[];
  /** Height of the main shard's top tip above the cluster origin. */
  topTip: number;
  /** Depth of the lowest point below the cluster origin (positive number). */
  bottomDepth: number;
}

interface ClusterBuffers {
  position: number[];
  normal: number[];
  bary: number[];
  center: number[];
  axis: number[];
  shape: number[];
}

const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _n = new THREE.Vector3();
const _centroid = new THREE.Vector3();

/**
 * Pushes one flat-shaded triangle, oriented outward from the shard centre.
 * `real0..2` flag whether the edge OPPOSITE each vertex is a true crystal edge
 * (false for the diagonal that splits a prism quad), encoded by lifting that
 * barycentric component so it never approaches zero.
 */
function pushTriangle(
  out: ClusterBuffers,
  shard: ShardSpec,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  real0: boolean,
  real1: boolean,
  real2: boolean,
  facet: number,
  halfLength: number,
): void {
  _ab.subVectors(b, a);
  _ac.subVectors(c, a);
  _n.crossVectors(_ab, _ac);
  _centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3).sub(shard.center);
  let v1 = b;
  let v2 = c;
  let r1 = real1;
  let r2 = real2;
  if (_n.dot(_centroid) < 0) {
    _n.negate();
    v1 = c;
    v2 = b;
    r1 = real2;
    r2 = real1;
  }
  _n.normalize();
  const verts = [a, v1, v2];
  const lift = [real0 ? 0 : 1, r1 ? 0 : 1, r2 ? 0 : 1];
  for (let k = 0; k < 3; k += 1) {
    const v = verts[k];
    out.position.push(v.x, v.y, v.z);
    out.normal.push(_n.x, _n.y, _n.z);
    out.bary.push((k === 0 ? 1 : 0) + lift[0], (k === 1 ? 1 : 0) + lift[1], (k === 2 ? 1 : 0) + lift[2]);
    out.center.push(shard.center.x, shard.center.y, shard.center.z);
    out.axis.push(shard.axis.x, shard.axis.y, shard.axis.z);
    out.shape.push(shard.radius, halfLength, shard.phase, facet);
  }
}

function buildShard(out: ClusterBuffers, shard: ShardSpec, rand: () => number): void {
  const axis = shard.axis.clone().normalize();
  const ref = Math.abs(axis.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(axis, ref).normalize();
  const w = new THREE.Vector3().crossVectors(axis, u).normalize();
  const n = Math.max(3, Math.round(shard.sides));
  const rot0 = rand() * Math.PI * 2;
  const ringA: THREE.Vector3[] = [];
  const ringB: THREE.Vector3[] = [];
  const point = (theta: number, r: number, h: number): THREE.Vector3 =>
    shard.center
      .clone()
      .addScaledVector(axis, h)
      .addScaledVector(u, Math.cos(theta) * r)
      .addScaledVector(w, Math.sin(theta) * r);

  for (let i = 0; i < n; i += 1) {
    const theta = rot0 + (i / n) * Math.PI * 2 + (rand() - 0.5) * (1.1 / n);
    const rA = shard.radius * (1 + (rand() - 0.5) * 2 * shard.jitter);
    const rB = shard.radius * 0.9 * (1 + (rand() - 0.5) * 2 * shard.jitter);
    const hA = -shard.prismHalf * (1 + (rand() - 0.5) * 0.16);
    const hB = shard.prismHalf * (1 + (rand() - 0.5) * 0.16);
    ringA.push(point(theta, rA, hA));
    ringB.push(point(theta + shard.twist, rB, hB));
  }
  const apexOffset = (scale: number): THREE.Vector3 =>
    new THREE.Vector3()
      .addScaledVector(u, (rand() - 0.5) * shard.radius * scale)
      .addScaledVector(w, (rand() - 0.5) * shard.radius * scale);
  const top = shard.center
    .clone()
    .addScaledVector(axis, shard.prismHalf + shard.topCap)
    .add(apexOffset(0.4));
  const bottom = shard.center
    .clone()
    .addScaledVector(axis, -(shard.prismHalf + shard.bottomCap))
    .add(apexOffset(0.3));
  const halfLength = shard.prismHalf + shard.topCap;

  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    // Bottom pyramid: every edge is a real ridge.
    pushTriangle(out, shard, bottom, ringA[j], ringA[i], true, true, true, rand(), halfLength);
    // Prism band: two triangles per (possibly non-planar) quad, diagonal hidden.
    const quadFacet = rand();
    // tri (A_i, A_j, B_j): diagonal B_j–A_i is opposite vertex A_j (index 1).
    pushTriangle(out, shard, ringA[i], ringA[j], ringB[j], true, false, true, quadFacet, halfLength);
    // tri (A_i, B_j, B_i): diagonal A_i–B_j is opposite vertex B_i (index 2).
    pushTriangle(out, shard, ringA[i], ringB[j], ringB[i], true, true, false, quadFacet * 0.85 + 0.08, halfLength);
    // Top pyramid.
    pushTriangle(out, shard, top, ringB[i], ringB[j], true, true, true, rand(), halfLength);
  }
}

/**
 * Builds a beacon crystal cluster: an elongated hexagonal bipyramid (main
 * shard, raised so its short lower tip and long upper tip suit a beacon that
 * hovers just above sloping rock) with 2 – 4 satellites sprouting up and out
 * of its mid-section. Non-indexed, flat normals, with the attributes
 * BeaconCrystal's shaders expect. The envelope flares upward like the free
 * space in front of a back-leaning cliff, so it can rotate close to the rock.
 */
export function createCrystalClusterGeometry(options: CrystalClusterOptions): CrystalClusterGeometry {
  const rand = mulberry32(options.seed);
  const scale = options.scale ?? 1;
  const satellites = Math.max(2, Math.min(4, Math.round(options.satellites)));

  const shards: ShardSpec[] = [];
  shards.push({
    center: new THREE.Vector3(0, 0.28 * scale, 0),
    axis: new THREE.Vector3((rand() - 0.5) * 0.12, 1, (rand() - 0.5) * 0.12).normalize(),
    radius: 0.27 * scale,
    prismHalf: 0.52 * scale,
    topCap: 0.72 * scale,
    bottomCap: 0.36 * scale,
    sides: 6,
    twist: 0.1,
    jitter: 0.07,
    phase: 0,
  });

  const azimuth0 = rand() * Math.PI * 2;
  // Golden-angle azimuths so no two satellites line up; lower ones are smaller
  // and lean further out, upper ones stand steeper.
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let k = 0; k < satellites; k += 1) {
    const u = satellites > 1 ? k / (satellites - 1) : 0.5;
    const az = azimuth0 + k * golden * 1.6 + (rand() - 0.5) * 0.35;
    const s = (0.38 + 0.2 * u + 0.12 * rand()) * scale;
    const tilt = 0.62 - 0.3 * u + (rand() - 0.5) * 0.1;
    const axis = new THREE.Vector3(Math.sin(tilt) * Math.cos(az), Math.cos(tilt), Math.sin(tilt) * Math.sin(az)).normalize();
    const radius = 0.25 * s * (0.95 + rand() * 0.15);
    const prismHalf = 0.42 * s * (0.85 + rand() * 0.3);
    const topCap = 0.62 * s;
    const bottomCap = 0.26 * s;
    const rootY = (0.1 + 0.46 * u + (rand() - 0.5) * 0.08) * scale;
    const root = new THREE.Vector3(Math.cos(az) * 0.1 * scale, rootY, Math.sin(az) * 0.1 * scale);
    // Sink the satellite's lower tip into the main shard so the cluster reads as grown together.
    const center = root.clone().addScaledVector(axis, prismHalf + bottomCap * 0.4);
    shards.push({
      center,
      axis,
      radius,
      prismHalf,
      topCap,
      bottomCap,
      sides: rand() < 0.5 ? 6 : 5,
      twist: (rand() - 0.5) * 0.3,
      jitter: 0.09,
      phase: 0.15 + (0.85 * (k + rand() * 0.5)) / satellites,
    });
  }

  const buffers: ClusterBuffers = { position: [], normal: [], bary: [], center: [], axis: [], shape: [] };
  for (const shard of shards) buildShard(buffers, shard, rand);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(buffers.position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(buffers.normal, 3));
  geometry.setAttribute('aBary', new THREE.Float32BufferAttribute(buffers.bary, 3));
  geometry.setAttribute('aCenter', new THREE.Float32BufferAttribute(buffers.center, 3));
  geometry.setAttribute('aAxis', new THREE.Float32BufferAttribute(buffers.axis, 3));
  geometry.setAttribute('aShape', new THREE.Float32BufferAttribute(buffers.shape, 4));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const box = geometry.boundingBox ?? new THREE.Box3();
  const bottomDepth = Math.max(0, -box.min.y);
  // The vertex stage floats satellites up to SATELLITE_SPREAD_MAX away and bobs them.
  if (geometry.boundingSphere) geometry.boundingSphere.radius += SATELLITE_SPREAD_MAX + 0.1;
  if (geometry.boundingBox) geometry.boundingBox.expandByScalar(SATELLITE_SPREAD_MAX + 0.1);

  const main = shards[0];
  return {
    geometry,
    shards,
    topTip: main.center.y + main.prismHalf + main.topCap,
    bottomDepth,
  };
}

/* ---------------------------------------------------------------------------
 * Fitting a beacon to the terrain
 * ------------------------------------------------------------------------- */

/** Signed distance to the rock (negative inside), e.g. terrainGeometry's mountainSdf. */
export type SdfFunction = (x: number, y: number, z: number) => number;

export interface BeaconTerrainFitOptions {
  /** Extra clearance kept between crystal and rock (mesh tessellation error, noise). */
  margin?: number;
  minScale?: number;
  maxScale?: number;
  /** Peak vertical hover of the cluster (world units). */
  hover?: number;
  /** Peak precession tilt of the cluster (radians). */
  tilt?: number;
}

export interface BeaconTerrainFit {
  /** Uniform scale for the crystal cluster so it rotates clear of the rock. */
  scale: number;
  /** Worst clearance at that scale (negative = still touching at minScale). */
  clearance: number;
  /** SDF at the beacon position (free radius around its centre). */
  distance: number;
  /** Unit direction away from the nearest rock (SDF gradient). */
  outward: THREE.Vector3;
  /** Ground glow placement relative to the beacon position, or null when no rock lies below. */
  ground: { offset: THREE.Vector3; normal: THREE.Vector3; depth: number } | null;
}

/** Maximum distance (object units) the satellites float out when a beacon flares. */
export const SATELLITE_SPREAD_MAX = 0.15 * 1.35;

function sdfGradient(sdf: SdfFunction, x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  const e = 0.04;
  out.set(sdf(x + e, y, z) - sdf(x - e, y, z), sdf(x, y + e, z) - sdf(x, y - e, z), sdf(x, y, z + e) - sdf(x, y, z - e));
  const len = out.length();
  return len > 1e-8 ? out.multiplyScalar(1 / len) : out.set(0, 1, 0);
}

/**
 * Fits a beacon to the rock around it (runs once at mount, ~0.3 ms):
 *   - the largest cluster scale whose rotating, hovering, flaring envelope
 *     keeps `margin` away from the rock (the free radius at each height is the
 *     SDF on the beacon's vertical axis),
 *   - where the rock lies straight below (for the ground glow) and its normal,
 *   - which way is "out of the rock" (to keep the point light off the face).
 */
export function fitBeaconToTerrain(
  position: readonly [number, number, number],
  cluster: THREE.BufferGeometry,
  sdf: SdfFunction,
  options: BeaconTerrainFitOptions = {},
): BeaconTerrainFit {
  const [px, py, pz] = position;
  const margin = options.margin ?? 0.12;
  const minScale = options.minScale ?? 0.6;
  const maxScale = options.maxScale ?? 1;
  const hover = options.hover ?? 0.08;
  const tilt = options.tilt ?? 0.06;

  // Free radius on the vertical axis, every 5 cm from −3 to +3.
  const step = 0.05;
  const half = 60;
  const free = new Float64Array(half * 2 + 1);
  for (let i = 0; i <= half * 2; i += 1) free[i] = sdf(px, py + (i - half) * step, pz);
  const freeAt = (y: number): number => {
    const f = Math.min(half * 2, Math.max(0, y / step + half));
    const i = Math.min(half * 2 - 1, Math.floor(f));
    const t = f - i;
    return free[i] + (free[i + 1] - free[i]) * t;
  };
  const freeOver = (y0: number, y1: number): number => {
    let m = Math.min(freeAt(y0), freeAt(y1));
    for (let y = y0 + step; y < y1; y += step) m = Math.min(m, freeAt(y));
    return m;
  };

  // Envelope samples: for each vertex, the horizontal radius it can sweep
  // (rotation about y, satellite self-spin, flare spread) and its height span.
  const pos = cluster.getAttribute('position') as THREE.BufferAttribute;
  const cen = cluster.getAttribute('aCenter') as THREE.BufferAttribute;
  const ax = cluster.getAttribute('aAxis') as THREE.BufferAttribute;
  const shape = cluster.getAttribute('aShape') as THREE.BufferAttribute;
  const radii: number[] = [];
  const lows: number[] = [];
  const highs: number[] = [];
  const v = new THREE.Vector3();
  const c = new THREE.Vector3();
  const a = new THREE.Vector3();
  const base = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 1) {
    v.fromBufferAttribute(pos, i);
    if (shape.getZ(i) <= 0.001) {
      radii.push(Math.hypot(v.x, v.z));
      lows.push(v.y);
      highs.push(v.y);
      continue;
    }
    c.fromBufferAttribute(cen, i);
    a.fromBufferAttribute(ax, i).normalize();
    const h = v.clone().sub(c).dot(a);
    base.copy(c).addScaledVector(a, h);
    const rho = v.distanceTo(base);
    const sideways = rho * Math.sqrt(Math.max(0, 1 - a.y * a.y));
    const away = c.clone().normalize();
    const lift = SATELLITE_SPREAD_MAX * away.y;
    radii.push(Math.hypot(base.x, base.z) + rho + SATELLITE_SPREAD_MAX * Math.hypot(away.x, away.z));
    lows.push(base.y - sideways - 0.05);
    highs.push(base.y + sideways + 0.05 + Math.max(0, lift));
  }

  const worstAt = (s: number): number => {
    let worst = Number.POSITIVE_INFINITY;
    for (let i = 0; i < radii.length; i += 1) {
      const y0 = lows[i] * s - hover;
      const y1 = highs[i] * s + hover;
      const reach = radii[i] * s + tilt * Math.max(Math.abs(y0), Math.abs(y1));
      worst = Math.min(worst, freeOver(y0, y1) - reach - margin);
    }
    return worst;
  };

  let scale = minScale;
  let clearance = worstAt(minScale);
  for (let s = maxScale; s >= minScale - 1e-6; s -= 0.025) {
    const w = worstAt(s);
    if (w >= 0) {
      scale = s;
      clearance = w;
      break;
    }
  }

  const outward = sdfGradient(sdf, px, py, pz, new THREE.Vector3());

  // Rock straight below: march down, then bisect onto the surface.
  let ground: BeaconTerrainFit['ground'] = null;
  let prev = 0;
  for (let t = 0.04; t <= 8; t += 0.04) {
    if (sdf(px, py - t, pz) < 0) {
      let lo = prev;
      let hi = t;
      for (let k = 0; k < 8; k += 1) {
        const mid = (lo + hi) * 0.5;
        if (sdf(px, py - mid, pz) < 0) hi = mid;
        else lo = mid;
      }
      const depth = (lo + hi) * 0.5;
      const normal = sdfGradient(sdf, px, py - depth, pz, new THREE.Vector3());
      ground = { offset: new THREE.Vector3(0, -depth, 0).addScaledVector(normal, 0.05), normal, depth };
      break;
    }
    prev = t;
  }

  return { scale, clearance, distance: sdf(px, py, pz), outward, ground };
}
