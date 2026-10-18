import * as THREE from 'three';
import { keyLight } from '../world/keyLight';
import { ROCK_NOISE_GLSL, getRockNoiseTexture } from './rockNoise';

/* ==========================================================================
 * Alpine rock material — a MeshStandardMaterial extended via onBeforeCompile.
 *
 * Everything is procedural and world-space (no UVs, no triplanar seams); one
 * shared 3D noise texture (rockNoise.ts) serves the layered noises, three
 * fetches per fragment, each filtered and mip-mapped:
 *   - fracture blocks: joint sets cut the rock into blocks; open joints are
 *     thin dark cracks with bevelled, occluded lips; the terrain's own planar
 *     facets (`aFacet`, one id per geometric facet) each get their own value,
 *     roughness and a few a faint warm cast (without `aFacet` a shader
 *     cellular facet id stands in);
 *   - weathered relief (ridged and fine gradient noise), chips up close;
 *   - albedo: cool-neutral granite, per-facet tone, iron staining, mottling,
 *     dark fall-line varnish and meltwater streaks on steep faces, cracks;
 *   - mid-field (20-150 m): snow gathers in gullies and on benches and sheds
 *     off the steep pyramid flanks, convex ribs stay bare and darker,
 *     horizontal bands break the faces, lit snow carries the alpenglow;
 *   - snow on up-facing ledges with a crisp, lobed, wind-scoured edge
 *     (anti-aliased to ~1.5 px), a rounded 5 cm lip that catches the light and
 *     a dark wet rim on the rock just outside it; wind ripples (sastrugi) and
 *     pixel-sized ice sparkle that only the sun's own highlight can flash;
 *   - baked per-vertex ambient occlusion (`aOcclusion`) and curvature
 *     (`aCurvature`): worn edges, grime in creases, snow scoured off convex
 *     edges and packed into hollows.
 * Every layer fades out with the world size of a pixel before it could alias.
 * It stays a standard PBR material: shadows, fog, tone mapping (and so
 * sceneFx.exposure) and environment lighting keep working. The sun direction
 * is the key light (keyLight.ts), shared by reference. The program cache key
 * is stable per (quality, AO, curvature, facet, sun-visibility, all-snow).
 * ========================================================================== */

export type RockShaderQuality = 0 | 1 | 2;

export interface AlpineRockMaterialOptions {
  /** Read the per-vertex `aOcclusion` attribute baked by terrainGeometry. */
  vertexOcclusion?: boolean;
  /** Read the per-vertex `aCurvature` attribute baked by terrainGeometry (edge wear, cavity grime, wind-scoured snow). */
  vertexCurvature?: boolean;
  /**
   * Shader detail: 0 = low (one steep joint set, sheeting joints, snow edge, lip and rim), 1 = medium (+ second
   * joint set, weathered relief, sastrugi, sparkle), 2 = high (+ 27-cell facets, chips, fine relief).
   */
  quality?: RockShaderQuality;
  /** Global snow coverage 0..1. */
  snowAmount?: number;
  /** World Y around which up-facing ledges are fully snow covered. */
  snowLine?: number;
  /** Strength of the procedural facet / fracture normal perturbation. */
  bumpStrength?: number;
  /** World-space scale multiplier of the rock pattern (1 = authored scale). */
  patternScale?: number;
  /**
   * Direction towards the sun (world space), copied. Default: the shared key-light vector
   * (`keyLight.direction`, by reference, so the material follows WorldLighting's key light).
   */
  sunDirection?: THREE.Vector3;
  /** Render every fragment as snow (used by createSnowMaterial). */
  allSnow?: boolean;
  /** Read the per-vertex `aFacet` id baked by terrainGeometry (one value per geometric facet). */
  vertexFacet?: boolean;
  /** Read the per-vertex `aSunVis` key-light visibility baked by terrainGeometry (quality 0 only). */
  vertexSunVis?: boolean;
}

export interface AlpineRockUniforms {
  uRockSun: { value: THREE.Vector3 };
  uSnowAmount: { value: number };
  uSnowLine: { value: number };
  uBumpStrength: { value: number };
  uPatternScale: { value: number };
  /** 0 → fragments resolve to the fog colour, 1 → fully visible (build-in reveal). */
  uReveal: { value: number };
  uGranite: { value: THREE.Color };
  uGraniteDark: { value: THREE.Color };
  uGraniteLight: { value: THREE.Color };
  uGraniteWarm: { value: THREE.Color };
  uSnowColor: { value: THREE.Color };
  uSnowShadow: { value: THREE.Color };
  /** Shared rock noise (rockNoise.ts). */
  uRockNoise: { value: THREE.Data3DTexture };
  /** Weight of the baked key-light visibility (keyLight.bakeWeight, shared by reference). */
  uKeyBakeWeight: { value: number };
}

export type AlpineRockMaterial = THREE.MeshStandardMaterial & {
  userData: { rockUniforms: AlpineRockUniforms };
};

