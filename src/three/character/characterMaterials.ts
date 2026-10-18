import * as THREE from 'three';
import { HEAD_PIVOT } from './characterGeometry';
import { HAIR_BASE_COLOR } from '../shaders/SilkyHairShader';

/* ==========================================================================
 * Character materials — physically based garments and skin, detailed in the
 * shader from the REST-pose position attribute (`aRest`), so every seam,
 * panel and painted feature sticks to the cloth while the skeleton bends it.
 *
 *   jacket    charcoal technical shell: twill micro-relief (triplanar data
 *             texture), reinforced shoulder yoke, princess & side seams with
 *             stitching, centre-front zip with storm flap and pull, chest
 *             pocket zip, hem and cuff bands, elbow articulation panels, a
 *             small unbranded shoulder patch, compression folds; gust flutter
 *             of the hem, sleeves and collar in the vertex stage;
 *   trousers  dark stretch twill: articulated knee panels with darts, side
 *             seams, inseams, seat yoke, thigh pocket zip, hem band;
 *   boots     leather upper, rubber rand and lugged sole, laces and eyelets,
 *             padded collar, heel pull tab;
 *   skin      SKIN_TONE with a wrapped sub-surface term in the direct
 *             diffuse, scalp painted to the hair colour under the cards,
 *             brows, lips, painted eyes, faint stubble, palm / knuckle tint.
 *
 * Every material multiplies its indirect light by the baked `aOcclusion` and
 * uses a scale-correct derivative bump (no tangents or UVs needed). All are
 * tone mapped normally (no `toneMapped: false`), so sceneFx.exposure reaches
 * them through the renderer / composer like the rest of the world.
 * ========================================================================== */

/** Skin tone of the protagonist (sRGB hex). Change this one constant to restyle the character. */
export const SKIN_TONE = '#9e7763';

export const JACKET_COLOR = '#3a3d43';
export const TROUSERS_COLOR = '#2a2d33';
export const BOOT_COLOR = '#4a4039';

export interface CharacterSharedUniforms {
  [uniform: string]: THREE.IUniform;
  uTime: THREE.IUniform<number>;
  /** Cloth flutter strength (0 calm → 1 gust). */
  uFlutter: THREE.IUniform<number>;
  /** Wind direction in the character's Root space (unit). */
  uWindLocal: THREE.IUniform<THREE.Vector3>;
  uWeave: THREE.IUniform<THREE.Texture>;
}

export interface CharacterMaterialSet {
  jacket: THREE.MeshPhysicalMaterial;
  trousers: THREE.MeshPhysicalMaterial;
  boots: THREE.MeshPhysicalMaterial;
  skin: THREE.MeshPhysicalMaterial;
  uniforms: CharacterSharedUniforms;
  dispose: () => void;
}

/* ---------------------------------------------------------------------------
 * Procedural weave texture (data texture: works without a DOM).
 * R = 2/1 twill relief, G = ripstop grid, B = fibre noise.
 * ------------------------------------------------------------------------- */

export function createWeaveTexture(size = 128): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const threadPx = 8;
  let s = 0x2f6b1d3;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const tx = Math.floor(x / threadPx);
      const ty = Math.floor(y / threadPx);
      const fx = ((x % threadPx) + 0.5) / threadPx;
      const fy = ((y % threadPx) + 0.5) / threadPx;
      const warpOver = (tx + ty) % 3 !== 0;
      const h = warpOver ? 0.5 + 0.5 * Math.sin(Math.PI * fx) * (0.75 + 0.25 * Math.sin(Math.PI * fy)) : 0.5 + 0.5 * Math.sin(Math.PI * fy) * (0.75 + 0.25 * Math.sin(Math.PI * fx));
      const gx = Math.min(x % 32, 32 - (x % 32));
      const gy = Math.min(y % 32, 32 - (y % 32));
      const grid = Math.max(Math.exp(-gx * gx * 0.5), Math.exp(-gy * gy * 0.5));
      const i = (y * size + x) * 4;
      data[i] = Math.round(Math.min(1, Math.max(0, h)) * 255);
      data[i + 1] = Math.round((0.35 + 0.65 * grid) * 255);
      data[i + 2] = Math.round(rnd() * 255);
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/* ---------------------------------------------------------------------------
 * Shared GLSL
 * ------------------------------------------------------------------------- */

const VERTEX_DECLS = /* glsl */ `
attribute vec3 aRest;
attribute vec3 aRestNormal;
attribute float aOcclusion;
attribute vec2 aMask;
varying vec3 vRest;
varying vec3 vRestNormal;
varying float vOcclusion;
varying vec2 vMask;
uniform float uTime;
uniform float uFlutter;
uniform vec3 uWindLocal;
`;

const VERTEX_ATTRS = /* glsl */ `
vRest = aRest;
vRestNormal = aRestNormal;
vOcclusion = aOcclusion;
vMask = aMask;
`;

/**
 * Extra normal offset (metres) for the character's shadow lookups: the world's sun shadow map spans tens of
 * metres, so its texels are coarser than facial features and fingers; without this the character would wear
 * blotchy self-shadow acne. Terrain / gear shadows still land on the body.
 */
