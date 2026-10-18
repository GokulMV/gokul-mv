import * as THREE from 'three';
import type { GpuTier } from '../../store/scrollStore';
import { PALETTE, SUN_DIRECTION } from '../world/worldLayout';

/* ==========================================================================
 * Twilight sky dome shader.
 *
 *   - elevation gradient PALETTE.skyZenith → skyMid → skyHorizon
 *   - warm skySunGlow concentrated on the horizon under the sun's azimuth,
 *     a soft Mie-like halo and a small HDR sun disc (feeds the bloom pass)
 *   - Earth's shadow and a faint Belt of Venus on the anti-solar horizon
 *   - faint, twinkling zenith stars (pixel-footprint aware, never aliasing)
 *   - optional high cirrus streaks lit by the low sun
 *   - below the horizon the dome fades to the fog colour, so fully fogged
 *     terrain meets the sky without a seam
 *   - triangular dither in display space against gradient banding
 *
 * The dome is pinned to the far plane in the vertex stage, so it is never
 * clipped whatever camera.far is. Tone mapped and colour-space converted like
 * every other world material (the Scene 10 dissolve works through exposure).
 * ========================================================================== */

export type SkyQuality = 0 | 1 | 2;

export function skyQualityFor(tier: GpuTier): SkyQuality {
  if (tier >= 2) return 2;
  if (tier === 1) return 1;
  return 0;
}