/* Hash and value noise, shared by the vertex and fragment stages. */
const NOISE_COMMON = /* glsl */ `
float rockHash13( vec3 p3 ) {
	p3 = fract( p3 * 0.1031 );
	p3 += dot( p3, p3.zyx + 31.32 );
	return fract( ( p3.x + p3.y ) * p3.z );
}

/* 3D value noise in [0, 1]. */
float rockValue3( vec3 p ) {
	vec3 i = floor( p );
	vec3 f = fract( p );
	vec3 u = f * f * ( 3.0 - 2.0 * f );
	float a = rockHash13( i );
	float b = rockHash13( i + vec3( 1.0, 0.0, 0.0 ) );
	float c = rockHash13( i + vec3( 0.0, 1.0, 0.0 ) );
	float d = rockHash13( i + vec3( 1.0, 1.0, 0.0 ) );
	float e = rockHash13( i + vec3( 0.0, 0.0, 1.0 ) );
	float f1 = rockHash13( i + vec3( 1.0, 0.0, 1.0 ) );
	float g = rockHash13( i + vec3( 0.0, 1.0, 1.0 ) );
	float h = rockHash13( i + vec3( 1.0, 1.0, 1.0 ) );
	return mix( mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y ), mix( mix( e, f1, u.x ), mix( g, h, u.x ), u.y ), u.z );
}
`;

/*
 * Low-frequency fields (features of 5–35 units) are evaluated per vertex and
 * interpolated: x = macro tone, y = fractured-zone mask, z = joint warp,
 * w = iron staining; vRockSnowLow = large-scale snow noise.
 */
const VERTEX_PARS = /* glsl */ `
uniform float uPatternScale;
varying vec3 vRockPos;
varying vec3 vRockNormal;
varying vec4 vRockLow;
varying float vRockSnowLow;
${NOISE_COMMON}
#ifdef ROCK_VERTEX_AO
attribute float aOcclusion;
varying float vRockAO;
#endif
#ifdef ROCK_VERTEX_CURVATURE
attribute float aCurvature;
varying float vRockCurv;
#endif
#ifdef ROCK_VERTEX_FACET
attribute float aFacet;
varying vec3 vRockFacet;
#endif
#if defined( ROCK_VERTEX_SUNVIS ) && ROCK_QUALITY == 0
attribute float aSunVis;
varying float vRockSunVis;
#endif
`;

const VERTEX_MAIN = /* glsl */ `
vRockPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vRockNormal = normalize( mat3( modelMatrix ) * objectNormal );
{
	vec3 lowP = vRockPos * uPatternScale;
	vRockLow = vec4(
		rockValue3( lowP * 0.028 ) * 0.6 + rockValue3( lowP * 0.1 + 11.0 ) * 0.4,
		rockValue3( lowP * 0.05 + vec3( 2.0, -4.0, 1.0 ) ),
		rockValue3( lowP * 0.045 ),
		rockValue3( lowP * 0.07 + vec3( 3.0, 1.0, -7.0 ) )
	);
	vRockSnowLow = rockValue3( lowP * 0.19 + 3.0 );
}
#ifdef ROCK_VERTEX_AO
vRockAO = aOcclusion;
#endif
#ifdef ROCK_VERTEX_CURVATURE
vRockCurv = aCurvature;
#endif
#ifdef ROCK_VERTEX_FACET
// Facet id plus two per-facet hashes, derived per vertex so they interpolate across facet seams without banding.
vRockFacet = vec3( aFacet, fract( aFacet * 7.3 ), smoothstep( 0.83, 0.87, fract( aFacet * 13.1 ) ) );
#endif
#if defined( ROCK_VERTEX_SUNVIS ) && ROCK_QUALITY == 0
vRockSunVis = aSunVis;
#endif
`;