export const CHARACTER_SHADOW_OFFSET = 0.028;

const VERTEX_SHADOW = /* glsl */ `
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
    vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * ( worldPosition + vec4( shadowWorldNormal * ( directionalLightShadows[ i ].shadowNormalBias + ${CHARACTER_SHADOW_OFFSET.toFixed(4)} ), 0.0 ) );
  }
  #pragma unroll_loop_end
#endif
`;

/** Gust flutter of the loose parts of the jacket (hem skirt, lower sleeves, collar top). */
const VERTEX_FLUTTER = /* glsl */ `
#ifdef CHAR_FLUTTER
{
  float skirt = 1.0 - smoothstep( 0.9, 1.08, aRest.y );
  float sleeve = aMask.x * ( 1.0 - smoothstep( 0.88, 1.15, aRest.y ) ) * 0.7;
  float collarTop = smoothstep( 1.5, 1.56, aRest.y ) * 0.45;
  float loose = max( max( skirt, sleeve ), collarTop );
  float ph = dot( aRest, vec3( 23.0, 41.0, 17.0 ) );
  float wave = 0.55 + 0.45 * sin( uTime * 9.0 + ph ) * sin( uTime * 3.7 + ph * 0.5 );
  transformed += uWindLocal * ( uFlutter * loose * wave * 0.014 );
}
#endif
`;

const FRAGMENT_COMMON = /* glsl */ `
varying vec3 vRest;
varying vec3 vRestNormal;
varying float vOcclusion;
varying vec2 vMask;
uniform float uTime;
uniform sampler2D uWeave;
uniform float uAOStrength;

float charSat( float x ) { return clamp( x, 0.0, 1.0 ); }

// Anti-aliased line of half-width hw around d = 0; fades with its pixel coverage when sub-pixel.
float charLine( float d, float hw ) {
  float fw = max( fwidth( d ), 1e-6 );
  float c = 1.0 - smoothstep( hw - fw, hw + fw, abs( d ) );
  return c * min( 1.0, hw / fw );
}

// Filtered step: 0 for d < 0, 1 for d > 0.
float charStep( float d ) {
  float fw = max( fwidth( d ), 1e-6 );
  return smoothstep( -fw, fw, d );
}

// Dashed stitch line offset from a seam (d = signed distance to the seam, along = coordinate along it).
float charStitch( float d, float along, float offset ) {
  float line = charLine( abs( d ) - offset, 0.00042 );
  float a = along / 0.0042;
  float fa = max( fwidth( a ), 1e-6 );
  float f = fract( a );
  float dash = smoothstep( 0.2 - fa, 0.2 + fa, f ) * ( 1.0 - smoothstep( 0.72 - fa, 0.72 + fa, f ) );
  dash = mix( dash, 0.52, smoothstep( 0.35, 0.9, fa ) );
  return line * dash;
}

vec4 charWeave( vec3 p, vec3 n, float scale ) {
  vec3 w = pow( abs( n ), vec3( 4.0 ) );
  w /= ( w.x + w.y + w.z + 1e-5 );
  vec4 a = texture2D( uWeave, p.zy * scale );
  vec4 b = texture2D( uWeave, p.xz * scale );
  vec4 c = texture2D( uWeave, p.xy * scale );
  return a * w.x + b * w.y + c * w.z;
}

// Scale-correct derivative bump (Mikkelsen): height in metres, positions in view space.
vec3 charPerturbNormal( vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir ) {
  vec3 sigmaX = dFdx( surfPos );
  vec3 sigmaY = dFdy( surfPos );
  vec3 r1 = cross( sigmaY, surfNorm );
  vec3 r2 = cross( surfNorm, sigmaX );
  float det = dot( sigmaX, r1 ) * faceDir;
  vec3 grad = sign( det ) * ( dHdxy.x * r1 + dHdxy.y * r2 );
  return normalize( abs( det ) * surfNorm - grad );
}

float charHash( vec2 p ) {
  return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
}
`;

/* ---------------------------------------------------------------------------
 * Garment detail functions: void charDetail( inout vec3 albedo, inout float rough,
 *   inout float height, inout float spec, inout float sheen ) — all in rest space (metres).
 * ------------------------------------------------------------------------- */

