import * as THREE from 'three';
import { PAPER_CREASES, PAPER_MARGIN_X, PAPER_RULES, PAPER_UNITS } from '../world/lensPaperNote';

/* ==========================================================================
 * Lens paper shaders.
 *
 * Vertex: a subdivided unit plane scaled to the sheet. It folds in quarters
 * (the way it sat in the pack) and unfolds, bends and flutters in flight,
 * squashes flat on the lens, lifts its corners in the wind while stuck and
 * peels off from the top-right corner around a moving cylinder. Normals come
 * from finite differences of the same deformation.
 *
 * Depth: the paper keeps real depth testing against itself (folds, curls and
 * the peel self-occlude correctly) while `uDepthSquash` compresses its depth
 * range into the first 0.2% of the buffer, so once it has left the pack it
 * always draws in front of the world and the cloud curtain.
 *
 * Fragment: procedural paper — fibre formation, tooth, printed rules and
 * margin, quarter-fold creases, edge grime, a spiral-torn top edge — lit by
 * the sun, the sky and light transmitted through the sheet from behind, with
 * ink from a canvas texture. toneMapped is false, so it multiplies by
 * `uExposure` (sceneFx.exposure) itself.
 * ========================================================================== */

/** Draws after the cloud curtain (900). */
export const LENS_PAPER_RENDER_ORDER = 1000;
export const LENS_HALO_RENDER_ORDER = 999;

const GLSL_CONSTANTS = /* glsl */ `
#define PI 3.14159265359
#define PAPER_W ${PAPER_UNITS.width.toFixed(1)}
#define PAPER_H ${PAPER_UNITS.height.toFixed(1)}
#define RULE_FIRST ${PAPER_RULES.first.toFixed(1)}
#define RULE_SPACING ${PAPER_RULES.spacing.toFixed(1)}
#define RULE_LAST ${(PAPER_RULES.count - 1).toFixed(1)}
#define MARGIN_X ${PAPER_MARGIN_X.toFixed(1)}
#define CREASE_X ${PAPER_CREASES.x.toFixed(1)}
#define CREASE_Y ${PAPER_CREASES.y.toFixed(1)}
`;