const FRAGMENT_PARS = /* glsl */ `
uniform vec3 uRockSun;
uniform float uSnowAmount;
uniform float uSnowLine;
uniform float uBumpStrength;
uniform float uPatternScale;
uniform float uReveal;
uniform vec3 uGranite;
uniform vec3 uGraniteDark;
uniform vec3 uGraniteLight;
uniform vec3 uGraniteWarm;
uniform vec3 uSnowColor;
uniform vec3 uSnowShadow;
uniform float uKeyBakeWeight;
varying vec3 vRockPos;
varying vec3 vRockNormal;
varying vec4 vRockLow;
varying float vRockSnowLow;
#ifdef ROCK_VERTEX_AO
varying float vRockAO;
#endif
#ifdef ROCK_VERTEX_CURVATURE
varying float vRockCurv;
#endif
#ifdef ROCK_VERTEX_FACET
varying vec3 vRockFacet;
#endif
#if defined( ROCK_VERTEX_SUNVIS ) && ROCK_QUALITY == 0
varying float vRockSunVis;
#endif
${NOISE_COMMON}
${ROCK_NOISE_GLSL}

#if ROCK_QUALITY > 1 || ! defined( ROCK_VERTEX_FACET )
vec3 rockHash33( vec3 p3 ) {
	p3 = fract( p3 * vec3( 0.1031, 0.1030, 0.0973 ) );
	p3 += dot( p3, p3.yxz + 33.33 );
	return fract( ( p3.xxy + p3.yxx ) * p3.zyx );
}
#endif

/* 3D value noise with analytic derivatives: ( value in [0, 1], d/dx, d/dy, d/dz ). */
vec4 rockNoised3( vec3 x ) {
	vec3 i = floor( x );
	vec3 f = fract( x );
	vec3 u = f * f * ( 3.0 - 2.0 * f );
	vec3 du = 6.0 * f * ( 1.0 - f );
	float a = rockHash13( i );
	float b = rockHash13( i + vec3( 1.0, 0.0, 0.0 ) );
	float c = rockHash13( i + vec3( 0.0, 1.0, 0.0 ) );
	float d = rockHash13( i + vec3( 1.0, 1.0, 0.0 ) );
	float e = rockHash13( i + vec3( 0.0, 0.0, 1.0 ) );
	float f1 = rockHash13( i + vec3( 1.0, 0.0, 1.0 ) );
	float g = rockHash13( i + vec3( 0.0, 1.0, 1.0 ) );
	float h = rockHash13( i + vec3( 1.0, 1.0, 1.0 ) );
	float k1 = b - a;
	float k2 = c - a;
	float k3 = e - a;
	float k4 = a - b - c + d;
	float k5 = a - c - e + g;
	float k6 = a - b - e + f1;
	float k7 = - a + b + c - d + e - f1 - g + h;
	return vec4(
		a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z,
		du * vec3(
			k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
			k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
			k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y
		)
	);
}

/* 1D value noise with derivative: ( value in [0, 1], d/dx ); seed picks the sequence. */
vec2 rockNoised1( float x, float seed ) {
	float i = floor( x );
	float f = x - i;
	float a = rockHash13( vec3( i, seed, 3.3 ) );
	float b = rockHash13( vec3( i + 1.0, seed, 3.3 ) );
	return vec2( a + ( b - a ) * f * f * ( 3.0 - 2.0 * f ), ( b - a ) * 6.0 * f * ( 1.0 - f ) );
}

/*
 * One family of parallel joint planes (normal pn, mean spacing sp, bent by a
 * low-frequency warp, irregularly spaced). Returns the distance *along the
 * surface* (world units) to the nearest plane; jdx is the index of that joint,
 * toEdge the tangent direction pointing at it (shorter than 1 where the planes
 * run nearly parallel to the surface) and obliq how squarely the planes cut the
 * surface (1 = at right angles).
 */
float rockPlanes( vec3 p, vec3 pn, float sp, float warp, float seed, vec3 n, out float jdx, out vec3 toEdge, out float obliq ) {
	float s0 = dot( p, pn ) / sp + warp;
	// Monotonic remap: joint spacing varies between ~0.7x and ~2x the mean.
	vec2 jn = rockNoised1( s0 * 0.37, seed );
	float s = s0 + 0.9 * ( jn.x - 0.5 );
	float i = floor( s );
	float f = s - i;
	vec3 g = pn / sp * ( 1.0 + 0.9 * 0.37 * jn.y );
	vec3 gt = g - dot( g, n ) * n;
	float tl = max( length( gt ), 0.25 * length( g ) );
	obliq = length( gt ) / length( g );
	jdx = f < 0.5 ? i : i + 1.0;
	toEdge = ( f < 0.5 ? - gt : gt ) / tl;
	return min( f, 1.0 - f ) / tl;
}

/*
 * Adds one joint family to the relief: the crack line and its bevelled lips
 * (the surface rolls into an open joint, so one lip catches the light and the
 * other falls into shade; the lips are also occluded, accumulated in bevel).
 * Joints open in segments along their plane (segFreq sets the segment scale)
 * and the crack tapers to nothing at each end; planes that slice the surface
 * at a grazing angle are faded out (they would smear into bands). Closed
 * joints leave no trace.
 */
void rockJointSet( vec3 p, vec3 pn, float sp, float warp, float openAt, float segFreq, float seed, vec3 n, float px, float lineFade, float blockFade, inout vec3 off, inout float crack, inout float bevel ) {
	float jdx;
	vec3 toEdge;
	float obliq;
	float e = rockPlanes( p, pn, sp, warp, seed, n, jdx, toEdge, obliq );
	float o = smoothstep( openAt, openAt + 0.2, rockValue3( p * segFreq + vec3( jdx * 7.13, seed, jdx * 3.71 ) ) );
	o *= step( 0.3, rockHash13( vec3( jdx, seed, 1.7 ) ) ) * smoothstep( 0.3, 0.6, obliq );
	float bw = 0.12 + 0.12 * o;
	float t = clamp( e / bw, 0.0, 1.0 );
	float lip = ( 1.0 - t ) * ( 1.0 - t ) * o * blockFade;
	off += toEdge * lip * 0.6;
	bevel = max( bevel, lip );
	float cw = 0.006 + 0.022 * o + 0.3 * px;
	crack = max( crack, ( 1.0 - smoothstep( cw * 0.45, cw, e ) ) * smoothstep( 0.04, 0.35, o ) * lineFade );
}

#if ROCK_QUALITY > 1 || ! defined( ROCK_VERTEX_FACET )
/*
 * Fracture facets: jittered 3D cells. Returns the distance along the surface
 * to the nearest cell boundary; id1 / id2 are the two nearest cells and toEdge
 * the tangent direction pointing at the boundary. With wide set it searches
 * the 27 cells around the point (large jitter, irregular cells); otherwise only
 * the 2x2x2 cells around the nearest lattice corner (smaller jitter to match).
 */
float rockFacets( vec3 p, vec3 invScale, vec3 n, bool wide, out vec3 id1, out vec3 id2, out vec3 toEdge ) {
	vec3 q = p * invScale;
	float d1 = 1e9;
	float d2 = 1e9;
	vec3 c1 = q;
	vec3 c2 = q + 1.0;
	id1 = floor( q );
	id2 = id1;
	// wide: the 27 cells around the point (large jitter); otherwise the 8 cells around the nearest lattice corner.
	vec3 b = wide ? floor( q ) - 1.0 : floor( q - 0.5 );
	int span = wide ? 3 : 2;
	float jitter = wide ? 0.76 : 0.4;
	for ( int k = 0; k < 3; k ++ ) {
		if ( k >= span ) break;
		for ( int j = 0; j < 3; j ++ ) {
			if ( j >= span ) break;
			for ( int i = 0; i < 3; i ++ ) {
				if ( i >= span ) break;
				vec3 g = b + vec3( float( i ), float( j ), float( k ) );
				vec3 c = g + 0.5 - 0.5 * jitter + jitter * rockHash33( g );
				vec3 r = c - q;
				float d = dot( r, r );
				if ( d < d1 ) {
					d2 = d1;
					c2 = c1;
					id2 = id1;
					d1 = d;
					c1 = c;
					id1 = g;
				} else if ( d < d2 ) {
					d2 = d;
					c2 = c;
					id2 = g;
				}
			}
		}
	}
	vec3 dir = normalize( c2 - c1 );
	float e = max( dot( 0.5 * ( c1 + c2 ) - q, dir ), 0.0 );
	vec3 gw = dir * invScale;
	vec3 gt = gw - dot( gw, n ) * n;
	float tl = max( length( gt ), 0.25 * length( gw ) );
	toEdge = gt / tl;
	return e / tl;
}
#endif
`;

