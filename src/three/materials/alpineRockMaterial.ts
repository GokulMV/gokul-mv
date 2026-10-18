import * as THREE from 'three';
import { PALETTE, SUN_DIRECTION } from '../world/worldLayout';

/* ==========================================================================
 * Alpine rock material — a MeshStandardMaterial extended via onBeforeCompile.
 *
 * Everything is procedural and world-space (no textures, no UVs, no
 * triplanar seams):
 *   - fracture blocks: a 3D cellular joint field (cells taller than wide, like
 *     vertically jointed granite) cuts the rock into blocks. Every block is a
 *     facet with its own slight tilt; open joints are thin dark cracks whose
 *     edges are bevelled (the normal leans into the crack, so one lip catches
 *     the sun and the other falls into shade); closed joints are just a crease.
 *     A second, smaller set of chips adds fracture detail close to the camera;
 *   - sheeting joints: intermittent, gently dipping horizontal cracks;
 *   - weathered relief: ridged and fine gradient noise;
 *   - albedo: PALETTE.granite / graniteDark lifted toward a pale feldspar grey,
 *     per-block tone, warm iron staining, dark water streaks on steep faces,
 *     mineral grain up close, darker cracks and crevices;
 *   - snow on up-facing ledges (after the facet tilt), increasing with altitude,
 *     wind-scoured by noise; PALETTE.snow in the sun, PALETTE.snowShadow (blue)
 *     away from it; sparse ice glints;
 *   - baked per-vertex ambient occlusion (`aOcclusion`) and curvature
 *     (`aCurvature`): worn pale edges, grime and occlusion in the creases,
 *     snow scoured off convex edges and packed into hollows.
 * Every layer fades out with the world size of a pixel before it could alias.
 * It stays a standard PBR material: shadows, fog, tone mapping and environment
 * lighting keep working. The program cache key is stable per
 * (quality, AO, curvature, all-snow) combination.
 * ========================================================================== */

export type RockShaderQuality = 0 | 1 | 2;

export interface AlpineRockMaterialOptions {
  /** Read the per-vertex `aOcclusion` attribute baked by terrainGeometry. */
  vertexOcclusion?: boolean;
  /** Read the per-vertex `aCurvature` attribute baked by terrainGeometry (edge wear, cavity grime, wind-scoured snow). */
  vertexCurvature?: boolean;
  /**
   * Shader detail: 0 = low (one steep joint set, sheeting joints, facets), 1 = medium (+ second joint set and
   * weathered relief), 2 = high (27-cell facets, chips, fine relief, mineral grain, ice glints).
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
  /** Direction towards the sun (world space). */
  sunDirection?: THREE.Vector3;
  /** Render every fragment as snow (used by createSnowMaterial). */
  allSnow?: boolean;
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
}

export type AlpineRockMaterial = THREE.MeshStandardMaterial & {
  userData: { rockUniforms: AlpineRockUniforms };
};

const VERTEX_PARS = /* glsl */ `
varying vec3 vRockPos;
varying vec3 vRockNormal;
#ifdef ROCK_VERTEX_AO
attribute float aOcclusion;
varying float vRockAO;
#endif
#ifdef ROCK_VERTEX_CURVATURE
attribute float aCurvature;
varying float vRockCurv;
#endif
`;

