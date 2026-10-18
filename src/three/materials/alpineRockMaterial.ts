import * as THREE from 'three';
import { PALETTE, SUN_DIRECTION } from '../world/worldLayout';

/* ==========================================================================
 * Alpine rock material — a MeshStandardMaterial extended via onBeforeCompile.
 *
 * Everything is procedural and world-space (no textures, no UVs):
 *   - triplanar granite relief (gradient noise with analytic derivatives) that
 *     drives both the albedo and a surface-gradient normal perturbation,
 *     including thin crack networks and mineral grain;
 *   - macro colour variation between PALETTE.granite / graniteDark, warm iron
 *     staining, strata banding and vertical water streaks on steep faces;
 *   - snow on up-facing slopes / ledges, increasing with altitude, broken up by
 *     noise, with a cool blue tint away from the sun and sparse sun glints;
 *   - optional baked per-vertex ambient occlusion (`aOcclusion` attribute).
 * It stays a standard PBR material, so shadows, fog, tone mapping and scene
 * environment lighting keep working unchanged.
 * ========================================================================== */

export type RockShaderQuality = 0 | 1 | 2;

export interface AlpineRockMaterialOptions {
  /** Read the per-vertex `aOcclusion` attribute baked by terrainGeometry. */
  vertexOcclusion?: boolean;
  /** Shader detail: 0 = low (2 relief octaves), 1 = medium, 2 = high (+grain, sparkle). */
  quality?: RockShaderQuality;
  /** Global snow coverage 0..1. */
  snowAmount?: number;
  /** World Y above which up-facing slopes are fully snow covered. */
  snowLine?: number;
  /** Strength of the procedural relief normal perturbation. */
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
uniform vec3 uGraniteWarm;
uniform vec3 uSnowColor;
uniform vec3 uSnowShadow;
varying vec3 vRockPos;
varying vec3 vRockNormal;
#ifdef ROCK_VERTEX_AO
varying float vRockAO;
#endif

float rockHash13( vec3 p3 ) {
	p3 = fract( p3 * 0.1031 );
	p3 += dot( p3, p3.zyx + 31.32 );
	return fract( ( p3.x + p3.y ) * p3.z );
}

vec2 rockHash22( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.xx + p3.yz ) * p3.zy );
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
 * Granite relief on one projection plane: returns (height, dh/du, dh/dv) in
 * pattern units; crack and grain masks via out parameters. fade.x fades the
 * mid octave and cracks, fade.y the fine octave / grain (distance anti-alias).
 */