export const LENS_PAPER_VERTEX_SHADER = /* glsl */ `
${GLSL_CONSTANTS}
uniform vec2 uSize;
uniform vec2 uFold;
uniform vec2 uBend;
uniform vec4 uWave;
uniform vec2 uWaveDir;
uniform vec4 uCornerLift;
uniform float uEdgeRipple;
uniform vec4 uPeel;
uniform vec2 uImpact;
uniform float uTime;
uniform float uDepthSquash;

varying vec2 vUv;
varying vec3 vNormalV;
varying float vLift;

float cornerWeight(vec2 q, vec2 c) {
  float w = smoothstep(0.8, 0.0, length(q - c));
  return w * w;
}

vec3 deform(vec2 uv, out float lift) {
  vec2 p = (uv - 0.5) * uSize;
  vec2 q = (uv - 0.5) * 2.0;
  float h = uSize.y;

  // Folds. The vertical crease only closes while the horizontal one is
  // closed, exactly as the sheet was folded in quarters for the pack.
  vec3 pos = vec3(p, 0.0);
  float s1 = step(0.0, p.y);
  float a1 = uFold.x * s1;
  pos = vec3(pos.x, pos.y * cos(a1), pos.y * sin(a1));
  pos.z += s1 * smoothstep(0.0, 0.05 * h, p.y) * (uFold.x / PI) * 0.004 * h;
  float s2 = step(0.0, p.x);
  float a2 = uFold.y * s2;
  pos = vec3(pos.x * cos(a2) - pos.z * sin(a2), pos.y, pos.x * sin(a2) + pos.z * cos(a2));
  pos.z += s2 * smoothstep(0.0, 0.05 * uSize.x, p.x) * (uFold.y / PI) * 0.012 * h;

  // Air pressure bends the sheet: edges trail away from the direction of travel.
  float sag = uBend.x * q.x * q.x + uBend.y * q.y * q.y;

  // Flutter: a travelling wave that grows towards the trailing edge.
  float along = dot(q, uWaveDir);
  float wave = uWave.x * sin(along * uWave.y * PI - uTime * uWave.z + uWave.w)
             * (0.3 + 0.7 * smoothstep(-1.0, 1.0, along));

  // On the lens: corners lift off the glass in the wind, edges ripple, and the
  // slap sends one ring out from the centre.
  float corners = uCornerLift.x * cornerWeight(q, vec2(-1.0, 1.0))
                + uCornerLift.y * cornerWeight(q, vec2(1.0, 1.0))
                + uCornerLift.z * cornerWeight(q, vec2(1.0, -1.0))
                + uCornerLift.w * cornerWeight(q, vec2(-1.0, -1.0));
  float edge = smoothstep(0.8, 1.0, max(abs(q.x), abs(q.y)));
  float ripple = uEdgeRipple * edge * (0.55 + 0.45 * sin(11.0 * (q.x - q.y) - uTime * 8.0))
               * (0.6 + 0.4 * sin(uTime * 2.7 + q.x * 3.1 + q.y * 1.7));
  float r = length(q * vec2(uSize.x / uSize.y, 1.0));
  float ring = uImpact.x * max(0.0, sin(r * 6.5 - uImpact.y * 30.0)) * smoothstep(0.2, 0.85, r);
  lift = max(corners + ripple + ring, 0.0) * h;

  pos.z += (wave - sag) * h - lift;

  // Peel from the top-right corner: the flap wraps a cylinder of radius
  // uPeel.z at the peel front and leaves it at angle uPeel.y.
  if (uPeel.y > 0.0) {
    vec2 corner = 0.5 * uSize;
    vec2 dir = normalize(-uSize);
    float s = dot(p - corner, dir);
    float d = uPeel.x - s;
    if (d > 0.0) {
      float R = max(uPeel.z, 1e-4);
      float ang = uPeel.y + uPeel.w * sin(uTime * 6.5 + s * 9.0 / h) * smoothstep(0.0, 0.35 * h, d);
      float arc = R * ang;
      float ds;
      float dz;
      if (d < arc) {
        float a = d / R;
        ds = R * sin(a);
        dz = R * (1.0 - cos(a));
      } else {
        ds = R * sin(ang) + (d - arc) * cos(ang);
        dz = R * (1.0 - cos(ang)) + (d - arc) * sin(ang);
      }
      pos.xy += dir * ((uPeel.x - ds) - s);
      pos.z -= dz;
      lift += dz;
    }
  }
  return pos;
}

void main() {
  float lift;
  float unused;
  vec3 p0 = deform(uv, lift);
  vec3 px = deform(uv + vec2(1.0 / 96.0, 0.0), unused);
  vec3 py = deform(uv + vec2(0.0, 1.0 / 96.0), unused);
  vec3 n = normalize(cross(px - p0, py - p0));

  vUv = uv;
  vLift = lift / uSize.y;
  vNormalV = normalize(normalMatrix * n);

  vec4 clip = projectionMatrix * modelViewMatrix * vec4(p0, 1.0);
  float ndcZ = clamp(clip.z / clip.w, -1.0, 1.0);
  clip.z = mix(clip.z, (-1.0 + (ndcZ + 1.0) * 0.002) * clip.w, uDepthSquash);
  gl_Position = clip;
}
`;