export const SKY_VERTEX_SHADER = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = position;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  // Pin to the far plane: never clipped, always behind everything else.
  clip.z = clip.w * 0.99999;
  gl_Position = clip;
}
`;

export const SKY_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uSunColor;
uniform vec3 uFog;
uniform vec3 uBelt;
uniform vec3 uSunDir;
uniform float uTime;
uniform float uWarmth;
uniform float uStars;
uniform float uCirrus;
uniform sampler2D uNoise;

varying vec3 vDir;

float skyHash13( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.zyx + 31.32 );
  return fract( ( p.x + p.y ) * p.z );
}

vec3 skyHash33( vec3 p ) {
  p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
  p += dot( p, p.yxz + 33.33 );
  return fract( ( p.xxy + p.yxx ) * p.zyx );
}

// Interleaved gradient noise (Jimenez) for screen-space dithering.
float skyIgn( vec2 fc ) {
  return fract( 52.9829189 * fract( dot( fc, vec2( 0.06711056, 0.00583715 ) ) ) );
}

vec3 skyStars( vec3 d ) {
  vec3 p = d * 230.0;
  vec3 cell = floor( p );
  float present = skyHash13( cell );
  if ( present > 0.0075 ) return vec3( 0.0 );
  vec3 r = skyHash33( cell + 17.17 );
  vec3 star = cell + 0.3 + 0.4 * r;
  vec3 delta = p - star;
  delta -= d * dot( delta, d );
  float dist = length( delta );
  // Keep every star at least ~1px wide so it never sparkles in and out.
  float footprint = length( fwidth( p ) );
  float radius = max( footprint * 0.8, 0.045 );
  float core = 1.0 - smoothstep( 0.0, radius, dist );
  float energy = 0.045 / radius;
  float magnitude = 0.12 + 2.2 * pow( r.x, 7.0 );
  float twinkle = 0.72 + 0.28 * sin( uTime * ( 1.3 + 5.0 * r.y ) + r.z * 41.0 );
  vec3 tint = mix( vec3( 0.72, 0.82, 1.0 ), vec3( 1.0, 0.86, 0.7 ), r.z );
  return tint * core * energy * energy * magnitude * twinkle;
}

void main() {
  vec3 d = normalize( vDir );
  vec3 L = normalize( uSunDir );
  float e = d.y;
  float eh = max( e, 0.0 );

  // ---- Elevation gradient.
  vec3 col = mix( uHorizon, uMid, smoothstep( 0.0, 0.32, pow( eh, 0.85 ) ) );
  col = mix( col, uZenith, smoothstep( 0.22, 0.95, eh ) );

  // ---- Sun azimuth alignment and the warm horizon glow.
  vec2 dh = normalize( d.xz + vec2( 1e-5, 0.0 ) );
  vec2 sh = normalize( L.xz );
  float az = dot( dh, sh ) * 0.5 + 0.5;
  float horizonBand = exp( -eh * 6.5 );
  float glowAz = pow( az, 3.0 );
  col = mix( col, uGlow * 0.62, glowAz * horizonBand * 0.55 * uWarmth );
  col += uGlow * glowAz * exp( -eh * 2.2 ) * 0.07 * uWarmth;

  // ---- Earth's shadow and Belt of Venus opposite the sun.
  float anti = pow( 1.0 - az, 2.0 );
  col *= 1.0 - anti * 0.28 * ( 1.0 - smoothstep( 0.0, 0.1, eh ) );
  col += uBelt * anti * exp( -pow( ( eh - 0.13 ) / 0.07, 2.0 ) ) * 0.16 * uWarmth;

  // ---- Sun halo and disc.
  float mu = max( dot( d, L ), 0.0 );
  float halo = pow( mu, 5.0 ) * 0.11 + pow( mu, 42.0 ) * 0.32 + pow( mu, 420.0 ) * 1.1;
  col += uGlow * halo * uWarmth;
  float disc = smoothstep( 0.999935, 0.999962, mu );
  col += uSunColor * disc * 26.0;

#if SKY_QUALITY > 0
  // ---- High cirrus streaks, lit warm toward the sun.
  float guard = smoothstep( 0.03, 0.2, e ) * ( 1.0 - smoothstep( 0.55, 0.95, e ) );
  if ( guard > 0.0 ) {
    vec2 cuv = d.xz / ( e + 0.16 );
    vec2 axis = normalize( vec2( 0.82, -0.57 ) );
    vec2 st = vec2( dot( cuv, axis ), dot( cuv, vec2( -axis.y, axis.x ) ) ) * vec2( 0.075, 0.34 );
    st.x += uTime * 0.0022;
    float c1 = texture2D( uNoise, st + vec2( 0.13, 0.57 ) ).r;
    float c2 = texture2D( uNoise, st * 2.7 + vec2( 0.37, 0.11 ) ).g;
    float c3 = texture2D( uNoise, st * 6.1 + vec2( 0.71, 0.53 ) ).b;
    float cn = c1 * 0.58 + c2 * 0.3 + c3 * 0.12;
    float cover = smoothstep( 0.54, 0.74, cn ) * guard * uCirrus;
    vec3 lit = mix( uMid * 1.9 + uHorizon * 0.3, uGlow * 0.9, pow( az, 2.0 ) * 0.75 + pow( mu, 6.0 ) * 0.6 );
    col = mix( col, lit, cover * 0.42 );
  }
#endif

  // ---- Stars at the zenith, fading toward the horizon and the sun.
  float starMask = uStars * smoothstep( 0.16, 0.62, e ) * ( 1.0 - smoothstep( 0.55, 0.92, mu ) );
  if ( starMask > 0.001 ) col += skyStars( d ) * starMask;

  // ---- Below the horizon: distant haze meeting the fogged terrain.
  col = mix( col, uFog, smoothstep( 0.0, -0.09, e ) );

  // ---- Triangular dither (±1 LSB in display space) against banding.
  vec3 encoded = pow( max( col, vec3( 0.0 ) ), vec3( 1.0 / 2.2 ) );
  float dither = skyIgn( gl_FragCoord.xy ) + skyIgn( gl_FragCoord.yx + 17.0 ) - 1.0;
  encoded += dither / 255.0;
  col = pow( max( encoded, vec3( 0.0 ) ), vec3( 2.2 ) );

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface SkyUniforms {
  [uniform: string]: THREE.IUniform;
  uZenith: THREE.IUniform<THREE.Color>;
  uMid: THREE.IUniform<THREE.Color>;
  uHorizon: THREE.IUniform<THREE.Color>;
  uGlow: THREE.IUniform<THREE.Color>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uFog: THREE.IUniform<THREE.Color>;
  uBelt: THREE.IUniform<THREE.Color>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uTime: THREE.IUniform<number>;
  uWarmth: THREE.IUniform<number>;
  uStars: THREE.IUniform<number>;
  uCirrus: THREE.IUniform<number>;
  uNoise: THREE.IUniform<THREE.Texture>;
}

export type SkyMaterial = THREE.ShaderMaterial & { uniforms: SkyUniforms };

export function createSkyMaterial(noise: THREE.Texture, quality: SkyQuality): SkyMaterial {
  const uniforms: SkyUniforms = {
    uZenith: { value: new THREE.Color(PALETTE.skyZenith) },
    uMid: { value: new THREE.Color(PALETTE.skyMid) },
    uHorizon: { value: new THREE.Color(PALETTE.skyHorizon) },
    uGlow: { value: new THREE.Color(PALETTE.skySunGlow) },
    uSunColor: { value: new THREE.Color(PALETTE.sun) },
    uFog: { value: new THREE.Color(PALETTE.fog) },
    uBelt: { value: new THREE.Color('#B98CA6') },
    uSunDir: { value: SUN_DIRECTION.clone().normalize() },
    uTime: { value: 0 },
    uWarmth: { value: 0.85 },
    uStars: { value: 0.7 },
    uCirrus: { value: quality > 0 ? 1 : 0 },
    uNoise: { value: noise },
  };
  const material = new THREE.ShaderMaterial({
    name: 'SkyDomeMaterial',
    uniforms,
    vertexShader: SKY_VERTEX_SHADER,
    fragmentShader: SKY_FRAGMENT_SHADER,
    defines: { SKY_QUALITY: quality },
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  return material as SkyMaterial;
}