const VERTEX_MAIN = /* glsl */ `
vRockPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vRockNormal = normalize( mat3( modelMatrix ) * objectNormal );
#ifdef ROCK_VERTEX_AO
vRockAO = aOcclusion;
#endif
#ifdef ROCK_VERTEX_CURVATURE
vRockCurv = aCurvature;
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
varying vec3 vRockPos;
varying vec3 vRockNormal;
#ifdef ROCK_VERTEX_AO
varying float vRockAO;
#endif
#ifdef ROCK_VERTEX_CURVATURE
varying float vRockCurv;
#endif

float rockHash13( vec3 p3 ) {
	p3 = fract( p3 * 0.1031 );
	p3 += dot( p3, p3.zyx + 31.32 );
	return fract( ( p3.x + p3.y ) * p3.z );
}

vec3 rockHash33( vec3 p3 ) {
	p3 = fract( p3 * vec3( 0.1031, 0.1030, 0.0973 ) );
	p3 += dot( p3, p3.yxz + 33.33 );
	return fract( ( p3.xxy + p3.yxx ) * p3.zyx );
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
 * other falls into shade). Joints open in segments along their plane (segFreq
 * sets the segment scale) and the crack tapers to nothing at each end; planes
 * that slice the surface at a grazing angle are faded out (they would smear
 * into bands). Closed joints leave no trace.
 */
void rockJointSet( vec3 p, vec3 pn, float sp, float warp, float openAt, float segFreq, float seed, vec3 n, float px, float lineFade, float blockFade, inout vec3 off, inout float crack ) {
	float jdx;
	vec3 toEdge;
	float obliq;
	float e = rockPlanes( p, pn, sp, warp, seed, n, jdx, toEdge, obliq );
	float o = smoothstep( openAt, openAt + 0.2, rockValue3( p * segFreq + vec3( jdx * 7.13, seed, jdx * 3.71 ) ) );
	o *= step( 0.3, rockHash13( vec3( jdx, seed, 1.7 ) ) ) * smoothstep( 0.3, 0.6, obliq );
	float bw = 0.12 + 0.12 * o;
	float t = clamp( e / bw, 0.0, 1.0 );
	off += toEdge * ( 1.0 - t ) * ( 1.0 - t ) * 0.6 * o * blockFade;
	float cw = 0.006 + 0.022 * o + 0.3 * px;
	crack = max( crack, ( 1.0 - smoothstep( cw * 0.45, cw, e ) ) * smoothstep( 0.04, 0.35, o ) * lineFade );
}

/*
 * Fracture facets: jittered 3D cells. Returns the distance along the surface
 * to the nearest cell boundary; id1 / id2 are the two nearest cells and toEdge
 * the tangent direction pointing at the boundary. Below the high tier the
 * search covers only the 2x2x2 cells around the nearest lattice corner (with a
 * smaller jitter to match).
 */
float rockFacets( vec3 p, vec3 invScale, vec3 n, out vec3 id1, out vec3 id2, out vec3 toEdge ) {
	vec3 q = p * invScale;
	float d1 = 1e9;
	float d2 = 1e9;
	vec3 c1 = q;
	vec3 c2 = q + 1.0;
	id1 = floor( q );
	id2 = id1;
	#if ROCK_QUALITY < 2
		vec3 b = floor( q - 0.5 );
		for ( int k = 0; k <= 1; k ++ ) {
			for ( int j = 0; j <= 1; j ++ ) {
				for ( int i = 0; i <= 1; i ++ ) {
					vec3 g = b + vec3( float( i ), float( j ), float( k ) );
					vec3 c = g + 0.3 + 0.4 * rockHash33( g );
	#else
		vec3 b = floor( q );
		for ( int k = - 1; k <= 1; k ++ ) {
			for ( int j = - 1; j <= 1; j ++ ) {
				for ( int i = - 1; i <= 1; i ++ ) {
					vec3 g = b + vec3( float( i ), float( j ), float( k ) );
					vec3 c = g + 0.12 + 0.76 * rockHash33( g );
	#endif
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
	float rockDist = length( cameraPosition - vRockPos );
	// World size of one pixel (outside any branch: derivatives need uniform control flow).
	float rockPx = length( fwidth( vRockPos ) ) * uPatternScale;

	// Fade factors: each layer disappears before its features shrink to a few pixels.
	float rockBlockFade = 1.0 - smoothstep( 0.09, 0.32, rockPx );
	float rockLineFade = 1.0 - smoothstep( 0.02, 0.07, rockPx );
	float rockChipFade = 1.0 - smoothstep( 0.012, 0.045, rockPx );
	float rockFineFade = 1.0 - smoothstep( 0.008, 0.03, rockPx );

	// Normal offset (world space, projected onto the surface at the end) and crack / tone accumulators.
	vec3 rockOff = vec3( 0.0 );
	float rockCrack = 0.0;
	float rockTone = 0.0;

	// Joints, facets and relief fade out with distance: far rock (flanks, skirt) skips them entirely.
	if ( rockBlockFade > 0.0 ) {
		// Fractured zones carry many open joints; elsewhere the granite is massive.
		float rockFracZone = smoothstep( 0.3, 0.7, rockValue3( rockP * 0.05 + vec3( 2.0, -4.0, 1.0 ) ) );
		float rockOpenAt = mix( 0.64, 0.4, rockFracZone );
		// Low-frequency warp that bends the joint planes and varies their spacing.
		float rockWarp = rockValue3( rockP * 0.045 ) - 0.5 + ( rockValue3( rockP * 0.4 + 9.0 ) - 0.5 ) * 0.05;

		// ---- Joints: two steep sets (vertical jointing) and gently dipping sheeting joints.
		rockJointSet( rockP, vec3( 0.86, 0.0, 0.51 ), 3.1, rockWarp * 1.6, rockOpenAt, 0.14, 1.0, rockN, rockPx, rockLineFade, rockBlockFade, rockOff, rockCrack );
		#if ROCK_QUALITY > 0
			rockJointSet( rockP, normalize( vec3( -0.47, 0.12, 0.87 ) ), 4.3, rockWarp * 1.3 + 0.37, rockOpenAt + 0.06, 0.14, 2.0, rockN, rockPx, rockLineFade, rockBlockFade, rockOff, rockCrack );
		#endif
		{
			// Sheeting joints only show on steep faces (on ledges they would run parallel to the surface).
			float sheet = smoothstep( 0.86, 0.55, abs( rockN.y ) );
			float c = 0.0;
			vec3 o = vec3( 0.0 );
			rockJointSet( rockP, normalize( vec3( 0.1, 0.99, -0.07 ) ), 2.3, rockWarp * 2.2, rockOpenAt + 0.26, 0.3, 3.0, rockN, rockPx, rockLineFade, rockBlockFade, o, c );
			rockOff += o * sheet;
			rockCrack = max( rockCrack, c * sheet * 0.85 );
		}
		{
			// Facets: irregular planar faces a few metres across, each with its own slight tilt and tone.
			vec3 fId1;
			vec3 fId2;
			vec3 fTo;
			float fe = rockFacets( rockP, vec3( 1.0 / 3.8, 1.0 / 5.0, 1.0 / 3.8 ), rockN, fId1, fId2, fTo );
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
			rockTone += ( rockHash13( fId1 + 3.1 ) - 0.5 ) * 0.2 * rockBlockFade;
		}

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

	#if ROCK_QUALITY > 1
		// ---- Chips: small fracture facets close to the camera (rarely an open hairline).
		if ( rockChipFade > 0.0 ) {
			vec3 cId1;
			vec3 cId2;
			vec3 cTo;
			float ce = rockFacets( rockP + vec3( 13.1, -7.3, 5.9 ), vec3( 1.0 / 0.7, 1.0 / 0.9, 1.0 / 0.7 ), rockN, cId1, cId2, cTo );
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
			vec4 nf = rockNoised3( rockP * 4.3 + vec3( 1.3, -2.1, 0.7 ) );
			rockOff -= nf.yzw * 4.3 * 0.02 * rockFineFade;
		}
	#endif

	// Bumped normal: the offset's component along the surface tilts the normal.
	vec3 rockOffT = rockOff - dot( rockOff, rockN ) * rockN;
	vec3 rockBumped = normalize( rockN + uBumpStrength * rockOffT );

	// ---- Albedo.
	float rockM1 = rockValue3( rockP * 0.028 );
	float rockM2 = rockValue3( rockP * 0.1 + 11.0 );
	float rockMacro = rockM1 * 0.6 + rockM2 * 0.4;
	vec3 rockAlbedo = mix( uGraniteDark, uGranite, smoothstep( 0.2, 0.55, rockMacro ) );
	rockAlbedo = mix( rockAlbedo, uGraniteLight, smoothstep( 0.45, 0.8, rockMacro ) * 0.85 );
	rockAlbedo *= 1.0 + rockTone;
	float rockIron = smoothstep( 0.6, 0.85, rockValue3( rockP * 0.07 + vec3( 3.0, 1.0, -7.0 ) ) );
	rockAlbedo = mix( rockAlbedo, uGraniteWarm, rockIron * 0.5 );
	// Weathering mottling at a few metres.
	rockAlbedo *= 0.86 + 0.24 * rockValue3( rockP * 0.45 + 2.0 );
	#if ROCK_QUALITY > 1
		// Mineral grain up close: pale feldspar and dark biotite flecks (low contrast).
		float rockGrainFade = 1.0 - smoothstep( 0.005, 0.016, rockPx );
		if ( rockGrainFade > 0.0 ) {
			float rockGrainA = rockValue3( rockP * 21.0 );
			float rockGrainB = rockValue3( rockP * 37.0 + 5.0 );
			rockAlbedo = mix( rockAlbedo, uGraniteLight * 1.1, smoothstep( 0.68, 0.86, rockGrainA ) * 0.2 * rockGrainFade );
			rockAlbedo *= 1.0 - smoothstep( 0.72, 0.9, rockGrainB ) * 0.22 * rockGrainFade;
		}
	#endif
	// Dark water streaks running down steep faces, strongest under ledges.
	float rockSteep = 1.0 - abs( rockN.y );
	float rockStreak = rockValue3( vec3( ( rockP.x + rockP.z ) * 0.55, rockP.y * 0.03, ( rockP.x - rockP.z ) * 0.55 ) );
	rockAlbedo *= 1.0 - 0.3 * smoothstep( 0.58, 0.85, rockStreak ) * smoothstep( 0.45, 0.85, rockSteep );
	// Worn, paler convex edges; grime and lichen in the creases.
	rockAlbedo *= ( 1.0 + 0.3 * rockConvex ) * ( 1.0 - 0.2 * rockCavity );
	// Cracks: dark, not black.
	rockAlbedo *= 1.0 - 0.55 * rockCrack;

	// ---- Snow: up-facing (after the facet tilt), more with altitude, broken up by noise.
	float rockSnowNoise = rockValue3( rockP * 0.19 + 3.0 ) * 0.62 + rockValue3( rockP * 0.74 - 9.0 ) * 0.38;
	float rockAlt = smoothstep( uSnowLine - 70.0, uSnowLine + 8.0, vRockPos.y );
	float rockUp = mix( rockN.y, rockBumped.y, 0.4 );
	float rockSnowEdge = mix( 0.84, 0.6, rockAlt * uSnowAmount ) + ( rockSnowNoise - 0.5 ) * 0.3 - 0.12 * rockCavity + 0.16 * rockConvex;
	// Edges soften with distance: far slopes read as a gentle gradient of cover, not a high-contrast camouflage.
	float rockSnowSoft = clamp( rockPx * 0.8, 0.0, 0.3 );
	float rockSnow = smoothstep( rockSnowEdge, rockSnowEdge + 0.06 + rockSnowSoft, rockUp );
	// Coverage decides where snow lies, never how opaque it is: wind-scoured
	// bare patches, more of them lower down and with less snow overall.
	float rockScour = rockValue3( rockP * 0.33 + vec3( -6.0, 2.0, 4.0 ) ) * 0.7 + rockSnowNoise * 0.3;
	rockSnow *= smoothstep( -rockSnowSoft, 0.05 + rockSnowSoft, rockScour - ( 1.0 - uSnowAmount ) * 0.9 - ( 1.0 - rockAlt ) * 0.38 + 0.1 );
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
	}

	float rockSunFacing = dot( rockBumped, uRockSun );
	vec3 rockSnowCol = mix( uSnowColor, uSnowShadow, 0.55 * ( 1.0 - smoothstep( -0.1, 0.35, rockSunFacing ) ) );
	rockSnowCol *= 0.95 + 0.05 * rockSnowNoise;
	diffuseColor.rgb = mix( rockAlbedo, rockSnowCol, rockSnow );
	float rockRoughness = mix( 0.82 - 0.2 * rockTone + 0.1 * rockCrack, 0.5, rockSnow );
`;

