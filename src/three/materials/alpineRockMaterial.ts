import * as THREE from 'three';
import { PALETTE, SUN_DIRECTION } from '../world/worldLayout';

/* ==========================================================================
 * Alpine rock material — a MeshStandardMaterial extended via onBeforeCompile.
 *
 * Everything is procedural and world-space (no textures, no UVs):
 *   - triplanar granite built from jittered cells (Voronoi): every cell is a
 *     flat fracture facet with its own tilt, so the relief normal breaks
 *     crisply at the joints; thin dark fracture lines run along the cell
 *     edges. Side projections use tall cells (vertical jointing). Three
 *     octaves — slabs (~8 units), blocks (~1.8) and chips (~0.7) — each faded
 *     out with distance before it can alias;
 *   - albedo from PALETTE.granite / graniteDark lifted toward a pale feldspar
 *     grey, mineral speckle, per-facet tone, warm iron staining and dark water
 *     streaks on steep faces, darker crevices;
 *   - snow on up-facing ledges, increasing with altitude, broken up by noise,
 *     PALETTE.snow in the sun and PALETTE.snowShadow (blue) away from it;
 *   - baked per-vertex ambient occlusion (`aOcclusion` attribute).
 * It stays a standard PBR material: shadows, fog, tone mapping, scene exposure
 * and environment lighting keep working unchanged. The program cache key is
 * stable per (quality, AO, all-snow) combination.
 * ========================================================================== */

export type RockShaderQuality = 0 | 1 | 2;

export interface AlpineRockMaterialOptions {
  /** Read the per-vertex `aOcclusion` attribute baked by terrainGeometry. */
  vertexOcclusion?: boolean;
  /** Shader detail: 0 = low (2 octaves, dominant projections), 1 = medium (2 octaves), 2 = high (3 octaves, speckle, glints). */
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
`;

const VERTEX_MAIN = /* glsl */ `
vRockPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vRockNormal = normalize( mat3( modelMatrix ) * objectNormal );
#ifdef ROCK_VERTEX_AO
vRockAO = aOcclusion;
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

float rockHash12( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}

vec2 rockHash22( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.xx + p3.yz ) * p3.zy );
}

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

/* 2D gradient noise with analytic derivatives: (value, d/dx, d/dy). */
vec3 rockNoised( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
	vec2 du = 30.0 * f * f * ( f * ( f - 2.0 ) + 1.0 );
	vec2 ga = rockHash22( i ) * 2.0 - 1.0;
	vec2 gb = rockHash22( i + vec2( 1.0, 0.0 ) ) * 2.0 - 1.0;
	vec2 gc = rockHash22( i + vec2( 0.0, 1.0 ) ) * 2.0 - 1.0;
	vec2 gd = rockHash22( i + vec2( 1.0, 1.0 ) ) * 2.0 - 1.0;
	float va = dot( ga, f );
	float vb = dot( gb, f - vec2( 1.0, 0.0 ) );
	float vc = dot( gc, f - vec2( 0.0, 1.0 ) );
	float vd = dot( gd, f - vec2( 1.0, 1.0 ) );
	float k = va - vb - vc + vd;
	return vec3(
		va + u.x * ( vb - va ) + u.y * ( vc - va ) + u.x * u.y * k,
		ga + u.x * ( gb - ga ) + u.y * ( gc - ga ) + u.x * u.y * ( ga - gb - gc + gd ) + du * ( u.yx * k + vec2( vb, vc ) - va )
	);
}

/*
 * Jittered cells. Returns (F1, F2 - F1, cell random); the nearest cell's
 * facet tilt (-1..1) comes back through tilt.
 */