export const LENS_PAPER_FRAGMENT_SHADER = /* glsl */ `
${GLSL_CONSTANTS}
uniform sampler2D tInk;
uniform float uInk;
uniform float uInkBack;
uniform vec3 uPaper;
uniform vec3 uGrime;
uniform vec3 uRule;
uniform vec3 uMargin;
uniform vec3 uSunView;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uSky;
uniform vec3 uGround;
uniform float uAmbient;
uniform vec3 uBackLight;
uniform float uTransmission;
uniform float uContact;
uniform float uSheen;
uniform float uOpacity;
uniform float uExposure;
uniform float uDetail;
uniform vec2 uResolution;

varying vec2 vUv;
varying vec3 vNormalV;
varying float vLift;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < FBM_OCTAVES; i++) {
    sum += amp * vnoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.3;
    amp *= 0.5;
  }
  return sum / (1.0 - pow(0.5, float(FBM_OCTAVES)));
}

// Thin, short strands: ridges of stretched noise in three orientations.
float fibres(vec2 p) {
  float f = 0.0;
  vec2 a = mat2(0.94, 0.34, -0.34, 0.94) * p;
  vec2 b = mat2(0.5, -0.87, 0.87, 0.5) * p + 31.7;
  vec2 c = mat2(-0.17, 0.98, -0.98, -0.17) * p + 63.1;
  f += pow(1.0 - abs(2.0 * vnoise(a * vec2(0.035, 0.42)) - 1.0), 14.0);
  f += pow(1.0 - abs(2.0 * vnoise(b * vec2(0.04, 0.5)) - 1.0), 14.0);
  f += pow(1.0 - abs(2.0 * vnoise(c * vec2(0.03, 0.38)) - 1.0), 14.0);
  return f;
}

void main() {
  vec2 pu = vec2(vUv.x * PAPER_W, (1.0 - vUv.y) * PAPER_H);
  bool front = gl_FrontFacing;
  vec2 pf = front ? pu : vec2(PAPER_W - pu.x, pu.y);
  float aa = max(max(fwidth(pu.x), fwidth(pu.y)), 1e-3);

  // ---- Silhouette: torn from a spiral pad along the top, softly worn corners.
  float tear = 11.0 + 3.4 * vnoise(vec2(pu.x * 0.11, 3.1)) + 1.7 * vnoise(vec2(pu.x * 0.53, 7.7));
  float alpha = smoothstep(tear - aa, tear + aa, pu.y);
  float hx = mod(pu.x - 24.0, 34.0) - 17.0;
  float hole = length(vec2(hx, pu.y - 12.5)) - 6.2;
  alpha *= smoothstep(-aa, aa, hole);
  vec2 halfSize = vec2(PAPER_W, PAPER_H) * 0.5;
  vec2 bd = abs(pu - halfSize) - (halfSize - 10.0);
  float box = length(max(bd, 0.0)) + min(max(bd.x, bd.y), 0.0) - 10.0;
  alpha *= 1.0 - smoothstep(-aa, aa, box);
  alpha *= uOpacity;
  if (alpha < 0.01) discard;

  // ---- Paper body.
  float detail = uDetail * (1.0 - smoothstep(1.4, 4.5, aa));
  float formation = fbm(pu * 0.017);
  float cloud = fbm(pu * 0.006 + 4.0);
  float tooth = vnoise(pu * 0.85) - 0.5;
  float strands = fibres(pu) * detail;
  vec3 albedo = uPaper * (0.975 + 0.045 * (formation - 0.5) + 0.025 * (cloud - 0.5) + detail * 0.022 * tooth);
  albedo *= 1.0 + 0.03 * strands - 0.014 * detail * fibres(pu * 1.7 + 9.0);

  // Handling grime and wear along the edges and the torn top.
  float edgeDist = min(-box, pu.y - tear);
  float grime = (1.0 - smoothstep(0.0, 34.0, edgeDist)) * (0.45 + 0.55 * fbm(pu * 0.045 + 2.0));
  albedo = mix(albedo, uGrime, 0.16 * grime);

  // Quarter-fold creases: worn fibres along the fold, light on one flank.
  float cx = pu.x - CREASE_X;
  float cy = pu.y - CREASE_Y;
  float creaseAA = max(1.4, aa);
  float lineV = exp(-abs(cx) / creaseAA);
  float lineH = exp(-abs(cy) / creaseAA);
  float wear = (lineV + lineH) * (0.5 + 0.5 * vnoise(pu * vec2(0.35, 0.35)));
  albedo *= 1.0 - 0.11 * wear;
  float relief = 0.05 * (sign(cx) * exp(-abs(cx) / 16.0) + sign(cy) * exp(-abs(cy) / 16.0)) * (front ? 1.0 : -1.0);

  // Printed rules and the margin (both sides of the sheet).
  float ry = pf.y - RULE_FIRST;
  float k = floor(ry / RULE_SPACING + 0.5);
  float ruleDist = abs(ry - k * RULE_SPACING);
  float ruleOn = step(-0.5, k) * step(k, RULE_LAST + 0.5);
  float lineWidth = 0.9;
  float fade = min(1.0, 1.6 / aa);
  float rule = ruleOn * (1.0 - smoothstep(lineWidth, lineWidth + aa, ruleDist)) * fade;
  rule *= 0.75 + 0.25 * vnoise(pf * vec2(0.09, 1.3));
  float margin = (1.0 - smoothstep(lineWidth, lineWidth + aa, abs(pf.x - MARGIN_X))) * fade * step(28.0, pf.y);
  albedo = mix(albedo, uRule, rule * 0.55);
  albedo = mix(albedo, uMargin, margin * 0.5);

  // Ink: the face carries the note; the back shows it faintly mirrored through the sheet.
  vec4 ink = texture2D(tInk, front ? vUv : vec2(1.0 - vUv.x, vUv.y));
  float inkTooth = 0.8 + 0.2 * vnoise(pu * 0.42) * (0.6 + 0.4 * detail);
  float inkA = ink.a * inkTooth * (front ? uInk : 0.12 * uInkBack);
  albedo = mix(albedo, ink.rgb, inkA * 0.95);

  // ---- Light.
  vec3 N = normalize(vNormalV) * (front ? 1.0 : -1.0);
  vec3 L = normalize(uSunView);
  float ndl = dot(N, L);
  vec3 hemi = mix(uGround, uSky, clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
  vec3 direct = uSunColor * uSunIntensity * max(ndl, 0.0);
  float thickness = 0.86 + 0.28 * formation + 0.08 * strands;
  vec3 through = (uSunColor * uSunIntensity * max(-ndl, 0.0) * 0.55 + uBackLight) * (uTransmission / thickness);
  // Pressed on the lens, the sheet glows a little more towards the bright sky above.
  through *= mix(1.0, 0.9 + 0.2 * vUv.y, uContact);
  vec3 col = albedo * (hemi * uAmbient + direct) + albedo * through * (1.0 - 0.9 * inkA);

  // Corners lifted off the glass tilt out of the light and fall into soft shade.
  col *= 1.0 - 0.45 * smoothstep(0.0, 0.09, vLift) * uContact;
  col *= 1.0 + relief;

  // The glass in front: a faint diagonal sheen across the pressed sheet.
  vec2 sp = gl_FragCoord.xy / uResolution;
  float band = exp(-pow((sp.x * 0.8 + sp.y - 1.05) * 5.5, 2.0));
  col += uSheen * band * vec3(0.9, 0.95, 1.0) * uContact;

  col *= uExposure;
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}
`;

