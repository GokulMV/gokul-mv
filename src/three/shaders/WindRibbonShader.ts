import * as THREE from 'three';

/* ==========================================================================
 * Wind ribbons — long, thin, translucent streaks of wind-driven spindrift
 * tearing through the chasm-2 gorge.
 *
 * Geometry: one subdivided strip (s 0 → 1 along its length, side −1 → 1
 * across it) drawn once per ribbon with instancing. Each ribbon follows a
 * quadratic Bézier through the open air of the gorge; the vertex shader
 * makes it undulate (travelling waves running downwind, laterally and
 * vertically), turns the strip to face the camera around its own tangent
 * (so it never collapses edge-on) and keeps it at least ~1px wide (fading
 * it instead of letting it shimmer).
 *
 * Every ribbon is one gust: a bright segment races along the path once per
 * gust period while the FBM pattern inside it streams downwind even faster,
 * so the wind reads as violent and directional, never as static lines.
 * The fragment stage gives the strip feathered edges, filamentary FBM alpha
 * and forward scattering toward the low sun.
 *
 * Tone mapped and fogged like the rest of the world (so the Scene 10
 * exposure dissolve applies to it automatically). Mesh model matrix is
 * identity (world-space attributes).
 * ========================================================================== */

export const WIND_RIBBON_VERTEX_SHADER = /* glsl */ `
attribute vec4 aP0;    // xyz start, w half width
attribute vec4 aP1;    // xyz Bézier control, w undulation amplitude
attribute vec4 aP2;    // xyz end, w undulation wavenumber (rad per unit)
attribute vec4 aFlow;  // x streak flow speed (units/s), y gust period (s), z gust phase 0..1, w seed
attribute vec2 aMeta;  // x opacity, y adaptive-quality rank

uniform float uTime;
uniform float uCount;
uniform float uGust;
uniform float uPixel;  // 2 tan(fov / 2) / viewport height (px), for the 1px minimum width
uniform vec3 uSunDir;

varying vec2 vStrip;
varying vec2 vFlowUv;
varying float vAlpha;
varying float vFwd;
varying float vHead;

#include <fog_pars_vertex>

vec3 bezier( float s ) {
  float u = 1.0 - s;
  return u * u * aP0.xyz + 2.0 * u * s * aP1.xyz + s * s * aP2.xyz;
}

vec3 centreAt( float s, vec3 lateral, float len, float wave ) {
  vec3 c = bezier( s );
  float x = s * len;
  float k = aP2.w;
  float ph = aFlow.w * 6.2831853;
  // Travelling waves running downwind (they never reach the ends at full size).
  float env = 0.35 + 0.65 * sin( 3.14159265 * s );
  float lat = 0.68 * sin( k * x - wave + ph ) + 0.32 * sin( k * 2.3 * x - wave * 1.9 + ph * 1.7 );
  float ver = sin( k * 0.71 * x - wave * 0.83 + ph * 2.9 ) * 0.6 + 0.25 * sin( k * 3.1 * x - wave * 2.6 + ph * 0.3 );
  return c + ( lateral * lat + vec3( 0.0, ver, 0.0 ) ) * ( aP1.w * env );
}

void main() {
  float s = position.x;
  float side = position.y;
  vec3 chord = aP2.xyz - aP0.xyz;
  float len = max( length( chord ), 1e-3 );
  vec3 dir = chord / len;
  vec3 lateral = cross( dir, vec3( 0.0, 1.0, 0.0 ) );
  float latLen = length( lateral );
  lateral = latLen > 1e-4 ? lateral / latLen : vec3( 1.0, 0.0, 0.0 );

  float wave = uTime * aP2.w * aFlow.x * 0.42;
  vec3 c = centreAt( s, lateral, len, wave );
  vec3 tangent = centreAt( min( s + 0.01, 1.0 ), lateral, len, wave ) - centreAt( max( s - 0.01, 0.0 ), lateral, len, wave );
  tangent = normalize( tangent + dir * 1e-4 );

  vec3 toCam = cameraPosition - c;
  float dist = max( length( toCam ), 1e-3 );
  vec3 view = toCam / dist;
  vec3 widthDir = cross( tangent, view );
  float wl = length( widthDir );
  widthDir = wl > 1e-3 ? widthDir / wl : lateral;

  // Gust: a bright segment races along the ribbon once per period.
  float life = fract( uTime / aFlow.y + aFlow.z );
  float head = mix( -0.15, 1.45, life );
  float tail = head - mix( 0.55, 0.8, fract( aFlow.w * 7.31 ) );
  float seg = smoothstep( tail, mix( tail, head, 0.55 ), s ) * ( 1.0 - smoothstep( head - 0.08, head, s ) );
  float ends = smoothstep( 0.0, 0.1, s ) * ( 1.0 - smoothstep( 0.86, 1.0, s ) );

  float halfWidth = aP0.w * ( 0.55 + 0.45 * uGust ) * mix( 0.45, 1.0, seg );
  float alpha = aMeta.x * seg * ends * clamp( uCount - aMeta.y, 0.0, 1.0 );

  vec4 mvPosition = modelViewMatrix * vec4( c, 1.0 );
  // Never thinner than ~1.1px: widen and fade instead (no sub-pixel shimmer).
  float minHalf = 0.55 * uPixel * max( -mvPosition.z, 0.0 );
  if ( halfWidth < minHalf ) {
    alpha *= halfWidth / minHalf;
    halfWidth = minHalf;
  }
  vec3 world = c + widthDir * ( side * halfWidth );
  mvPosition = modelViewMatrix * vec4( world, 1.0 );
  // Nothing smears across the lens.
  alpha *= smoothstep( 1.2, 4.5, dist );

  gl_Position = projectionMatrix * mvPosition;
  if ( alpha < 0.002 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );

  vStrip = vec2( s, side );
  vFlowUv = vec2( ( s * len - uTime * aFlow.x ) * 0.032, aFlow.w * 3.7 );
  vAlpha = alpha;
  vFwd = pow( max( dot( -view, uSunDir ), 0.0 ), 4.0 );
  vHead = smoothstep( head - 0.3, head - 0.02, s ) * seg;
  #include <fog_vertex>
}
`;

