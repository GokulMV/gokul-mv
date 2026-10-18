import type { GpuTier } from '../../store/scrollStore';
import { BONE_PARENT, type BoneName, type GearSocketName } from './rigTypes';
import {
  LIMB_FRAMES,
  REST_JOINTS,
  SKIN_BONE_INDEX,
  SKINNED_BONES,
  limbDirToBind,
  limbDirToRest,
  limbScratch,
  limbToBind,
  limbToRest,
  type LimbFrame,
  type SocketSpec,
  type Vec3,
} from './characterSkeleton';
import { polygonizeSdfSteps, type GridBounds, type PolygonizedSurface, type ScalarField } from './characterSurfaceNets';

/* ==========================================================================
 * Character geometry — PURE module (no React, no DOM; runs in Node).
 *
 * The protagonist is sculpted as signed distance fields in the REST pose
 * (Root space, arms hanging) from anatomical primitives — ribcage, pecs,
 * lats, deltoids, biceps, quads … — smooth-unioned into garments:
 *
 *   jacket    fitted charcoal shell over the torso and arms: V-taper, stand-up
 *             collar with an open V at the zip, hem with a dropped tail, cuff
 *             bands with real openings;
 *   trousers  climbing trousers over hips and legs with eased knees and an
 *             open hem over the boots;
 *   boots     approach / climbing boots (sole with toe spring, toe box, heel
 *             counter, padded collar) — rigid with the Leg bone;
 *   skin      head (neutral, non-identifiable face, ears, eyes) + neck and
 *             both bare hands (relaxed hook grip).
 *
 * Arms and legs are polygonised in a BIND pose (abducted, see
 * characterSkeleton) so armpits and inner thighs are resolvable; hands and
 * boots are polygonised once in their rest frame (left side) and mirrored.
 * Per vertex we bake: skin weights (soft-min over per-bone anatomical part
 * distances, restricted to neighbouring bones), the rest-pose position
 * (`rest`, the design space every shader detail is drawn in), a local
 * ambient occlusion term, and for skin a scalp-hair / stubble mask.
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * SDF primitives
 * ------------------------------------------------------------------------- */

export function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

export function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Approximate ellipsoid distance (iq). */
export function ell(px: number, py: number, pz: number, rx: number, ry: number, rz: number): number {
  const ax = px / rx;
  const ay = py / ry;
  const az = pz / rz;
  const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
  const bx = ax / rx;
  const by = ay / ry;
  const bz = az / rz;
  const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
  return k1 < 1e-12 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
}

function sph(px: number, py: number, pz: number, r: number): number {
  return Math.sqrt(px * px + py * py + pz * pz) - r;
}

function roundBox(px: number, py: number, pz: number, bx: number, by: number, bz: number, r: number): number {
  const qx = Math.abs(px) - bx;
  const qy = Math.abs(py) - by;
  const qz = Math.abs(pz) - bz;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const oz = Math.max(qz, 0);
  return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0) - r;
}

/** Precomputed round cone (iq's exact sdRoundCone between two points). */
interface Cone {
  ax: number;
  ay: number;
  az: number;
  bax: number;
  bay: number;
  baz: number;
  l2: number;
  rr: number;
  a2: number;
  il2: number;
  r1: number;
  r2: number;
}

function cone(a: Vec3, b: Vec3, r1: number, r2: number): Cone {
  const bax = b[0] - a[0];
  const bay = b[1] - a[1];
  const baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2;
  return { ax: a[0], ay: a[1], az: a[2], bax, bay, baz, l2, rr, a2: l2 - rr * rr, il2: 1 / l2, r1, r2 };
}

function sdCone(c: Cone, px: number, py: number, pz: number): number {
  const pax = px - c.ax;
  const pay = py - c.ay;
  const paz = pz - c.az;
  const y = pax * c.bax + pay * c.bay + paz * c.baz;
  const z = y - c.l2;
  const qx = pax * c.l2 - c.bax * y;
  const qy = pay * c.l2 - c.bay * y;
  const qz = paz * c.l2 - c.baz * y;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = y * y * c.l2;
  const z2 = z * z * c.l2;
  const k = Math.sign(c.rr) * c.rr * c.rr * x2;
  if (Math.sign(z) * c.a2 * z2 > k) return Math.sqrt(x2 + z2) * c.il2 - c.r2;
  if (Math.sign(y) * c.a2 * y2 < k) return Math.sqrt(x2 + y2) * c.il2 - c.r1;
  return (Math.sqrt(x2 * c.a2 * c.il2) + y * c.rr) * c.il2 - c.r1;
}