/* Computes rock / snow albedo, relief normal and roughness (world space). */
const FRAGMENT_SURFACE = /* glsl */ `
	vec3 rockN = normalize( vRockNormal );
	vec3 rockP = vRockPos * uPatternScale;
	#ifdef ROCK_VERTEX_CURVATURE
		// Convex edges (> 0) and creases / hollows (< 0) of the sculpted rock.
		float rockCurv = vRockCurv;
	#else
		float rockCurv = 0.0;
	#endif
	float rockConvex = smoothstep( 0.05, 0.6, rockCurv );
	float rockCavity = smoothstep( 0.05, 0.6, - rockCurv );
	// World size of one pixel (outside any branch: derivatives need uniform control flow).
	float rockPx = length( fwidth( vRockPos ) ) * uPatternScale;

	// Fade factors: each layer disappears before its features shrink to a few pixels.
	float rockBlockFade = 1.0 - smoothstep( 0.09, 0.32, rockPx );
	float rockLineFade = 1.0 - smoothstep( 0.02, 0.07, rockPx );
	float rockChipFade = 1.0 - smoothstep( 0.012, 0.045, rockPx );
	// Mid-field (about 20-150 m): gully / bench snow, bare ribs, bands.
	float rockMid = smoothstep( 0.03, 0.06, rockPx ) * ( 1.0 - smoothstep( 0.9, 1.3, rockPx ) );

	// Shared noise, one filtered fetch per scale (implicit LOD: keep these in uniform control flow).
	// F1 (2.5 m): x joint warp, y mottling, z wind scour, w snow noise.
	vec4 rockF1 = rockTex( rockP * 0.4 + vec3( 9.0, 2.0, -4.0 ) );
	// F2 (fall-line stretched, 0.45 m x 6 m): x varnish, y varnish break, z meltwater streak, w snow runnels.
	vec4 rockF2 = rockTex( vec3( ( rockP.x + rockP.z ) * 2.2, rockP.y * 0.16, ( rockP.x - rockP.z ) * 2.2 ) + 17.0 );
	// F3 (0.45 m): x snow-edge break-up, y sastrugi strength.
	vec4 rockF3 = rockTex( rockP * 2.2 + 5.0 );

	// Normal offset (world space, projected onto the surface at the end) and crack / tone / bevel accumulators.
	vec3 rockOff = vec3( 0.0 );
	float rockCrack = 0.0;
	float rockTone = 0.0;
	float rockBevel = 0.0;

	// Joints, facets and relief fade out with distance: far rock (flanks, skirt) skips them entirely.
	if ( rockBlockFade > 0.0 ) {
		// Fractured zones carry many open joints; elsewhere the granite is massive.
		float rockFracZone = smoothstep( 0.3, 0.7, vRockLow.y );
		float rockOpenAt = mix( 0.64, 0.4, rockFracZone );
		// Low-frequency warp that bends the joint planes and varies their spacing.
		float rockWarp = vRockLow.z - 0.5 + ( rockF1.x - 0.5 ) * 0.05;

		// ---- Joints: two steep sets (vertical jointing) and gently dipping sheeting joints.
		rockJointSet( rockP, vec3( 0.86, 0.0, 0.51 ), 3.1, rockWarp * 1.6, rockOpenAt, 0.14, 1.0, rockN, rockPx, rockLineFade, rockBlockFade, rockOff, rockCrack, rockBevel );
		#if ROCK_QUALITY > 0
			rockJointSet( rockP, normalize( vec3( -0.47, 0.12, 0.87 ) ), 4.3, rockWarp * 1.3 + 0.37, rockOpenAt + 0.06, 0.14, 2.0, rockN, rockPx, rockLineFade, rockBlockFade, rockOff, rockCrack, rockBevel );
		#endif
		{
			// Sheeting joints only show on steep faces (on ledges they would run parallel to the surface).
			float sheet = smoothstep( 0.86, 0.55, abs( rockN.y ) );
			float c = 0.0;
			float bv = 0.0;
			vec3 o = vec3( 0.0 );
			rockJointSet( rockP, normalize( vec3( 0.1, 0.99, -0.07 ) ), 2.3, rockWarp * 2.2, rockOpenAt + 0.26, 0.3, 3.0, rockN, rockPx, rockLineFade, rockBlockFade, o, c, bv );
			rockOff += o * sheet;
			rockCrack = max( rockCrack, c * sheet * 0.85 );
			rockBevel = max( rockBevel, bv * sheet );
		}
		#ifndef ROCK_VERTEX_FACET
		{
			// No geometric facet ids: cellular facets a few metres across, each with its own tilt and value.
			vec3 fId1;
			vec3 fId2;
			vec3 fTo;
			float fe = rockFacets( rockP, vec3( 1.0 / 3.8, 1.0 / 5.0, 1.0 / 3.8 ), rockN, ROCK_QUALITY > 1, fId1, fId2, fTo );
			vec3 tilt = rockHash33( fId1 * 1.37 + 4.1 ) * 2.0 - 1.0;
			// The 2x2x2 search below the high tier gives more regular cells: keep their tilt subtler.
			#if ROCK_QUALITY < 2
				rockOff += tilt * 0.09 * rockBlockFade;
			#else
				rockOff += tilt * 0.13 * rockBlockFade;
			#endif
			// A crisp crease between facets.
			float t = clamp( fe / 0.16, 0.0, 1.0 );
			rockOff += fTo * ( 1.0 - t ) * ( 1.0 - t ) * 0.06 * rockBlockFade;
			rockTone += ( rockHash13( fId1 + 3.1 ) - 0.5 ) * 0.36 * rockBlockFade;
		}
		#endif

		#if ROCK_QUALITY > 0
			// ---- Weathered relief: ridged creases (vertical ribs) and a softer undulation.
			{
				vec3 sc = vec3( 0.7, 0.3, 0.7 );
				vec4 nr = rockNoised3( rockP * sc + vec3( 4.0, 1.0, -2.0 ) );
				float sgn = nr.x > 0.5 ? 1.0 : - 1.0;
				rockOff += sgn * 2.0 * nr.yzw * sc * 0.13 * rockBlockFade;
				vec4 nu = rockNoised3( rockP * 0.9 + vec3( -6.0, 3.0, 2.0 ) );
				rockOff -= nu.yzw * 0.9 * 0.12 * rockBlockFade;
				rockTone += ( nu.x - 0.5 ) * 0.14 * rockBlockFade;
			}
		#endif
	}
	#ifdef ROCK_VERTEX_FACET
		// Geometric facets (terrainGeometry): every planar face has its own value at any distance.
		rockTone += ( vRockFacet.x - 0.5 ) * 0.22;
	#endif

	#if ROCK_QUALITY > 1
		// ---- Chips: small fracture facets close to the camera (rarely an open hairline).
		if ( rockChipFade > 0.0 ) {
			vec3 cId1;
			vec3 cId2;
			vec3 cTo;
			float ce = rockFacets( rockP + vec3( 13.1, -7.3, 5.9 ), vec3( 1.0 / 0.7, 1.0 / 0.9, 1.0 / 0.7 ), rockN, false, cId1, cId2, cTo );
			vec3 tilt = rockHash33( cId1 * 1.91 - 2.3 ) * 2.0 - 1.0;
			rockOff += tilt * 0.07 * rockChipFade;
			float cOpen = step( 0.93, rockHash13( cId1 + cId2 + vec3( 0.37, 0.71, 0.13 ) ) );
			float t = clamp( ce / 0.08, 0.0, 1.0 );
			rockOff += cTo * ( 1.0 - t ) * ( 1.0 - t ) * 0.3 * cOpen * rockChipFade;
			rockTone += ( rockHash13( cId1 - 1.7 ) - 0.5 ) * 0.1 * rockChipFade;
			float cw = 0.006 + 0.45 * rockPx;
			rockCrack = max( rockCrack, ( 1.0 - smoothstep( cw * 0.45, cw, ce ) ) * cOpen * rockChipFade * 0.35 );
		}
		// ---- Fine grain relief.
		{
			float rockFineFade = 1.0 - smoothstep( 0.008, 0.03, rockPx );
			vec4 nf = rockNoised3( rockP * 4.3 + vec3( 1.3, -2.1, 0.7 ) );
			rockOff -= nf.yzw * 4.3 * 0.02 * rockFineFade;
		}
	#endif

	// Bumped normal: the offset's component along the surface tilts the normal.
	vec3 rockOffT = rockOff - dot( rockOff, rockN ) * rockN;
	vec3 rockBumped = normalize( rockN + uBumpStrength * rockOffT );

	// ---- Albedo: cool-neutral granite.
	float rockSteep = 1.0 - abs( rockN.y );
	float rockMacro = vRockLow.x;
	// Broad tone stays calm (it read as blotches up close): darker and paler zones only in the tails.
	vec3 rockAlbedo = mix( uGranite, uGraniteDark, ( 1.0 - smoothstep( 0.22, 0.48, rockMacro ) ) * 0.6 );
	rockAlbedo = mix( rockAlbedo, uGraniteLight, smoothstep( 0.55, 0.85, rockMacro ) * 0.5 );
	// The upper mountain's rock is darker (wet, varnished), so its snow reads.
	rockAlbedo *= ( 1.0 + rockTone ) * ( 1.0 - 0.65 * smoothstep( 12.0, 48.0, vRockPos.y ) );
	rockAlbedo = mix( rockAlbedo, uGraniteWarm, smoothstep( 0.6, 0.85, vRockLow.w ) * 0.3 );
	#ifdef ROCK_VERTEX_FACET
		// A few facets are freshly broken / oxidised: a faint warm cast.
		rockAlbedo *= mix( vec3( 1.0 ), vec3( 1.03, 1.0, 0.97 ), vRockFacet.z );
	#endif
	// Weathering mottling at a few metres.
	rockAlbedo *= 0.9 + 0.18 * rockF1.y;
	// Varnish and meltwater streaks: narrow dark runs down the fall line on steep faces, broken along their length.
	float rockVarnish = max(
		smoothstep( 0.62, 0.8, rockF2.x ) * smoothstep( 0.35, 0.65, rockF2.y ),
		smoothstep( 0.66, 0.86, rockF2.z ) * 0.7
	) * smoothstep( 0.3, 0.8, rockSteep );
	rockAlbedo *= 1.0 - 0.38 * rockVarnish;
	// Worn, paler convex edges; grime in the creases.
	rockAlbedo *= ( 1.0 + 0.3 * rockConvex ) * ( 1.0 - 0.2 * rockCavity );
	// Mid-field: bare steep convex ribs are darker; horizontal bands break the faces.
	float rockRib = rockMid * smoothstep( 0.15, 0.5, rockCurv ) * smoothstep( 0.35, 0.6, rockSteep );
	float rockBandY = vRockPos.y + ( vRockLow.z - 0.5 ) * 9.0 + ( rockF1.x - 0.5 ) * 2.0;
	float rockBandI = floor( rockBandY * ( 1.0 / 11.0 ) );
	float rockBandF = fract( rockBandY * ( 1.0 / 11.0 ) ) * 11.0;
	float rockBandW = mix( 1.2, 3.0, rockHash13( vec3( rockBandI, 4.0, 1.0 ) ) );
	float rockBand = ( 1.0 - smoothstep( rockBandW - 0.4, rockBandW + 0.4, rockBandF ) ) * smoothstep( 0.0, 0.4, rockBandF );
	rockBand *= rockMid * smoothstep( 0.38, 0.62, rockF1.z + ( rockMacro - 0.5 ) * 0.4 );
	rockAlbedo *= ( 1.0 - 0.15 * rockRib ) * ( 1.0 - 0.18 * rockBand );
	// Cracks: dark, not black.
	rockAlbedo *= 1.0 - 0.55 * rockCrack;

	// ---- Snow: up-facing (after the facet tilt), more with altitude, wind-scoured.
	float rockSnowNoise = vRockSnowLow * 0.62 + rockF1.w * 0.38;
	float rockAlt = smoothstep( uSnowLine - 70.0, uSnowLine + 8.0, vRockPos.y );
	float rockUp = mix( rockN.y, rockBumped.y, 0.4 );
	float rockSnowEdge = mix( 0.84, 0.6, rockAlt * uSnowAmount ) + ( rockSnowNoise - 0.5 ) * 0.3 - 0.12 * rockCavity + 0.16 * rockConvex;
	// Upper mountain (and the mid-field): snow gathers in gullies and on benches; steep flanks shed it.
	float rockHigh = smoothstep( 0.4, 0.6, rockAlt );
	rockSnowEdge += rockHigh * ( 0.08 * ( 1.0 - rockCavity ) * ( 1.0 - smoothstep( 0.65, 0.75, rockN.y ) ) - 0.12 * smoothstep( 0.6, 1.0, rockAlt ) ) - max( rockMid, rockHigh ) * 0.18 * rockCavity;
	// Edges soften with distance: far slopes read as a gentle gradient of cover, not a high-contrast camouflage.
	float rockSnowSoft = clamp( rockPx * 0.8, 0.0, 0.3 );
	float rockScour = rockF1.z * 0.7 + rockSnowNoise * 0.3;
	// Wind-scoured, lobed edge (0.15-0.5 m lobes) anti-aliased to ~1.5 px: two edge-relative fields.
	float rockBreak = 0.16 * ( rockF3.x - 0.5 );
	float rockSnowF1 = rockUp - rockSnowEdge - 0.03 + rockBreak;
	// High on the mountain snow also clings to steep faces in fall-line runnels (never on convex ribs).
	float rockRunnel = smoothstep( 0.45, 0.65, rockF2.w ) * smoothstep( 0.7, 1.0, rockAlt ) * smoothstep( 0.3, 0.5, rockSteep ) * ( 1.0 - rockConvex );
	rockSnowF1 += 0.45 * rockRunnel;
	float rockSnowF2 = rockScour - ( 1.0 - uSnowAmount ) * 0.9 - ( 1.0 - rockAlt ) * 0.38 + 0.12 + rockBreak + 0.3 * rockRunnel;
	float rockSnowW1 = max( 0.7 * fwidth( rockSnowF1 ), 0.2 * rockSnowSoft );
	float rockSnowW2 = max( 0.7 * fwidth( rockSnowF2 ), 0.2 * rockSnowSoft );
	float rockSnow = smoothstep( - rockSnowW1, rockSnowW1, rockSnowF1 ) * smoothstep( - rockSnowW2, rockSnowW2, rockSnowF2 );
	// Thickness: a rounded 5 cm lip (height in metres; field units per metre from the derivatives), close up only.
	float rockPxS = max( rockPx, 1e-4 );
	float rockLip1 = max( 0.08 * fwidth( rockSnowF1 ) / rockPxS, 2.0 * rockSnowW1 );
	float rockLip2 = max( 0.08 * fwidth( rockSnowF2 ) / rockPxS, 2.0 * rockSnowW2 );
	float rockNear = 1.0 - smoothstep( 0.02, 0.05, rockPx );
	float rockSnowH = 0.05 * smoothstep( 0.0, rockLip1, rockSnowF1 ) * smoothstep( 0.0, rockLip2, rockSnowF2 ) * rockNear;
	// The rock right outside the edge is wet and shaded by the lip.
	float rockSnowRim = ( 1.0 - rockSnow ) * smoothstep( - 3.0 * rockLip1, 0.0, rockSnowF1 ) * smoothstep( - rockLip2, 0.0, rockSnowF2 ) * ( 1.0 - smoothstep( 0.05, 0.12, rockPx ) );
	rockAlbedo *= 1.0 - 0.3 * rockSnowRim;
	// Bare ribs and steep bands shed snow.
	rockSnow *= ( 1.0 - rockRib ) * ( 1.0 - rockBand * smoothstep( 0.3, 0.6, rockSteep ) );
	// Wind-packed snow lingers in the joints of gentle slabs.
	rockSnow = max( rockSnow, rockCrack * smoothstep( 0.55, 0.85, rockN.y ) * 0.85 * uSnowAmount );
	#ifdef ROCK_ALL_SNOW
		rockSnow = 1.0;
	#endif
	// Snow smooths the relief it covers (soft drifts instead of facets).
	if ( rockSnow > 0.0 ) {
		vec4 rockDrift = rockNoised3( rockP * 0.8 + 7.0 );
		vec3 rockDriftN = normalize( rockN - ( rockDrift.yzw - dot( rockDrift.yzw, rockN ) * rockN ) * 0.8 * 0.22 );
		rockBumped = normalize( mix( rockBumped, rockDriftN, rockSnow ) );
		#if ROCK_QUALITY > 0
			// Wind ripples (sastrugi): ridges elongated across the wind (~ +z), 0.25-0.6 m apart.
			vec4 rockRip = rockNoised3( rockP * vec3( 0.7, 1.2, 3.4 ) + 3.0 );
			vec3 rockRipG = rockRip.yzw * vec3( 0.7, 1.2, 3.4 );
			rockBumped = normalize( rockBumped - ( rockRipG - dot( rockRipG, rockBumped ) * rockBumped ) * 0.05 * ( 0.5 + rockF3.y ) * rockSnow * rockChipFade );
		#endif
	}
	{
		// Lip bump from the snow-height field (world metres), in three's perturbNormalArb form.
		vec3 sX = dFdx( vRockPos );
		vec3 sY = dFdy( vRockPos );
		float hX = dFdx( rockSnowH );
		float hY = dFdy( rockSnowH );
		vec3 r1 = cross( sY, rockBumped );
		vec3 r2 = cross( rockBumped, sX );
		float det = dot( sX, r1 );
		vec3 g = sign( det ) * ( hX * r1 + hY * r2 );
		rockBumped = normalize( abs( det ) * rockBumped - g );
	}

	float rockSunFacing = dot( rockBumped, uRockSun );
	// Snow stays bright in shade: the sky light makes it blue, not the albedo.
	vec3 rockSnowCol = mix( uSnowColor, uSnowShadow, 0.18 * ( 1.0 - smoothstep( -0.1, 0.35, rockSunFacing ) ) );
	rockSnowCol *= 0.95 + 0.05 * rockSnowNoise;
	// Alpenglow: lit snow high on the mountain takes the warm last light.
	rockSnowCol *= mix( vec3( 1.0 ), vec3( 1.0, 0.86, 0.72 ), 0.35 * smoothstep( 20.0, 56.0, vRockPos.y ) * smoothstep( 0.0, 0.3, rockSunFacing ) );
	diffuseColor.rgb = mix( rockAlbedo, rockSnowCol, rockSnow );
	float rockRoughness = 0.82 - 0.2 * rockTone + 0.1 * rockCrack + 0.06 * rockVarnish;
	#ifdef ROCK_VERTEX_FACET
		rockRoughness += ( vRockFacet.y - 0.5 ) * 0.12;
	#endif
	rockRoughness = mix( rockRoughness, 0.68, rockSnow );
	float rockSparkle = 0.0;
	#if ROCK_QUALITY > 0
	{
		// Sparkle: pixel-sized ice facets (power-of-two cells so they do not swim) that are glassy and lean toward
		// the sun's half vector, so only the sun's own GGX lobe flashes them: shadowed snow never sparkles.
		float gs = exp2( ceil( log2( max( rockPx * 2.0, 0.004 ) ) ) );
		float gh = rockHash13( floor( vRockPos / gs ) * 1.31 + 0.7 );
		rockSparkle = step( 0.982, gh ) * smoothstep( 0.5, 0.9, rockSnow ) * ( 1.0 - smoothstep( 0.02, 0.06, rockPx ) );
		vec3 gH = normalize( uRockSun + normalize( cameraPosition - vRockPos ) );
		rockBumped = normalize( mix( rockBumped, gH, rockSparkle * ( 0.55 + 0.45 * fract( gh * 53.0 ) ) ) );
		rockRoughness = mix( rockRoughness, 0.07, rockSparkle );
	}
	#endif
`;