const JACKET_DETAIL = /* glsl */ `
uniform vec3 uYokeTint;
uniform vec3 uZipColor;
uniform vec3 uStitchColor;
uniform vec3 uPatchColor;

float jacketHemY( vec3 p ) {
  float back = 1.0 - smoothstep( -0.1, 0.03, p.z );
  float side = smoothstep( 0.08, 0.17, abs( p.x ) );
  return 0.902 - 0.022 * back + 0.01 * side * ( 1.0 - back );
}

void charDetail( inout vec3 albedo, inout float rough, inout float height, inout float spec, inout float sheen ) {
  vec3 p = vRest;
  vec3 n = normalize( vRestNormal );
  float ax = abs( p.x );
  float arm = charSat( vMask.x );
  float torso = 1.0 - arm;
  float stitch = 0.0;
  float seam = 0.0;

  // Fabric micro-relief, ripstop and mottling.
  vec4 wv = charWeave( p, n, 82.0 );
  height += ( wv.r - 0.5 ) * 0.00026 + ( wv.g - 0.5 ) * 0.00016;
  albedo *= 0.95 + 0.1 * wv.b;
  rough += ( wv.r - 0.5 ) * 0.05;
  float mottle = charHash( floor( p.xy * 90.0 ) + floor( p.z * 90.0 ) );
  albedo *= 0.985 + 0.03 * mottle;

  // Compression folds: lower back / waist sides and the inner elbow.
  float waistFold = ( 1.0 - smoothstep( 0.025, 0.085, abs( p.y - 1.07 ) ) ) * torso * ( 1.0 - smoothstep( 0.02, 0.09, p.z ) );
  height += sin( p.y * 150.0 + sin( p.x * 23.0 ) * 2.2 ) * 0.0007 * waistFold;
  float elbowFold = arm * ( 1.0 - smoothstep( 0.0, 0.055, abs( p.y - 1.12 ) ) ) * smoothstep( -0.04, -0.01, p.z );
  height += sin( p.y * 230.0 + p.x * 40.0 ) * 0.0008 * elbowFold;
  float pitFold = arm * ( 1.0 - smoothstep( 0.0, 0.06, abs( p.y - 1.33 ) ) ) * ( 1.0 - smoothstep( 0.18, 0.21, ax ) );
  height += sin( p.y * 190.0 + p.z * 60.0 ) * 0.0006 * pitFold;

  // Reinforced shoulder yoke (raglan line), continuing over the sleeve cap.
  float yokeD = p.y - ( 1.405 - 0.52 * max( ax - 0.06, 0.0 ) );
  float yoke = charStep( yokeD );
  albedo = mix( albedo, albedo * uYokeTint, yoke );
  rough = mix( rough, rough - 0.14, yoke );
  seam += charLine( yokeD, 0.0009 );
  stitch += charStitch( yokeD, p.x + p.z, 0.0028 );

  // Centre-front zip with storm flap and pull.
  float front = smoothstep( 0.03, 0.07, p.z ) * torso;
  float zip = charLine( p.x, 0.0042 ) * front * ( 1.0 - charStep( p.y - 1.556 ) );
  float teeth = charLine( fract( p.y / 0.0031 ) - 0.5, 0.22 );
  albedo = mix( albedo, uZipColor * ( 0.75 + 0.5 * teeth ), zip );
  rough = mix( rough, 0.38, zip );
  height += zip * ( 0.0011 + teeth * 0.0003 );
  float flap = charLine( ax - 0.0105, 0.0006 ) * front;
  seam += flap;
  stitch += charStitch( ax - 0.0105, p.y, 0.0026 ) * front;
  float pull = ( 1.0 - charStep( abs( p.x - 0.0015 ) - 0.0035 ) ) * charStep( p.y - 1.49 ) * ( 1.0 - charStep( p.y - 1.522 ) ) * front;
  albedo = mix( albedo, vec3( 0.32, 0.33, 0.35 ), pull );
  rough = mix( rough, 0.3, pull );
  height += pull * 0.0016;

  // Chest pocket zip (left chest).
  vec2 pa = vec2( 0.042, 1.372 );
  vec2 pb = vec2( 0.112, 1.282 );
  vec2 pq = p.xy - pa;
  vec2 pd = pb - pa;
  float ph = charSat( dot( pq, pd ) / dot( pd, pd ) );
  float pocketD = length( pq - pd * ph );
  float pocketMask = smoothstep( 0.05, 0.08, p.z ) * torso * step( 0.0, p.x );
  float pocket = charLine( pocketD, 0.0024 ) * pocketMask;
  albedo = mix( albedo, uZipColor, pocket * 0.9 );
  height += pocket * 0.0006;
  stitch += charStitch( pocketD, ph * 0.12, 0.0042 ) * pocketMask * step( ph, 0.999 ) * step( 0.001, ph );

  // Princess seams (front and back) and side seams.
  float below = 1.0 - charStep( yokeD );
  float princess = ax - ( 0.084 - 0.045 * ( 1.33 - p.y ) );
  float pr = charLine( princess, 0.0008 ) * torso * below * ( 1.0 - smoothstep( 0.115, 0.13, ax ) );
  seam += pr;
  stitch += charStitch( princess, p.y, 0.0026 ) * torso * below * ( 1.0 - smoothstep( 0.115, 0.13, ax ) );
  float sideD = p.z + 0.012;
  float side = charLine( sideD, 0.0008 ) * torso * smoothstep( 0.1, 0.13, ax ) * below;
  seam += side;
  float sidePanel = torso * smoothstep( 0.11, 0.14, ax ) * ( 1.0 - smoothstep( 0.01, 0.03, abs( sideD ) ) ) * below;
  albedo *= 1.0 - 0.06 * sidePanel;

  // Hem band.
  float hemD = p.y - ( jacketHemY( p ) + 0.03 );
  float hemBand = ( 1.0 - charStep( hemD ) ) * torso;
  albedo *= 1.0 - 0.07 * hemBand;
  seam += charLine( hemD, 0.0008 ) * torso;
  stitch += charStitch( hemD, p.x + p.z, 0.003 ) * torso;
  height -= hemBand * 0.0004;

  // Cuff band with a tab on the outer side.
  float cuffD = p.y - 0.92;
  float cuff = ( 1.0 - charStep( cuffD ) ) * arm;
  albedo *= 1.0 - 0.09 * cuff;
  rough -= 0.05 * cuff;
  seam += charLine( cuffD, 0.0008 ) * arm;
  stitch += charStitch( cuffD, p.x + p.z, 0.0028 ) * arm;
  float tab = cuff * charStep( ax - 0.236 ) * charStep( p.y - 0.884 ) * ( 1.0 - charStep( abs( p.z + 0.008 ) - 0.016 ) );
  albedo *= 1.0 - 0.12 * tab;
  height += tab * 0.0012;

  // Elbow articulation panel (back of the sleeve).
  float elbowY = abs( p.y - 1.118 ) - 0.058;
  float elbowZ = -( p.z + 0.04 );
  float elbow = arm * ( 1.0 - charStep( elbowY ) ) * charStep( elbowZ );
  albedo = mix( albedo, albedo * uYokeTint, elbow * 0.8 );
  rough -= elbow * 0.08;
  seam += arm * charStep( elbowZ ) * charLine( elbowY, 0.0008 );
  stitch += arm * charStep( elbowZ ) * charStitch( elbowY, p.x + p.z, 0.0028 );

  // Small unbranded patch on the left shoulder (stitched border, a faint chevron).
  vec2 pc = vec2( p.z + 0.028, p.y - 1.245 );
  float lateral = smoothstep( 0.5, 0.75, n.x ) * arm * step( 0.0, p.x );
  vec2 pe = abs( pc ) - vec2( 0.022, 0.016 );
  float patchD = max( pe.x, pe.y );
  float patchM = ( 1.0 - charStep( patchD ) ) * lateral;
  float chevron = charLine( abs( pc.y + 0.004 - ( 0.009 - abs( pc.x ) * 0.55 ) ), 0.0012 ) * ( 1.0 - charStep( abs( pc.x ) - 0.012 ) );
  albedo = mix( albedo, uPatchColor * ( 1.0 + 0.9 * chevron ), patchM );
  rough = mix( rough, 0.62, patchM );
  height += patchM * 0.0007;
  stitch += charStitch( patchD + 0.0025, pc.x + pc.y, 0.0 ) * lateral;

  // Collar binding.
  float collarTop = 1.555 - 0.022 * smoothstep( -0.02, 0.07, p.z );
  float collarBand = charStep( p.y - ( collarTop - 0.007 ) ) * torso * step( 1.45, p.y );
  albedo *= 1.0 - 0.1 * collarBand;

  seam = charSat( seam );
  stitch = charSat( stitch );
  albedo *= 1.0 - 0.38 * seam;
  height -= seam * 0.0011;
  height += stitch * 0.0002;
  albedo = mix( albedo, uStitchColor, stitch * 0.55 );
  rough = clamp( rough, 0.2, 1.0 );
  spec = 1.0 - 0.3 * seam;
  sheen = 1.0 - 0.8 * max( zip, patchM );
}
`;

