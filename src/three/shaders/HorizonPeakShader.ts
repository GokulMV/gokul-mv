import * as THREE from 'three';
import type { GpuTier } from '../../store/scrollStore';
import { FOG, PALETTE, SUN_DIRECTION } from '../world/worldLayout';

/* ==========================================================================
 * Horizon peak shader — the distant range and the next mountain (Scene 8+).
 *
 * Lighting is fully custom (the range sits far outside the sun's shadow
 * camera), driven by per-vertex data baked once by HorizonRange:
 *   aBake.x  soft cast-shadow visibility toward SUN_DIRECTION (0 = shadowed)
 *   aBake.y  horizon-based ambient occlusion (0 = occluded)
 *   aBake.z  concavity at gully scale (0 = convex rib, 0.5 = flat, 1 = gully)
 *   aBake.w  hanging-glacier / snowfield mask (0..1)
 *
 * The fragment stage adds a noisy, slope-dependent snow line (snow collects
 * in couloirs, on benches and glaciers, steep ribs stay dark granite), warm
 * golden sun light with a cool sky-lit shadow side, alpenglow on high
 * sun-facing snow, a golden rim on sun-facing crests, and aerial perspective
 * that follows the scene's linear fog but thins with altitude so snow and
 * rock stay readable at 150–260 units instead of collapsing to silhouettes.
 *
 * The material is tone mapped (renderer exposure / composer exposure pass
 * handle the Scene 10 dissolve), so it carries no exposure uniform.
 * ========================================================================== */

export type HorizonShaderQuality = 0 | 1 | 2;

export function horizonShaderQualityFor(tier: GpuTier): HorizonShaderQuality {
  if (tier >= 3) return 2;
  if (tier === 2) return 1;
  return 0;
}

/* ---------------------------------------------------------------------------
 * Shared tileable noise texture (also used by the valley mist and the sky).
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

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * RGBA8 texture holding four independent, seamlessly tiling gradient noises
 * (R, G, B with `period` lattice cells per tile, A with twice as many). Every
 * FBM octave in the shaders is one filtered, mip-mapped fetch.
 */