const FRAGMENT_ROUGHNESS = /* glsl */ `
	roughnessFactor = clamp( rockRoughness, mix( 0.3, 0.05, rockSparkle ), 1.0 );
`;

const FRAGMENT_NORMAL = /* glsl */ `
	normal = normalize( ( viewMatrix * vec4( rockBumped * faceDirection, 0.0 ) ).xyz );
`;

const FRAGMENT_OCCLUSION = /* glsl */ `
	{
		#ifdef ROCK_VERTEX_AO
			// The ~2 m baked field stays broad occlusion; crack and bevel AO carry the detail.
			float rockOcc = 0.4 + 0.6 * vRockAO;
		#else
			float rockOcc = 1.0;
		#endif
		rockOcc *= 1.0 - rockCrack * 0.6 * ( 1.0 - rockSnow );
		rockOcc *= 1.0 - 0.28 * rockCavity;
		rockOcc *= 1.0 - 0.45 * rockBevel * ( 1.0 - rockSnow );
		rockOcc *= 1.0 - 0.4 * rockSnowRim;
		reflectedLight.indirectDiffuse *= rockOcc;
		reflectedLight.indirectSpecular *= rockOcc;
		reflectedLight.directDiffuse *= mix( 1.0, rockOcc, 0.35 );
		reflectedLight.directSpecular *= mix( 1.0, rockOcc, 0.5 );
		#if defined( ROCK_VERTEX_SUNVIS ) && ROCK_QUALITY == 0
			// No shadow map on this tier: the baked visibility toward the climb's key light stands in.
			reflectedLight.directDiffuse *= mix( 1.0, vRockSunVis, uKeyBakeWeight );
		#endif
	}
`;