/** Distance from a point to an axis-aligned box (0 inside) — a cheap lower bound for early-outs. */
function boxBound(px: number, py: number, pz: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  const dx = Math.max(x0 - px, 0, px - x1);
  const dy = Math.max(y0 - py, 0, py - y1);
  const dz = Math.max(z0 - pz, 0, pz - z1);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/* ---------------------------------------------------------------------------
 * Anatomy (REST space, metres). Torso parts take ax = |x| (bilateral);
 * limb parts take LEFT-limb rest coordinates (right limbs are mirrored).
 * ------------------------------------------------------------------------- */

const J = REST_JOINTS;
const LATS_C = Math.cos(0.2);
const LATS_S = Math.sin(0.2);
const TRAP = cone([0.03, 1.468, -0.036], [0.16, 1.412, -0.03], 0.042, 0.034);
const GIRDLE = cone([0, 1.388, -0.022], [0.168, 1.386, -0.024], 0.056, 0.048);

/** Ribcage, pecs, upper back / traps, shoulder girdle and flaring lats (the V). */
function chestPart(ax: number, y: number, z: number): number {
  let d = ell(ax, y - 1.272, z + 0.006, 0.152, 0.19, 0.112);
  d = smin(d, ell(ax - 0.07, y - 1.322, z - 0.056, 0.088, 0.058, 0.046), 0.06); // pecs: broad, flat
  d = smin(d, ell(ax, y - 1.4, z + 0.045, 0.13, 0.072, 0.074), 0.05);
  d = smin(d, sdCone(TRAP, ax, y, z), 0.04);
  d = smin(d, sdCone(GIRDLE, ax, y, z), 0.04);
  // Lats: tilted so the top flares outward.
  const lx = ax - 0.122;
  const ly = y - 1.255;
  d = smin(d, ell(LATS_C * lx - LATS_S * ly, LATS_S * lx + LATS_C * ly, z + 0.04, 0.07, 0.125, 0.07), 0.05);
  return d;
}

/** Lean waist and abdomen. */
function spinePart(ax: number, y: number, z: number): number {
  const d = ell(ax, y - 1.088, z - 0.004, 0.128, 0.13, 0.1);
  return smin(d, ell(ax, y - 1.14, z - 0.052, 0.098, 0.11, 0.052), 0.04);
}

/** Pelvis and glutes. */
function pelvisPart(ax: number, y: number, z: number): number {
  const d = ell(ax, y - 0.955, z + 0.01, 0.152, 0.105, 0.11);
  return smin(d, ell(ax - 0.06, y - 0.888, z + 0.054, 0.077, 0.086, 0.07), 0.05);
}

const UPPER_ARM = cone(J.LeftArm, J.LeftForeArm, 0.046, 0.039);
const FOREARM = cone(J.LeftForeArm, J.LeftHand, 0.041, 0.026);

function upperArmPart(x: number, y: number, z: number): number {
  let d = sdCone(UPPER_ARM, x, y, z);
  d = smin(d, ell(x - 0.192, y - 1.376, z + 0.028, 0.046, 0.072, 0.058), 0.03); // deltoid
  d = smin(d, ell(x - 0.207, y - 1.245, z + 0.012, 0.039, 0.075, 0.04), 0.03); // biceps
  d = smin(d, ell(x - 0.214, y - 1.27, z + 0.06, 0.039, 0.09, 0.04), 0.03); // triceps
  return d;
}

function forearmPart(x: number, y: number, z: number): number {
  // The wrist is flatter across the palm direction (x) than front-to-back (z).
  const fx = J.LeftHand[0] + (x - J.LeftHand[0]) * 1.18;
  let d = sdCone(FOREARM, fx, y, z) / 1.08;
  d = smin(d, ell(x - 0.216, y - 1.04, z + 0.02, 0.037, 0.08, 0.043), 0.035); // flexor / extensor bellies
  return d;
}

const THIGH = cone(J.LeftUpLeg, J.LeftLeg, 0.084, 0.052);
const SHIN = cone(J.LeftLeg, [0.09, 0.09, -0.008], 0.048, 0.033);

function thighPart(x: number, y: number, z: number): number {
  let d = sdCone(THIGH, x, y, z);
  d = smin(d, ell(x - 0.097, y - 0.7, z - 0.028, 0.066, 0.15, 0.058), 0.04); // quads
  d = smin(d, ell(x - 0.126, y - 0.67, z, 0.04, 0.13, 0.052), 0.03); // vastus lateralis
  d = smin(d, ell(x - 0.09, y - 0.73, z + 0.035, 0.064, 0.14, 0.055), 0.04); // hamstrings
  return d;
}

function shinPart(x: number, y: number, z: number): number {
  let d = sdCone(SHIN, x, y, z);
  d = smin(d, sph(x - 0.092, y - 0.497, z - 0.012, 0.05), 0.03); // knee
  d = smin(d, ell(x - 0.094, y - 0.355, z + 0.03, 0.046, 0.1, 0.046), 0.04); // calf
  return d;
}

/* ---------------------------------------------------------------------------
 * Head, neck (rest = bind, torso frame)
 * ------------------------------------------------------------------------- */

const HEAD = J.Head;
/** Head bone pivot (Root space, rest). Head-local = rest − HEAD_PIVOT. */
export const HEAD_PIVOT: Vec3 = HEAD;
const NECK_CONE = cone([0, 1.43, -0.032], [0, 1.6, -0.016], 0.06, 0.054);
const JAW = cone([0.047, -0.036, -0.016], [0.021, -0.072, 0.057], 0.015, 0.015);
const BROW = cone([0, 0.03, 0.086], [0.038, 0.031, 0.079], 0.011, 0.009);
const NOSE = cone([0, 0.026, 0.088], [0, -0.011, 0.11], 0.0068, 0.0098);
const SCM = cone([0.05, 1.585, -0.03], [0.012, 1.452, 0.04], 0.013, 0.011);

/** Cranium centre in head-local space (the hairline / scalp reference). */
export const CRANIUM_CENTER: Vec3 = [0, 0.058, -0.014];
export const CRANIUM_RADII: Vec3 = [0.0765, 0.08, 0.097];

function craniumPart(hx: number, hy: number, hz: number): number {
  return ell(hx - CRANIUM_CENTER[0], hy - CRANIUM_CENTER[1], hz - CRANIUM_CENTER[2], CRANIUM_RADII[0], CRANIUM_RADII[1], CRANIUM_RADII[2]);
}

/** Full detailed head in head-local coordinates (pivot at the Head bone). Neutral, generic features. */
function headDetail(hx: number, hy: number, hz: number): number {
  const ahx = Math.abs(hx);
  let d = craniumPart(hx, hy, hz);
  d = smin(d, ell(hx, hy - 0.05, hz - 0.045, 0.064, 0.05, 0.045), 0.03); // forehead
  d = smin(d, sdCone(BROW, ahx, hy, hz), 0.016); // brow ridge
  d = smin(d, ell(hx, hy + 0.03, hz - 0.04, 0.046, 0.047, 0.042), 0.028); // maxilla / mid-face
  d = smin(d, ell(ahx - 0.041, hy + 0.004, hz - 0.052, 0.017, 0.013, 0.024), 0.022); // cheekbones (inside the skull line)
  d = smin(d, ell(ahx - 0.038, hy + 0.024, hz - 0.024, 0.021, 0.04, 0.042), 0.024); // cheek / masseter volume
  d = smin(d, sdCone(JAW, ahx, hy, hz), 0.03); // jawline
  d = smin(d, ell(hx, hy + 0.071, hz - 0.066, 0.026, 0.019, 0.019), 0.022); // chin
  // Eye sockets, eyeballs and lids (the opening itself is painted in the skin shader).
  d = smax(d, -sph(ahx - 0.032, hy - 0.018, hz - 0.094, 0.0145), 0.014);
  d = smin(d, sph(ahx - 0.032, hy - 0.0165, hz - 0.0705, 0.0122), 0.003);
  d = smin(d, ell(ahx - 0.032, hy - 0.0215, hz - 0.0735, 0.0155, 0.0075, 0.0115), 0.004);
  d = smin(d, ell(ahx - 0.032, hy - 0.0105, hz - 0.073, 0.0145, 0.0055, 0.011), 0.004);
  // Nose: bridge, tip, alae.
  d = smin(d, sdCone(NOSE, hx, hy, hz), 0.012);
  d = smin(d, sph(hx, hy + 0.015, hz - 0.105, 0.011), 0.008);
  d = smin(d, ell(ahx - 0.0102, hy + 0.02, hz - 0.095, 0.0084, 0.0066, 0.0075), 0.007);
  // Lips and the mouth line.
  d = smin(d, ell(hx, hy + 0.041, hz - 0.0815, 0.021, 0.0076, 0.0092), 0.008);
  d = smin(d, ell(hx, hy + 0.0515, hz - 0.079, 0.0185, 0.0073, 0.0088), 0.007);
  d = smax(d, -roundBox(hx, hy + 0.0466, hz - 0.092, 0.019, 0.0006, 0.012, 0.0006), 0.0025);
  // Ears (tilted back), with the concha hollow.
  const ex = ahx - 0.075;
  const ey = hy - 0.012;
  const ez = hz + 0.016;
  const ery = 0.966 * ey + 0.259 * ez;
  const erz = -0.259 * ey + 0.966 * ez;
  d = smin(d, ell(ex, ery, erz, 0.011, 0.03, 0.019), 0.006);
  d = smax(d, -ell(ahx - 0.084, hy - 0.008, hz + 0.013, 0.006, 0.016, 0.0105), 0.004);
  return d;
}

/**
 * Scalp-only head SDF in head-local coordinates (neck, cranium, forehead, ears): what the hair grows on.
 * Matches headSdf wherever hair grows and is ~6× cheaper (used for strand growth).
 */
export function scalpSdf(hx: number, hy: number, hz: number): number {
  const ahx = Math.abs(hx);
  let d = sdCone(NECK_CONE, hx + HEAD[0], hy + HEAD[1], hz + HEAD[2]);
  d = smin(d, craniumPart(hx, hy, hz), 0.025);
  d = smin(d, ell(hx, hy - 0.05, hz - 0.045, 0.064, 0.05, 0.045), 0.03);
  const ex = ahx - 0.075;
  const ey = hy - 0.012;
  const ez = hz + 0.016;
  return smin(d, ell(ex, 0.966 * ey + 0.259 * ez, -0.259 * ey + 0.966 * ez, 0.011, 0.03, 0.019), 0.006);
}

/** Neck (rest/bind coordinates), with sternocleidomastoid hints. */
function neckPart(x: number, y: number, z: number): number {
  const d = sdCone(NECK_CONE, x, y, z);
  return smin(d, sdCone(SCM, Math.abs(x), y, z), 0.02);
}

/** Head + neck skin surface in rest/bind coordinates. */
export function headSdf(x: number, y: number, z: number): number {
  const hx = x - HEAD[0];
  const hy = y - HEAD[1];
  const hz = z - HEAD[2];
  let d = neckPart(x, y, z);
  if (boxBound(hx, hy, hz, -0.1, -0.11, -0.13, 0.1, 0.16, 0.14) < d + 0.03) d = smin(d, headDetail(hx, hy, hz), 0.025);
  // The neck ends inside the jacket.
  return smax(d, 1.43 - y, 0.01);
}

/* ---------------------------------------------------------------------------
 * Hands (left, REST coordinates; wrist pivot at J.LeftHand). Palm faces −X,
 * thumb forward (+Z), fingers hang down (−Y) in a relaxed hook grip.
 * ------------------------------------------------------------------------- */

const WRIST = J.LeftHand;

interface FingerSpec {
  base: Vec3;
  lengths: readonly [number, number, number];
  radii: readonly [number, number, number, number];
  /** Cumulative flexion of each phalanx toward the palm (radians). */
  curl: readonly [number, number, number];
  /** Fan angle about X (positive toward +Z / thumb side). */
  fan: number;
}

const FINGERS: readonly FingerSpec[] = [
  { base: [-0.001, -0.092, 0.026], lengths: [0.042, 0.025, 0.021], radii: [0.0094, 0.0085, 0.0077, 0.0069], curl: [0.16, 0.42, 0.22], fan: 0.03 },
  { base: [-0.001, -0.096, 0.0078], lengths: [0.046, 0.028, 0.022], radii: [0.0097, 0.0088, 0.0079, 0.0071], curl: [0.21, 0.47, 0.24], fan: 0.0 },
  { base: [-0.001, -0.093, -0.0102], lengths: [0.043, 0.027, 0.022], radii: [0.0092, 0.0083, 0.0075, 0.0067], curl: [0.27, 0.52, 0.26], fan: -0.025 },
  { base: [-0.001, -0.086, -0.0265], lengths: [0.034, 0.02, 0.019], radii: [0.0082, 0.0075, 0.0068, 0.0061], curl: [0.33, 0.55, 0.28], fan: -0.06 },
];

/** Hand-local cones (relative to the wrist pivot), built once. */
const HAND_CONES: Cone[] = (() => {
  const cones: Cone[] = [];
  for (const f of FINGERS) {
    let px = f.base[0];
    let py = f.base[1];
    let pz = f.base[2];
    let theta = 0;
    for (let s = 0; s < 3; s += 1) {
      theta += f.curl[s];
      // Flexion rotates −Y toward −X (the palm side); the fan tilts toward ±Z.
      const dx = -Math.sin(theta);
      const dyRaw = -Math.cos(theta);
      const dy = dyRaw * Math.cos(f.fan);
      const dz = -dyRaw * Math.sin(f.fan);
      const nx = px + dx * f.lengths[s];
      const ny = py + dy * f.lengths[s];
      const nz = pz + dz * f.lengths[s];
      cones.push(cone([px, py, pz], [nx, ny, nz], f.radii[s], f.radii[s + 1]));
      px = nx;
      py = ny;
      pz = nz;
    }
  }
  // Thumb: metacarpal, proximal, distal phalanx curling across the palm.
  const thumbDirs: readonly Vec3[] = [
    [-0.24, -0.93, 0.3],
    [-0.2, -0.97, 0.12],
    [-0.26, -0.96, 0.04],
  ];
  const thumbLen = [0.04, 0.031, 0.025];
  const thumbR = [0.0122, 0.0105, 0.0094, 0.008];
  let tx = -0.008;
  let ty = -0.022;
  let tz = 0.024;
  for (let s = 0; s < 3; s += 1) {
    const d = thumbDirs[s];
    const l = Math.hypot(d[0], d[1], d[2]);
    const nx = tx + (d[0] / l) * thumbLen[s];
    const ny = ty + (d[1] / l) * thumbLen[s];
    const nz = tz + (d[2] / l) * thumbLen[s];
    cones.push(cone([tx, ty, tz], [nx, ny, nz], thumbR[s], thumbR[s + 1]));
    tx = nx;
    ty = ny;
    tz = nz;
  }
  return cones;
})();

const WRIST_CONE = cone([0, 0.035, 0], [0, -0.012, 0.002], 0.025, 0.023);

/** Metacarpal shafts from the carpus to each knuckle (hand-local), built once. */
const METACARPALS: Cone[] = FINGERS.map((f) => cone([-0.0005, -0.014, f.base[2] * 0.5], [f.base[0] + 0.0012, f.base[1] + 0.004, f.base[2]], 0.0102, 0.0098));

/** Left hand in hand-local coordinates (wrist pivot at the origin). */
function handLocal(u: number, v: number, w: number): number {
  // Wrist (extends into the cuff), flattened across the palm normal.
  let d = sdCone(WRIST_CONE, u * 1.25, v, w) / 1.12;
  for (let i = 0; i < METACARPALS.length; i += 1) d = smin(d, sdCone(METACARPALS[i], u, v, w), 0.013);
  d = smin(d, ell(u + 0.007, v + 0.056, w - 0.0, 0.0105, 0.04, 0.035), 0.012); // palm pad
  d = smin(d, ell(u + 0.011, v + 0.03, w - 0.021, 0.0115, 0.024, 0.015), 0.012); // thenar
  d = smin(d, ell(u + 0.008, v + 0.056, w + 0.028, 0.009, 0.03, 0.0105), 0.01); // hypothenar
  for (let i = 0; i < HAND_CONES.length; i += 1) d = smin(d, sdCone(HAND_CONES[i], u, v, w), 0.0055);
  // The wrist ends 3 cm inside the cuff (keeps the surface closed inside the grid).
  return smax(d, v - 0.03, 0.004);
}

/** Left hand in REST coordinates. */
export function handSdfRest(x: number, y: number, z: number): number {
  return handLocal(x - WRIST[0], y - WRIST[1], z - WRIST[2]);
}

/** Simple hand proxy for skin weights (left, rest coordinates). */
function handProxy(x: number, y: number, z: number): number {
  return roundBox(x - WRIST[0] + 0.014, y - WRIST[1] + 0.085, z - WRIST[2] - 0.002, 0.02, 0.066, 0.032, 0.012);
}

/** Centre of the grip channel of the curled fingers (hand-local, left hand). */
export const HAND_GRIP_LOCAL: Vec3 = [-0.034, -0.12, 0.002];

/* ---------------------------------------------------------------------------
 * Garments
 * ------------------------------------------------------------------------- */

/** Jacket hem height: dropped tail at the back, slightly raised at the hips. */
function jacketHemY(x: number, z: number): number {
  const back = smoothstep(0.03, -0.1, z);
  const side = smoothstep(0.08, 0.17, Math.abs(x));
  return 0.902 - 0.022 * back + 0.01 * side * (1 - back);
}

/** Jacket ease: the shell stands off the waist (hangs from the chest) and the hips. */
function jacketEase(y: number): number {
  return 0.0125 + 0.005 * smoothstep(1.2, 1.06, y);
}

function jacketTorso(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  let d = chestPart(ax, y, z);
  // The shell bridges the sternum between the pecs and the spine valley between the lats / shoulder blades.
  d = smin(d, ell(x, y - 1.31, z - 0.052, 0.07, 0.075, 0.05), 0.03);
  d = smin(d, ell(x, y - 1.215, z + 0.072, 0.135, 0.17, 0.058), 0.045);
  d = smin(d, spinePart(ax, y, z), 0.075);
  if (y < 1.08) d = smin(d, pelvisPart(ax, y, z), 0.07);
  return d - jacketEase(y);
}

const SLEEVE_CUFF_Y = J.LeftHand[1] + 0.012;

/** Left sleeve in left-arm REST coordinates: eased arm, cuff band, open cuff. */
function sleeve(x: number, y: number, z: number): number {
  let d = smin(upperArmPart(x, y, z), forearmPart(x, y, z), 0.045);
  // Fabric ease grows toward the elbow / forearm (fitted, not tight).
  d -= 0.011 + 0.003 * smoothstep(1.2, 1.0, y);
  // Cuff band: a slightly raised band over the last 4 cm.
  const cuff = smoothstep(SLEEVE_CUFF_Y + 0.05, SLEEVE_CUFF_Y + 0.035, y);
  d -= 0.0035 * cuff;
  // Rounded cuff end; the wrist emerges from it (robust at every grid resolution).
  return smax(d, SLEEVE_CUFF_Y - y, 0.009);
}

/** Stand-up collar: a solid rolled band the neck emerges from (robust at every grid resolution). */
function collar(x: number, y: number, z: number): number {
  const cz = z + 0.022 - (y - 1.46) * 0.12; // leans slightly forward with height
  const r = Math.sqrt(x * x * 1.05 + cz * cz * 0.95);
  const radius = 0.079 + 0.014 * smoothstep(1.545, 1.455, y);
  let d = r - radius;
  const top = 1.546 - 0.02 * smoothstep(-0.02, 0.07, z); // taller at the back
  d = smax(d, y - top, 0.014);
  return smax(d, 1.43 - y, 0.01);
}

/** Jacket in BIND coordinates. */
export function jacketSdf(x: number, y: number, z: number): number {
  let d = jacketTorso(x, y, z);
  if (y > 1.38) d = smin(d, collar(x, y, z), 0.016);
  // Sleeves (bind → rest per arm, right arm mirrored onto the left-arm design).
  const fl = limbToRest(LIMB_FRAMES.armL, x, y, z);
  if (boxBound(fl.x, fl.y, fl.z, 0.13, 0.84, -0.12, 0.3, 1.5, 0.08) < d + 0.03) {
    d = smin(d, sleeve(fl.x, fl.y, fl.z), 0.028);
  }
  const fr = limbToRest(LIMB_FRAMES.armR, x, y, z);
  if (boxBound(-fr.x, fr.y, fr.z, 0.13, 0.84, -0.12, 0.3, 1.5, 0.08) < d + 0.03) {
    d = smin(d, sleeve(-fr.x, fr.y, fr.z), 0.028);
  }
  return smax(d, jacketHemY(x, z) - y, 0.006);
}

const TROUSER_HANG = cone([0.093, 0.5, 0.004], [0.091, 0.16, -0.004], 0.058, 0.05);
const TROUSER_HEM_Y = 0.135;
const TROUSER_OPENING = cone([0.09, 0.0, -0.006], [0.09, 0.17, -0.006], 0.045, 0.045);

/** Left trouser leg in left-leg REST coordinates. */
function trouserLeg(x: number, y: number, z: number): number {
  let d = smin(thighPart(x, y, z), shinPart(x, y, z), 0.05);
  d = smin(d, sdCone(TROUSER_HANG, x, y, z), 0.06);
  d -= 0.011 + 0.004 * smoothstep(0.62, 0.42, y);
  d = smax(d, TROUSER_HEM_Y - y, 0.004);
  d = smax(d, -sdCone(TROUSER_OPENING, x, y, z), 0.004);
  return d;
}

/** Trousers in BIND coordinates. */
export function trousersSdf(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  let d = smin(pelvisPart(ax, y, z), spinePart(ax, y, z), 0.06) - 0.011;
  const fl = limbToRest(LIMB_FRAMES.legL, x, y, z);
  if (boxBound(fl.x, fl.y, fl.z, -0.02, 0.1, -0.12, 0.2, 0.95, 0.12) < d + 0.05) {
    d = smin(d, trouserLeg(fl.x, fl.y, fl.z), 0.045);
  }
  const fr = limbToRest(LIMB_FRAMES.legR, x, y, z);
  if (boxBound(-fr.x, fr.y, fr.z, -0.02, 0.1, -0.12, 0.2, 0.95, 0.12) < d + 0.05) {
    d = smin(d, trouserLeg(-fr.x, fr.y, fr.z), 0.045);
  }
  return smax(d, y - 1.03, 0.006);
}

/* Boot (left, REST coordinates). The foot centre line is x = BOOT_X. */
const BOOT_X = 0.091;
const BOOT_SHAFT = cone([BOOT_X, 0.06, -0.012], [BOOT_X, 0.158, -0.015], 0.047, 0.044);

function soleOutline(x: number, z: number): number {
  const heel = Math.hypot(x - (BOOT_X + 0.002), z + 0.031) - 0.043;
  const ball = Math.hypot(x - (BOOT_X - 0.005), z - 0.112) - 0.052;
  const toe = Math.hypot(x - (BOOT_X - 0.007), z - 0.158) - 0.046;
  return smin(smin(heel, ball, 0.11), toe, 0.04);
}

export function bootSdfRest(x: number, y: number, z: number): number {
  // Sole + midsole with toe spring.
  const spring = Math.max(0, z - 0.12) * 0.28;
  const sole = smax(soleOutline(x, z), Math.max(spring - y, y - (0.03 + spring * 0.6)), 0.006);
  // Upper.
  let u = ell(x - (BOOT_X - 0.004), y - 0.042 - spring * 0.5, z - 0.128, 0.05, 0.04, 0.083); // toe box
  u = smin(u, ell(x - BOOT_X, y - 0.062, z - 0.05, 0.049, 0.056, 0.1), 0.03); // midfoot / instep
  u = smin(u, ell(x - BOOT_X, y - 0.066, z + 0.03, 0.044, 0.06, 0.05), 0.03); // heel counter
  u = smin(u, sdCone(BOOT_SHAFT, x, y, z), 0.035); // ankle shaft
  u = smin(u, ell(x - BOOT_X, y - 0.112, z - 0.03, 0.033, 0.055, 0.03), 0.02); // tongue
  // Padded collar ring.
  const rx = x - BOOT_X;
  const rz = z + 0.015;
  const ring = Math.hypot(Math.hypot(rx, rz) - 0.043, y - 0.157) - 0.0085;
  u = smin(u, ring, 0.008);
  u = smax(u, y - 0.163, 0.006);
  u = smax(u, 0.012 + spring * 0.5 - y, 0.004);
  return smin(sole, u, 0.008);
}

/* ---------------------------------------------------------------------------
 * Per-bone anatomical parts (skin weights).
 * ------------------------------------------------------------------------- */

const B = SKIN_BONE_INDEX;
const BONE_COUNT = SKINNED_BONES.length;

function headProxy(x: number, y: number, z: number): number {
  const hx = x - HEAD[0];
  const hy = y - HEAD[1];
  const hz = z - HEAD[2];
  return smin(ell(hx, hy - 0.04, hz - 0.005, 0.08, 0.1, 0.104), sdCone(JAW, Math.abs(hx), hy, hz), 0.03);
}

function footProxy(x: number, y: number, z: number): number {
  return ell(x - BOOT_X, y - 0.07, z - 0.065, 0.06, 0.08, 0.15);
}

/** Fills `out` (SKINNED_BONES order) with the distance to each bone's anatomical part at a BIND-space point. */
export function bonePartDistances(x: number, y: number, z: number, out: Float64Array): void {
  const ax = Math.abs(x);
  out[B.Pelvis] = pelvisPart(ax, y, z);
  out[B.Spine] = spinePart(ax, y, z);
  out[B.Chest] = chestPart(ax, y, z);
  out[B.Neck] = sdCone(NECK_CONE, x, y, z);
  out[B.Head] = headProxy(x, y, z);
  limbToRest(LIMB_FRAMES.armL, x, y, z);
  let lx = limbScratch.x;
  let ly = limbScratch.y;
  let lz = limbScratch.z;
  out[B.LeftArm] = upperArmPart(lx, ly, lz);
  out[B.LeftForeArm] = forearmPart(lx, ly, lz);
  out[B.LeftHand] = handProxy(lx, ly, lz);
  limbToRest(LIMB_FRAMES.armR, x, y, z);
  lx = -limbScratch.x;
  ly = limbScratch.y;
  lz = limbScratch.z;
  out[B.RightArm] = upperArmPart(lx, ly, lz);
  out[B.RightForeArm] = forearmPart(lx, ly, lz);
  out[B.RightHand] = handProxy(lx, ly, lz);
  limbToRest(LIMB_FRAMES.legL, x, y, z);
  lx = limbScratch.x;
  ly = limbScratch.y;
  lz = limbScratch.z;
  out[B.LeftUpLeg] = thighPart(lx, ly, lz);
  out[B.LeftLeg] = Math.min(shinPart(lx, ly, lz), footProxy(lx, ly, lz));
  limbToRest(LIMB_FRAMES.legR, x, y, z);
  lx = -limbScratch.x;
  ly = limbScratch.y;
  lz = limbScratch.z;
  out[B.RightUpLeg] = thighPart(lx, ly, lz);
  out[B.RightLeg] = Math.min(shinPart(lx, ly, lz), footProxy(lx, ly, lz));
}

/** Blend width (metres) of each joint, keyed by the child bone. */
const JOINT_SIGMA: Readonly<Record<Exclude<BoneName, 'Root' | 'Pelvis'>, number>> = {
  Spine: 0.034,
  Chest: 0.034,
  Neck: 0.014,
  Head: 0.011,
  LeftArm: 0.017,
  LeftForeArm: 0.0105,
  LeftHand: 0.006,
  RightArm: 0.017,
  RightForeArm: 0.0105,
  RightHand: 0.006,
  LeftUpLeg: 0.02,
  LeftLeg: 0.0105,
  RightUpLeg: 0.02,
  RightLeg: 0.0105,
};

/** For each skinned bone: neighbour bone indices and the blend width to each. */
const NEIGHBOURS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = SKINNED_BONES.map((name) => {
  const list: Array<readonly [number, number]> = [];
  const parent = BONE_PARENT[name];
  if (parent && parent !== 'Root') list.push([B[parent as Exclude<BoneName, 'Root'>], JOINT_SIGMA[name as keyof typeof JOINT_SIGMA]]);
  for (const child of SKINNED_BONES) {
    if (BONE_PARENT[child] === name) list.push([B[child], JOINT_SIGMA[child as keyof typeof JOINT_SIGMA]]);
  }
  return list;
});

/** Bone frames for rest-position reconstruction: which limb frame (if any) moves each bone in the bind pose. */
const BONE_FRAME: ReadonlyArray<LimbFrame | null> = SKINNED_BONES.map((name) => {
  if (name === 'LeftArm' || name === 'LeftForeArm' || name === 'LeftHand') return LIMB_FRAMES.armL;
  if (name === 'RightArm' || name === 'RightForeArm' || name === 'RightHand') return LIMB_FRAMES.armR;
  if (name === 'LeftUpLeg' || name === 'LeftLeg') return LIMB_FRAMES.legL;
  if (name === 'RightUpLeg' || name === 'RightLeg') return LIMB_FRAMES.legR;
  return null;
});

const _parts = new Float64Array(BONE_COUNT);
const _cand = new Float64Array(BONE_COUNT);

/**
 * Skin weights at a bind-space point: soft-min over the anatomical part distances, restricted to the dominant bone
 * and its direct neighbours, top 4, renormalised. Optionally forces a single bone (rigid parts).
 */
export function skinWeightsAt(
  x: number,
  y: number,
  z: number,
  outIndex: Uint16Array,
  outWeight: Float32Array,
  offset: number,
  rigidBone = -1,
): void {
  for (let i = 0; i < 4; i += 1) {
    outIndex[offset + i] = 0;
    outWeight[offset + i] = 0;
  }
  if (rigidBone >= 0) {
    outIndex[offset] = rigidBone;
    outWeight[offset] = 1;
    return;
  }
  bonePartDistances(x, y, z, _parts);
  let b0 = 0;
  for (let b = 1; b < BONE_COUNT; b += 1) if (_parts[b] < _parts[b0]) b0 = b;
  _cand.fill(0);
  _cand[b0] = 1;
  for (const [nb, sigma] of NEIGHBOURS[b0]) {
    const w = Math.exp(-Math.max(0, _parts[nb] - _parts[b0]) / sigma);
    if (w > 0.004) _cand[nb] = w;
  }
  // Top 4.
  let sum = 0;
  for (let slot = 0; slot < 4; slot += 1) {
    let best = -1;
    for (let b = 0; b < BONE_COUNT; b += 1) if (_cand[b] > 0 && (best < 0 || _cand[b] > _cand[best])) best = b;
    if (best < 0) break;
    outIndex[offset + slot] = best;
    outWeight[offset + slot] = _cand[best];
    sum += _cand[best];
    _cand[best] = 0;
  }
  for (let i = 0; i < 4; i += 1) outWeight[offset + i] /= sum;
}

/** Rest-pose position of a bind-space vertex under its weights (what the skinned mesh shows at rest). */
function restFromBind(
  x: number,
  y: number,
  z: number,
  index: Uint16Array,
  weight: Float32Array,
  offset: number,
  out: Float32Array,
  outOffset: number,
): void {
  let rx = 0;
  let ry = 0;
  let rz = 0;
  for (let i = 0; i < 4; i += 1) {
    const w = weight[offset + i];
    if (w <= 0) continue;
    const frame = BONE_FRAME[index[offset + i]];
    if (frame) {
      limbToRest(frame, x, y, z);
      rx += limbScratch.x * w;
      ry += limbScratch.y * w;
      rz += limbScratch.z * w;
    } else {
      rx += x * w;
      ry += y * w;
      rz += z * w;
    }
  }
  out[outOffset] = rx;
  out[outOffset + 1] = ry;
  out[outOffset + 2] = rz;
}

/** Rest-pose normal of a bind-space normal under the vertex weights. */
function restNormalFromBind(
  x: number,
  y: number,
  z: number,
  index: Uint16Array,
  weight: Float32Array,
  offset: number,
  out: Float32Array,
  outOffset: number,
): void {
  let rx = 0;
  let ry = 0;
  let rz = 0;
  for (let i = 0; i < 4; i += 1) {
    const w = weight[offset + i];
    if (w <= 0) continue;
    const frame = BONE_FRAME[index[offset + i]];
    if (frame) {
      limbDirToRest(frame, x, y, z);
      rx += limbScratch.x * w;
      ry += limbScratch.y * w;
      rz += limbScratch.z * w;
    } else {
      rx += x * w;
      ry += y * w;
      rz += z * w;
    }
  }
  const l = Math.hypot(rx, ry, rz) || 1;
  out[outOffset] = rx / l;
  out[outOffset + 1] = ry / l;
  out[outOffset + 2] = rz / l;
}

const ARM_BONES = new Set<number>([B.LeftArm, B.LeftForeArm, B.LeftHand, B.RightArm, B.RightForeArm, B.RightHand]);
const LEG_BONES = new Set<number>([B.LeftUpLeg, B.LeftLeg, B.RightUpLeg, B.RightLeg]);

/* ---------------------------------------------------------------------------
 * Scalp hair mask (head-local) — shared with the hair card generator.
 * ------------------------------------------------------------------------- */

/** Hairline height (head-local y) by azimuth a ∈ [0 front, 1 back] around the cranium centre. */
const HAIRLINE: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.085],
  [0.09, 0.083],
  [0.19, 0.074],
  [0.28, 0.07],
  [0.37, 0.056],
  [0.425, 0.016],
  [0.475, 0.006],
  [0.51, 0.04],
  [0.6, 0.046],
  [0.68, 0.012],
  [0.78, -0.026],
  [0.9, -0.041],
  [1.0, -0.045],
];