const FRAGMENT_ROUGHNESS = /* glsl */ `
	roughnessFactor = clamp( rockRoughness, 0.3, 1.0 );
`;

const FRAGMENT_NORMAL = /* glsl */ `
	normal = normalize( ( viewMatrix * vec4( rockBumped * faceDirection, 0.0 ) ).xyz );
`;

const FRAGMENT_EMISSIVE = /* glsl */ `
	#if ROCK_QUALITY > 1
		{
			// Sparse ice-crystal glints in sunlit snow, only close to the camera.
			vec3 rockV = normalize( cameraPosition - vRockPos );
			float rockGlint = step( 0.994, rockHash13( floor( vRockPos * 28.0 ) ) );
			rockGlint *= pow( max( dot( reflect( -uRockSun, rockBumped ), rockV ), 0.0 ), 40.0 );
			rockGlint *= smoothstep( 0.0, 0.25, rockSunFacing ) * rockSnow * ( 1.0 - smoothstep( 4.0, 22.0, rockDist ) );
			totalEmissiveRadiance += rockGlint * vec3( 1.6, 1.5, 1.35 );
		}
	#endif
`;

const FRAGMENT_OCCLUSION = /* glsl */ `
	{
		#ifdef ROCK_VERTEX_AO
			float rockOcc = vRockAO;
		#else
			float rockOcc = 1.0;
		#endif
		rockOcc *= 1.0 - rockCrack * 0.6 * ( 1.0 - rockSnow );
		rockOcc *= 1.0 - 0.28 * rockCavity;
		reflectedLight.indirectDiffuse *= rockOcc;
		reflectedLight.indirectSpecular *= rockOcc;
		reflectedLight.directDiffuse *= mix( 1.0, rockOcc, 0.35 );
		reflectedLight.directSpecular *= mix( 1.0, rockOcc, 0.5 );
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
 * The caller owns the material and must `dispose()` it.
 */
export function createAlpineRockMaterial(options: AlpineRockMaterialOptions = {}): AlpineRockMaterial {
  const quality: RockShaderQuality = options.quality ?? 2;
  const vertexOcclusion = options.vertexOcclusion ?? false;
  const vertexCurvature = options.vertexCurvature ?? false;
  const allSnow = options.allSnow ?? false;

  const uniforms: AlpineRockUniforms = {
    uRockSun: { value: (options.sunDirection ?? SUN_DIRECTION).clone().normalize() },
    uSnowAmount: { value: options.snowAmount ?? 0.85 },
    uSnowLine: { value: options.snowLine ?? 46 },
    uBumpStrength: { value: options.bumpStrength ?? 1.0 },
    uPatternScale: { value: options.patternScale ?? 1 },
    uReveal: { value: 1 },
    // The palette swatches are display colours for a shaded face; as albedo
    // they are lifted so granite reads as the pale, crisp rock it is under a
    // low sun, with a light feldspar grey for the bright zones.
    uGranite: { value: new THREE.Color(PALETTE.granite).multiplyScalar(2.7) },
    uGraniteDark: { value: new THREE.Color(PALETTE.graniteDark).multiplyScalar(2.6) },
    uGraniteLight: { value: new THREE.Color('#ABA79F') },
    uGraniteWarm: { value: new THREE.Color('#8C6A50') },
    uSnowColor: { value: new THREE.Color(PALETTE.snow) },
    uSnowShadow: { value: new THREE.Color(PALETTE.snowShadow) },
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
    fs = inject(fs, '#include <emissivemap_fragment>', FRAGMENT_EMISSIVE);
    fs = inject(fs, '#include <aomap_fragment>', FRAGMENT_OCCLUSION);
    fs = inject(fs, '#include <fog_fragment>', FRAGMENT_REVEAL);
    shader.fragmentShader = fs;
  };

  const cacheKey = `alpine-rock-v3|q${quality}|ao${vertexOcclusion ? 1 : 0}|cv${vertexCurvature ? 1 : 0}|snow${allSnow ? 1 : 0}`;
  material.customProgramCacheKey = () => cacheKey;
  return material;
}

/** Pure snow variant of the alpine material (cornices, snow fields). */
export function createSnowMaterial(options: Omit<AlpineRockMaterialOptions, 'allSnow'> = {}): AlpineRockMaterial {
  return createAlpineRockMaterial({ bumpStrength: 0.4, ...options, allSnow: true });
}