vec3 rockRelief( vec2 uv, vec2 fade, out float crack, out float grain ) {
	vec3 n0 = rockNoised( uv * 0.42 );
	n0.yz *= 0.42;
	// Thin crack network along the zero set of the first octave.
	const float cw = 0.06;
	float ct = clamp( abs( n0.x ) / cw, 0.0, 1.0 );
	crack = ( 1.0 - ct * ct * ( 3.0 - 2.0 * ct ) ) * fade.x;
	vec2 dCrack = -( 6.0 * ct * ( 1.0 - ct ) / cw ) * sign( n0.x ) * n0.yz * fade.x;
	vec3 n1 = rockNoised( uv * 1.31 + vec2( 3.1, 7.3 ) );
	n1.yz *= 1.31;
	vec3 h = n0 * 0.42 + n1 * 0.2;
	#if ROCK_QUALITY > 0
		vec3 n2 = rockNoised( uv * 3.7 + vec2( -7.7, 1.9 ) );
		n2.yz *= 3.7;
		h += n2 * ( 0.085 * fade.x );
	#endif
	#if ROCK_QUALITY > 1
		vec3 n3 = rockNoised( uv * 10.3 + vec2( 1.3, -4.1 ) );
		n3.yz *= 10.3;
		h += n3 * ( 0.03 * fade.y );
		grain = n3.x * fade.y;
	#else
		grain = 0.0;
	#endif
	h.x -= crack * 0.16;
	h.yz -= dCrack * 0.16;
	return h;
}
`;

/* Computes rock / snow albedo, relief normal and roughness (world space). */
const FRAGMENT_SURFACE = /* glsl */ `
	vec3 rockN = normalize( vRockNormal );
	vec3 rockP = vRockPos * uPatternScale;
	float rockDist = length( cameraPosition - vRockPos );
	vec2 rockFade = vec2( 1.0 - smoothstep( 40.0, 140.0, rockDist ), 1.0 - smoothstep( 9.0, 38.0, rockDist ) );

	vec3 rockW = pow( abs( rockN ), vec3( 5.0 ) );
	rockW /= ( rockW.x + rockW.y + rockW.z );
	float rockH = 0.0;
	vec3 rockGrad = vec3( 0.0 );
	float rockCrack = 0.0;
	float rockGrain = 0.0;
	float rc;
	float rg;
	vec3 rr;
	if ( rockW.x > 0.015 ) {
		rr = rockRelief( rockP.zy, rockFade, rc, rg );
		rockH += rockW.x * rr.x;
		rockGrad += rockW.x * vec3( 0.0, rr.z, rr.y );
		rockCrack += rockW.x * rc;
		rockGrain += rockW.x * rg;
	}
	if ( rockW.y > 0.015 ) {
		rr = rockRelief( rockP.xz + vec2( 17.0, -5.0 ), rockFade, rc, rg );
		rockH += rockW.y * rr.x;
		rockGrad += rockW.y * vec3( rr.y, 0.0, rr.z );
		rockCrack += rockW.y * rc;
		rockGrain += rockW.y * rg;
	}
	if ( rockW.z > 0.015 ) {
		rr = rockRelief( rockP.xy + vec2( -31.0, 9.0 ), rockFade, rc, rg );
		rockH += rockW.z * rr.x;
		rockGrad += rockW.z * vec3( rr.y, rr.z, 0.0 );
		rockCrack += rockW.z * rc;
		rockGrain += rockW.z * rg;
	}
	rockGrad *= uPatternScale;

	// Macro colour.
	float rockM1 = rockValue3( vRockPos * 0.045 );
	float rockM2 = rockValue3( vRockPos * 0.16 + 11.0 );
	float rockM3 = rockValue3( vec3( vRockPos.x * 0.9, vRockPos.y * 0.05, vRockPos.z * 0.9 ) + 5.0 );
	vec3 rockAlbedo = mix( uGraniteDark, uGranite, smoothstep( 0.2, 0.8, rockM1 * 0.6 + rockM2 * 0.4 ) );
	rockAlbedo = mix( rockAlbedo, uGraniteWarm, smoothstep( 0.6, 0.88, rockM2 ) * 0.5 );
	float rockBand = sin( vRockPos.y * 1.9 + rockM1 * 6.0 ) * 0.5 + 0.5;
	rockAlbedo *= 0.9 + 0.14 * rockBand;
	rockAlbedo *= 0.82 + 0.34 * clamp( rockH * 1.1 + 0.5, 0.0, 1.0 );
	float rockSteep = 1.0 - abs( rockN.y );
	rockAlbedo *= 1.0 - 0.3 * rockSteep * smoothstep( 0.55, 0.82, rockM3 );
	rockAlbedo *= 1.0 - 0.32 * smoothstep( 0.3, 0.62, rockGrain );
	rockAlbedo += uGranite * 0.22 * ( 1.0 - smoothstep( -0.62, -0.38, rockGrain ) ) * rockFade.y;
	rockAlbedo *= 1.0 - 0.6 * rockCrack;

	// Snow: up-facing, more with altitude, broken up by noise; cracks on ledges hold it.
	float rockSnowNoise = rockValue3( vRockPos * 0.21 + 3.0 ) * 0.65 + rockValue3( vRockPos * 0.83 - 9.0 ) * 0.35;
	float rockAlt = smoothstep( uSnowLine - 75.0, uSnowLine + 10.0, vRockPos.y );
	float rockUp = rockN.y + rockH * 0.22;
	float rockSnowEdge = mix( 0.95, 0.5, rockAlt * uSnowAmount ) + ( 0.5 - rockSnowNoise ) * 0.4;
	float rockSnow = smoothstep( rockSnowEdge, rockSnowEdge + 0.09, rockUp );
	rockSnow *= clamp( uSnowAmount * ( 0.4 + 0.6 * rockAlt ) * 1.7, 0.0, 1.0 );
	rockSnow = max( rockSnow, rockCrack * smoothstep( 0.5, 0.8, rockN.y ) * 0.85 * uSnowAmount );
	#ifdef ROCK_ALL_SNOW
		rockSnow = 1.0;
	#endif

	vec3 rockSurfGrad = rockGrad - dot( rockGrad, rockN ) * rockN;
	vec3 rockBumped = normalize( rockN - uBumpStrength * ( 1.0 - 0.8 * rockSnow ) * rockSurfGrad );

	float rockSunFacing = dot( rockBumped, uRockSun );
	vec3 rockSnowCol = mix( uSnowColor, uSnowShadow, 0.55 * ( 1.0 - smoothstep( -0.15, 0.45, rockSunFacing ) ) );
	rockSnowCol *= 0.92 + 0.08 * rockSnowNoise;
	diffuseColor.rgb = mix( rockAlbedo, rockSnowCol, rockSnow );
	float rockRoughness = mix( 0.8 + 0.12 * rockM2 + 0.08 * rockCrack, 0.56, rockSnow );