const TROUSERS_DETAIL = /* glsl */ `
uniform vec3 uPanelTint;
uniform vec3 uStitchColor;
uniform vec3 uZipColor;

void charDetail( inout vec3 albedo, inout float rough, inout float height, inout float spec, inout float sheen ) {
  vec3 p = vRest;
  vec3 n = normalize( vRestNormal );
  float ax = abs( p.x );
  float leg = charSat( vMask.x );
  float stitch = 0.0;
  float seam = 0.0;

  vec4 wv = charWeave( p, n, 105.0 );
  height += ( wv.r - 0.5 ) * 0.0002;
  albedo *= 0.95 + 0.1 * wv.b;
  rough += ( wv.r - 0.5 ) * 0.05;

  // Articulated knee panels with darts.
  vec2 kq = vec2( ( ax - 0.093 ) / 0.058, ( p.y - 0.5 ) / 0.088 );
  float kd = ( length( kq ) - 1.0 ) * 0.07;
  float kneeFront = smoothstep( 0.0, 0.03, p.z );
  float knee = ( 1.0 - charStep( kd ) ) * kneeFront * leg;
  albedo = mix( albedo, albedo * uPanelTint, knee );
  rough = mix( rough, rough + 0.06, knee );
  seam += charLine( kd, 0.0008 ) * kneeFront * leg;
  stitch += charStitch( kd, atan( kq.y, kq.x ) * 0.06, 0.0028 ) * kneeFront * leg;
  float darts = ( charLine( p.y - 0.535, 0.0007 ) + charLine( p.y - 0.462, 0.0007 ) ) * knee * ( 1.0 - smoothstep( 0.6, 0.95, abs( kq.x ) ) );
  seam += darts;
  height += sin( ( p.y - 0.5 ) * 260.0 ) * 0.0005 * smoothstep( 0.04, 0.0, abs( p.y - 0.5 ) - 0.03 ) * ( 1.0 - kneeFront ) * leg;

  // Side seams and inseams.
  float lateral = smoothstep( 0.135, 0.15, ax ) * leg;
  seam += charLine( p.z - 0.004, 0.0008 ) * lateral;
  stitch += charStitch( p.z - 0.004, p.y, 0.0026 ) * lateral;
  float medial = ( 1.0 - smoothstep( 0.04, 0.055, ax ) ) * leg * step( p.y, 0.86 );
  seam += charLine( p.z + 0.002, 0.0008 ) * medial;

  // Seat yoke (back).
  float back = 1.0 - smoothstep( -0.07, -0.04, p.z );
  float seatD = p.y - ( 0.945 - 0.06 * ax );
  seam += charLine( seatD, 0.0008 ) * back;
  stitch += charStitch( seatD, p.x, 0.0028 ) * back;

  // Thigh pocket zip (right thigh, lateral front).
  vec2 za = vec2( 0.065, 0.80 );
  vec2 zb = vec2( 0.085, 0.67 );
  vec2 zq = vec2( p.z, p.y ) - za;
  vec2 zd = zb - za;
  float zh = charSat( dot( zq, zd ) / dot( zd, zd ) );
  float zipD = length( zq - zd * zh );
  float zipMask = step( p.x, 0.0 ) * smoothstep( 0.11, 0.13, ax ) * smoothstep( -0.1, 0.3, n.z ) * smoothstep( 0.2, 0.5, -n.x ) * leg;
  float zip = charLine( zipD, 0.0022 ) * zipMask;
  albedo = mix( albedo, uZipColor, zip * 0.9 );
  height += zip * 0.0005;

  // Hem band.
  float hemD = p.y - 0.166;
  float hem = ( 1.0 - charStep( hemD ) ) * leg;
  albedo *= 1.0 - 0.08 * hem;
  seam += charLine( hemD, 0.0008 ) * leg;
  stitch += charStitch( hemD, p.x + p.z, 0.0028 ) * leg;

  seam = charSat( seam );
  stitch = charSat( stitch );
  albedo *= 1.0 - 0.36 * seam;
  height -= seam * 0.001;
  height += stitch * 0.0002;
  albedo = mix( albedo, uStitchColor, stitch * 0.45 );
  rough = clamp( rough, 0.25, 1.0 );
  spec = 1.0 - 0.3 * seam;
}
`;