const FRAGMENT_REVEAL = /* glsl */ `
	#ifdef USE_FOG
		gl_FragColor.rgb = mix( fogColor, gl_FragColor.rgb, uReveal );
	#endif
`;

function inject(source: string, anchor: string, addition: string, before = false): string {
  if (!source.includes(anchor)) {
    throw new Error(`alpineRockMaterial: shader anchor ${anchor} not found`);
  }
  return source.replace(anchor, before ? `${addition}\n${anchor}` : `${anchor}\n${addition}`);
}

/**
 * Creates the procedural granite / snow material. Uniforms live on
 * `material.userData.rockUniforms` and can be changed at any time.
 * The caller owns the material and must `dispose()` it (the shared noise
 * texture is never disposed with it).
 */
export function createAlpineRockMaterial(options: AlpineRockMaterialOptions = {}): AlpineRockMaterial {
  const quality: RockShaderQuality = options.quality ?? 2;
  const vertexOcclusion = options.vertexOcclusion ?? false;
  const vertexCurvature = options.vertexCurvature ?? false;
  const allSnow = options.allSnow ?? false;
  const vertexFacet = options.vertexFacet ?? false;
  const vertexSunVis = options.vertexSunVis ?? false;

  const uniforms: AlpineRockUniforms = {
    uRockSun: { value: options.sunDirection ? options.sunDirection.clone().normalize() : keyLight.direction },
    uSnowAmount: { value: options.snowAmount ?? 0.85 },
    uSnowLine: { value: options.snowLine ?? 46 },
    uBumpStrength: { value: options.bumpStrength ?? 1.0 },
    uPatternScale: { value: options.patternScale ?? 1 },
    uReveal: { value: 1 },
    // Cool-neutral alpine granite (the sky light adds the blue, the key light the warmth); these are albedos,
    // not the PALETTE display swatches the horizon range and sky use.
    uGranite: { value: new THREE.Color('#8A8C8E') },
    uGraniteDark: { value: new THREE.Color('#56585B') },
    uGraniteLight: { value: new THREE.Color('#B1B0AC') },
    uGraniteWarm: { value: new THREE.Color('#7A6352') },
    uSnowColor: { value: new THREE.Color('#F0F3F7') },
    uSnowShadow: { value: new THREE.Color('#A9BAD2') },
    uRockNoise: { value: getRockNoiseTexture() },
    uKeyBakeWeight: keyLight.bakeWeight,
  };

  const material = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.85,
    metalness: 0,
  }) as AlpineRockMaterial;
  material.userData.rockUniforms = uniforms;

  material.defines = {
    ...(material.defines ?? {}),
    ROCK_QUALITY: quality,
    ...(vertexOcclusion ? { ROCK_VERTEX_AO: '' } : {}),
    ...(vertexCurvature ? { ROCK_VERTEX_CURVATURE: '' } : {}),
    ...(allSnow ? { ROCK_ALL_SNOW: '' } : {}),
    ...(vertexFacet ? { ROCK_VERTEX_FACET: '' } : {}),
    ...(vertexSunVis ? { ROCK_VERTEX_SUNVIS: '' } : {}),
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let vs = shader.vertexShader;
    vs = inject(vs, '#include <common>', VERTEX_PARS);
    vs = inject(vs, '#include <worldpos_vertex>', VERTEX_MAIN);
    shader.vertexShader = vs;

    let fs = shader.fragmentShader;
    fs = inject(fs, '#include <common>', FRAGMENT_PARS);
    fs = inject(fs, '#include <color_fragment>', FRAGMENT_SURFACE);
    fs = inject(fs, '#include <roughnessmap_fragment>', FRAGMENT_ROUGHNESS);
    fs = inject(fs, '#include <normal_fragment_maps>', FRAGMENT_NORMAL);
    fs = inject(fs, '#include <aomap_fragment>', FRAGMENT_OCCLUSION);
    fs = inject(fs, '#include <fog_fragment>', FRAGMENT_REVEAL);
    shader.fragmentShader = fs;
  };

  const cacheKey = `alpine-rock-v4|q${quality}|ao${vertexOcclusion ? 1 : 0}|cv${vertexCurvature ? 1 : 0}|fa${vertexFacet ? 1 : 0}|sv${vertexSunVis ? 1 : 0}|snow${allSnow ? 1 : 0}`;
  material.customProgramCacheKey = () => cacheKey;
  return material;
}

/** Pure snow variant of the alpine material (cornices, snow fields). */
export function createSnowMaterial(options: Omit<AlpineRockMaterialOptions, 'allSnow'> = {}): AlpineRockMaterial {
  return createAlpineRockMaterial({ bumpStrength: 0.4, ...options, allSnow: true });
}