export function hairlineY(a: number): number {
  const t = Math.min(1, Math.max(0, a));
  for (let i = 1; i < HAIRLINE.length; i += 1) {
    const [a1, y1] = HAIRLINE[i];
    if (t <= a1) {
      const [a0, y0] = HAIRLINE[i - 1];
      const f = (t - a0) / (a1 - a0);
      const s = f * f * (3 - 2 * f);
      return y0 + (y1 - y0) * s;
    }
  }
  return HAIRLINE[HAIRLINE.length - 1][1];
}

/** Azimuth parameter a ∈ [0, 1] (0 = forehead, 1 = nape) of a head-local point. */
export function scalpAzimuth(hx: number, hz: number): number {
  return Math.abs(Math.atan2(hx, hz - CRANIUM_CENTER[2])) / Math.PI;
}

/** 0..1 coverage of the scalp hair at a head-local point (soft hairline). */
export function scalpHairMask(hx: number, hy: number, hz: number): number {
  const a = scalpAzimuth(hx, hz);
  const line = hairlineY(a) + 0.0035 * Math.sin(a * 47 + Math.sign(hx) * 1.7) + 0.0022 * Math.sin(a * 113 + 0.6);
  return smoothstep(line - 0.007, line + 0.013, hy);
}

/* ---------------------------------------------------------------------------
 * Sockets — measured on the garment surfaces.
 * ------------------------------------------------------------------------- */