const BOOTS_DETAIL = /* glsl */ `
uniform vec3 uRubberColor;
uniform vec3 uLaceColor;
uniform vec3 uCollarColor;
uniform vec3 uStitchColor;

void charDetail( inout vec3 albedo, inout float rough, inout float height, inout float spec, inout float sheen ) {
  vec3 p = vRest;
  vec3 n = normalize( vRestNormal );
  float bx = abs( p.x ) - 0.091;
  float spring = max( 0.0, p.z - 0.12 ) * 0.28;
  float stitch = 0.0;
  float seam = 0.0;

  // Leather grain.
  vec4 wv = charWeave( p * 0.6, n, 60.0 );
  height += ( wv.b - 0.5 ) * 0.00025;
  albedo *= 0.92 + 0.16 * wv.b;

  // Sole and midsole.
  float soleTop = 0.03 + spring * 0.6;
  float sole = 1.0 - charStep( p.y - soleTop );
  float midsole = sole * charStep( p.y - ( soleTop - 0.012 ) );
  // Rubber rand around the toe and heel.
  float randTop = 0.052 + spring * 0.5;
  float rand = ( 1.0 - charStep( p.y - randTop ) ) * max( charStep( p.z - 0.13 ), 1.0 - charStep( p.z + 0.045 ) );
  float rubber = max( sole, rand );
  albedo = mix( albedo, uRubberColor, rubber );
  albedo = mix( albedo, uRubberColor * 1.9, midsole * 0.85 );
  rough = mix( rough, 0.86, rubber );
  float lugs = step( 0.0, -n.y - 0.5 ) * ( charLine( fract( p.z / 0.012 ) - 0.5, 0.18 ) + charLine( fract( bx / 0.016 + 0.25 ) - 0.5, 0.15 ) );
  height -= lugs * 0.0018;
  height += charLine( fract( p.y / 0.006 ) - 0.5, 0.12 ) * sole * ( 1.0 - midsole ) * 0.0003;
  seam += charLine( p.y - randTop, 0.0007 ) * ( 1.0 - sole );

  // Upper panels: forefoot seam and heel counter.
  float vamp = p.y - ( 0.062 + spring * 0.4 + 0.012 * smoothstep( 0.05, 0.13, p.z ) );
  float upper = 1.0 - rubber;
  seam += charLine( vamp, 0.0007 ) * upper * step( 0.03, p.z );
  stitch += charStitch( vamp, p.z + bx, 0.0024 ) * upper * step( 0.03, p.z );
  float heelD = -( p.z + 0.02 ) - 0.02 * smoothstep( 0.03, 0.13, p.y );
  seam += charLine( heelD, 0.0007 ) * upper;

  // Laces and eyelets on the tongue.
  float lacing = ( 1.0 - smoothstep( 0.014, 0.018, abs( bx ) ) ) * smoothstep( 0.06, 0.075, p.y ) * ( 1.0 - smoothstep( 0.148, 0.155, p.y ) ) * smoothstep( 0.1, 0.4, n.z + n.y * 0.5 );
  float cross1 = charLine( fract( ( p.y + bx * 0.9 ) / 0.016 ) - 0.5, 0.11 );
  float cross2 = charLine( fract( ( p.y - bx * 0.9 ) / 0.016 ) - 0.5, 0.11 );
  float laces = max( cross1, cross2 ) * lacing;
  albedo = mix( albedo, uLaceColor, laces );
  height += laces * 0.0012;
  float eyelet = charLine( length( vec2( abs( bx ) - 0.017, fract( ( p.y - 0.07 ) / 0.017 ) * 0.017 - 0.0085 ) ) - 0.0028, 0.0009 ) * smoothstep( 0.065, 0.07, p.y ) * ( 1.0 - smoothstep( 0.15, 0.155, p.y ) ) * smoothstep( 0.1, 0.3, n.z );
  albedo = mix( albedo, vec3( 0.42, 0.42, 0.43 ), eyelet );
  rough = mix( rough, 0.32, eyelet );

  // Padded collar and heel pull tab.
  float collar = charStep( p.y - 0.142 );
  albedo = mix( albedo, uCollarColor, collar );
  rough = mix( rough, 0.82, collar );
  seam += charLine( p.y - 0.142, 0.0007 );
  float tab = ( 1.0 - charStep( abs( bx ) - 0.007 ) ) * charStep( p.y - 0.128 ) * ( 1.0 - charStep( p.z + 0.04 ) );
  albedo = mix( albedo, uLaceColor, tab );

  seam = charSat( seam );
  stitch = charSat( stitch );
  albedo *= 1.0 - 0.35 * seam;
  height -= seam * 0.0008;
  albedo = mix( albedo, uStitchColor, stitch * 0.5 );
  spec = 1.0;
}
`;