export function createTileableNoiseTexture(size = 256, period = 8, seed = 0x51ed2701): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let channel = 0; channel < 4; channel += 1) {
    const rand = mulberry32(seed + channel * 7919);
    const p = channel === 3 ? period * 2 : period;
    const gx = new Float32Array(p * p);
    const gy = new Float32Array(p * p);
    for (let i = 0; i < p * p; i += 1) {
      const a = rand() * Math.PI * 2;
      gx[i] = Math.cos(a);
      gy[i] = Math.sin(a);
    }
    for (let j = 0; j < size; j += 1) {
      const v = ((j + 0.5) / size) * p;
      const y0 = Math.floor(v);
      const fy = v - y0;
      const y1 = (y0 + 1) % p;
      const sy = fade(fy);
      for (let i = 0; i < size; i += 1) {
        const u = ((i + 0.5) / size) * p;
        const x0 = Math.floor(u);
        const fx = u - x0;
        const x1 = (x0 + 1) % p;
        const sx = fade(fx);
        const g00 = x0 + y0 * p;
        const g10 = x1 + y0 * p;
        const g01 = x0 + y1 * p;
        const g11 = x1 + y1 * p;
        const n00 = gx[g00] * fx + gy[g00] * fy;
        const n10 = gx[g10] * (fx - 1) + gy[g10] * fy;
        const n01 = gx[g01] * fx + gy[g01] * (fy - 1);
        const n11 = gx[g11] * (fx - 1) + gy[g11] * (fy - 1);
        const nx0 = n00 + (n10 - n00) * sx;
        const nx1 = n01 + (n11 - n01) * sx;
        const n = nx0 + (nx1 - nx0) * sy;
        const value = Math.max(0, Math.min(255, Math.round((0.5 + n * 0.78) * 255)));
        data[(i + j * size) * 4 + channel] = value;
      }
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.name = 'HorizonNoise';
  texture.needsUpdate = true;
  return texture;
}

/* ---------------------------------------------------------------------------
 * GLSL
 * ------------------------------------------------------------------------- */

export const HORIZON_PEAK_VERTEX_SHADER = /* glsl */ `
attribute vec4 aBake;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec4 vBake;
varying float vViewDepth;

void main() {
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vWorldPos = world.xyz;
  vWorldNormal = normalize( mat3( modelMatrix ) * normal );
  vBake = aBake;
  vec4 mv = viewMatrix * world;
  vViewDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

export const HORIZON_PEAK_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uNoise;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyLight;
uniform vec3 uGroundLight;
uniform vec3 uRock;
uniform vec3 uRockDark;
uniform vec3 uRockWarm;
uniform vec3 uSnow;
uniform vec3 uSnowShadow;
uniform vec3 uIce;
uniform vec3 uGlow;
uniform vec3 uFogColor;
uniform vec3 uHazeColor;
uniform vec3 uMistColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uHazeThin;
uniform float uSnowLine;
uniform float uAlpenglow;
uniform float uReveal;
uniform float uTime;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec4 vBake;
varying float vViewDepth;

float hpNoise( vec2 p, int ch ) {
  vec4 t = texture2D( uNoise, p );
  return ch == 0 ? t.r : ch == 1 ? t.g : ch == 2 ? t.b : t.a;
}

void main() {
  vec3 N = normalize( vWorldNormal );
  vec3 L = normalize( uSunDir );
  vec3 toCam = cameraPosition - vWorldPos;
  vec3 V = normalize( toCam );
  float y = vWorldPos.y;
  vec2 xz = vWorldPos.xz;

  float sunVis = vBake.x;
  float ao = vBake.y;
  float concave = vBake.z * 2.0 - 1.0;
  float glacier = vBake.w;

  // ---- Noise fields (world space; mip-mapped so distance never shimmers).
  float nBroad = texture2D( uNoise, xz * 0.0042 + vec2( 0.13, 0.71 ) ).r;
  float nMid = texture2D( uNoise, xz * 0.016 + vec2( 0.31, 0.05 ) ).g;
  float nFine = texture2D( uNoise, xz * 0.058 + vec2( 0.73, 0.41 ) ).b;
#if HP_QUALITY > 0
  // Fall-line streaks: stretched vertically on steep faces (rock ribs / runnels).
  float nStreak = texture2D( uNoise, vec2( xz.x * 0.09 + xz.y * 0.035, y * 0.012 ) ).a;
#else
  float nStreak = 0.5;
#endif
#if HP_QUALITY > 1
  float nGrain = texture2D( uNoise, xz * 0.19 + vec2( y * 0.07, 0.0 ) ).r;
#else
  float nGrain = 0.5;
#endif

  // ---- Snow: noisy snow line, slope dependence, gullies and benches hold snow.
  float steep = 1.0 - clamp( N.y, 0.0, 1.0 );
  float line = uSnowLine + ( nBroad - 0.5 ) * 30.0 + ( nMid - 0.5 ) * 12.0;
  float altSnow = smoothstep( line - 7.0, line + 9.0, y );
  float altitude01 = smoothstep( line, line + 95.0, y );
  float hold = mix( 0.40, 0.63, altitude01 )
    + concave * 0.26
    + ( nFine - 0.5 ) * 0.22
    + ( nStreak - 0.5 ) * 0.2
    + glacier * 0.35;
  float snow = altSnow * smoothstep( -0.05, 0.06, hold - steep );
  snow = max( snow, glacier * smoothstep( 0.55, 0.85, glacier ) * altSnow );
  snow = clamp( snow, 0.0, 1.0 );

  // ---- Rock albedo: dark granite, strata bands, warm iron staining.
  float strata = sin( y * 0.62 + nMid * 7.0 + nFine * 2.5 ) * 0.5 + 0.5;
  vec3 rock = mix( uRockDark, uRock, clamp( 0.25 + 0.45 * nFine + 0.25 * strata + 0.2 * ( nGrain - 0.5 ), 0.0, 1.0 ) );
  rock = mix( rock, uRockWarm, smoothstep( 0.45, 0.8, nBroad ) * 0.35 );
  rock *= 0.75 + 0.5 * nStreak;
  // Convex ribs are wind-scoured and darker; gullies slightly lighter (debris).
  rock *= 1.0 - 0.22 * clamp( -concave, 0.0, 1.0 );

  // ---- Lighting.
  float ndl = dot( N, L );
  float sun = clamp( ndl, 0.0, 1.0 ) * sunVis;
  // Snow scatters light under the surface: a little wrap on the terminator.
  float sunSnow = clamp( ( ndl + 0.18 ) / 1.18, 0.0, 1.0 ) * sunVis;
  float hemi = N.y * 0.5 + 0.5;
  vec3 ambient = mix( uGroundLight, uSkyLight, hemi ) * ( 0.35 + 0.65 * ao );

  vec3 rockCol = rock * ( uSunColor * sun + ambient );
  vec3 snowLit = uSnow * uSunColor * sunSnow;
  vec3 snowShade = uSnowShadow * ambient * 1.9;
  vec3 snowCol = snowLit + snowShade;
  // Glacier ice on steep snow (serac faces) shows a cold blue.
  float ice = glacier * smoothstep( 0.35, 0.7, steep );
  snowCol = mix( snowCol, uIce * ( uSunColor * sun * 0.6 + ambient * 1.6 ), ice * 0.65 );

  vec3 col = mix( rockCol, snowCol, snow );

  // Alpenglow: high sun-facing snow takes on the warm last light.
  float high = smoothstep( 35.0, 118.0, y );
  col += uGlow * snow * sunSnow * high * 0.42 * uAlpenglow;

  // Golden rim on sun-facing crests (grazing view, convex, lit).
  float facing = clamp( dot( N, V ), 0.0, 1.0 );
  float rim = pow( 1.0 - facing, 3.0 ) * smoothstep( -0.1, 0.45, ndl ) * sunVis;
  float crest = 0.35 + 0.65 * clamp( -concave * 1.5, 0.0, 1.0 );
  col += uGlow * uSunColor * rim * crest * ( 0.22 + 0.3 * snow ) * uAlpenglow;

  // ---- Aerial perspective (linear scene fog, thinning with altitude).
  float fogF = smoothstep( uFogNear, uFogFar, vViewDepth );
  float thin = mix( 1.0, uHazeThin, smoothstep( -10.0, 125.0, y ) );
  float haze = fogF * thin;
  vec3 viewDir = -V;
  float sunward = pow( max( dot( viewDir, L ), 0.0 ), 4.0 );
  vec3 hazeCol = mix( uFogColor, uHazeColor, smoothstep( -20.0, 130.0, y ) * 0.6 );
  hazeCol += uGlow * sunward * 0.14;
  // Valley mist pooled low between the peaks.
  float pooled = ( 1.0 - smoothstep( -8.0, 42.0, y ) ) * smoothstep( 60.0, 160.0, vViewDepth );
  col = mix( col, uMistColor, pooled * 0.45 );
  col = mix( col, hazeCol, haze );

  // Build-in reveal: the range condenses out of the haze.
  col = mix( hazeCol, col, uReveal );

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ---------------------------------------------------------------------------
 * Material factory
 * ------------------------------------------------------------------------- */

export interface HorizonPeakUniforms {
  [uniform: string]: THREE.IUniform;
  uNoise: THREE.IUniform<THREE.Texture>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSkyLight: THREE.IUniform<THREE.Color>;
  uGroundLight: THREE.IUniform<THREE.Color>;
  uRock: THREE.IUniform<THREE.Color>;
  uRockDark: THREE.IUniform<THREE.Color>;
  uRockWarm: THREE.IUniform<THREE.Color>;
  uSnow: THREE.IUniform<THREE.Color>;
  uSnowShadow: THREE.IUniform<THREE.Color>;
  uIce: THREE.IUniform<THREE.Color>;
  uGlow: THREE.IUniform<THREE.Color>;
  uFogColor: THREE.IUniform<THREE.Color>;
  uHazeColor: THREE.IUniform<THREE.Color>;
  uMistColor: THREE.IUniform<THREE.Color>;
  uFogNear: THREE.IUniform<number>;
  uFogFar: THREE.IUniform<number>;
  uHazeThin: THREE.IUniform<number>;
  uSnowLine: THREE.IUniform<number>;
  uAlpenglow: THREE.IUniform<number>;
  uReveal: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
}

export type HorizonPeakMaterial = THREE.ShaderMaterial & { uniforms: HorizonPeakUniforms };

/** Linear-space light levels tuned against WorldLighting's sun (3.1) / hemisphere (0.55). */
const SUN_LEVEL = 1.25;
const SKY_LEVEL = 0.3;
const GROUND_LEVEL = 0.22;

export function createHorizonPeakMaterial(noise: THREE.Texture, quality: HorizonShaderQuality): HorizonPeakMaterial {
  const uniforms: HorizonPeakUniforms = {
    uNoise: { value: noise },
    uSunDir: { value: SUN_DIRECTION.clone().normalize() },
    uSunColor: { value: new THREE.Color(PALETTE.sun).multiplyScalar(SUN_LEVEL) },
    uSkyLight: { value: new THREE.Color(PALETTE.hemisphereSky).multiplyScalar(SKY_LEVEL) },
    uGroundLight: { value: new THREE.Color(PALETTE.hemisphereGround).multiplyScalar(GROUND_LEVEL) },
    uRock: { value: new THREE.Color(PALETTE.granite) },
    uRockDark: { value: new THREE.Color(PALETTE.graniteDark) },
    uRockWarm: { value: new THREE.Color('#5A4A40') },
    uSnow: { value: new THREE.Color(PALETTE.snow) },
    uSnowShadow: { value: new THREE.Color(PALETTE.snowShadow) },
    uIce: { value: new THREE.Color('#7FA6C9') },
    uGlow: { value: new THREE.Color(PALETTE.skySunGlow) },
    uFogColor: { value: new THREE.Color(PALETTE.fog) },
    uHazeColor: { value: new THREE.Color(PALETTE.skyHorizon) },
    uMistColor: { value: new THREE.Color('#56678A') },
    uFogNear: { value: FOG.near },
    uFogFar: { value: FOG.far },
    uHazeThin: { value: 0.58 },
    uSnowLine: { value: 18 },
    uAlpenglow: { value: 0.7 },
    uReveal: { value: 0 },
    uTime: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    name: 'HorizonPeakMaterial',
    uniforms,
    vertexShader: HORIZON_PEAK_VERTEX_SHADER,
    fragmentShader: HORIZON_PEAK_FRAGMENT_SHADER,
    defines: { HP_QUALITY: quality },
    fog: false,
    lights: false,
    side: THREE.FrontSide,
  });
  return material as HorizonPeakMaterial;
}