export const WIND_RIBBON_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uNoise;
uniform float uIntensity;
uniform vec3 uColor;
uniform vec3 uShadowColor;
uniform vec3 uSunColor;

varying vec2 vStrip;
varying vec2 vFlowUv;
varying float vAlpha;
varying float vFwd;
varying float vHead;

#include <fog_pars_fragment>

void main() {
  float side = vStrip.y;
  // Feathered edges that reach exactly zero at the strip border.
  float e = 1.0 - side * side;
  float edge = e * e;
  // Filaments: the pattern streams downwind and is finely split across the width.
  float n1 = texture2D( uNoise, vec2( vFlowUv.x, vFlowUv.y + side * 0.035 ) ).r;
  float n2 = texture2D( uNoise, vec2( vFlowUv.x * 2.6 + 0.37, vFlowUv.y * 1.3 + side * 0.11 ) ).b;
  float n3 = texture2D( uNoise, vec2( vFlowUv.x * 0.45 - 0.21, vFlowUv.y * 0.7 ) ).a;
  float streak = smoothstep( 0.32, 0.82, n1 * 0.55 + n2 * 0.3 + n3 * 0.15 );
  float core = 1.0 - smoothstep( 0.0, 0.55, abs( side ) );
  float a = vAlpha * edge * ( 0.18 + 0.82 * streak ) * ( 0.75 + 0.25 * core ) * ( 1.0 + 0.6 * vHead );
  a *= uIntensity;
  if ( a < 0.002 ) discard;
  vec3 col = mix( uShadowColor, uColor, 0.45 + 0.55 * streak );
  col += uSunColor * vFwd * ( 0.35 + 0.65 * streak );
  gl_FragColor = vec4( col, min( a, 1.0 ) );
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export type WindRibbonUniforms = {
  uNoise: THREE.IUniform<THREE.Texture>;
  uTime: THREE.IUniform<number>;
  uCount: THREE.IUniform<number>;
  uGust: THREE.IUniform<number>;
  uPixel: THREE.IUniform<number>;
  uIntensity: THREE.IUniform<number>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uColor: THREE.IUniform<THREE.Color>;
  uShadowColor: THREE.IUniform<THREE.Color>;
  uSunColor: THREE.IUniform<THREE.Color>;
};

export interface WindRibbonColors {
  lit: THREE.ColorRepresentation;
  shadow: THREE.ColorRepresentation;
  sun: THREE.ColorRepresentation;
}

export interface WindRibbonMaterial {
  material: THREE.ShaderMaterial;
  uniforms: WindRibbonUniforms;
}

export function createWindRibbonMaterial(
  noise: THREE.Texture,
  colors: WindRibbonColors,
  sunDirection: THREE.Vector3,
): WindRibbonMaterial {
  const uniforms: WindRibbonUniforms = {
    uNoise: { value: noise },
    uTime: { value: 0 },
    uCount: { value: 0 },
    uGust: { value: 1 },
    uPixel: { value: 0.0015 },
    uIntensity: { value: 0 },
    uSunDir: { value: sunDirection.clone().normalize() },
    uColor: { value: new THREE.Color(colors.lit) },
    uShadowColor: { value: new THREE.Color(colors.shadow) },
    uSunColor: { value: new THREE.Color(colors.sun) },
  };
  const material = new THREE.ShaderMaterial({
    name: 'WindRibbons',
    vertexShader: WIND_RIBBON_VERTEX_SHADER,
    fragmentShader: WIND_RIBBON_FRAGMENT_SHADER,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...uniforms },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: true,
  });
  return { material, uniforms };
}