const SKIN_DETAIL = /* glsl */ `
uniform vec3 uScalpColor;
uniform vec3 uBrowColor;
uniform vec3 uHeadPivot;

void charDetail( inout vec3 albedo, inout float rough, inout float height, inout float spec, inout float sheen ) {
  vec3 p = vRest;
  vec3 n = normalize( vRestNormal );
  vec3 h = p - uHeadPivot;
  float head = smoothstep( 1.33, 1.4, p.y );
  float ahx = abs( h.x );
  // Pixel footprint (m): small painted features fade out once they are sub-pixel instead of smearing.
  float footprint = length( fwidth( p ) );
  float fine = 1.0 - smoothstep( 0.0025, 0.007, footprint );
  float medium = 1.0 - smoothstep( 0.005, 0.014, footprint );

  // Pores / micro-relief (fades out with distance through the derivative filter).
  float pore = charHash( floor( p.xy * 1400.0 ) + floor( p.z * 1400.0 ) );
  height += ( pore - 0.5 ) * 0.00006;

  // Warmth: nose tip, cheeks, ears; slightly cooler under the eyes.
  float noseTip = 1.0 - smoothstep( 0.0, 0.016, length( h - vec3( 0.0, -0.016, 0.112 ) ) );
  float cheeks = 1.0 - smoothstep( 0.0, 0.03, length( vec3( ahx - 0.045, h.y + 0.012, h.z - 0.065 ) ) );
  float ears = 1.0 - smoothstep( 0.0, 0.03, length( vec3( ahx - 0.078, h.y - 0.012, h.z + 0.016 ) ) );
  vec3 flush = vec3( 1.04, 0.95, 0.93 );
  albedo *= mix( vec3( 1.0 ), flush, head * charSat( noseTip * 0.6 + cheeks * 0.35 + ears * 0.45 ) );

  // Lips.
  float lipD = length( vec2( h.x * 0.92, ( h.y + 0.046 ) * 2.1 ) ) - 0.0205;
  float lips = ( 1.0 - charStep( lipD ) ) * smoothstep( 0.078, 0.084, h.z ) * head * medium;
  albedo = mix( albedo, albedo * vec3( 0.84, 0.66, 0.64 ), lips * 0.85 );
  rough = mix( rough, 0.36, lips );
  float mouthLine = charLine( h.y + 0.0466, 0.0007 ) * ( 1.0 - smoothstep( 0.016, 0.021, ahx ) ) * smoothstep( 0.081, 0.086, h.z ) * head * fine;
  albedo *= 1.0 - 0.55 * mouthLine;

  // Brows.
  float bxp = ahx;
  float browY = 0.0385 + 0.0045 * sin( charSat( ( bxp - 0.012 ) / 0.044 ) * 3.14159 ) - 0.002;
  float browW = mix( 0.0042, 0.0022, smoothstep( 0.02, 0.055, bxp ) );
  float brow = ( 1.0 - smoothstep( browW * 0.55, browW, abs( h.y - browY ) ) ) * smoothstep( 0.011, 0.017, bxp ) * ( 1.0 - smoothstep( 0.049, 0.057, bxp ) ) * smoothstep( 0.066, 0.076, h.z ) * head * medium;
  float browHair = 0.75 + 0.25 * charLine( fract( ( bxp * 900.0 + h.y * 300.0 ) ) - 0.5, 0.25 );
  albedo = mix( albedo, uBrowColor, brow * 0.7 * browHair );
  rough = mix( rough, 0.6, brow );

  // Eyes: an almond-shaped opening painted over the eyeball / lid geometry.
  vec2 eq = vec2( ahx - 0.032, h.y - 0.0168 );
  float ex = charSat( abs( eq.x + 0.0012 ) / 0.0128 );
  float almond = max( abs( eq.y + 0.0006 * ex ) - 0.0041 * ( 1.0 - ex * ex ), abs( eq.x + 0.0012 ) - 0.0128 );
  float eyeFront = smoothstep( 0.07, 0.076, h.z ) * head * fine;
  float opening = ( 1.0 - charStep( almond ) ) * eyeFront;
  float irisD = length( eq - vec2( 0.0005, -0.0004 ) );
  float iris = 1.0 - charStep( irisD - 0.0049 );
  float pupil = 1.0 - charStep( irisD - 0.0019 );
  vec3 eyeColor = mix( vec3( 0.15, 0.135, 0.12 ), vec3( 0.045, 0.027, 0.018 ), iris );
  eyeColor = mix( eyeColor, vec3( 0.006 ), pupil );
  albedo = mix( albedo, eyeColor, opening );
  rough = mix( rough, 0.32, opening );
  // Upper lash line and lid crease.
  float lash = charLine( almond, 0.0008 ) * step( -0.0004, eq.y ) * eyeFront;
  albedo *= 1.0 - 0.6 * lash;
  float crease = charLine( eq.y - 0.0072 + 0.002 * ex * ex, 0.0012 ) * ( 1.0 - ex ) * eyeFront;
  albedo *= 1.0 - 0.18 * crease;
  float onEye = max( opening, lash );

  // Faint stubble shadow along the jaw and upper lip.
  float stubble = charSat( vMask.y ) * head;
  albedo *= mix( vec3( 1.0 ), vec3( 0.8, 0.8, 0.84 ), stubble * 0.32 );

  // Scalp under the hair takes the hair colour.
  float scalp = charSat( vMask.x ) * head;
  albedo = mix( albedo, uScalpColor, scalp * scalp * ( 3.0 - 2.0 * scalp ) * 0.95 );
  rough = mix( rough, 0.7, scalp );

  // Hands: lighter palms, warmer knuckles.
  float hand = 1.0 - head;
  float palm = smoothstep( 0.2, 0.6, -n.x * sign( p.x ) ) * hand;
  albedo = mix( albedo, albedo * vec3( 1.1, 1.0, 0.97 ), palm );
  float knuckle = smoothstep( 0.3, 0.7, n.x * sign( p.x ) ) * hand * ( 1.0 - smoothstep( 0.0, 0.02, abs( p.y - 0.776 ) ) );
  albedo *= mix( vec3( 1.0 ), vec3( 1.04, 0.92, 0.9 ), knuckle );

  // Oilier T-zone.
  float tzone = head * ( 1.0 - smoothstep( 0.0, 0.03, ahx ) ) * smoothstep( 0.07, 0.09, h.z ) * ( 1.0 - scalp );
  rough -= 0.08 * tzone;
  rough = clamp( rough, 0.06, 1.0 );
  spec = 1.0;
  sheen = ( 1.0 - scalp ) * ( 1.0 - brow ) * ( 1.0 - onEye ) * ( 1.0 - lips * 0.5 );
}
`;

