import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { scrollStore, smoothstep, type GpuTier } from '../../store/scrollStore';
import { sceneFx } from '../fx/sceneFx';
import { adaptiveQuality } from '../perf/adaptiveQuality';
import {
  createHorizonPeakMaterial,
  createTileableNoiseTexture,
  horizonShaderQualityFor,
} from '../shaders/HorizonPeakShader';
import {
  createValleyMistGeometry,
  createValleyMistMaterial,
  maxMistLayersForTier,
  MIST_HEIGHT_ENCODING,
  VALLEY_MIST_FIELD,
} from '../shaders/ValleyMistShader';
import { skirtHeight } from './terrainGeometry';
import { NEXT_MOUNTAIN, SUN_DIRECTION, ZONES } from './worldLayout';

/* ==========================================================================
 * The horizon range — THE NEXT MOUNTAIN plus eight flanking peaks.
 *
 * One colossal, continuous massif dead ahead (summit NEXT_MOUNTAIN.summit),
 * built from sharp arêtes that all meet in a single dominant summit: east and
 * west skyline ridges with broad snowy shoulders, a north ridge, three front
 * buttresses with couloirs between them, hanging glaciers on the faces and a
 * stepped, sun-lit "journey ridge" the eye can climb from the lower right to
 * the top. Eight lower peaks (z within ZONES.horizon) spread wide on both
 * sides, overlapping in depth, so the hero sits centred and dominant.
 *
 * The whole range is ONE heightfield on a graded grid (fine where the hero
 * is, coarser toward the wings), displaced with slope-following erosion noise
 * (gullies run down the fall line) and ridged FBM crags. Cast shadows toward
 * the low sun, horizon-based ambient occlusion, gully concavity and glacier
 * masks are baked per vertex. Everything is deterministic and built once per
 * GPU tier; the build is time-sliced inside useFrame (a few ms per frame) and
 * the result is attached imperatively — no React state, no re-render.
 *
 * Layered valley mist (ValleyMistShader) pools between the peaks; its soft
 * terrain contact uses a height map baked from this range plus the skirt.
 * ========================================================================== */

const { damp } = THREE.MathUtils;
const TAU = Math.PI * 2;

/* ---------------------------------------------------------------------------
 * Deterministic noise
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

const PERM = new Uint8Array(512);
const GRAD_X = new Float32Array(256);
const GRAD_Z = new Float32Array(256);
{
  const rand = mulberry32(0x7a11e4);
  const p: number[] = [];
  for (let i = 0; i < 256; i += 1) p.push(i);
  for (let i = 255; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i += 1) PERM[i] = p[i & 255];
  for (let i = 0; i < 256; i += 1) {
    const a = rand() * TAU;
    GRAD_X[i] = Math.cos(a);
    GRAD_Z[i] = Math.sin(a);
  }
}

/** 2D gradient noise, roughly in [-1, 1]. */
function noise2(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const X = ix & 255;
  const Z = iz & 255;
  const a = PERM[X + PERM[Z]];
  const b = PERM[X + 1 + PERM[Z]];
  const c = PERM[X + PERM[Z + 1]];
  const d = PERM[X + 1 + PERM[Z + 1]];
  const n00 = GRAD_X[a] * fx + GRAD_Z[a] * fz;
  const n10 = GRAD_X[b] * (fx - 1) + GRAD_Z[b] * fz;
  const n01 = GRAD_X[c] * fx + GRAD_Z[c] * (fz - 1);
  const n11 = GRAD_X[d] * (fx - 1) + GRAD_Z[d] * (fz - 1);
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return (nx0 + (nx1 - nx0) * v) * 1.41;
}