/** Marches from `start` along `dir` and returns the parameter where `field` first becomes ≤ 0. */
function marchTo(field: ScalarField, start: Vec3, dir: Vec3, maxT: number): number {
  let t = 0;
  for (let i = 0; i < 400 && t < maxT; i += 1) {
    const d = field(start[0] + dir[0] * t, start[1] + dir[1] * t, start[2] + dir[2] * t);
    if (d < 1e-4) return t;
    t += Math.max(d * 0.8, 1e-4);
  }
  return maxT;
}

function garmentUnion(x: number, y: number, z: number): number {
  return Math.min(jacketSdf(x, y, z), trousersSdf(x, y, z));
}

function buildSocketSpecs(): Record<GearSocketName, SocketSpec> {
  // Backpack: on the jacket's back between the shoulder blades; +Z of the socket points away from the back.
  const backY = 1.33;
  const backZ = -0.4 + marchTo(jacketSdf, [0, backY, -0.4], [0, 0, 1], 0.4);
  // Rope coil: the top of the left shoulder.
  const ropeX = 0.135;
  const ropeY = 1.7 - marchTo(jacketSdf, [ropeX, 1.7, -0.03], [0, -1, 0], 0.4);
  // Hip holsters: the side of the hips at harness-gear-loop height.
  const holsterY = 0.935;
  const holsterX = 0.4 - marchTo(garmentUnion, [0.4, holsterY, -0.01], [-1, 0, 0], 0.4);
  const grip = HAND_GRIP_LOCAL;
  return {
    backpack: { bone: 'Chest', position: [0, backY, backZ], rotation: [0, Math.PI, 0] },
    ropeCoil: { bone: 'Chest', position: [ropeX, ropeY, -0.03], rotation: [0, 0, 0] },
    harness: { bone: 'Pelvis', position: [0, 0.985, 0], rotation: [0, 0, 0] },
    hipHolsterL: { bone: 'Pelvis', position: [holsterX, holsterY, -0.01], rotation: [0, 0, 0] },
    hipHolsterR: { bone: 'Pelvis', position: [-holsterX, holsterY, -0.01], rotation: [0, 0, 0] },
    handGripL: {
      bone: 'LeftHand',
      position: [WRIST[0] + grip[0], WRIST[1] + grip[1], WRIST[2] + grip[2]],
      rotation: [0, 0, 0],
    },
    handGripR: {
      bone: 'RightHand',
      position: [-(WRIST[0] + grip[0]), WRIST[1] + grip[1], WRIST[2] + grip[2]],
      rotation: [0, 0, 0],
    },
  };
}