vec3 rockCells( vec2 p, out vec2 tilt ) {
	vec2 n = floor( p );
	vec2 f = fract( p );
	float d1 = 8.0;
	float d2 = 8.0;
	vec2 id1 = n;
	for ( int j = -1; j <= 1; j ++ ) {
		for ( int i = -1; i <= 1; i ++ ) {
			vec2 g = vec2( float( i ), float( j ) );
			vec2 r = g + rockHash22( n + g ) * 0.86 + 0.07 - f;
			float d = dot( r, r );
			if ( d < d1 ) {
				d2 = d1;
				d1 = d;
				id1 = n + g;
			} else if ( d < d2 ) {
				d2 = d;
			}
		}
	}
	tilt = rockHash22( id1 + 17.31 ) * 2.0 - 1.0;
	float f1 = sqrt( d1 );
	return vec3( f1, sqrt( d2 ) - f1, rockHash12( id1 + 3.7 ) );
}

/*
 * Joint-bounded blocks: two irregular joint sets — steep cross-joints and
 * gently inclined sheeting joints — cut the plane into blocks. Returns the
 * distance (uv units) to the nearest visible joint; each block's facet tilt
 * and tone come back through tilt / tone. Only some joints are open, and only
 * in segments, so they read as long fractures rather than a grid.
 */
float rockJoints( vec2 uv, float warp, out vec2 tilt, out float tone ) {
	const float SA = 0.6;
	const float SB = 0.4;
	float tA = uv.x * SA + uv.y * 0.1 + warp * 0.8;
	float tB = uv.y * SB - uv.x * 0.11 + warp * 0.55;
	float iA = floor( tA );
	float iB = floor( tB );
	float fA = tA - iA;
	float fB = tB - iB;
	vec2 cell = vec2( iA, iB );
	tilt = rockHash22( cell + 41.7 ) * 2.0 - 1.0;
	tone = rockHash12( cell + 5.3 );
	// Open joints: per joint plane, and per segment along it.
	float a0 = step( 0.55, rockHash12( vec2( iA, 3.1 ) ) ) * step( 0.45, rockHash12( vec2( iA, floor( tB * 0.5 ) + 9.0 ) ) );
	float a1 = step( 0.55, rockHash12( vec2( iA + 1.0, 3.1 ) ) ) * step( 0.45, rockHash12( vec2( iA + 1.0, floor( tB * 0.5 ) + 9.0 ) ) );
	float b0 = step( 0.6, rockHash12( vec2( 7.7, iB ) ) ) * step( 0.5, rockHash12( vec2( floor( tA * 0.5 ) - 4.0, iB ) ) );
	float b1 = step( 0.6, rockHash12( vec2( 7.7, iB + 1.0 ) ) ) * step( 0.5, rockHash12( vec2( floor( tA * 0.5 ) - 4.0, iB + 1.0 ) ) );
	float d = 9.0;
	d = mix( d, min( d, fA / SA ), a0 );
	d = mix( d, min( d, ( 1.0 - fA ) / SA ), a1 );
	d = mix( d, min( d, fB / SB ), b0 );
	d = mix( d, min( d, ( 1.0 - fB ) / SB ), b1 );
	return d;
}

/*
 * Granite on one projection plane (uv in world units, v vertical on the side
 * planes). Accumulates the relief gradient (d/du, d/dv), a fracture mask and
 * a facet tone. fade.x/y/z fade the slab/block/chip octaves with distance;
 * px is the world size of a pixel (fractures widen, then fade, before they
 * could alias); crackMask confines most fractures to fractured zones.
 */