function hashCell(ix: number, iz: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Slope-following erosion noise (after Clay John's "eroded terrain" filter):
 * every cell contributes a cosine wave that varies along `dir` (the
 * perpendicular of the slope gradient), so the stripes — gullies and ribs —
 * run down the fall line. Writes [value, d/dx, d/dz] (value in ≈[-1, 1]).
 */
function erosion(px: number, pz: number, dirX: number, dirZ: number, out: Float64Array): void {
  const ix = Math.floor(px);
  const iz = Math.floor(pz);
  const fx = px - ix;
  const fz = pz - iz;
  let v = 0;
  let gx = 0;
  let gz = 0;
  let wt = 0;
  for (let j = -1; j <= 1; j += 1) {
    for (let i = -1; i <= 1; i += 1) {
      const h = hashCell(ix + i, iz + j);
      const jx = ((h & 0xffff) / 65535 - 0.5) * 0.6;
      const jz = ((h >>> 16) / 65535 - 0.5) * 0.6;
      const ppx = fx - i - 0.5 - jx;
      const ppz = fz - j - 0.5 - jz;
      const d2 = ppx * ppx + ppz * ppz;
      const w = Math.exp(-d2 * 2.2);
      wt += w;
      const mag = (ppx * dirX + ppz * dirZ) * TAU;
      const s = Math.sin(mag);
      v += Math.cos(mag) * w;
      gx -= s * dirX * w;
      gz -= s * dirZ * w;
    }
  }
  out[0] = v / wt;
  out[1] = gx / wt;
  out[2] = gz / wt;
}

/* ---------------------------------------------------------------------------
 * Range definition
 * ------------------------------------------------------------------------- */

type P3 = readonly [number, number, number];

interface RidgeDef {
  /** Crest polyline [x, crestY, z]. */
  points: readonly P3[];
  /** Height lost per unit of horizontal distance right next to the crest. */
  cross: number;
  /** Distance over which the flanks flatten out (concave mountain profile). */
  flatten: number;
}

interface Ridge {
  xs: Float64Array;
  ys: Float64Array;
  zs: Float64Array;
  invLen2: Float64Array;
  count: number;
  cross: number;
  invFlatten: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Radius over which ridge crests are rounded (anti-aliasing of the sharp V). */
const CREST_ROUND = 0.7;
/** Valley floor the range rises from (deep in the valley mist, out of frame). */
const FLOOR_Y = -86;
/** Quads entirely below this are always hidden under mist and below frame. */
const CULL_Y = -78;

/** Heightfield extent (the flanking wings taper to the floor before the edges). */
export const HORIZON_EXTENT = {
  x0: -440,
  x1: 440,
  z0: -350,
  z1: -130,
} as const;

const S = NEXT_MOUNTAIN.summit;

/** The next mountain, as arêtes that all meet in the summit. */
const HERO_RIDGES: readonly RidgeDef[] = [
  // The journey ridge: a stepped, sun-catching line rising from the lower right to the summit.
  {
    points: [
      S,
      [4, 106, -226],
      [9, 94.5, -217.5],
      [13, 89, -212.5],
      [18, 78, -205],
      [25, 58, -196],
      [33, 34, -187],
      [43, 8, -177],
      [57, -40, -163],
    ],
    cross: 1.75,
    flatten: 150,
  },
  // East skyline ridge with the broad, snowy east shoulder.
  {
    points: [S, [20, 107, -240], [44, 92, -244], [66, 85, -241], [88, 72, -234], [110, 44, -224], [134, 4, -212], [160, -40, -198]],
    cross: 1.6,
    flatten: 160,
  },
  // West skyline ridge with its fore-summit.
  {
    points: [S, [-18, 105, -241], [-40, 91, -247], [-60, 86.5, -250], [-80, 74, -246], [-104, 45, -236], [-130, 6, -222], [-156, -40, -206]],
    cross: 1.6,
    flatten: 160,
  },
  // North ridge, falling away behind the summit.
  { points: [S, [4, 100, -262], [10, 64, -292], [14, 8, -318], [16, -40, -336]], cross: 1.6, flatten: 160 },
  // South-west buttress off the west ridge.
  { points: [[-40, 91, -247], [-46, 72, -228], [-53, 47, -210], [-61, 16, -194], [-72, -30, -177]], cross: 1.9, flatten: 140 },
  // Front-left rib between the journey ridge and the SW buttress.
  { points: [[-6, 104, -231], [-13, 82, -216], [-19, 60, -204], [-26, 33, -192], [-35, -8, -179]], cross: 2.0, flatten: 130 },
  // East-face rib off the east ridge.
  { points: [[44, 92, -244], [57, 72, -229], [70, 48, -215], [84, 17, -202], [99, -30, -188]], cross: 1.95, flatten: 130 },
];

interface FlankSpec {
  x: number;
  y: number;
  z: number;
  /** Horizontal length of the longest arms. */
  reach: number;
  arms: number;
  /** Orientation of the first arm (radians from +z, toward +x). */
  rot: number;
  cross: number;
  seed: number;
}

/** Eight flanking peaks, lower than the hero, spread wide and overlapping in depth. */
const FLANKS: readonly FlankSpec[] = [
  { x: -104, y: 78, z: -186, reach: 78, arms: 3, rot: 0.35, cross: 1.75, seed: 11 },
  { x: 114, y: 84, z: -192, reach: 82, arms: 3, rot: -0.4, cross: 1.7, seed: 23 },
  { x: -162, y: 100, z: -258, reach: 95, arms: 4, rot: 0.2, cross: 1.6, seed: 37 },
  { x: 168, y: 106, z: -256, reach: 98, arms: 4, rot: -0.15, cross: 1.6, seed: 41 },
  { x: -236, y: 88, z: -214, reach: 88, arms: 3, rot: 0.6, cross: 1.65, seed: 53 },
  { x: 240, y: 75, z: -198, reach: 82, arms: 3, rot: -0.7, cross: 1.7, seed: 67 },
  { x: -322, y: 104, z: -252, reach: 100, arms: 4, rot: 0.1, cross: 1.55, seed: 71 },
  { x: 326, y: 92, z: -238, reach: 95, arms: 3, rot: -0.3, cross: 1.6, seed: 89 },
];

function flankRidgeDefs(f: FlankSpec): RidgeDef[] {
  const rand = mulberry32(f.seed * 7919 + 13);
  const defs: RidgeDef[] = [];
  const drop = f.y - FLOOR_Y;
  const fractions = [0.16, 0.38, 0.66, 1];
  for (let a = 0; a < f.arms; a += 1) {
    const theta = f.rot + (a / f.arms) * TAU + (rand() - 0.5) * 0.7;
    const len = f.reach * (0.72 + 0.5 * rand());
    const bend = (rand() - 0.5) * 0.6;
    const heights = [0.1 + 0.07 * rand(), 0.3 + 0.1 * rand(), 0.6 + 0.1 * rand(), 1.02];
    const points: P3[] = [[f.x, f.y, f.z]];
    for (let k = 0; k < fractions.length; k += 1) {
      const ang = theta + bend * fractions[k];
      const r = len * fractions[k];
      points.push([f.x + Math.sin(ang) * r, f.y - drop * heights[k], f.z + Math.cos(ang) * r]);
    }
    defs.push({ points, cross: f.cross * (0.88 + 0.26 * rand()), flatten: 170 });
  }
  return defs;
}

function compileRidge(def: RidgeDef): Ridge {
  const n = def.points.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const zs = new Float64Array(n);
  const invLen2 = new Float64Array(Math.max(1, n - 1));
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let crestMax = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const [x, y, z] = def.points[i];
    xs[i] = x;
    ys[i] = y;
    zs[i] = z;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
    crestMax = Math.max(crestMax, y);
  }
  for (let i = 0; i < n - 1; i += 1) {
    const dx = xs[i + 1] - xs[i];
    const dz = zs[i + 1] - zs[i];
    invLen2[i] = 1 / Math.max(1e-6, dx * dx + dz * dz);
  }
  // Horizontal distance beyond which the flank is certainly below the floor.
  const delta = crestMax - FLOOR_Y + 30;
  const asymptote = def.cross - delta / def.flatten;
  const reach = asymptote > 0.05 ? Math.min(420, delta / asymptote) : 420;
  return {
    xs,
    ys,
    zs,
    invLen2,
    count: n,
    cross: def.cross,
    invFlatten: 1 / def.flatten,
    minX: minX - reach,
    maxX: maxX + reach,
    minZ: minZ - reach,
    maxZ: maxZ + reach,
  };
}

function ridgeHeight(r: Ridge, x: number, z: number): number {
  if (x < r.minX || x > r.maxX || z < r.minZ || z > r.maxZ) return -1e9;
  let best = -1e9;
  for (let i = 0; i < r.count - 1; i += 1) {
    const ax = r.xs[i];
    const az = r.zs[i];
    const abx = r.xs[i + 1] - ax;
    const abz = r.zs[i + 1] - az;
    let t = ((x - ax) * abx + (z - az) * abz) * r.invLen2[i];
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (ax + abx * t);
    const dz = z - (az + abz * t);
    // Crest rounded over ~0.7 units so the arête never aliases into sawteeth.
    const d = Math.sqrt(dx * dx + dz * dz + CREST_ROUND * CREST_ROUND) - CREST_ROUND;
    const crest = r.ys[i] + (r.ys[i + 1] - r.ys[i]) * t;
    const h = crest - (r.cross * d) / (1 + d * r.invFlatten);
    if (h > best) best = h;
  }
  return best;
}

/** Polynomial smooth maximum (k = blend width in world units). */
function smax(a: number, b: number, k: number): number {
  const diff = Math.abs(a - b);
  const m = a > b ? a : b;
  if (diff >= k) return m;
  const h = (k - diff) / k;
  return m + h * h * k * 0.25;
}

interface FlankRuntime {
  spec: FlankSpec;
  ridges: Ridge[];
  bound: number;
}

const HERO = HERO_RIDGES.map(compileRidge);
const FLANK_RUNTIME: readonly FlankRuntime[] = FLANKS.map((spec) => ({
  spec,
  ridges: flankRidgeDefs(spec).map(compileRidge),
  bound: spec.reach * 2.4 + 80,
}));

/** Every summit of the range (hero first), used for detail masks. */
const SUMMITS: ReadonlyArray<{ x: number; z: number; radius: number }> = [
  { x: S[0], z: S[2], radius: 24 },
  ...FLANKS.map((f) => ({ x: f.x, z: f.z, radius: 15 })),
];

function heroBody(x: number, z: number): number {
  const dx = x - S[0];
  const dz = (z - (S[2] - 3)) / 0.56;
  const r = Math.sqrt(dx * dx + dz * dz);
  return 92 - (1.65 * r) / (1 + r / 240);
}

function floorAt(x: number, z: number): number {
  return FLOOR_Y + noise2(x * 0.011 + 4.1, z * 0.011 - 2.3) * 7;
}

function edgeMask(x: number, z: number): number {
  const E = HORIZON_EXTENT;
  const dSide = Math.min(x - E.x0, E.x1 - x);
  const dBack = z - E.z0;
  const dFront = E.z1 - z;
  return smoothstep(0, 85, dSide) * smoothstep(0, 40, dBack) * smoothstep(0, 22, dFront);
}

/** Large-form height of the range (before erosion detail). Pure and deterministic. */
export function horizonBaseHeight(x: number, z: number): number {
  const dS = Math.hypot(x - S[0], z - S[2]);
  // Arêtes meet in a crisp point: almost no blending right at the summit.
  const kSummit = 1 + 4 * smoothstep(0, 34, dS);
  let ridges = -1e9;
  for (let i = 0; i < HERO.length; i += 1) {
    const h = ridgeHeight(HERO[i], x, z);
    ridges = ridges < -1e8 ? h : smax(ridges, h, kSummit);
  }
  let h = smax(heroBody(x, z), ridges, 7);

  for (let f = 0; f < FLANK_RUNTIME.length; f += 1) {
    const fr = FLANK_RUNTIME[f];
    if (Math.abs(x - fr.spec.x) > fr.bound || Math.abs(z - fr.spec.z) > fr.bound) continue;
    const dP = Math.hypot(x - fr.spec.x, z - fr.spec.z);
    const kPeak = 1 + 3.5 * smoothstep(0, 24, dP);
    let fh = fr.spec.y - 20 - (1.35 * dP) / (1 + dP / 200);
    for (let i = 0; i < fr.ridges.length; i += 1) {
      fh = smax(fh, ridgeHeight(fr.ridges[i], x, z), kPeak);
    }
    h = smax(h, fh, 11);
  }

  const floor = floorAt(x, z);
  h = smax(h, floor, 14);
  return floor + (h - floor) * edgeMask(x, z);
}

/* Hanging glaciers / snowfields: benches with a serac edge on the hero's faces. */
interface ShelfDef {
  x: number;
  z: number;
  rx: number;
  rz: number;
  /** Lift of the shelf surface above the face at its centre. */
  lift: number;
  /** Surface slope down the fall line. */
  tilt: number;
}

const SHELF_DEFS: readonly ShelfDef[] = [
  { x: -27, z: -219, rx: 15, rz: 10, lift: 4, tilt: 0.42 },
  { x: 30, z: -224, rx: 14, rz: 10, lift: 4, tilt: 0.4 },
  { x: -62, z: -236, rx: 18, rz: 11, lift: 3.5, tilt: 0.35 },
  { x: 70, z: -233, rx: 16, rz: 11, lift: 3.5, tilt: 0.35 },
  { x: 11, z: -207, rx: 9, rz: 7, lift: 2.5, tilt: 0.3 },
  { x: -84, z: -214, rx: 12, rz: 9, lift: 3, tilt: 0.4 },
];

interface Shelf extends ShelfDef {
  y0: number;
  downX: number;
  downZ: number;
}

const SHELVES: readonly Shelf[] = SHELF_DEFS.map((def) => {
  const e = 1.5;
  const y0 = horizonBaseHeight(def.x, def.z);
  const gx = (horizonBaseHeight(def.x + e, def.z) - horizonBaseHeight(def.x - e, def.z)) / (2 * e);
  const gz = (horizonBaseHeight(def.x, def.z + e) - horizonBaseHeight(def.x, def.z - e)) / (2 * e);
  const len = Math.hypot(gx, gz) || 1;
  return { ...def, y0: y0 + def.lift, downX: -gx / len, downZ: -gz / len };
});

const shelfScratch = { bulge: 0, mask: 0 };

/** Glacier bulge above `h` at (x, z); writes the bulge height and a 0..1 glacier mask. */
function shelfAt(x: number, z: number, h: number): void {
  let bulge = 0;
  let mask = 0;
  for (let i = 0; i < SHELVES.length; i += 1) {
    const s = SHELVES[i];
    const ex = (x - s.x) / s.rx;
    const ez = (z - s.z) / s.rz;
    const e2 = ex * ex + ez * ez;
    if (e2 >= 1) continue;
    const m = 1 - smoothstep(0.45, 1, Math.sqrt(e2));
    const along = (x - s.x) * s.downX + (z - s.z) * s.downZ;
    const surface = s.y0 - s.tilt * along;
    const above = surface - h;
    if (above <= 0) continue;
    const b = above * (1 - smoothstep(9, 14, above)) * m;
    if (b > bulge) bulge = b;
    const gm = m * smoothstep(0.3, 2.5, above) * (1 - smoothstep(12, 15, above));
    if (gm > mask) mask = gm;
  }
  shelfScratch.bulge = bulge;
  shelfScratch.mask = mask;
}

function summitDetailMask(x: number, z: number): number {
  let m = 1;
  for (let i = 0; i < SUMMITS.length; i += 1) {
    const s = SUMMITS[i];
    const d = Math.hypot(x - s.x, z - s.z);
    if (d < s.radius) m = Math.min(m, smoothstep(2, s.radius, d));
  }
  return m;
}

const erosionOut = new Float64Array(3);

/**
 * Erosion detail on top of the base: slope-following gullies (several
 * octaves, each bent by the previous ones) carved into the faces, a little
 * ridged roughness and broad undulation. `crest` (0..1) protects arêtes so
 * skylines stay clean lines instead of sawteeth.
 */
function detailHeight(
  x: number,
  z: number,
  gx: number,
  gz: number,
  base: number,
  crest: number,
  octaves: number,
): number {
  const slope = Math.hypot(gx, gz);
  const amp0 =
    5.4 *
    smoothstep(0.2, 0.95, slope) *
    smoothstep(-82, -48, base) *
    summitDetailMask(x, z) *
    (1 - 0.8 * crest);
  if (amp0 < 1e-3) return 0;
  let h = 0;
  let ax = gx;
  let az = gz;
  let amp = amp0;
  let freq = 1 / 26;
  for (let o = 0; o < octaves; o += 1) {
    // Perpendicular of the accumulated gradient: stripes run down the fall line.
    const len = Math.hypot(ax, az) || 1;
    const k = Math.min(1.35, Math.max(0.65, len)) / len;
    erosion(x * freq, z * freq, az * k, -ax * k, erosionOut);
    // Biased toward carving: gullies cut in, ribs stay near the large form.
    h += (erosionOut[0] - 0.4) * amp;
    ax += erosionOut[1] * amp * freq * TAU * 0.35;
    az += erosionOut[2] * amp * freq * TAU * 0.35;
    amp *= 0.46;
    freq *= 2.05;
  }
  const r1 = 1 - Math.abs(noise2(x * 0.045 + 3.1, z * 0.045 - 1.7));
  const r2 = 1 - Math.abs(noise2(x * 0.1 - 5.3, z * 0.1 + 2.9));
  const rough = (r1 * r1 - 0.45) * 1.1 + (r2 * r2 - 0.45) * 0.45;
  const broad = noise2(x * 0.013 - 7.7, z * 0.013 + 1.9) * 4.5;
  return h + (rough + broad) * (amp0 / 5.4);
}

/* ---------------------------------------------------------------------------
 * Graded grid
 * ------------------------------------------------------------------------- */

export interface HorizonDetail {
  /** Multiplier on the authored grid spacing (1 = finest). */
  scale: number;
  /** Erosion octaves. */
  octaves: number;
  /** Maximum sun-shadow march steps per vertex. */
  shadowSteps: number;
}

const DETAIL_BY_TIER: Readonly<Record<GpuTier, HorizonDetail>> = {
  3: { scale: 1, octaves: 4, shadowSteps: 56 },
  2: { scale: 1.38, octaves: 4, shadowSteps: 48 },
  1: { scale: 1.95, octaves: 3, shadowSteps: 40 },
  0: { scale: 2.75, octaves: 3, shadowSteps: 32 },
};

export function horizonDetailForTier(tier: GpuTier): HorizonDetail {
  return DETAIL_BY_TIER[tier];
}

/** Column spacing: finest across the hero, growing toward the wings. */
function spacingX(x: number): number {
  const a = Math.abs(x);
  return a < 140 ? 1 : 1 + (a - 140) / 95;
}

/** Row spacing: finest over the faces seen from the climb (z ≈ -250 … -158). */
function spacingZ(z: number): number {
  if (z > -158) return 0.75 * (1 + (z + 158) / 18);
  if (z >= -250) return 0.75;
  return 0.75 * (1 + (-250 - z) / 40);
}

function buildAxis(min: number, max: number, spacingAt: (v: number) => number): Float64Array {
  const values: number[] = [min];
  let v = min;
  for (;;) {
    const s = spacingAt(v);
    if (v + s >= max - 0.35 * s) {
      values.push(max);
      break;
    }
    v += s;
    values.push(v);
  }
  return Float64Array.from(values);
}

/** Fractional index lookup (axis value → index) at a fixed resolution. */
function indexTable(axis: Float64Array, res: number): Float32Array {
  const min = axis[0];
  const max = axis[axis.length - 1];
  const n = Math.ceil((max - min) * res) + 1;
  const table = new Float32Array(n);
  let j = 0;
  for (let t = 0; t < n; t += 1) {
    const v = Math.min(max, min + t / res);
    while (j < axis.length - 2 && axis[j + 1] < v) j += 1;
    const f = (v - axis[j]) / (axis[j + 1] - axis[j]);
    table[t] = j + (f < 0 ? 0 : f > 1 ? 1 : f);
  }
  return table;
}

/* ---------------------------------------------------------------------------
 * Builder
 * ------------------------------------------------------------------------- */

export interface HorizonBuildStats {
  columns: number;
  rows: number;
  vertices: number;
  triangles: number;
  culledQuads: number;
  buildMs: number;
  /** Highest vertex of the range (should be the hero summit). */
  peak: [number, number, number];
}

export interface HorizonHeightMap {
  data: Uint8Array;
  width: number;
  height: number;
  /** World x0, z0 and inverse width / depth, for uv = (xz - origin) * inv. */
  rect: [number, number, number, number];
}

export interface HorizonBuildResult {
  geometry: THREE.BufferGeometry;
  heightMap: HorizonHeightMap;
  stats: HorizonBuildStats;
}

let lastStats: HorizonBuildStats | null = null;

/** Stats of the most recent finished build (for harnesses / audits). */
export function lastHorizonBuildStats(): HorizonBuildStats | null {
  return lastStats;
}

/** Mutable build settings: CPU ms spent on the build per frame (Infinity = all at once). */
export const horizonBuildSettings = {
  frameBudgetMs: 4,
};

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const SUN_H_LEN = Math.hypot(SUN_DIRECTION.x, SUN_DIRECTION.z);
const SUN_HX = SUN_DIRECTION.x / SUN_H_LEN;
const SUN_HZ = SUN_DIRECTION.z / SUN_H_LEN;
const SUN_TAN = SUN_DIRECTION.y / SUN_H_LEN;

const AO_DIRS = 8;
/** Grid steps either side used to measure crestness of the large form. */
const CREST_STEP = 4;
const AO_RADII = [4, 11, 26, 52] as const;
const MIST_MAP_W = 256;
const MIST_MAP_H = 64;

function* buildHorizon(detail: HorizonDetail): Generator<void, HorizonBuildResult, void> {
  const start = now();
  const E = HORIZON_EXTENT;
  const xs = buildAxis(E.x0, E.x1, (x) => spacingX(x) * detail.scale);
  const zs = buildAxis(E.z0, E.z1, (z) => spacingZ(z) * detail.scale);
  const nx = xs.length;
  const nz = zs.length;
  const count = nx * nz;

  // 1. Large forms.
  const base = new Float32Array(count);
  for (let k = 0; k < nz; k += 1) {
    const z = zs[k];
    const row = k * nx;
    for (let i = 0; i < nx; i += 1) base[row + i] = horizonBaseHeight(xs[i], z);
    if ((k & 3) === 3) yield;
  }

  // 2. Erosion detail + hanging glaciers.
  const height = new Float32Array(count);
  const glacier = new Float32Array(count);
  for (let k = 0; k < nz; k += 1) {
    const z = zs[k];
    const k0 = Math.max(0, k - 1);
    const k1 = Math.min(nz - 1, k + 1);
    for (let i = 0; i < nx; i += 1) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(nx - 1, i + 1);
      const idx = k * nx + i;
      const gx = (base[k * nx + i1] - base[k * nx + i0]) / (xs[i1] - xs[i0]);
      const gz = (base[k1 * nx + i] - base[k0 * nx + i]) / (zs[k1] - zs[k0]);
      const b = base[idx];
      const x = xs[i];
      // Crestness: how sharply the large form falls away on both sides (≈ cross slope on an arête).
      const ia = Math.max(0, i - CREST_STEP);
      const ib = Math.min(nx - 1, i + CREST_STEP);
      const ka = Math.max(0, k - CREST_STEP);
      const kb = Math.min(nz - 1, k + CREST_STEP);
      const sx = (xs[ib] - xs[ia]) * 0.5;
      const sz = (zs[kb] - zs[ka]) * 0.5;
      const convexX = sx > 0 ? (b - (base[k * nx + ia] + base[k * nx + ib]) * 0.5) / sx : 0;
      const convexZ = sz > 0 ? (b - (base[ka * nx + i] + base[kb * nx + i]) * 0.5) / sz : 0;
      const crest = smoothstep(0.25, 1.1, Math.max(convexX, convexZ, (convexX + convexZ) * 0.75));
      shelfAt(x, z, b);
      const g = shelfScratch.mask;
      const d = detailHeight(x, z, gx, gz, b, crest, detail.octaves);
      height[idx] = b + d * (1 - 0.8 * g) + shelfScratch.bulge;
      glacier[idx] = g;
    }
    if ((k & 1) === 1) yield;
  }

  // 3. Normals from the final heights.
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  let peakIdx = 0;
  for (let k = 0; k < nz; k += 1) {
    const k0 = Math.max(0, k - 1);
    const k1 = Math.min(nz - 1, k + 1);
    for (let i = 0; i < nx; i += 1) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(nx - 1, i + 1);
      const idx = k * nx + i;
      const h = height[idx];
      if (h > height[peakIdx]) peakIdx = idx;
      const dhdx = (height[k * nx + i1] - height[k * nx + i0]) / (xs[i1] - xs[i0]);
      const dhdz = (height[k1 * nx + i] - height[k0 * nx + i]) / (zs[k1] - zs[k0]);
      const inv = 1 / Math.sqrt(dhdx * dhdx + 1 + dhdz * dhdz);
      positions[idx * 3] = xs[i];
      positions[idx * 3 + 1] = h;
      positions[idx * 3 + 2] = zs[k];
      normals[idx * 3] = -dhdx * inv;
      normals[idx * 3 + 1] = inv;
      normals[idx * 3 + 2] = -dhdz * inv;
    }
    if ((k & 15) === 15) yield;
  }

  // Bilinear sampler over the graded grid.
  const RES = 4;
  const tableX = indexTable(xs, RES);
  const tableZ = indexTable(zs, RES);
  const sample = (x: number, z: number): number => {
    if (x <= E.x0 || x >= E.x1 || z <= E.z0 || z >= E.z1) return FLOOR_Y - 10;
    const fx = tableX[Math.round((x - E.x0) * RES)];
    const fz = tableZ[Math.round((z - E.z0) * RES)];
    let i = Math.floor(fx);
    let k = Math.floor(fz);
    if (i > nx - 2) i = nx - 2;
    if (k > nz - 2) k = nz - 2;
    const tx = fx - i;
    const tz = fz - k;
    const a = height[k * nx + i];
    const b = height[k * nx + i + 1];
    const c = height[(k + 1) * nx + i];
    const d = height[(k + 1) * nx + i + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  };

  // 4. Bake sun visibility, ambient occlusion, concavity and glacier mask.
  const bake = new Uint8Array(count * 4);
  const aoCos = new Float64Array(AO_DIRS);
  const aoSin = new Float64Array(AO_DIRS);
  for (let d = 0; d < AO_DIRS; d += 1) {
    aoCos[d] = Math.cos((d / AO_DIRS) * TAU + 0.2);
    aoSin[d] = Math.sin((d / AO_DIRS) * TAU + 0.2);
  }
  for (let k = 0; k < nz; k += 1) {
    const z = zs[k];
    for (let i = 0; i < nx; i += 1) {
      const idx = k * nx + i;
      const x = xs[i];
      const h = height[idx];
      const out = idx * 4;
      if (h < CULL_Y - 6) {
        bake[out] = 128;
        bake[out + 1] = 90;
        bake[out + 2] = 140;
        bake[out + 3] = 0;
        continue;
      }

      // Soft cast shadow toward the sun (penumbra widens with distance).
      let vis = 1;
      let t = 1.5;
      for (let s = 0; s < detail.shadowSteps; s += 1) {
        const sx = x + SUN_HX * t;
        const sz = z + SUN_HZ * t;
        if (sx <= E.x0 || sx >= E.x1 || sz <= E.z0 || sz >= E.z1) break;
        const ray = h + 0.8 + SUN_TAN * t;
        const terrain = sample(sx, sz);
        const v = (7 * (ray - terrain)) / t;
        if (v < vis) vis = v;
        if (vis <= 0) break;
        if (ray > 125) break;
        t += Math.max(1.4, t * 0.085);
      }
      vis = vis < 0 ? 0 : vis > 1 ? 1 : vis;
      vis = vis * vis * (3 - 2 * vis);

      // Horizon-based ambient occlusion.
      let occ = 0;
      for (let d = 0; d < AO_DIRS; d += 1) {
        let maxTan = 0;
        for (let r = 0; r < AO_RADII.length; r += 1) {
          const radius = AO_RADII[r];
          const tan = (sample(x + aoCos[d] * radius, z + aoSin[d] * radius) - h) / radius;
          if (tan > maxTan) maxTan = tan;
        }
        occ += maxTan / Math.sqrt(1 + maxTan * maxTan);
      }
      const ao = Math.max(0.12, 1 - (occ / AO_DIRS) * 1.15);

      // Concavity at gully scale (positive = gully, negative = rib / crest).
      const lap4 = (sample(x + 4, z) + sample(x - 4, z) + sample(x, z + 4) + sample(x, z - 4)) * 0.25 - h;
      const lap12 = (sample(x + 12, z) + sample(x - 12, z) + sample(x, z + 12) + sample(x, z - 12)) * 0.25 - h;
      const conc = Math.max(-0.5, Math.min(0.5, lap4 * 0.2 + lap12 * 0.05));

      bake[out] = Math.round(vis * 255);
      bake[out + 1] = Math.round(ao * 255);
      bake[out + 2] = Math.round((0.5 + conc) * 255);
      bake[out + 3] = Math.round(glacier[idx] * 255);
    }
    if ((k & 1) === 1) yield;
  }

  // 5. Triangles (diagonal along the smaller height step keeps arêtes crisp).
  const quads = (nx - 1) * (nz - 1);
  const indexScratch = new Uint32Array(quads * 6);
  let n = 0;
  let culled = 0;
  for (let k = 0; k < nz - 1; k += 1) {
    for (let i = 0; i < nx - 1; i += 1) {
      const a = k * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      const ha = height[a];
      const hb = height[b];
      const hc = height[c];
      const hd = height[d];
      if (ha < CULL_Y && hb < CULL_Y && hc < CULL_Y && hd < CULL_Y) {
        culled += 1;
        continue;
      }
      if (Math.abs(ha - hd) < Math.abs(hb - hc)) {
        indexScratch[n++] = a;
        indexScratch[n++] = c;
        indexScratch[n++] = d;
        indexScratch[n++] = a;
        indexScratch[n++] = d;
        indexScratch[n++] = b;
      } else {
        indexScratch[n++] = a;
        indexScratch[n++] = c;
        indexScratch[n++] = b;
        indexScratch[n++] = b;
        indexScratch[n++] = c;
        indexScratch[n++] = d;
      }
    }
    if ((k & 31) === 31) yield;
  }

  // 6. Terrain height map for the valley mist's soft contact (range + skirt).
  const F = VALLEY_MIST_FIELD;
  const mistData = new Uint8Array(MIST_MAP_W * MIST_MAP_H);
  const W = F.x1 - F.x0;
  const D = F.z1 - F.z0;
  for (let j = 0; j < MIST_MAP_H; j += 1) {
    const z = F.z0 + ((j + 0.5) / MIST_MAP_H) * D;
    for (let i = 0; i < MIST_MAP_W; i += 1) {
      const x = F.x0 + ((i + 0.5) / MIST_MAP_W) * W;
      const ground = Math.max(sample(x, z), skirtHeight(x, z));
      const enc = ((ground - MIST_HEIGHT_ENCODING.min) / MIST_HEIGHT_ENCODING.range) * 255;
      mistData[i + j * MIST_MAP_W] = Math.max(0, Math.min(255, Math.round(enc)));
    }
    if ((j & 7) === 7) yield;
  }

  // 7. Geometry.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('aBake', new THREE.BufferAttribute(bake, 4, true));
  geometry.setIndex(new THREE.BufferAttribute(indexScratch.slice(0, n), 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const stats: HorizonBuildStats = {
    columns: nx,
    rows: nz,
    vertices: count,
    triangles: n / 3,
    culledQuads: culled,
    buildMs: now() - start,
    peak: [positions[peakIdx * 3], positions[peakIdx * 3 + 1], positions[peakIdx * 3 + 2]],
  };
  return {
    geometry,
    heightMap: { data: mistData, width: MIST_MAP_W, height: MIST_MAP_H, rect: [F.x0, F.z0, 1 / W, 1 / D] },
    stats,
  };
}

export interface HorizonBuilder {
  readonly done: boolean;
  readonly result: HorizonBuildResult | null;
  /** Runs the build for up to `budgetMs`; returns true on the call that finishes it. */
  step: (budgetMs: number) => boolean;
}

export function createHorizonBuilder(detail: HorizonDetail): HorizonBuilder {
  const iterator = buildHorizon(detail);
  let done = false;
  let result: HorizonBuildResult | null = null;
  return {
    get done() {
      return done;
    },
    get result() {
      return result;
    },
    step(budgetMs: number): boolean {
      if (done) return false;
      const begin = now();
      for (;;) {
        const r = iterator.next();
        if (r.done) {
          result = r.value;
          done = true;
          lastStats = r.value.stats;
          return true;
        }
        if (now() - begin >= budgetMs) return false;
      }
    },
  };
}

/** Builds the whole range synchronously (Node checks, tests). */
export function buildHorizonRangeSync(detail: HorizonDetail): HorizonBuildResult {
  const builder = createHorizonBuilder(detail);
  builder.step(Number.POSITIVE_INFINITY);
  if (!builder.result) throw new Error('Horizon build did not finish');
  return builder.result;
}

/* ---------------------------------------------------------------------------
 * Component
 * ------------------------------------------------------------------------- */

/** Alpenglow strength: the next mountain catches the last warm light at the summit. */
function alpenglowAt(progress: number): number {
  return 0.66 + 0.34 * smoothstep(0.62, 0.9, progress);
}

interface RangeState {
  builder: HorizonBuilder | null;
  mesh: THREE.Mesh | null;
  heightTexture: THREE.DataTexture | null;
  reveal: number;
  mistCount: number;
  alpenglow: number;
  initialised: boolean;
}

export function HorizonRange(): JSX.Element {
  const tier = scrollStore.gpuTier;
  const maxLayers = maxMistLayersForTier(tier);
  const group = useRef<THREE.Group>(null);
  const mist = useRef<THREE.Mesh>(null);

  const resources = useMemo(() => {
    const noise = createTileableNoiseTexture(256, 8, 0x0be5a11);
    const peakMaterial = createHorizonPeakMaterial(noise, horizonShaderQualityFor(tier));
    const placeholder = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
    placeholder.needsUpdate = true;
    const mistMaterial = createValleyMistMaterial(noise, placeholder, tier >= 2 ? 1 : 0);
    const mistGeometry = createValleyMistGeometry(maxLayers);
    return { noise, peakMaterial, placeholder, mistMaterial, mistGeometry };
  }, [tier, maxLayers]);

  useLayoutEffect(
    () => () => {
      resources.peakMaterial.dispose();
      resources.mistMaterial.dispose();
      resources.mistGeometry.dispose();
      resources.placeholder.dispose();
      resources.noise.dispose();
    },
    [resources],
  );

  const state = useRef<RangeState>({
    builder: null,
    mesh: null,
    heightTexture: null,
    reveal: 0,
    mistCount: 0,
    alpenglow: 0.66,
    initialised: false,
  });

  useEffect(() => {
    const s = state.current;
    s.builder = createHorizonBuilder(horizonDetailForTier(tier));
    s.reveal = 0;
    s.mistCount = 0;
    resources.peakMaterial.uniforms.uReveal.value = 0;
    resources.mistMaterial.uniforms.uOpacity.value = 0;
    const owner = group.current;
    return () => {
      if (s.mesh) {
        owner?.remove(s.mesh);
        s.mesh.geometry.dispose();
        s.mesh = null;
      }
      if (s.heightTexture) {
        resources.mistMaterial.uniforms.uHeight.value = resources.placeholder;
        s.heightTexture.dispose();
        s.heightTexture = null;
      }
      s.builder = null;
    };
  }, [tier, resources]);

  useFrame((root, delta) => {
    const g = group.current;
    const mistMesh = mist.current;
    if (!g || !mistMesh) return;
    const s = state.current;
    const pu = resources.peakMaterial.uniforms;
    const mu = resources.mistMaterial.uniforms;

    if (s.builder && !s.builder.done && s.builder.step(horizonBuildSettings.frameBudgetMs)) {
      const result = s.builder.result;
      if (result) {
        const mesh = new THREE.Mesh(result.geometry, resources.peakMaterial);
        mesh.name = 'horizon-peaks';
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.updateMatrixWorld();
        g.add(mesh);
        s.mesh = mesh;
        const hm = result.heightMap;
        const texture = new THREE.DataTexture(hm.data, hm.width, hm.height, THREE.RedFormat, THREE.UnsignedByteType);
        texture.magFilter = THREE.LinearFilter;
        texture.minFilter = THREE.LinearFilter;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.colorSpace = THREE.NoColorSpace;
        texture.needsUpdate = true;
        s.heightTexture = texture;
        mu.uHeight.value = texture;
        mu.uHeightRect.value.set(hm.rect[0], hm.rect[1], hm.rect[2], hm.rect[3]);
      }
    }

    const p = scrollStore.dampedProgress;
    if (!s.initialised) {
      s.alpenglow = alpenglowAt(p);
      s.initialised = true;
    }
    const ready = s.mesh !== null;
    s.reveal = damp(s.reveal, ready ? 1 : 0, 1.8, delta);
    if (s.reveal > 0.999) s.reveal = 1;
    s.alpenglow = damp(s.alpenglow, alpenglowAt(p), 1.5, delta);

    // Follow the scene's linear fog if the experience animates it.
    const fog = root.scene.fog;
    if (fog instanceof THREE.Fog) {
      pu.uFogColor.value.copy(fog.color);
      pu.uFogNear.value = fog.near;
      pu.uFogFar.value = fog.far;
      mu.uFogColor.value.copy(fog.color);
      mu.uFogNear.value = fog.near;
      mu.uFogFar.value = fog.far;
    }

    const time = scrollStore.elapsed;
    pu.uReveal.value = s.reveal;
    pu.uAlpenglow.value = s.alpenglow;
    pu.uTime.value = time;

    // Mist layers follow the adaptive particle density (last layer cross-fades).
    const target = ready ? adaptiveQuality.countFor(maxLayers, Math.min(2, maxLayers)) : 0;
    s.mistCount = damp(s.mistCount, target, 2.5, delta);
    if (Math.abs(s.mistCount - target) < 1e-3) s.mistCount = target;
    const drawn = Math.min(maxLayers, Math.ceil(s.mistCount - 0.002));
    resources.mistGeometry.instanceCount = Math.max(0, drawn);
    mu.uCount.value = s.mistCount;
    mu.uOpacity.value = s.reveal;
    mu.uTime.value = time;
    mistMesh.visible = s.reveal > 0.01 && drawn > 0;

    // Scene 10 void: nothing left to draw.
    g.visible = sceneFx.exposure > 0.002;
  });

  return (
    <group ref={group} name="horizon-range" userData={{ zNear: ZONES.horizon.zNear, zFar: ZONES.horizon.zFar }}>
      <mesh
        ref={mist}
        name="valley-mist"
        geometry={resources.mistGeometry}
        material={resources.mistMaterial}
        frustumCulled={false}
      />
    </group>
  );
}

export default HorizonRange;