export const LENS_HALO_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Soft light loss around a sheet pressed on the lens (and under its lifted corners). */
export const LENS_HALO_FRAGMENT_SHADER = /* glsl */ `
uniform vec2 uPaperSize;
uniform vec2 uHaloSize;
uniform float uSoftness;
uniform float uStrength;
uniform vec3 uColor;
uniform float uExposure;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * uHaloSize;
  vec2 halfSize = uPaperSize * 0.5;
  vec2 d = abs(p) - (halfSize - 0.02 * uPaperSize.y);
  float sdf = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - 0.02 * uPaperSize.y;
  float a = 1.0 - smoothstep(-0.2 * uSoftness, uSoftness, sdf);
  a = pow(a, 1.6) * uStrength;
  gl_FragColor = vec4(uColor * uExposure, a);
  #include <colorspace_fragment>
}
`;

export interface LensPaperUniforms {
  [uniform: string]: THREE.IUniform;
  tInk: THREE.IUniform<THREE.Texture | null>;
  uInk: THREE.IUniform<number>;
  uInkBack: THREE.IUniform<number>;
  uSize: THREE.IUniform<THREE.Vector2>;
  uFold: THREE.IUniform<THREE.Vector2>;
  uBend: THREE.IUniform<THREE.Vector2>;
  uWave: THREE.IUniform<THREE.Vector4>;
  uWaveDir: THREE.IUniform<THREE.Vector2>;
  uCornerLift: THREE.IUniform<THREE.Vector4>;
  uEdgeRipple: THREE.IUniform<number>;
  uPeel: THREE.IUniform<THREE.Vector4>;
  uImpact: THREE.IUniform<THREE.Vector2>;
  uTime: THREE.IUniform<number>;
  uDepthSquash: THREE.IUniform<number>;
  uPaper: THREE.IUniform<THREE.Color>;
  uGrime: THREE.IUniform<THREE.Color>;
  uRule: THREE.IUniform<THREE.Color>;
  uMargin: THREE.IUniform<THREE.Color>;
  uSunView: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSunIntensity: THREE.IUniform<number>;
  uSky: THREE.IUniform<THREE.Color>;
  uGround: THREE.IUniform<THREE.Color>;
  uAmbient: THREE.IUniform<number>;
  uBackLight: THREE.IUniform<THREE.Color>;
  uTransmission: THREE.IUniform<number>;
  uContact: THREE.IUniform<number>;
  uSheen: THREE.IUniform<number>;
  uOpacity: THREE.IUniform<number>;
  uExposure: THREE.IUniform<number>;
  uDetail: THREE.IUniform<number>;
  uResolution: THREE.IUniform<THREE.Vector2>;
}