`;

const FRAGMENT_ROUGHNESS = /* glsl */ `
	roughnessFactor = rockRoughness;
`;

const FRAGMENT_NORMAL = /* glsl */ `
	normal = normalize( ( viewMatrix * vec4( rockBumped * faceDirection, 0.0 ) ).xyz );
`;

const FRAGMENT_EMISSIVE = /* glsl */ `
	#if ROCK_QUALITY > 1
		{
			vec3 rockV = normalize( cameraPosition - vRockPos );
			float rockGlint = step( 0.992, rockHash13( floor( vRockPos * 30.0 ) ) );
			rockGlint *= pow( max( dot( reflect( -uRockSun, rockBumped ), rockV ), 0.0 ), 48.0 );
			rockGlint *= smoothstep( 0.0, 0.25, rockSunFacing ) * rockSnow * ( 1.0 - smoothstep( 5.0, 26.0, rockDist ) );
			totalEmissiveRadiance += rockGlint * vec3( 2.4, 2.25, 2.0 );
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
		rockOcc *= 1.0 - rockCrack * 0.4 * ( 1.0 - rockSnow );
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
  const allSnow = options.allSnow ?? false;

  const uniforms: AlpineRockUniforms = {
    uRockSun: { value: (options.sunDirection ?? SUN_DIRECTION).clone().normalize() },
    uSnowAmount: { value: options.snowAmount ?? 0.85 },
    uSnowLine: { value: options.snowLine ?? 42 },
    uBumpStrength: { value: options.bumpStrength ?? 0.55 },
    uPatternScale: { value: options.patternScale ?? 1 },
    uReveal: { value: 1 },
    uGranite: { value: new THREE.Color(PALETTE.granite) },
    uGraniteDark: { value: new THREE.Color(PALETTE.graniteDark) },
    uGraniteWarm: { value: new THREE.Color('#5E5048') },
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

  const cacheKey = `alpine-rock-v1|q${quality}|ao${vertexOcclusion ? 1 : 0}|snow${allSnow ? 1 : 0}`;
  material.customProgramCacheKey = () => cacheKey;
  return material;
}

/** Pure snow variant of the alpine material (cornices, snow fields). */
export function createSnowMaterial(options: Omit<AlpineRockMaterialOptions, 'allSnow'> = {}): AlpineRockMaterial {
  return createAlpineRockMaterial({ bumpStrength: 0.3, ...options, allSnow: true });
}