const SKIN_SSS_UNIFORMS = /* glsl */ `
uniform float uSkinWrap;
uniform vec3 uSkinScatter;
`;

/* ---------------------------------------------------------------------------
 * Patching
 * ------------------------------------------------------------------------- */

type GarmentKind = 'jacket' | 'trousers' | 'boots' | 'skin';

const DETAIL: Readonly<Record<GarmentKind, string>> = {
  jacket: JACKET_DETAIL,
  trousers: TROUSERS_DETAIL,
  boots: BOOTS_DETAIL,
  skin: SKIN_DETAIL,
};

const DIRECT_DIFFUSE_LINE = 'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );';
const DIRECT_DIFFUSE_SSS = /* glsl */ `
	float charWrapNL = dot( geometryNormal, directLight.direction );
	vec3 charScatter = directLight.color * max( 0.0, ( charWrapNL + uSkinWrap ) / ( 1.0 + uSkinWrap ) - max( charWrapNL, 0.0 ) ) * uSkinScatter;
	reflectedLight.directDiffuse += ( irradiance + charScatter ) * BRDF_Lambert( material.diffuseColor );`;

function patchMaterial(
  material: THREE.MeshPhysicalMaterial,
  kind: GarmentKind,
  shared: CharacterSharedUniforms,
  local: Record<string, THREE.IUniform>,
): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, local);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `${VERTEX_DECLS}\n#include <common>`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_ATTRS}`)
      .replace('#include <skinning_vertex>', `#include <skinning_vertex>\n${VERTEX_FLUTTER}`)
      .replace('#include <shadowmap_vertex>', `#include <shadowmap_vertex>\n${VERTEX_SHADOW}`);
    let fragment = shader.fragmentShader
      .replace('#include <common>', `${FRAGMENT_COMMON}\n${kind === 'skin' ? SKIN_SSS_UNIFORMS : ''}\n${DETAIL[kind]}\n#include <common>`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 cdAlbedo = diffuseColor.rgb;
        float cdRough = roughness;
        float cdHeight = 0.0;
        float cdSpec = 1.0;
        float cdSheen = 1.0;
        charDetail( cdAlbedo, cdRough, cdHeight, cdSpec, cdSheen );
        diffuseColor.rgb = cdAlbedo;`,
      )
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = cdRough;`)
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
        #ifdef USE_SHEEN
          material.sheenColor *= cdSheen;
        #endif`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        normal = charPerturbNormal( - vViewPosition, normal, vec2( dFdx( cdHeight ), dFdy( cdHeight ) ), faceDirection );`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        {
          float charAO = mix( 1.0, clamp( vOcclusion, 0.0, 1.0 ), uAOStrength );
          reflectedLight.indirectDiffuse *= charAO;
          reflectedLight.indirectSpecular *= mix( 1.0, charAO, 0.8 ) * cdSpec;
          reflectedLight.directDiffuse *= mix( 1.0, charAO, 0.35 );
          reflectedLight.directSpecular *= mix( 1.0, charAO, 0.5 ) * cdSpec;
        }`,
      );
    if (kind === 'skin') {
      const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
      if (chunk.includes(DIRECT_DIFFUSE_LINE)) {
        fragment = fragment.replace('#include <lights_physical_pars_fragment>', chunk.replace(DIRECT_DIFFUSE_LINE, DIRECT_DIFFUSE_SSS));
      }
    }
    shader.fragmentShader = fragment;
  };
  material.customProgramCacheKey = () => `protagonist-${kind}-v2`;
}

export interface CharacterMaterialOptions {
  skinTone?: THREE.ColorRepresentation;
}

/** Creates the four garment materials (one draw call each) sharing the time / wind / weave uniforms. */
export function createCharacterMaterials(options: CharacterMaterialOptions = {}): CharacterMaterialSet {
  const weave = createWeaveTexture();
  const uniforms: CharacterSharedUniforms = {
    uTime: { value: 0 },
    uFlutter: { value: 0 },
    uWindLocal: { value: new THREE.Vector3(0, 0, 1) },
    uWeave: { value: weave },
  };

  const jacket = new THREE.MeshPhysicalMaterial({
    name: 'Protagonist.jacket',
    color: JACKET_COLOR,
    roughness: 0.74,
    metalness: 0,
    sheen: 0.6,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color('#8d96a6'),
    specularIntensity: 0.6,
  });
  patchMaterial(jacket, 'jacket', uniforms, {
    uAOStrength: { value: 1 },
    uYokeTint: { value: new THREE.Color(0.74, 0.75, 0.78) },
    uZipColor: { value: new THREE.Color('#141518') },
    uStitchColor: { value: new THREE.Color('#5b6068') },
    uPatchColor: { value: new THREE.Color('#2a2c30') },
  });

  const trousers = new THREE.MeshPhysicalMaterial({
    name: 'Protagonist.trousers',
    color: TROUSERS_COLOR,
    roughness: 0.8,
    metalness: 0,
    sheen: 0.45,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color('#6c7380'),
    specularIntensity: 0.5,
  });
  patchMaterial(trousers, 'trousers', uniforms, {
    uAOStrength: { value: 1 },
    uPanelTint: { value: new THREE.Color(0.78, 0.79, 0.81) },
    uStitchColor: { value: new THREE.Color('#4c5058') },
    uZipColor: { value: new THREE.Color('#141518') },
  });

  const boots = new THREE.MeshPhysicalMaterial({
    name: 'Protagonist.boots',
    color: BOOT_COLOR,
    roughness: 0.66,
    metalness: 0,
    specularIntensity: 0.6,
  });
  patchMaterial(boots, 'boots', uniforms, {
    uAOStrength: { value: 1 },
    uRubberColor: { value: new THREE.Color('#151516') },
    uLaceColor: { value: new THREE.Color('#7b4a2e') },
    uCollarColor: { value: new THREE.Color('#2b2725') },
    uStitchColor: { value: new THREE.Color('#8a7d6e') },
  });

  const skin = new THREE.MeshPhysicalMaterial({
    name: 'Protagonist.skin',
    color: options.skinTone ?? SKIN_TONE,
    roughness: 0.52,
    metalness: 0,
    sheen: 0.18,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color('#f2d2c0'),
    specularIntensity: 0.5,
  });
  patchMaterial(skin, 'skin', uniforms, {
    uAOStrength: { value: 0.55 },
    uScalpColor: { value: new THREE.Color(HAIR_BASE_COLOR).multiplyScalar(1.15) },
    uBrowColor: { value: new THREE.Color('#15110e') },
    uHeadPivot: { value: new THREE.Vector3(HEAD_PIVOT[0], HEAD_PIVOT[1], HEAD_PIVOT[2]) },
    uSkinWrap: { value: 0.26 },
    uSkinScatter: { value: new THREE.Color(0.42, 0.22, 0.15) },
  });

  return {
    jacket,
    trousers,
    boots,
    skin,
    uniforms,
    dispose: () => {
      jacket.dispose();
      trousers.dispose();
      boots.dispose();
      skin.dispose();
      weave.dispose();
    },
  };
}