/** One ribbon: a quadratic Bézier through open air plus its animation parameters. */
export interface WindRibbonSpec {
  p0: readonly [number, number, number];
  p1: readonly [number, number, number];
  p2: readonly [number, number, number];
  /** Half width of the strip (world units) at full gust. */
  halfWidth: number;
  /** Undulation amplitude (world units). */
  amplitude: number;
  /** Undulation wavelength (world units). */
  wavelength: number;
  /** Speed at which the streak pattern streams along the ribbon (units/s). */
  flowSpeed: number;
  /** Gust period (s): the bright segment crosses the ribbon once per period. */
  period: number;
  /** Gust phase 0..1. */
  phase: number;
  opacity: number;
  seed: number;
  /** Adaptive-quality rank: drawn while rank < count. */
  rank: number;
}

/** Instanced ribbon strips; `segments` subdivisions along the length. */
export function createWindRibbonGeometry(
  ribbons: readonly WindRibbonSpec[],
  segments: number,
  bounds: THREE.Sphere,
): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  const segs = Math.max(2, Math.floor(segments));
  const positions = new Float32Array((segs + 1) * 2 * 3);
  for (let i = 0; i <= segs; i += 1) {
    const s = i / segs;
    positions.set([s, -1, 0, s, 1, 0], i * 6);
  }
  const index: number[] = [];
  for (let i = 0; i < segs; i += 1) {
    const a = i * 2;
    index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(index);

  const count = ribbons.length;
  const aP0 = new Float32Array(count * 4);
  const aP1 = new Float32Array(count * 4);
  const aP2 = new Float32Array(count * 4);
  const aFlow = new Float32Array(count * 4);
  const aMeta = new Float32Array(count * 2);
  ribbons.forEach((r, i) => {
    aP0.set([r.p0[0], r.p0[1], r.p0[2], r.halfWidth], i * 4);
    aP1.set([r.p1[0], r.p1[1], r.p1[2], r.amplitude], i * 4);
    aP2.set([r.p2[0], r.p2[1], r.p2[2], (Math.PI * 2) / Math.max(0.5, r.wavelength)], i * 4);
    aFlow.set([r.flowSpeed, Math.max(0.25, r.period), r.phase, r.seed], i * 4);
    aMeta.set([r.opacity, r.rank], i * 2);
  });
  geometry.setAttribute('aP0', new THREE.InstancedBufferAttribute(aP0, 4));
  geometry.setAttribute('aP1', new THREE.InstancedBufferAttribute(aP1, 4));
  geometry.setAttribute('aP2', new THREE.InstancedBufferAttribute(aP2, 4));
  geometry.setAttribute('aFlow', new THREE.InstancedBufferAttribute(aFlow, 4));
  geometry.setAttribute('aMeta', new THREE.InstancedBufferAttribute(aMeta, 2));
  geometry.instanceCount = count;
  geometry.boundingSphere = bounds.clone();
  geometry.boundingBox = new THREE.Box3().setFromCenterAndSize(bounds.center, new THREE.Vector3().setScalar(bounds.radius * 2));
  return geometry;
}

/**
 * CPU mirror of the vertex shader's centreline displacement bound: the
 * farthest any point of a ribbon strays from its Bézier (amplitude envelope
 * plus the vertical wave), used to keep ribbons clear of rock.
 */
export function windRibbonMaxExcursion(spec: WindRibbonSpec): number {
  return spec.amplitude * Math.hypot(1, 0.85) + spec.halfWidth;
}