/** Socket placements (Root-space rest positions on their bones). */
export const SOCKET_SPECS: Readonly<Record<GearSocketName, SocketSpec>> = buildSocketSpecs();

/** Harness waist belt half-extents at the harness socket height (jacket outer surface), for the gear system. */
export const HARNESS_WAIST = (() => {
  const y = SOCKET_SPECS.harness.position[1];
  const hx = 0.4 - marchTo(jacketSdf, [0.4, y, 0], [-1, 0, 0], 0.4);
  const front = 0.4 - marchTo(jacketSdf, [0, y, 0.4], [0, 0, -1], 0.4);
  const back = -0.4 + marchTo(jacketSdf, [0, y, -0.4], [0, 0, 1], 0.4);
  return { halfWidth: hx, front, back } as const;
})();

/* ---------------------------------------------------------------------------
 * Build
 * ------------------------------------------------------------------------- */

export type CharacterDetailLevel = 'high' | 'medium' | 'low';

export function characterDetailForTier(tier: GpuTier): CharacterDetailLevel {
  return tier >= 3 ? 'high' : tier === 2 ? 'medium' : 'low';
}

interface CellSizes {
  jacket: number;
  trousers: number;
  boot: number;
  head: number;
  hand: number;
}

/** Fine cell sizes per detail level (tuned to the triangle budget: ~48k / 29k / 16k body triangles). */
const CELL_SIZES: Readonly<Record<CharacterDetailLevel, CellSizes>> = {
  high: { jacket: 0.0142, trousers: 0.0158, boot: 0.0105, head: 0.0074, hand: 0.0062 },
  medium: { jacket: 0.0185, trousers: 0.0205, boot: 0.0135, head: 0.0095, hand: 0.008 },
  low: { jacket: 0.025, trousers: 0.0275, boot: 0.018, head: 0.0128, hand: 0.0108 },
};