void rockLayer( vec2 uv, float warp, vec3 fade, float px, float crackMask, inout vec2 grad, inout float crack, inout float tone ) {
	vec2 tilt;
	// Slabs: big tilted facets.
	vec3 c = rockCells( uv * 0.12, tilt );
	grad += tilt * 0.1 * fade.x;
	tone += ( c.z - 0.5 ) * 0.5;
	// Continuous weathered relief between the facets.
	vec3 nd = rockNoised( uv * vec2( 0.8, 1.1 ) + vec2( 1.7, 9.2 ) );
	grad += nd.yz * vec2( 0.8, 1.1 ) * 0.12 * fade.y;
	tone += nd.x * 0.18 * fade.y;
	// Blocks between joints.
	float bt;
	float jd = rockJoints( uv, warp, tilt, bt );
	grad += tilt * 0.13 * fade.y;
	tone += ( bt - 0.5 ) * 0.34 * fade.y;
	float jw = 0.022 + px * 0.9;
	crack = max( crack, ( 1.0 - smoothstep( 0.0, jw, jd ) ) * ( 0.45 + 0.55 * crackMask ) * smoothstep( 0.18, 0.06, px ) * fade.y );
	#if ROCK_QUALITY > 1
		// Chips: small facets close up.
		c = rockCells( uv * 1.6 + vec2( -3.1, 5.7 ), tilt );
		grad += tilt * 0.11 * fade.z;
		tone += ( c.z - 0.5 ) * 0.14 * fade.z;
		nd = rockNoised( uv * vec2( 2.7, 3.6 ) + vec2( -5.3, 2.2 ) );
		grad += nd.yz * vec2( 2.7, 3.6 ) * 0.045 * fade.z;
	#endif
}
`;

/* Computes rock / snow albedo, relief normal and roughness (world space). */
const FRAGMENT_SURFACE = /* glsl */ `
	vec3 rockN = normalize( vRockNormal );
	vec3 rockP = vRockPos * uPatternScale;
	float rockDist = length( cameraPosition - vRockPos );
	vec3 rockFade = vec3(
		1.0 - smoothstep( 260.0, 520.0, rockDist ),
		1.0 - smoothstep( 45.0, 130.0, rockDist ),
		1.0 - smoothstep( 10.0, 32.0, rockDist )
	);

	// World size of one pixel (computed outside any branch: derivatives need uniform control flow).
	float rockPx = length( fwidth( vRockPos ) );
	// Fractures are concentrated in zones; elsewhere the granite is massive.
	float rockCrackMask = smoothstep( 0.32, 0.62, rockValue3( vRockPos * 0.11 + vec3( 2.0, -4.0, 1.0 ) ) );
	// Low-frequency warp that keeps the joint sets from running perfectly straight.
	float rockWarp = rockValue3( vRockPos * 0.09 ) * 2.0 - 1.0;
	vec3 rockW = pow( abs( rockN ), vec3( 6.0 ) );
	rockW /= ( rockW.x + rockW.y + rockW.z );
	#if ROCK_QUALITY == 0
		// Low tier: only the projections that matter.
		rockW = max( rockW - 0.2, 0.0 );
		rockW /= max( rockW.x + rockW.y + rockW.z, 1e-4 );
	#endif
	vec3 rockGrad = vec3( 0.0 );
	float rockCrack = 0.0;
	float rockTone = 0.0;
	const float rockStretch = 0.62;
	if ( rockW.x > 0.02 ) {
		vec2 g = vec2( 0.0 );
		float k = 0.0;
		float t = 0.0;
		rockLayer( vec2( rockP.z, rockP.y * rockStretch ), rockWarp, rockFade, rockPx, rockCrackMask, g, k, t );
		rockGrad += rockW.x * vec3( 0.0, g.y * rockStretch, g.x );
		rockCrack += rockW.x * k;
		rockTone += rockW.x * t;
	}
	if ( rockW.y > 0.02 ) {
		vec2 g = vec2( 0.0 );
		float k = 0.0;
		float t = 0.0;
		rockLayer( rockP.xz + vec2( 17.0, -5.0 ), rockWarp, rockFade, rockPx, rockCrackMask, g, k, t );
		rockGrad += rockW.y * vec3( g.x, 0.0, g.y );
		rockCrack += rockW.y * k;
		rockTone += rockW.y * t;
	}
	if ( rockW.z > 0.02 ) {
		vec2 g = vec2( 0.0 );
		float k = 0.0;
		float t = 0.0;
		rockLayer( vec2( rockP.x, rockP.y * rockStretch ) + vec2( -31.0, 9.0 ), rockWarp, rockFade, rockPx, rockCrackMask, g, k, t );
		rockGrad += rockW.z * vec3( g.x, g.y * rockStretch, 0.0 );
		rockCrack += rockW.z * k;
		rockTone += rockW.z * t;
	}

	// Macro colour: dark / mid / pale granite zones, warm iron staining.
	float rockM1 = rockValue3( vRockPos * 0.035 );
	float rockM2 = rockValue3( vRockPos * 0.13 + 11.0 );
	float rockMacro = rockM1 * 0.65 + rockM2 * 0.35;
	vec3 rockAlbedo = mix( uGraniteDark, uGranite, smoothstep( 0.18, 0.55, rockMacro ) );
	rockAlbedo = mix( rockAlbedo, uGraniteLight, smoothstep( 0.5, 0.85, rockMacro ) * 0.75 );
	rockAlbedo *= 1.0 + rockTone * 0.55;
	float rockIron = smoothstep( 0.62, 0.86, rockValue3( vRockPos * 0.085 + vec3( 3.0, 1.0, -7.0 ) ) );
	rockAlbedo = mix( rockAlbedo, uGraniteWarm, rockIron * 0.55 );

	// Weathering mottling at a few metres, then mineral speckle up close:
	// pale feldspar / quartz and dark biotite grains.
	rockAlbedo *= 0.8 + 0.24 * rockValue3( vRockPos * 0.6 + 2.0 ) + 0.16 * rockValue3( vRockPos * 2.3 - 6.0 );
	#if ROCK_QUALITY > 0
		float rockGrainFade = 1.0 - smoothstep( 0.012, 0.03, rockPx );
		float rockGrain = rockValue3( vRockPos * 31.0 );
		float rockGrain2 = rockValue3( vRockPos * 57.0 + 5.0 );
		rockAlbedo = mix( rockAlbedo, uGraniteLight * 1.12, smoothstep( 0.72, 0.86, rockGrain ) * 0.32 * rockGrainFade );
		rockAlbedo *= 1.0 - smoothstep( 0.76, 0.92, rockGrain2 ) * 0.38 * rockGrainFade;
	#endif

	// Dark water / lichen streaks running down steep faces.
	float rockSteep = 1.0 - abs( rockN.y );
	float rockStreak = rockValue3( vec3( ( vRockPos.x + vRockPos.z ) * 0.7, vRockPos.y * 0.035, ( vRockPos.x - vRockPos.z ) * 0.7 ) );
	rockAlbedo *= 1.0 - 0.32 * smoothstep( 0.6, 0.85, rockStreak ) * smoothstep( 0.45, 0.85, rockSteep );
	// Fractures read as thin dark lines.
	rockAlbedo *= 1.0 - 0.45 * rockCrack;

	// Snow: up-facing (after the facet tilt), more with altitude, broken up by noise.
	vec3 rockSurfGrad = rockGrad - dot( rockGrad, rockN ) * rockN;
	vec3 rockBumped = normalize( rockN - uBumpStrength * rockSurfGrad );
	float rockSnowNoise = rockValue3( vRockPos * 0.19 + 3.0 ) * 0.62 + rockValue3( vRockPos * 0.74 - 9.0 ) * 0.38;
	float rockAlt = smoothstep( uSnowLine - 70.0, uSnowLine + 8.0, vRockPos.y );
	float rockUp = mix( rockN.y, rockBumped.y, 0.45 );
	float rockSnowEdge = mix( 0.86, 0.6, rockAlt * uSnowAmount ) + ( rockSnowNoise - 0.5 ) * 0.3;
	float rockSnow = smoothstep( rockSnowEdge, rockSnowEdge + 0.07, rockUp );
	// Coverage decides where snow lies, never how opaque it is: wind-scoured
	// bare patches, more of them lower down and with less snow overall.
	float rockScour = rockValue3( vRockPos * 0.33 + vec3( -6.0, 2.0, 4.0 ) ) * 0.7 + rockSnowNoise * 0.3;
	rockSnow *= smoothstep( 0.0, 0.06, rockScour - ( 1.0 - uSnowAmount ) * 0.9 - ( 1.0 - rockAlt ) * 0.38 + 0.1 );
	// Wind-packed snow lingers in the fractures of gentle slabs.
	rockSnow = max( rockSnow, rockCrack * smoothstep( 0.55, 0.85, rockN.y ) * 0.8 * uSnowAmount );
	#ifdef ROCK_ALL_SNOW
		rockSnow = 1.0;
	#endif
	// Snow smooths the relief it covers (soft drifts instead of facets).
	vec3 rockDrift = vec3( rockValue3( vRockPos * 0.9 ), rockValue3( vRockPos * 0.9 + 7.0 ), rockValue3( vRockPos * 0.9 - 7.0 ) ) - 0.5;
	rockBumped = normalize( mix( rockBumped, normalize( rockN + rockDrift * 0.18 ), rockSnow ) );

	float rockSunFacing = dot( rockBumped, uRockSun );
	vec3 rockSnowCol = mix( uSnowColor, uSnowShadow, 0.6 * ( 1.0 - smoothstep( -0.1, 0.4, rockSunFacing ) ) );
	rockSnowCol *= 0.94 + 0.06 * rockSnowNoise;
	diffuseColor.rgb = mix( rockAlbedo, rockSnowCol, rockSnow );
	float rockRoughness = mix( 0.8 + 0.14 * rockTone + 0.08 * rockCrack, 0.52, rockSnow );
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
		rockOcc *= 1.0 - rockCrack * 0.55 * ( 1.0 - rockSnow );
		reflectedLight.indirectDiffuse *= rockOcc;
		reflectedLight.indirectSpecular *= rockOcc;
		reflectedLight.directDiffuse *= mix( 1.0, rockOcc, 0.3 );
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
  const allSnow = options.allSnow ?? false;

  const uniforms: AlpineRockUniforms = {
    uRockSun: { value: (options.sunDirection ?? SUN_DIRECTION).clone().normalize() },
    uSnowAmount: { value: options.snowAmount ?? 0.85 },
    uSnowLine: { value: options.snowLine ?? 46 },
    uBumpStrength: { value: options.bumpStrength ?? 1.0 },
    uPatternScale: { value: options.patternScale ?? 1 },
    uReveal: { value: 1 },
    // Granite reads lighter than its palette swatch under a low sun: lift the
    // swatches a little and add a pale feldspar grey for the bright zones.
    uGranite: { value: new THREE.Color(PALETTE.granite).multiplyScalar(1.8) },
    uGraniteDark: { value: new THREE.Color(PALETTE.graniteDark).multiplyScalar(1.6) },
    uGraniteLight: { value: new THREE.Color('#9C9A96') },
    uGraniteWarm: { value: new THREE.Color('#7A6150') },
    uSnowColor: { value: new THREE.Color(PALETTE.snow) },
    uSnowShadow: { value: new THREE.Color(PALETTE.snowShadow) },
  };

  const material = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.88,
    metalness: 0,
  }) as AlpineRockMaterial;
  material.userData.rockUniforms = uniforms;

  material.defines = {
    ...(material.defines ?? {}),
    ROCK_QUALITY: quality,
    ...(vertexOcclusion ? { ROCK_VERTEX_AO: '' } : {}),
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

  const cacheKey = `alpine-rock-v2|q${quality}|ao${vertexOcclusion ? 1 : 0}|snow${allSnow ? 1 : 0}`;
  material.customProgramCacheKey = () => cacheKey;
  return material;
}

/** Pure snow variant of the alpine material (cornices, snow fields). */
export function createSnowMaterial(options: Omit<AlpineRockMaterialOptions, 'allSnow'> = {}): AlpineRockMaterial {
  return createAlpineRockMaterial({ bumpStrength: 0.4, ...options, allSnow: true });
}