export function createLensPaperUniforms(ink: THREE.Texture | null): LensPaperUniforms {
  return {
    tInk: { value: ink },
    uInk: { value: 1 },
    uInkBack: { value: 1 },
    uSize: { value: new THREE.Vector2(0.2, 0.27) },
    uFold: { value: new THREE.Vector2(0, 0) },
    uBend: { value: new THREE.Vector2(0, 0) },
    uWave: { value: new THREE.Vector4(0, 1.6, 9, 0) },
    uWaveDir: { value: new THREE.Vector2(0.6, 0.8) },
    uCornerLift: { value: new THREE.Vector4(0, 0, 0, 0) },
    uEdgeRipple: { value: 0 },
    uPeel: { value: new THREE.Vector4(0, 0, 0.02, 0) },
    uImpact: { value: new THREE.Vector2(0, 10) },
    uTime: { value: 0 },
    uDepthSquash: { value: 0 },
    uPaper: { value: new THREE.Color('#F1EBDD') },
    uGrime: { value: new THREE.Color('#9C917E') },
    uRule: { value: new THREE.Color('#86A6D2') },
    uMargin: { value: new THREE.Color('#D98A8A') },
    uSunView: { value: new THREE.Vector3(0.7, 0.45, -0.25) },
    uSunColor: { value: new THREE.Color('#FFD9A8') },
    uSunIntensity: { value: 1.4 },
    uSky: { value: new THREE.Color('#C9D5E8') },
    uGround: { value: new THREE.Color('#1A1F2B') },
    uAmbient: { value: 0.6 },
    uBackLight: { value: new THREE.Color(0, 0, 0) },
    uTransmission: { value: 0.55 },
    uContact: { value: 0 },
    uSheen: { value: 0.03 },
    uOpacity: { value: 1 },
    uExposure: { value: 1 },
    uDetail: { value: 1 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  };
}

export function createLensPaperMaterial(uniforms: LensPaperUniforms, tier: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'LensPaperMaterial',
    uniforms,
    vertexShader: LENS_PAPER_VERTEX_SHADER,
    fragmentShader: LENS_PAPER_FRAGMENT_SHADER,
    defines: { FBM_OCTAVES: tier >= 2 ? 4 : 3 },
    side: THREE.DoubleSide,
    transparent: true,
    depthTest: true,
    depthWrite: true,
    toneMapped: false,
    fog: false,
    lights: false,
  });
}

export interface LensHaloUniforms {
  [uniform: string]: THREE.IUniform;
  uPaperSize: THREE.IUniform<THREE.Vector2>;
  uHaloSize: THREE.IUniform<THREE.Vector2>;
  uSoftness: THREE.IUniform<number>;
  uStrength: THREE.IUniform<number>;
  uColor: THREE.IUniform<THREE.Color>;
  uExposure: THREE.IUniform<number>;
}

export function createLensHaloUniforms(): LensHaloUniforms {
  return {
    uPaperSize: { value: new THREE.Vector2(0.2, 0.27) },
    uHaloSize: { value: new THREE.Vector2(0.3, 0.37) },
    uSoftness: { value: 0.04 },
    uStrength: { value: 0 },
    uColor: { value: new THREE.Color('#030407') },
    uExposure: { value: 1 },
  };
}

export function createLensHaloMaterial(uniforms: LensHaloUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'LensPaperHaloMaterial',
    uniforms,
    vertexShader: LENS_HALO_VERTEX_SHADER,
    fragmentShader: LENS_HALO_FRAGMENT_SHADER,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
}