export type GarmentName = 'jacket' | 'trousers' | 'boots' | 'skin';

export interface SkinnedMeshData {
  name: GarmentName;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  /** Rest-pose position (design space for shader details). */
  rest: Float32Array;
  /** Rest-pose normal (triplanar fabric projection). */
  restNormal: Float32Array;
  /** Baked local ambient occlusion (0 = occluded, 1 = open). */
  occlusion: Float32Array;
  /**
   * Per-garment mask: skin → (scalp hair coverage, stubble); jacket → (sleeve membership, 0);
   * trousers → (leg membership, 0); boots → (0, 0).
   */
  mask: Float32Array;
  vertexCount: number;
  triangleCount: number;
}

export interface CharacterMeshes {
  detail: CharacterDetailLevel;
  meshes: Readonly<Record<GarmentName, SkinnedMeshData>>;
  triangleCount: number;
  /** Triangles per polygonised piece (diagnostics). */
  pieceTriangles: Readonly<Record<string, number>>;
  buildMs: number;
  evaluations: number;
}

/** A polygonised surface plus how to transform/weight it. */
interface Piece {
  surface: PolygonizedSurface;
  /** Rest→bind frame for pieces polygonised in rest space (boots, hands; already mirrored for the right side). */
  frame: LimbFrame | null;
  /** Bone forced for rigid pieces (boots), else -1. */
  rigidBone: number;
}

function mirrored(surface: PolygonizedSurface): PolygonizedSurface {
  const positions = surface.positions.slice();
  const normals = surface.normals.slice();
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = -positions[i];
    normals[i] = -normals[i];
  }
  const indices = surface.indices.slice();
  for (let i = 0; i < indices.length; i += 3) {
    const t = indices[i + 1];
    indices[i + 1] = indices[i + 2];
    indices[i + 2] = t;
  }
  return { ...surface, positions, normals, indices };
}

const AO_STEPS = [0.01, 0.024, 0.045] as const;
const ASSEMBLE_YIELD_EVERY = 24;

function* assembleSteps(name: GarmentName, pieces: readonly Piece[], aoField: ScalarField): Generator<void, SkinnedMeshData, void> {
  let vertexCount = 0;
  let indexCount = 0;
  for (const p of pieces) {
    vertexCount += p.surface.vertexCount;
    indexCount += p.surface.indices.length;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  const skinIndex = new Uint16Array(vertexCount * 4);
  const skinWeight = new Float32Array(vertexCount * 4);
  const rest = new Float32Array(vertexCount * 3);
  const restNormal = new Float32Array(vertexCount * 3);
  const occlusion = new Float32Array(vertexCount);
  const mask = new Float32Array(vertexCount * 2);
  let v0 = 0;
  let i0 = 0;
  for (const piece of pieces) {
    const s = piece.surface;
    for (let v = 0; v < s.vertexCount; v += 1) {
      const x = s.positions[v * 3];
      const y = s.positions[v * 3 + 1];
      const z = s.positions[v * 3 + 2];
      const nx = s.normals[v * 3];
      const ny = s.normals[v * 3 + 1];
      const nz = s.normals[v * 3 + 2];
      const o = (v0 + v) * 3;
      let bx = x;
      let by = y;
      let bz = z;
      let bnx = nx;
      let bny = ny;
      let bnz = nz;
      if (piece.frame) {
        // Rest-space piece: the rest position is the surface itself; move it to the bind pose.
        rest[o] = x;
        rest[o + 1] = y;
        rest[o + 2] = z;
        limbToBind(piece.frame, x, y, z);
        bx = limbScratch.x;
        by = limbScratch.y;
        bz = limbScratch.z;
        limbDirToBind(piece.frame, nx, ny, nz);
        bnx = limbScratch.x;
        bny = limbScratch.y;
        bnz = limbScratch.z;
      }
      positions[o] = bx;
      positions[o + 1] = by;
      positions[o + 2] = bz;
      normals[o] = bnx;
      normals[o + 1] = bny;
      normals[o + 2] = bnz;
      const wo = (v0 + v) * 4;
      skinWeightsAt(bx, by, bz, skinIndex, skinWeight, wo, piece.rigidBone);
      if (piece.frame) {
        restNormal[o] = nx;
        restNormal[o + 1] = ny;
        restNormal[o + 2] = nz;
      } else {
        restFromBind(bx, by, bz, skinIndex, skinWeight, wo, rest, o);
        restNormalFromBind(bnx, bny, bnz, skinIndex, skinWeight, wo, restNormal, o);
      }
      if (name === 'jacket' || name === 'trousers') {
        let limb = 0;
        for (let k = 0; k < 4; k += 1) {
          const bone = skinIndex[wo + k];
          const isLimb = name === 'jacket' ? ARM_BONES.has(bone) : LEG_BONES.has(bone);
          if (isLimb) limb += skinWeight[wo + k];
        }
        mask[(v0 + v) * 2] = limb;
      }
      // Local ambient occlusion along the normal (bind space).
      let occ = 0;
      for (let k = 0; k < AO_STEPS.length; k += 1) {
        const h = AO_STEPS[k];
        const d = aoField(bx + bnx * h, by + bny * h, bz + bnz * h);
        occ += Math.max(0, h - d) / h / (1 << k);
      }
      occlusion[v0 + v] = Math.max(0.15, Math.min(1, 1 - occ * 0.7));
      if (name === 'skin') {
        const rx = rest[o];
        const ry = rest[o + 1];
        const rz = rest[o + 2];
        if (ry > 1.3) {
          const hx = rx - HEAD[0];
          const hy = ry - HEAD[1];
          const hz = rz - HEAD[2];
          mask[(v0 + v) * 2] = scalpHairMask(hx, hy, hz);
          const a = scalpAzimuth(hx, hz);
          const jaw = smoothstep(-0.022, -0.045, hy) * smoothstep(0.56, 0.42, a) * smoothstep(-0.12, -0.085, hy);
          const lips = smoothstep(0.03, 0.02, Math.hypot(hx * 0.9, (hy + 0.046) * 2.2)) * smoothstep(0.075, 0.085, hz);
          mask[(v0 + v) * 2 + 1] = jaw * (1 - lips);
        }
      }
      if (v % ASSEMBLE_YIELD_EVERY === ASSEMBLE_YIELD_EVERY - 1) yield;
    }
    for (let i = 0; i < s.indices.length; i += 1) indices[i0 + i] = s.indices[i] + v0;
    v0 += s.vertexCount;
    i0 += s.indices.length;
    yield;
  }
  return {
    name,
    positions,
    normals,
    indices,
    skinIndex,
    skinWeight,
    rest,
    restNormal,
    occlusion,
    mask,
    vertexCount,
    triangleCount: indexCount / 3,
  };
}

function bootsUnionBind(x: number, y: number, z: number): number {
  const l = limbToRest(LIMB_FRAMES.legL, x, y, z);
  const dl = bootSdfRest(l.x, l.y, l.z);
  const r = limbToRest(LIMB_FRAMES.legR, x, y, z);
  const dr = bootSdfRest(-r.x, r.y, r.z);
  return Math.min(dl, dr);
}

function handsUnionBind(x: number, y: number, z: number): number {
  const l = limbToRest(LIMB_FRAMES.armL, x, y, z);
  const dl = handSdfRest(l.x, l.y, l.z);
  const r = limbToRest(LIMB_FRAMES.armR, x, y, z);
  const dr = handSdfRest(-r.x, r.y, r.z);
  return Math.min(dl, dr);
}

const JACKET_BOUNDS: GridBounds = { x0: -0.6, y0: 0.84, z0: -0.19, x1: 0.6, y1: 1.6, z1: 0.17 };
const TROUSER_BOUNDS: GridBounds = { x0: -0.24, y0: 0.11, z0: -0.16, x1: 0.24, y1: 1.05, z1: 0.14 };
const BOOT_BOUNDS: GridBounds = { x0: 0.025, y0: -0.012, z0: -0.09, x1: 0.16, y1: 0.172, z1: 0.225 };
const HEAD_BOUNDS: GridBounds = { x0: -0.105, y0: 1.42, z0: -0.13, x1: 0.105, y1: 1.745, z1: 0.135 };
const HAND_BOUNDS: GridBounds = {
  x0: WRIST[0] - 0.085,
  y0: WRIST[1] - 0.175,
  z0: WRIST[2] - 0.05,
  x1: WRIST[0] + 0.035,
  y1: WRIST[1] + 0.045,
  z1: WRIST[2] + 0.075,
};

const cache = new Map<CharacterDetailLevel, CharacterMeshes>();

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function* buildSteps(detail: CharacterDetailLevel): Generator<void, CharacterMeshes, void> {
  const t0 = now();
  let spent = 0;
  const cells = CELL_SIZES[detail];
  const jacket = yield* polygonizeSdfSteps(jacketSdf, { bounds: JACKET_BOUNDS, cell: cells.jacket });
  const trousers = yield* polygonizeSdfSteps(trousersSdf, { bounds: TROUSER_BOUNDS, cell: cells.trousers });
  const boot = yield* polygonizeSdfSteps(bootSdfRest, { bounds: BOOT_BOUNDS, cell: cells.boot });
  const head = yield* polygonizeSdfSteps(headSdf, { bounds: HEAD_BOUNDS, cell: cells.head });
  const hand = yield* polygonizeSdfSteps(handSdfRest, { bounds: HAND_BOUNDS, cell: cells.hand, normalStep: 0.3 });
  spent = jacket.evaluations + trousers.evaluations + boot.evaluations + head.evaluations + hand.evaluations;

  const jacketMesh = yield* assembleSteps('jacket', [{ surface: jacket, frame: null, rigidBone: -1 }], (x, y, z) =>
    Math.min(jacketSdf(x, y, z), headSdf(x, y, z)),
  );
  const trouserMesh = yield* assembleSteps('trousers', [{ surface: trousers, frame: null, rigidBone: -1 }], (x, y, z) =>
    Math.min(trousersSdf(x, y, z), jacketSdf(x, y, z), bootsUnionBind(x, y, z)),
  );
  const bootMesh = yield* assembleSteps(
    'boots',
    [
      { surface: boot, frame: LIMB_FRAMES.legL, rigidBone: B.LeftLeg },
      { surface: mirrored(boot), frame: LIMB_FRAMES.legR, rigidBone: B.RightLeg },
    ],
    (x, y, z) => Math.min(bootsUnionBind(x, y, z), trousersSdf(x, y, z), y),
  );
  const skinMesh = yield* assembleSteps(
    'skin',
    [
      { surface: head, frame: null, rigidBone: -1 },
      { surface: hand, frame: LIMB_FRAMES.armL, rigidBone: -1 },
      { surface: mirrored(hand), frame: LIMB_FRAMES.armR, rigidBone: -1 },
    ],
    (x, y, z) => Math.min(headSdf(x, y, z), handsUnionBind(x, y, z), jacketSdf(x, y, z)),
  );
  const meshes: Record<GarmentName, SkinnedMeshData> = { jacket: jacketMesh, trousers: trouserMesh, boots: bootMesh, skin: skinMesh };
  return {
    detail,
    meshes,
    triangleCount: jacketMesh.triangleCount + trouserMesh.triangleCount + bootMesh.triangleCount + skinMesh.triangleCount,
    pieceTriangles: {
      jacket: jacket.triangleCount,
      trousers: trousers.triangleCount,
      boot: boot.triangleCount,
      head: head.triangleCount,
      hand: hand.triangleCount,
    },
    buildMs: now() - t0,
    evaluations: spent,
  };
}

/** Incremental (time-sliceable) builder for the garment meshes of one detail level. Memoised on completion. */
export interface CharacterMeshBuilder {
  readonly detail: CharacterDetailLevel;
  /** Advances the build for up to `budgetMs`; returns true once `result` is available. */
  step(budgetMs: number): boolean;
  readonly result: CharacterMeshes | null;
}

export function createCharacterMeshBuilder(detail: CharacterDetailLevel): CharacterMeshBuilder {
  let result: CharacterMeshes | null = cache.get(detail) ?? null;
  const it = result ? null : buildSteps(detail);
  let workMs = 0;
  return {
    detail,
    get result() {
      return result;
    },
    step(budgetMs: number): boolean {
      if (result || !it) return true;
      const start = now();
      for (;;) {
        const r = it.next();
        if (r.done) {
          workMs += now() - start;
          result = { ...r.value, buildMs: workMs };
          cache.set(detail, result);
          return true;
        }
        if (now() - start >= budgetMs) {
          workMs += now() - start;
          return false;
        }
      }
    },
  };
}

/** Builds (or returns the memoised) garment meshes synchronously. */
export function buildCharacterMeshes(detail: CharacterDetailLevel): CharacterMeshes {
  const builder = createCharacterMeshBuilder(detail);
  builder.step(Number.POSITIVE_INFINITY);
  return builder.result as CharacterMeshes;
}

/** Releases memoised CPU-side mesh data (e.g. after a tier change). */
export function clearCharacterMeshCache(): void {
  cache.clear();
}

/** Stores meshes built elsewhere (the build worker) so later builders of this detail level start complete. */
export function primeCharacterMeshCache(meshes: CharacterMeshes): void {
  cache.set(meshes.detail, meshes);
}
