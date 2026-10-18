import * as THREE from 'three';
import type { GpuTier } from '../../store/scrollStore';
import { PATH_PHASES, WAYPOINTS, protagonistPositionAt } from '../protagonistPath';

/* ==========================================================================
 * Terrain geometry — PURE module (no React, no DOM; runs in Node).
 *
 * The climbable massif is a signed distance field (negative = inside rock):
 *   ground  : a large heightfield mountain body (ridges, valleys, carved gorges)
 *   masses  : base-camp mesa, Company-1 cliff buttress, Company-2 pillar and
 *             the summit pyramid — each shaped directly from the climb route so
 *             the rock face sits just behind the climber and every standing
 *             waypoint has a surface right under the feet.
 *   detail  : world-space FBM / ridged ribs / stepped strata displacement,
 *             suppressed close to the route so clearances stay controlled.
 *
 * Inside a bounded "massif domain" the field is polygonised with naive surface
 * nets on a sparse brick grid (only bricks near the surface are evaluated).
 * Outside the domain the ground heightfield continues as a graded-resolution
 * skirt mesh that overlaps the domain edge slightly, so there are no cracks.
 *
 * Everything is deterministic (fixed seeds) and built once per detail level.
 * ========================================================================== */

export type TerrainDetail = 'high' | 'medium' | 'low';

export interface TerrainPiece {
  /** Stable name, e.g. `massif-1-0-2` or `skirt`. */
  name: string;
  /** World-space, indexed geometry with `position`, `normal` and `aOcclusion` (0..1). */
  geometry: THREE.BufferGeometry;
  kind: 'massif' | 'skirt';
  triangles: number;
}

/** World-space Y of the rock surface directly under each standing waypoint. */
export const STANDING_SURFACE_Y = {
  baseCamp: 0,
  firstLedge: 17.75,
  chasmOneLanding: 21.92,
  chasmOneTop: 31.85,
  summit: 54.9,
} as const;

/** Bounds of the finely polygonised massif (outside it only the skirt exists). */
export const MASSIF_DOMAIN = {
  x0: -28,
  x1: 28,
  y0: -40,
  y1: 58,
  z0: -62,
  z1: 18,
} as const;

/** Extent of the outer skirt heightfield (fully fogged at its edges). */
export const SKIRT_EXTENT = {
  x0: -460,
  x1: 460,
  z0: -430,
  z1: 300,
} as const;

interface DetailConfig {
  /** Surface-net cell size (world units). */
  cell: number;
  /** Include the finest displacement octave. */
  fineNoise: boolean;
  /** Skirt grid spacing next to the massif domain. */
  skirtNear: number;
  /** Geometric growth of skirt spacing away from the domain. */
  skirtGrowth: number;
  /** Spacing of the coarse field used for baked ambient occlusion. */
  aoSpacing: number;
}

const DETAIL_CONFIG: Readonly<Record<TerrainDetail, DetailConfig>> = {
  high: { cell: 0.3, fineNoise: true, skirtNear: 0.75, skirtGrowth: 1.045, aoSpacing: 1.9 },
  medium: { cell: 0.42, fineNoise: true, skirtNear: 1.05, skirtGrowth: 1.06, aoSpacing: 2.1 },
  low: { cell: 0.62, fineNoise: false, skirtNear: 1.6, skirtGrowth: 1.085, aoSpacing: 2.5 },
};

/** Terrain detail for a GPU tier (tier 0 never renders WebGL; it maps to low). */
export function terrainDetailForTier(tier: GpuTier): TerrainDetail {
  if (tier >= 3) return 'high';
  if (tier === 2) return 'medium';
  return 'low';
}

/* ==========================================================================
 * Math helpers
 * ========================================================================== */

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Polynomial smooth minimum (IQ). */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function smax(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

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

/* ==========================================================================
 * Gradient noise (Perlin "improved"), deterministic permutation.
 * ========================================================================== */

const PERM = new Uint8Array(512);
(() => {
  const rand = mulberry32(0x5eed1e55);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) p[i] = i;
  for (let i = 255; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i += 1) PERM[i] = p[i & 255];
})();

function grad3(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

/** 3D gradient noise, roughly in [-1, 1]. */
export function noise3(xIn: number, yIn: number, zIn: number): number {
  const fx = Math.floor(xIn);
  const fy = Math.floor(yIn);
  const fz = Math.floor(zIn);
  const x = xIn - fx;
  const y = yIn - fy;
  const z = zIn - fz;
  const X = fx & 255;
  const Y = fy & 255;
  const Z = fz & 255;
  const u = x * x * x * (x * (x * 6 - 15) + 10);
  const v = y * y * y * (y * (y * 6 - 15) + 10);
  const w = z * z * z * (z * (z * 6 - 15) + 10);
  const A = PERM[X] + Y;
  const AA = PERM[A] + Z;
  const AB = PERM[A + 1] + Z;
  const B = PERM[X + 1] + Y;
  const BA = PERM[B] + Z;
  const BB = PERM[B + 1] + Z;
  const x1 = x - 1;
  const y1 = y - 1;
  const z1 = z - 1;
  const g000 = grad3(PERM[AA], x, y, z);
  const g100 = grad3(PERM[BA], x1, y, z);
  const g010 = grad3(PERM[AB], x, y1, z);
  const g110 = grad3(PERM[BB], x1, y1, z);
  const g001 = grad3(PERM[AA + 1], x, y, z1);
  const g101 = grad3(PERM[BA + 1], x1, y, z1);
  const g011 = grad3(PERM[AB + 1], x, y1, z1);
  const g111 = grad3(PERM[BB + 1], x1, y1, z1);
  const a0 = g000 + u * (g100 - g000);
  const a1 = g010 + u * (g110 - g010);
  const a2 = g001 + u * (g101 - g001);
  const a3 = g011 + u * (g111 - g011);
  const b0 = a0 + v * (a1 - a0);
  const b1 = a2 + v * (a3 - a2);
  return b0 + w * (b1 - b0);
}

function grad2(hash: number, x: number, y: number): number {
  switch (hash & 7) {
    case 0:
      return x + y;
    case 1:
      return -x + y;
    case 2:
      return x - y;
    case 3:
      return -x - y;
    case 4:
      return 1.4142 * x;
    case 5:
      return -1.4142 * x;
    case 6:
      return 1.4142 * y;
    default:
      return -1.4142 * y;
  }
}

/** 2D gradient noise, roughly in [-1, 1]. */
export function noise2(xIn: number, yIn: number): number {
  const fx = Math.floor(xIn);
  const fy = Math.floor(yIn);
  const x = xIn - fx;
  const y = yIn - fy;
  const X = fx & 255;
  const Y = fy & 255;
  const u = x * x * x * (x * (x * 6 - 15) + 10);
  const v = y * y * y * (y * (y * 6 - 15) + 10);
  const A = PERM[X] + Y;
  const B = PERM[X + 1] + Y;
  const g00 = grad2(PERM[A], x, y);
  const g10 = grad2(PERM[B], x - 1, y);
  const g01 = grad2(PERM[A + 1], x, y - 1);
  const g11 = grad2(PERM[B + 1], x - 1, y - 1);
  const a0 = g00 + u * (g10 - g00);
  const a1 = g01 + u * (g11 - g01);
  return (a0 + v * (a1 - a0)) * 0.72;
}

/* ==========================================================================
 * Route tables — the climb route sampled as functions of height.
 * ========================================================================== */

interface RouteTable {
  y0: number;
  y1: number;
  step: number;
  xs: Float64Array;
  zs: Float64Array;
  /** dz/dy and dx/dy at the low end, for extrapolating below the table. */
  slopeZ0: number;
  slopeX0: number;
}

function buildRouteTable(pStart: number, pEnd: number): RouteTable {
  const samples = 4000;
  const ys: number[] = [];
  const xs: number[] = [];
  const zs: number[] = [];
  const v = new THREE.Vector3();
  let lastY = -Infinity;
  for (let i = 0; i <= samples; i += 1) {
    const p = pStart + ((pEnd - pStart) * i) / samples;
    protagonistPositionAt(Math.min(p, pEnd - 1e-7), v);
    if (v.y > lastY + 1e-6) {
      ys.push(v.y);
      xs.push(v.x);
      zs.push(v.z);
      lastY = v.y;
    }
  }
  const y0 = ys[0];
  const y1 = ys[ys.length - 1];
  const step = 0.02;
  const n = Math.ceil((y1 - y0) / step) + 1;
  const outX = new Float64Array(n);
  const outZ = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    const y = Math.min(y1, y0 + i * step);
    while (j < ys.length - 2 && ys[j + 1] < y) j += 1;
    const t = clamp((y - ys[j]) / Math.max(1e-9, ys[j + 1] - ys[j]), 0, 1);
    outX[i] = xs[j] + (xs[j + 1] - xs[j]) * t;
    outZ[i] = zs[j] + (zs[j + 1] - zs[j]) * t;
  }
  // Start tangent from the first ~0.6 units of climb.
  const k = Math.min(n - 1, Math.round(0.6 / step));
  const dy = k * step;
  return {
    y0,
    y1,
    step,
    xs: outX,
    zs: outZ,
    slopeZ0: (outZ[k] - outZ[0]) / dy,
    slopeX0: (outX[k] - outX[0]) / dy,
  };
}

const ROUTE_ASCENT = buildRouteTable(PATH_PHASES.ascentStart, PATH_PHASES.ascentEnd);
const ROUTE_PILLAR = buildRouteTable(PATH_PHASES.jumpOneEnd, PATH_PHASES.climbOneEnd);
const ROUTE_SCRAMBLE = buildRouteTable(PATH_PHASES.leapTwoEnd, PATH_PHASES.scrambleEnd);

function routeZ(t: RouteTable, y: number): number {
  if (y <= t.y0) return t.zs[0] + t.slopeZ0 * (y - t.y0);
  if (y >= t.y1) return t.zs[t.zs.length - 1];
  const f = (y - t.y0) / t.step;
  const i = Math.floor(f);
  const a = t.zs[i];
  return a + (t.zs[Math.min(i + 1, t.zs.length - 1)] - a) * (f - i);
}

function routeX(t: RouteTable, y: number): number {
  if (y <= t.y0) return t.xs[0] + t.slopeX0 * (y - t.y0);
  if (y >= t.y1) return t.xs[t.xs.length - 1];
  const f = (y - t.y0) / t.step;
  const i = Math.floor(f);
  const a = t.xs[i];
  return a + (t.xs[Math.min(i + 1, t.xs.length - 1)] - a) * (f - i);
}

/* ==========================================================================
 * Ground / skirt heightfield — the mountain body.
 * ========================================================================== */

interface RidgeSpec {
  /** Polyline of [x, crestHeight, z]. */
  points: ReadonlyArray<readonly [number, number, number]>;
  /** Cross-slope (height lost per unit of horizontal distance from the crest). */
  cross: number;
}

const RIDGES: readonly RidgeSpec[] = [
  // South-west arête: frames base camp on the left and climbs to the summit shoulder.
  { points: [[-7, 31, -33], [-24, 9, -17], [-58, -30, 10], [-130, -92, 46]], cross: 1.2 },
  // South-east spur beyond the first canyon.
  { points: [[9, 26, -31], [31, 3, -21], [70, -38, 2], [140, -95, 34]], cross: 1.25 },
  // North ridge falling toward the horizon reveal (seen from the summit).
  { points: [[1, 27, -49], [8, -2, -82], [18, -48, -124], [26, -100, -176]], cross: 1.15 },
  // North-west and north-east shoulders.
  { points: [[-10, 24, -45], [-46, -12, -76], [-110, -76, -112]], cross: 1.3 },
  { points: [[12, 23, -43], [52, -14, -70], [118, -82, -104]], cross: 1.3 },
  // Southern spur that supports the base-camp outcrop.
  { points: [[0, -9, 9], [1, -27, 30], [-7, -62, 72], [-12, -104, 124]], cross: 1.3 },
  // Far flanking ranges that give the valleys depth.
  { points: [[-150, -40, -40], [-210, -10, -150], [-260, -30, -260]], cross: 0.9 },
  { points: [[160, -45, -30], [230, -15, -140], [290, -35, -250]], cross: 0.9 },
];

interface GorgeCapsule {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  r: number;
}

/** Horizontal footprints carved down to the misty gorge floor. */
const GORGES: readonly GorgeCapsule[] = [
  // Chasm 1 slot canyon, opening to the south-east.
  { ax: -3.5, az: -15.8, bx: 15, bz: -0.4, r: 2.3 },
  // Chasm 2 abyss between the pillar and the summit massif, running west.
  { ax: -13, az: -21.5, bx: 8.5, bz: -21.5, r: 4.6 },
  // Join between the two around the pillar's north-west foot.
  { ax: 1, az: -17, bx: 4, bz: -22, r: 2.6 },
];

const GORGE_FLOOR = -27;
const VALLEY_FLOOR = -118;

function ridgeHeight(r: RidgeSpec, x: number, z: number): number {
  let best = -1e9;
  const pts = r.points;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    const abx = b[0] - a[0];
    const abz = b[2] - a[2];
    const len2 = abx * abx + abz * abz;
    const t = clamp(((x - a[0]) * abx + (z - a[2]) * abz) / len2, 0, 1);
    const dx = x - (a[0] + abx * t);
    const dz = z - (a[2] + abz * t);
    const d = Math.sqrt(dx * dx + dz * dz);
    const h = a[1] + (b[1] - a[1]) * t - r.cross * d - 0.006 * d * d;
    if (h > best) best = h;
  }
  return best;
}

function gorgeDistance(x: number, z: number): number {
  let best = 1e9;
  for (let i = 0; i < GORGES.length; i += 1) {
    const g = GORGES[i];
    const abx = g.bx - g.ax;
    const abz = g.bz - g.az;
    const t = clamp(((x - g.ax) * abx + (z - g.az) * abz) / (abx * abx + abz * abz), 0, 1);
    const dx = x - (g.ax + abx * t);
    const dz = z - (g.az + abz * t);
    const d = Math.sqrt(dx * dx + dz * dz) - g.r;
    if (d < best) best = d;
  }
  return best;
}

/** Ridged 2D fbm in [0, ~1]. */
function ridged2(x: number, z: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i += 1) {
    const n = 1 - Math.abs(noise2(x * freq + i * 17.3, z * freq - i * 9.1));
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/**
 * Height of the mountain body / outer skirt at (x, z). Shared by the skirt mesh
 * and the massif field so both agree exactly along the domain edge.
 */
export function skirtHeight(x: number, z: number): number {
  // Broad cone centred under the summit.
  const cx = x;
  const cz = z + 36;
  const r = Math.sqrt(cx * cx + cz * cz);
  let h = 34 - 1.15 * r + 0.0009 * r * r;

  for (let i = 0; i < RIDGES.length; i += 1) {
    h = smax(h, ridgeHeight(RIDGES[i], x, z), 7);
  }

  // Erosion-like detail: big gullies, then finer ribs. Calmer inside the massif core.
  const core = smoothstep(18, 46, r);
  const big = ridged2(x * 0.021, z * 0.021, 3) - 0.42;
  const mid = noise2(x * 0.071 + 3.1, z * 0.071 - 7.7);
  const fine = noise2(x * 0.19 - 1.7, z * 0.19 + 4.4);
  h += (0.35 + 0.65 * core) * (big * 16 + mid * 3.2) + fine * (0.6 + 0.4 * core);

  // Valley floors far below, softly levelled.
  h = smax(h, VALLEY_FLOOR + noise2(x * 0.012, z * 0.012) * 6, 14);

  // Carve the gorges between the climbing blocks down into the mist.
  const g = gorgeDistance(x, z);
  if (g < 22) {
    h = smin(h, GORGE_FLOOR + Math.max(0, g) * 2.7 + noise2(x * 0.3, z * 0.3) * 0.8, 5);
  }
  return h;
}

/* ==========================================================================
 * Massif masses
 * ========================================================================== */

/** Chasm-1 jump direction (ledge 1 → ledge 2) in xz, and the canyon centre. */
const JX = 5 / Math.hypot(5, 6);
const JZ = -6 / Math.hypot(5, 6);
const CANYON_CX = 2.5;
const CANYON_CZ = -11;

function canyonHalfWidth(y: number): number {
  return Math.max(1.05, 3 - 0.075 * Math.max(0, 15 - y));
}

function canyonCoord(x: number, z: number): number {
  return JX * (x - CANYON_CX) + JZ * (z - CANYON_CZ);
}

const SY = STANDING_SURFACE_Y;

/** Lip positions (z) of the faces right in front of each standing waypoint. */
const LEDGE_ONE_LIP_Z = WAYPOINTS.firstLedge[2] + 0.24;
const PILLAR_LIP_Z = WAYPOINTS.chasmOneTop[2] + 0.2;
const SUMMIT_LIP_Z = WAYPOINTS.summit[2] + 0.05;

/** Face of the Company-1 wall: z of the rock surface at (x, y). */
function cliffOneFaceZ(x: number, y: number): number {
  const yc = Math.min(y, SY.firstLedge);
  let z = routeZ(ROUTE_ASCENT, yc) - 0.8;
  // The face swings forward into a crisp lip just in front of the standing point.
  z += (LEDGE_ONE_LIP_Z - z) * smoothstep(17.0, 17.45, y);
  // Plan shape: recedes toward the canyon arête on the right, steps forward on the left.
  if (x > 1.5) z -= 0.055 * (x - 1.5) * (x - 1.5);
  if (x < -1.8) z += Math.min(3.4, 0.34 * (-1.8 - x));
  return z;
}

function cliffOneTopY(x: number): number {
  return SY.firstLedge + Math.max(0, -x - 1.9) * 0.95;
}

function mesaSdf(x: number, y: number, z: number): number {
  const ex = x / 7.4;
  const ez = (z - 2.7) / 4.6;
  const el = Math.sqrt(ex * ex + ez * ez);
  // Steep rocky rim that flares out with depth.
  const side = (el - 1) * 5.4 - Math.min(Math.max(0, -y), 14) * 0.48;
  // Flat standing area, gentle undulation, raised rocky rim.
  const dStand = Math.sqrt(x * x + (z - 0.6) * (z - 0.6));
  const flatMask = smoothstep(2.2, 3.8, dStand);
  const rim = smoothstep(0.66, 0.98, el) * (0.22 + 0.3 * (0.5 + 0.5 * noise2(x * 0.7, z * 0.7)));
  const undulate = 0.07 * noise2(x * 0.45 + 4, z * 0.45);
  const top = y - flatMask * (undulate + rim);
  return smax(side, top, 0.55);
}

function cliffOneSdf(x: number, y: number, z: number): number {
  const face = (z - cliffOneFaceZ(x, y)) * 0.9;
  const back = canyonCoord(x, z) + canyonHalfWidth(y);
  const west = -(x + 15.5);
  const body = Math.max(face, back, west);
  return smax(body, y - cliffOneTopY(x), 0.14);
}

function pillarFaceZ(y: number): number {
  const yc = clamp(y, ROUTE_PILLAR.y0, SY.chasmOneTop);
  const z = routeZ(ROUTE_PILLAR, yc) - 0.56;
  return z + (PILLAR_LIP_Z - z) * smoothstep(31.2, 31.6, y);
}

function pillarSdf(x: number, y: number, z: number): number {
  const canyonBack = canyonHalfWidth(y) - canyonCoord(x, z);
  const dx = x - 5.7;
  const dz = z + 15.9;
  const radius = 2.9 + 0.12 * Math.max(0, SY.chasmOneLanding - y);
  const circ = Math.sqrt(dx * dx + dz * dz) - radius;
  const lower = Math.max(circ, canyonBack, y - SY.chasmOneLanding);

  const face = (z - pillarFaceZ(y)) * 0.95;
  const sideX = Math.abs(x - 5.1) - 2.0;
  const back = -(z + 19.6);
  const tower = Math.max(face, sideX, back, y - SY.chasmOneTop, 20.5 - y);
  return smin(lower, tower, 0.22);
}

interface PyramidPlane {
  nx: number;
  ny: number;
  nz: number;
  d: number;
}

/** Facets of the summit pyramid: outward horizontal direction, slope angle, offset at the top. */
const PYRAMID: readonly PyramidPlane[] = (
  [
    [0.98, -0.2, 64, 0.72],
    [0.5, -0.87, 70, 0.66],
    [-0.55, -0.83, 68, 0.62],
    [-0.97, 0.1, 61, 0.66],
    [-0.72, 0.7, 56, 2.8],
    [0.74, 0.67, 59, 2.0],
  ] as const
).map(([hx, hz, deg, r0]) => {
  const l = Math.hypot(hx, hz);
  const a = (deg * Math.PI) / 180;
  const sx = (hx / l) * Math.sin(a);
  const sz = (hz / l) * Math.sin(a);
  const cy = Math.cos(a);
  // Plane through the point at horizontal distance r0 from the summit axis at the platform height.
  const px = (hx / l) * r0;
  const pz = WAYPOINTS.summit[2] + (hz / l) * r0;
  const py = SY.summit;
  return { nx: sx, ny: cy, nz: sz, d: -(sx * px + cy * py + sz * pz) };
});

function summitFaceZ(x: number, y: number): number {
  let z: number;
  const lipY = WAYPOINTS.chasmTwoCatch[1];
  const lipZ = routeZ(ROUTE_SCRAMBLE, lipY) - 0.55;
  if (y >= lipY) {
    z = routeZ(ROUTE_SCRAMBLE, Math.min(y, 54.75)) - 0.55;
    z += (SUMMIT_LIP_Z - z) * smoothstep(53.9, 54.75, y);
  } else {
    // Undercut directly below the catch lip, then a sheer wall that flares at its foot.
    z = lipZ - 0.42 * smoothstep(lipY, lipY - 1.4, y) + 0.3 * clamp(26 - y, 0, 20);
  }
  if (x > 1.8) z -= 0.18 * (x - 1.8) * (x - 1.8);
  if (x < -5.4) z -= 0.15 * (-5.4 - x) * (-5.4 - x);
  return z;
}

function summitSdf(x: number, y: number, z: number): number {
  let d = y - SY.summit;
  for (let i = 0; i < PYRAMID.length; i += 1) {
    const p = PYRAMID[i];
    const s = p.nx * x + p.ny * y + p.nz * z + p.d;
    if (s > d) d = s;
  }
  const south = (z - summitFaceZ(x, y)) * 0.86;
  return Math.max(d, south);
}

/* ---------------------------------------------------------------------------
 * Detail displacement and its suppression near the route.
 * ------------------------------------------------------------------------- */

interface StandSpot {
  x: number;
  y: number;
  z: number;
}

const STAND_SPOTS: readonly StandSpot[] = [
  { x: WAYPOINTS.baseCamp[0], y: SY.baseCamp, z: WAYPOINTS.baseCamp[2] },
  { x: WAYPOINTS.firstLedge[0], y: SY.firstLedge, z: WAYPOINTS.firstLedge[2] },
  { x: WAYPOINTS.chasmOneLanding[0], y: SY.chasmOneLanding, z: WAYPOINTS.chasmOneLanding[2] },
  { x: WAYPOINTS.chasmOneTop[0], y: SY.chasmOneTop, z: WAYPOINTS.chasmOneTop[2] },
  { x: WAYPOINTS.chasmTwoCatch[0], y: WAYPOINTS.chasmTwoCatch[1] - 0.2, z: WAYPOINTS.chasmTwoCatch[2] - 0.5 },
  { x: WAYPOINTS.summit[0], y: SY.summit, z: WAYPOINTS.summit[2] },
];

/** 0 → no displacement (standing spots), ~0.22 along climbing lines, 1 → full detail. */
function detailMask(x: number, y: number, z: number): number {
  let dRoute = 1e9;
  if (y > -1.5 && y < 19.5) {
    const dx = x - routeX(ROUTE_ASCENT, y);
    const dz = z - routeZ(ROUTE_ASCENT, y);
    dRoute = Math.min(dRoute, Math.sqrt(dx * dx + dz * dz));
  }
  if (y > 20.5 && y < 33.5) {
    const dx = x - routeX(ROUTE_PILLAR, y);
    const dz = z - routeZ(ROUTE_PILLAR, y);
    dRoute = Math.min(dRoute, Math.sqrt(dx * dx + dz * dz));
  }
  if (y > 38.5 && y < 56.5) {
    const dx = x - routeX(ROUTE_SCRAMBLE, y);
    const dz = z - routeZ(ROUTE_SCRAMBLE, y);
    dRoute = Math.min(dRoute, Math.sqrt(dx * dx + dz * dz));
  }
  let dStand = 1e9;
  for (let i = 0; i < STAND_SPOTS.length; i += 1) {
    const s = STAND_SPOTS[i];
    const dy = y - s.y;
    if (dy > -2.6 && dy < 3) {
      const ddx = x - s.x;
      const ddz = z - s.z;
      const d = Math.sqrt(ddx * ddx + ddz * ddz);
      if (d < dStand) dStand = d;
    }
  }
  const routeAmp = 0.22 + 0.78 * smoothstep(1.0, 3.6, dRoute);
  const standAmp = smoothstep(1.5, 3.8, dStand);
  return Math.min(routeAmp, standAmp);
}

/** Upper bound of |displacement| (used to skip the noise far from any rock). */
const MAX_DISPLACEMENT = 2.9;

function displacement(x: number, y: number, z: number, fine: boolean): number {
  // Buttress-scale undulation.
  const n1 = noise3(x * 0.082, y * 0.082, z * 0.082) + 0.5 * noise3(x * 0.19 + 5.2, y * 0.19, z * 0.19 - 1.3);
  // Vertical ribs and grooves (granite jointing).
  const rr = noise3(x * 0.41 + 11.3, y * 0.085, z * 0.41 - 4.2);
  const rib = 1 - Math.abs(rr);
  // Stepped strata: quick inward step (ledge) then a slow outward lean.
  const u = y * 0.68 + n1 * 0.9;
  const f = u - Math.floor(u);
  const saw = f < 0.3 ? f / 0.3 : (1 - f) / 0.7;
  const strataAmp = 0.34 * smoothstep(-0.35, 0.45, noise3(x * 0.05 + 3, y * 0.035, z * 0.05));
  let d = 1.3 * n1 + 0.8 * (rib * rib - 0.42) + strataAmp * (saw - 0.5) * 2;
  if (fine) d += 0.2 * noise3(x * 0.95 - 2.1, y * 0.95, z * 0.95 + 7.7);
  return d;
}

/* ==========================================================================
 * The field
 * ========================================================================== */

interface GroundCache {
  x0: number;
  z0: number;
  h: number;
  nx: number;
  nz: number;
  height: Float32Array;
  slope: Float32Array;
}

function* buildGroundCache(x0: number, z0: number, h: number, nx: number, nz: number): Generator<void, GroundCache, void> {
  const height = new Float32Array((nx + 1) * (nz + 1));
  for (let k = 0; k <= nz; k += 1) {
    for (let i = 0; i <= nx; i += 1) height[i + (nx + 1) * k] = skirtHeight(x0 + i * h, z0 + k * h);
    if ((k & 7) === 7) yield;
  }
  const slope = new Float32Array((nx + 1) * (nz + 1));
  for (let k = 0; k <= nz; k += 1) {
    for (let i = 0; i <= nx; i += 1) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(nx, i + 1);
      const k0 = Math.max(0, k - 1);
      const k1 = Math.min(nz, k + 1);
      const gx = (height[i1 + (nx + 1) * k] - height[i0 + (nx + 1) * k]) / ((i1 - i0) * h);
      const gz = (height[i + (nx + 1) * k1] - height[i + (nx + 1) * k0]) / ((k1 - k0) * h);
      slope[i + (nx + 1) * k] = 1 / Math.sqrt(1 + gx * gx + gz * gz);
    }
  }
  return { x0, z0, h, nx, nz, height, slope };
}

function groundTerm(cache: GroundCache | null, x: number, y: number, z: number): number {
  if (!cache) {
    const e = 0.25;
    const hc = skirtHeight(x, z);
    const gx = (skirtHeight(x + e, z) - skirtHeight(x - e, z)) / (2 * e);
    const gz = (skirtHeight(x, z + e) - skirtHeight(x, z - e)) / (2 * e);
    return (y - hc) / Math.sqrt(1 + gx * gx + gz * gz);
  }
  const fx = clamp((x - cache.x0) / cache.h, 0, cache.nx - 1e-6);
  const fz = clamp((z - cache.z0) / cache.h, 0, cache.nz - 1e-6);
  const i = Math.floor(fx);
  const k = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - k;
  const w = cache.nx + 1;
  const o = i + w * k;
  const H = cache.height;
  const S = cache.slope;
  const h00 = H[o];
  const h10 = H[o + 1];
  const h01 = H[o + w];
  const h11 = H[o + w + 1];
  const hh = (h00 + (h10 - h00) * tx) * (1 - tz) + (h01 + (h11 - h01) * tx) * tz;
  const s00 = S[o];
  const s10 = S[o + 1];
  const s01 = S[o + w];
  const s11 = S[o + w + 1];
  const ss = (s00 + (s10 - s00) * tx) * (1 - tz) + (s01 + (s11 - s01) * tx) * tz;
  return (y - hh) * ss;
}

const D = MASSIF_DOMAIN;

function massField(x: number, y: number, z: number, fine: boolean): number {
  let m = 1e9;
  // Base camp mesa.
  if (x > -19 && x < 19 && z > -8 && z < 17 && y < 4) m = mesaSdf(x, y, z);
  // Company-1 buttress.
  if (x > -20 && x < 16 && z > -26 && z < 9 && y < 36) m = smin(m, cliffOneSdf(x, y, z), 0.75);
  // Company-2 pillar.
  if (x > -6 && x < 18 && z > -26 && z < -6 && y < 35) m = Math.min(m, pillarSdf(x, y, z));
  // Summit massif.
  if (z < -16) m = smin(m, summitSdf(x, y, z), 1.1);

  // Masses melt into the ground body near the domain edge so the skirt can take over.
  const edge = Math.min(x - D.x0, D.x1 - x, z - D.z0, D.z1 - z);
  if (edge < 5) m += (5 - edge) * 3;

  if (m < MAX_DISPLACEMENT + 1.2 && m > -(MAX_DISPLACEMENT + 1.2)) {
    const mask = detailMask(x, y, z);
    if (mask > 0) m += displacement(x, y, z, fine) * mask;
  }
  return m;
}

function fieldAt(cache: GroundCache | null, x: number, y: number, z: number, fine: boolean): number {
  const g = groundTerm(cache, x, y, z);
  const m = massField(x, y, z, fine);
  return smin(g, m, 2.4);
}

/**
 * Signed distance (approximate, negative inside rock) of the climbable massif
 * at a world position, at full detail. Useful for placing effects near rock.
 */
export function mountainSdf(x: number, y: number, z: number): number {
  if (x < D.x0 || x > D.x1 || z < D.z0 || z > D.z1) return groundTerm(null, x, y, z);
  return fieldAt(null, x, y, z, true);
}

/* ==========================================================================
 * Sparse surface nets
 * ========================================================================== */

const BRICK = 8;
const BRICK_CELLS = BRICK * BRICK * BRICK;
/** Conservative Lipschitz bound of the field, used for the seeding march. */
const LIPSCHITZ = 2.4;

interface SurfaceMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

class GrowableF32 {
  data: Float32Array;
  length = 0;
  constructor(capacity: number) {
    this.data = new Float32Array(capacity);
  }
  push3(a: number, b: number, c: number): void {
    if (this.length + 3 > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length] = a;
    this.data[this.length + 1] = b;
    this.data[this.length + 2] = c;
    this.length += 3;
  }
}

class GrowableU32 {
  data: Uint32Array;
  length = 0;
  constructor(capacity: number) {
    this.data = new Uint32Array(capacity);
  }
  push(a: number): void {
    if (this.length + 1 > this.data.length) this.grow();
    this.data[this.length] = a;
    this.length += 1;
  }
  push3(a: number, b: number, c: number): void {
    if (this.length + 3 > this.data.length) this.grow();
    this.data[this.length] = a;
    this.data[this.length + 1] = b;
    this.data[this.length + 2] = c;
    this.length += 3;
  }
  private grow(): void {
    const next = new Uint32Array(this.data.length * 2);
    next.set(this.data);
    this.data = next;
  }
}

/** Corner offsets of a cell (bit 0 = x, bit 1 = y, bit 2 = z). */
const CORNER_X = [0, 1, 0, 1, 0, 1, 0, 1] as const;
const CORNER_Y = [0, 0, 1, 1, 0, 0, 1, 1] as const;
const CORNER_Z = [0, 0, 0, 0, 1, 1, 1, 1] as const;

/** The 12 cell edges as pairs of corner indices. */
const EDGE_A = [0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3] as const;
const EDGE_B = [1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7] as const;

/** Corner masks of the six cell faces and the matching neighbour offsets. */
const FACE_MASK = [0x55, 0xaa, 0x33, 0xcc, 0x0f, 0xf0] as const;
const FACE_DI = [-1, 1, 0, 0, 0, 0] as const;
const FACE_DJ = [0, 0, -1, 1, 0, 0] as const;
const FACE_DK = [0, 0, 0, 0, -1, 1] as const;

/**
 * Naive surface nets by surface following: seed cells are found by marching
 * down a sparse set of columns, then the connected iso-surface is traced cell
 * to cell. Field values are evaluated lazily once per grid point and stored in
 * sparse 8³ bricks, so the cost scales with surface area, not volume.
 */
function* polygonise(cache: GroundCache, cell: number, fine: boolean): Generator<void, SurfaceMesh, void> {
  const x0 = D.x0;
  const y0 = D.y0;
  const z0 = D.z0;
  const nx = Math.ceil((D.x1 - D.x0) / cell);
  const ny = Math.ceil((D.y1 - D.y0) / cell);
  const nz = Math.ceil((D.z1 - D.z0) / cell);
  const nbx = (nx >> 3) + 1;
  const nby = (ny >> 3) + 1;
  const nbz = (nz >> 3) + 1;

  const slot = new Int32Array(nbx * nby * nbz).fill(-1);
  const brickValues: Float32Array[] = [];
  const brickVertex: Int32Array[] = [];
  const brickVisited: Uint8Array[] = [];

  const brickFor = (i: number, j: number, k: number): number => {
    const b = (i >> 3) + nbx * ((j >> 3) + nby * (k >> 3));
    let s = slot[b];
    if (s < 0) {
      s = brickValues.length;
      slot[b] = s;
      brickValues.push(new Float32Array(BRICK_CELLS).fill(Number.NaN));
      brickVertex.push(new Int32Array(BRICK_CELLS).fill(-1));
      brickVisited.push(new Uint8Array(BRICK_CELLS));
    }
    return s;
  };

  const value = (i: number, j: number, k: number): number => {
    const s = brickFor(i, j, k);
    const local = (i & 7) + BRICK * ((j & 7) + BRICK * (k & 7));
    const vals = brickValues[s];
    let v = vals[local];
    if (v !== v) {
      v = fieldAt(cache, x0 + i * cell, y0 + j * cell, z0 + k * cell, fine);
      // Never exactly zero: keeps the sign test unambiguous.
      if (v === 0) v = 1e-6;
      vals[local] = v;
    }
    return v;
  };

  const queue = new GrowableU32(1 << 16);
  const pushCell = (i: number, j: number, k: number): void => {
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return;
    queue.push3(i, j, k);
  };

  // ---- Seeds: march down columns until the field turns negative.
  const seedStride = 5;
  for (let k = 0; k <= nz; k += seedStride) {
    for (let i = 0; i <= nx; i += seedStride) {
      const x = x0 + i * cell;
      const z = z0 + k * cell;
      let y = D.y1;
      let prevY = y;
      let f = fieldAt(cache, x, y, z, fine);
      while (f > 0 && y > D.y0) {
        prevY = y;
        y -= Math.max(cell, (f / LIPSCHITZ) * 0.9);
        f = fieldAt(cache, x, Math.max(D.y0, y), z, fine);
      }
      if (f > 0) continue;
      // Exact crossing on the grid column between prevY and y.
      let j = Math.min(ny, Math.ceil((prevY - y0) / cell));
      const jEnd = Math.max(0, Math.floor((y - y0) / cell) - 1);
      while (j > jEnd && value(i, j, k) > 0) j -= 1;
      if (j < 0 || j >= ny || value(i, j, k) > 0) continue;
      for (let dk = -1; dk <= 0; dk += 1) {
        for (let di = -1; di <= 0; di += 1) pushCell(i + di, j, k + dk);
      }
    }
    yield;
  }

  // ---- Trace the connected surface.
  const pos = new GrowableF32(1 << 18);
  const surfaceCells = new GrowableU32(1 << 18);
  const corner = new Float64Array(8);
  let head = 0;
  let traced = 0;
  while (head < queue.length) {
    traced += 1;
    if ((traced & 1023) === 0) yield;
    const ci = queue.data[head];
    const cj = queue.data[head + 1];
    const ck = queue.data[head + 2];
    head += 3;
    const s = brickFor(ci, cj, ck);
    const local = (ci & 7) + BRICK * ((cj & 7) + BRICK * (ck & 7));
    const visited = brickVisited[s];
    if (visited[local] !== 0) continue;
    visited[local] = 1;

    let mask = 0;
    for (let c = 0; c < 8; c += 1) {
      const v = value(ci + CORNER_X[c], cj + CORNER_Y[c], ck + CORNER_Z[c]);
      corner[c] = v;
      if (v < 0) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    visited[local] = 2;

    let sx = 0;
    let sy = 0;
    let sz = 0;
    let count = 0;
    for (let e = 0; e < 12; e += 1) {
      const a = EDGE_A[e];
      const b = EDGE_B[e];
      const va = corner[a];
      const vb = corner[b];
      if (va < 0 === vb < 0) continue;
      const t = va / (va - vb);
      sx += CORNER_X[a] + (CORNER_X[b] - CORNER_X[a]) * t;
      sy += CORNER_Y[a] + (CORNER_Y[b] - CORNER_Y[a]) * t;
      sz += CORNER_Z[a] + (CORNER_Z[b] - CORNER_Z[a]) * t;
      count += 1;
    }
    brickVertex[s][local] = pos.length / 3;
    pos.push3(x0 + (ci + sx / count) * cell, y0 + (cj + sy / count) * cell, z0 + (ck + sz / count) * cell);
    surfaceCells.push3(ci, cj, ck);

    for (let fIdx = 0; fIdx < 6; fIdx += 1) {
      const fm = FACE_MASK[fIdx];
      const m = mask & fm;
      if (m === 0 || m === fm) continue;
      pushCell(ci + FACE_DI[fIdx], cj + FACE_DJ[fIdx], ck + FACE_DK[fIdx]);
    }
    // Compact the queue occasionally so it never grows without bound.
    if (head > 3 << 20 && head * 2 > queue.length) {
      queue.data.copyWithin(0, head, queue.length);
      queue.length -= head;
      head = 0;
    }
  }

  const vertexAt = (i: number, j: number, k: number): number => {
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return -1;
    const s = slot[(i >> 3) + nbx * ((j >> 3) + nby * (k >> 3))];
    if (s < 0) return -1;
    return brickVertex[s][(i & 7) + BRICK * ((j & 7) + BRICK * (k & 7))];
  };

  // ---- Quads around every sign-changing grid edge leaving a cell's min corner.
  const idx = new GrowableU32(1 << 19);
  const p = pos.data;
  const emitQuad = (a: number, b: number, c: number, d: number, flip: boolean): void => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    const acx = p[c * 3] - p[a * 3];
    const acy = p[c * 3 + 1] - p[a * 3 + 1];
    const acz = p[c * 3 + 2] - p[a * 3 + 2];
    const bdx = p[d * 3] - p[b * 3];
    const bdy = p[d * 3 + 1] - p[b * 3 + 1];
    const bdz = p[d * 3 + 2] - p[b * 3 + 2];
    const splitAC = acx * acx + acy * acy + acz * acz <= bdx * bdx + bdy * bdy + bdz * bdz;
    if (!flip) {
      if (splitAC) {
        idx.push3(a, b, c);
        idx.push3(a, c, d);
      } else {
        idx.push3(a, b, d);
        idx.push3(b, c, d);
      }
    } else if (splitAC) {
      idx.push3(a, c, b);
      idx.push3(a, d, c);
    } else {
      idx.push3(a, d, b);
      idx.push3(b, d, c);
    }
  };

  const sc = surfaceCells.data;
  for (let n = 0; n < surfaceCells.length; n += 3) {
    if (n % 24576 === 0) yield;
    const ci = sc[n];
    const cj = sc[n + 1];
    const ck = sc[n + 2];
    const v0 = value(ci, cj, ck);
    const inside = v0 < 0;
    if (cj > 0 && ck > 0 && inside !== value(ci + 1, cj, ck) < 0) {
      emitQuad(vertexAt(ci, cj, ck), vertexAt(ci, cj - 1, ck), vertexAt(ci, cj - 1, ck - 1), vertexAt(ci, cj, ck - 1), !inside);
    }
    if (ci > 0 && ck > 0 && inside !== value(ci, cj + 1, ck) < 0) {
      emitQuad(vertexAt(ci, cj, ck), vertexAt(ci, cj, ck - 1), vertexAt(ci - 1, cj, ck - 1), vertexAt(ci - 1, cj, ck), !inside);
    }
    if (ci > 0 && cj > 0 && inside !== value(ci, cj, ck + 1) < 0) {
      emitQuad(vertexAt(ci, cj, ck), vertexAt(ci - 1, cj, ck), vertexAt(ci - 1, cj - 1, ck), vertexAt(ci, cj - 1, ck), !inside);
    }
  }

  const vertexCount = pos.length / 3;
  const positions = pos.data.slice(0, pos.length);
  const indices = idx.data.slice(0, idx.length);
  const normals = new Float32Array(vertexCount * 3);
  accumulateNormals(positions, indices, normals);
  return { positions, normals, indices, vertexCount, triangleCount: indices.length / 3 };
}

function accumulateNormals(positions: Float32Array, indices: Uint32Array, normals: Float32Array): void {
  normals.fill(0);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    normals[a] += nx;
    normals[a + 1] += ny;
    normals[a + 2] += nz;
    normals[b] += nx;
    normals[b + 1] += ny;
    normals[b + 2] += nz;
    normals[c] += nx;
    normals[c + 1] += ny;
    normals[c + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.sqrt(normals[i] * normals[i] + normals[i + 1] * normals[i + 1] + normals[i + 2] * normals[i + 2]) || 1;
    normals[i] /= l;
    normals[i + 1] /= l;
    normals[i + 2] /= l;
  }
}

/* ==========================================================================
 * Baked ambient occlusion from a coarse copy of the field.
 * ========================================================================== */

interface CoarseField {
  x0: number;
  y0: number;
  z0: number;
  h: number;
  nx: number;
  ny: number;
  nz: number;
  data: Float32Array;
}

function* buildCoarseField(cache: GroundCache, spacing: number): Generator<void, CoarseField, void> {
  const pad = 8;
  const x0 = D.x0 - pad;
  const y0 = D.y0;
  const z0 = D.z0 - pad;
  const nx = Math.ceil((D.x1 - D.x0 + pad * 2) / spacing);
  const ny = Math.ceil((D.y1 + 10 - D.y0) / spacing);
  const nz = Math.ceil((D.z1 - D.z0 + pad * 2) / spacing);
  const data = new Float32Array((nx + 1) * (ny + 1) * (nz + 1));
  let o = 0;
  for (let k = 0; k <= nz; k += 1) {
    const z = z0 + k * spacing;
    for (let j = 0; j <= ny; j += 1) {
      const y = y0 + j * spacing;
      for (let i = 0; i <= nx; i += 1) {
        const x = x0 + i * spacing;
        const inside = x >= D.x0 && x <= D.x1 && z >= D.z0 && z <= D.z1;
        data[o] = inside ? fieldAt(cache, x, y, z, false) : groundTerm(cache, x, y, z);
        o += 1;
      }
    }
    yield;
  }
  return { x0, y0, z0, h: spacing, nx, ny, nz, data };
}

function sampleCoarse(f: CoarseField, x: number, y: number, z: number): number {
  const fx = (x - f.x0) / f.h;
  const fy = (y - f.y0) / f.h;
  const fz = (z - f.z0) / f.h;
  if (fx < 0 || fy < 0 || fz < 0 || fx >= f.nx || fy >= f.ny || fz >= f.nz) return 1e3;
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const k = Math.floor(fz);
  const tx = fx - i;
  const ty = fy - j;
  const tz = fz - k;
  const sx = 1;
  const sy = f.nx + 1;
  const sz = (f.nx + 1) * (f.ny + 1);
  const o = i * sx + j * sy + k * sz;
  const d = f.data;
  const c00 = d[o] + (d[o + sx] - d[o]) * tx;
  const c10 = d[o + sy] + (d[o + sy + sx] - d[o + sy]) * tx;
  const c01 = d[o + sz] + (d[o + sz + sx] - d[o + sz]) * tx;
  const c11 = d[o + sz + sy] + (d[o + sz + sy + sx] - d[o + sz + sy]) * tx;
  const c0 = c00 + (c10 - c00) * ty;
  const c1 = c01 + (c11 - c01) * ty;
  return c0 + (c1 - c0) * tz;
}

const AO_TAPS = [
  [0.9, 0.34],
  [2.0, 0.26],
  [4.2, 0.22],
  [8.0, 0.18],
] as const;

function* bakeOcclusion(
  f: CoarseField,
  positions: Float32Array,
  normals: Float32Array,
): Generator<void, Float32Array, void> {
  const count = positions.length / 3;
  const ao = new Float32Array(count);
  for (let v = 0; v < count; v += 1) {
    if ((v & 16383) === 16383) yield;
    const px = positions[v * 3];
    const py = positions[v * 3 + 1];
    const pz = positions[v * 3 + 2];
    const nx = normals[v * 3];
    const ny = normals[v * 3 + 1];
    const nz = normals[v * 3 + 2];
    const base = sampleCoarse(f, px, py, pz);
    let occ = 0;
    for (let t = 0; t < AO_TAPS.length; t += 1) {
      const dist = AO_TAPS[t][0];
      const s = sampleCoarse(f, px + nx * dist, py + ny * dist, pz + nz * dist) - base;
      occ += AO_TAPS[t][1] * clamp((dist * 0.82 - s) / dist, 0, 1);
    }
    // Overhang undersides and deep gorge floors see less sky.
    const skyBias = 0.06 * clamp(-ny, 0, 1) + 0.12 * smoothstep(-6, -26, py);
    ao[v] = clamp(1 - occ * 1.25 - skyBias, 0.18, 1);
  }
  return ao;
}

/* ==========================================================================
 * Chunking (frustum / shadow culling) with globally consistent normals.
 * ========================================================================== */

const CHUNK_XZ = 18.7;
const CHUNK_Y = 33;

function* chunkSurface(mesh: SurfaceMesh, ao: Float32Array): Generator<void, TerrainPiece[], void> {
  const { positions, normals, indices } = mesh;
  const cnx = Math.ceil((D.x1 - D.x0) / CHUNK_XZ);
  const cny = Math.ceil((D.y1 - D.y0) / CHUNK_Y);
  const cnz = Math.ceil((D.z1 - D.z0) / CHUNK_XZ);
  const chunkCount = cnx * cny * cnz;
  const triCount = indices.length / 3;
  const triChunk = new Int32Array(triCount);
  const offsets = new Int32Array(chunkCount + 1);
  for (let t = 0; t < triCount; t += 1) {
    const a = indices[t * 3] * 3;
    const b = indices[t * 3 + 1] * 3;
    const c = indices[t * 3 + 2] * 3;
    const cx = (positions[a] + positions[b] + positions[c]) / 3;
    const cy = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3;
    const cz = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
    const i = clamp(Math.floor((cx - D.x0) / CHUNK_XZ), 0, cnx - 1);
    const j = clamp(Math.floor((cy - D.y0) / CHUNK_Y), 0, cny - 1);
    const k = clamp(Math.floor((cz - D.z0) / CHUNK_XZ), 0, cnz - 1);
    const ch = i + cnx * (j + cny * k);
    triChunk[t] = ch;
    offsets[ch + 1] += 1;
  }
  for (let ch = 0; ch < chunkCount; ch += 1) offsets[ch + 1] += offsets[ch];
  // Counting sort of triangles by chunk.
  const order = new Int32Array(triCount);
  const cursor = offsets.slice(0, chunkCount);
  for (let t = 0; t < triCount; t += 1) {
    const ch = triChunk[t];
    order[cursor[ch]] = t;
    cursor[ch] += 1;
  }
  yield;

  const pieces: TerrainPiece[] = [];
  const remap = new Int32Array(positions.length / 3).fill(-1);
  const used = new Int32Array(positions.length / 3);
  for (let ch = 0; ch < chunkCount; ch += 1) {
    const begin = offsets[ch];
    const end = offsets[ch + 1];
    const tris = end - begin;
    if (tris === 0) continue;
    const local = new Uint32Array(tris * 3);
    let vc = 0;
    let w = 0;
    for (let n = begin; n < end; n += 1) {
      const t = order[n];
      for (let e = 0; e < 3; e += 1) {
        const g = indices[t * 3 + e];
        let l = remap[g];
        if (l < 0) {
          l = vc;
          remap[g] = l;
          used[vc] = g;
          vc += 1;
        }
        local[w] = l;
        w += 1;
      }
    }
    const pos = new Float32Array(vc * 3);
    const nor = new Float32Array(vc * 3);
    const occ = new Float32Array(vc);
    for (let l = 0; l < vc; l += 1) {
      const g = used[l];
      pos[l * 3] = positions[g * 3];
      pos[l * 3 + 1] = positions[g * 3 + 1];
      pos[l * 3 + 2] = positions[g * 3 + 2];
      nor[l * 3] = normals[g * 3];
      nor[l * 3 + 1] = normals[g * 3 + 1];
      nor[l * 3 + 2] = normals[g * 3 + 2];
      occ[l] = ao[g];
      remap[g] = -1;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geometry.setAttribute('aOcclusion', new THREE.BufferAttribute(occ, 1));
    geometry.setIndex(new THREE.BufferAttribute(local, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const i = ch % cnx;
    const j = Math.floor(ch / cnx) % cny;
    const k = Math.floor(ch / (cnx * cny));
    pieces.push({ name: `massif-${i}-${j}-${k}`, geometry, kind: 'massif', triangles: tris });
    yield;
  }
  return pieces;
}

/* ==========================================================================
 * Outer skirt heightfield
 * ========================================================================== */

/** Grid coordinates: uniform `near` spacing over [innerMin, innerMax], growing outward. */
function axisCoordinates(
  min: number,
  max: number,
  innerMin: number,
  innerMax: number,
  near: number,
  growth: number,
): number[] {
  const inner: number[] = [];
  const n = Math.max(1, Math.round((innerMax - innerMin) / near));
  for (let i = 0; i <= n; i += 1) inner.push(innerMin + ((innerMax - innerMin) * i) / n);
  const low: number[] = [];
  let s = near;
  let c = innerMin;
  while (c > min) {
    s *= growth;
    c = Math.max(min, c - s);
    low.push(c);
  }
  const high: number[] = [];
  s = near;
  c = innerMax;
  while (c < max) {
    s *= growth;
    c = Math.min(max, c + s);
    high.push(c);
  }
  return [...low.reverse(), ...inner, ...high];
}

/** Index of the first element greater than `v` in an ascending array. */
function upperBound(arr: readonly number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** How far a point lies inside the massif domain (negative outside). */
function insideDomain(x: number, z: number): number {
  return Math.min(x - D.x0, D.x1 - x, z - D.z0, D.z1 - z);
}

const SKIRT_OVERLAP = 1.6;

function* buildSkirt(cfg: DetailConfig): Generator<void, TerrainPiece, void> {
  const pad = 12;
  const xs = axisCoordinates(SKIRT_EXTENT.x0, SKIRT_EXTENT.x1, D.x0 - pad, D.x1 + pad, cfg.skirtNear, cfg.skirtGrowth);
  const zs = axisCoordinates(SKIRT_EXTENT.z0, SKIRT_EXTENT.z1, D.z0 - pad, D.z1 + pad, cfg.skirtNear, cfg.skirtGrowth);
  const w = xs.length;
  const hgt = zs.length;
  const vertexCount = w * hgt;
  const positions = new Float32Array(vertexCount * 3);
  const heights = new Float32Array(vertexCount);
  for (let k = 0; k < hgt; k += 1) {
    for (let i = 0; i < w; i += 1) {
      const x = xs[i];
      const z = zs[k];
      let y = skirtHeight(x, z);
      const inside = insideDomain(x, z);
      // Tuck the overlap band just under the massif surface so the seams never show.
      if (inside > 0) y -= 0.32 * smoothstep(0, 1.2, inside) + Math.max(0, inside - SKIRT_OVERLAP) * 2;
      const o = i + w * k;
      heights[o] = y;
      positions[o * 3] = x;
      positions[o * 3 + 1] = y;
      positions[o * 3 + 2] = z;
    }
    if (k % 24 === 23) yield;
  }
  const tri: number[] = [];
  for (let k = 0; k < hgt - 1; k += 1) {
    for (let i = 0; i < w - 1; i += 1) {
      // Skip cells wholly inside the domain beyond the overlap band.
      if (
        insideDomain(xs[i], zs[k]) > SKIRT_OVERLAP &&
        insideDomain(xs[i + 1], zs[k]) > SKIRT_OVERLAP &&
        insideDomain(xs[i], zs[k + 1]) > SKIRT_OVERLAP &&
        insideDomain(xs[i + 1], zs[k + 1]) > SKIRT_OVERLAP
      ) {
        continue;
      }
      const a = i + w * k;
      const b = i + 1 + w * k;
      const c = i + w * (k + 1);
      const d = i + 1 + w * (k + 1);
      // Counter-clockwise when seen from above (+y normal).
      tri.push(a, c, b, b, c, d);
    }
  }
  const indices = new Uint32Array(tri);
  const normals = new Float32Array(vertexCount * 3);
  accumulateNormals(positions, indices, normals);

  // Cheap valley occlusion: compare with the surrounding mean height (looked up on the grid itself).
  const lookup = (x: number, z: number): number => {
    const i = clamp(upperBound(xs, x) - 1, 0, w - 2);
    const k = clamp(upperBound(zs, z) - 1, 0, hgt - 2);
    const tx = clamp((x - xs[i]) / (xs[i + 1] - xs[i]), 0, 1);
    const tz = clamp((z - zs[k]) / (zs[k + 1] - zs[k]), 0, 1);
    const o = i + w * k;
    const a = heights[o] + (heights[o + 1] - heights[o]) * tx;
    const b = heights[o + w] + (heights[o + w + 1] - heights[o + w]) * tx;
    return a + (b - a) * tz;
  };
  const ao = new Float32Array(vertexCount);
  for (let o = 0; o < vertexCount; o += 1) {
    const x = positions[o * 3];
    const z = positions[o * 3 + 2];
    const r = 9;
    const mean = (lookup(x + r, z) + lookup(x - r, z) + lookup(x, z + r) + lookup(x, z - r)) * 0.25;
    ao[o] = clamp(1 - Math.max(0, mean - heights[o]) * 0.045 - 0.12 * smoothstep(-40, -110, heights[o]), 0.3, 1);
    if ((o & 8191) === 8191) yield;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('aOcclusion', new THREE.BufferAttribute(ao, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { name: 'skirt', geometry, kind: 'skirt', triangles: indices.length / 3 };
}

/* ==========================================================================
 * Public builder
 * ========================================================================== */

export interface MountainBuildStats {
  detail: TerrainDetail;
  massifTriangles: number;
  skirtTriangles: number;
  totalTriangles: number;
  pieces: number;
  /** Pure CPU time spent building (excludes idle time between incremental steps). */
  milliseconds: number;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** The full build as a resumable sequence of small steps (each well under a millisecond). */
function* mountainBuildSteps(
  detail: TerrainDetail,
  onStats: (stats: Omit<MountainBuildStats, 'milliseconds'>) => void,
): Generator<void, TerrainPiece[], void> {
  const cfg = DETAIL_CONFIG[detail];
  // Ground cache on the surface-net lattice, padded so the AO field can use it too.
  const padCells = Math.ceil(10 / cfg.cell);
  const pad = padCells * cfg.cell;
  const nx = Math.ceil((D.x1 - D.x0) / cfg.cell) + padCells * 2 + 1;
  const nz = Math.ceil((D.z1 - D.z0) / cfg.cell) + padCells * 2 + 1;
  const cache = yield* buildGroundCache(D.x0 - pad, D.z0 - pad, cfg.cell, nx, nz);
  const surface = yield* polygonise(cache, cfg.cell, cfg.fineNoise);
  const coarse = yield* buildCoarseField(cache, cfg.aoSpacing);
  const ao = yield* bakeOcclusion(coarse, surface.positions, surface.normals);
  const pieces = yield* chunkSurface(surface, ao);
  const skirt = yield* buildSkirt(cfg);
  pieces.push(skirt);
  onStats({
    detail,
    massifTriangles: surface.triangleCount,
    skirtTriangles: skirt.triangles,
    totalTriangles: surface.triangleCount + skirt.triangles,
    pieces: pieces.length,
  });
  return pieces;
}

/** Incremental mountain build that can be advanced a few milliseconds per frame. */
export interface MountainBuilder {
  readonly detail: TerrainDetail;
  /** Advances the build for at most `budgetMs`; returns true once finished. */
  step(budgetMs: number): boolean;
  readonly done: boolean;
  /** The finished pieces (null until done). Ownership passes to the caller. */
  readonly pieces: TerrainPiece[] | null;
  readonly stats: MountainBuildStats | null;
}

let lastStats: MountainBuildStats | null = null;

/** Statistics of the most recent finished build (for telemetry / tests). */
export function lastMountainBuildStats(): MountainBuildStats | null {
  return lastStats;
}

export function createMountainBuilder(detail: TerrainDetail): MountainBuilder {
  let partial: Omit<MountainBuildStats, 'milliseconds'> | null = null;
  const steps = mountainBuildSteps(detail, (s) => {
    partial = s;
  });
  let done = false;
  let pieces: TerrainPiece[] | null = null;
  let stats: MountainBuildStats | null = null;
  let cpu = 0;
  return {
    detail,
    step(budgetMs: number): boolean {
      if (done) return true;
      const start = now();
      for (;;) {
        const r = steps.next();
        if (r.done) {
          done = true;
          pieces = r.value;
          cpu += now() - start;
          if (partial) {
            stats = { ...partial, milliseconds: cpu };
            lastStats = stats;
          }
          return true;
        }
        if (now() - start >= budgetMs) break;
      }
      cpu += now() - start;
      return false;
    },
    get done() {
      return done;
    },
    get pieces() {
      return pieces;
    },
    get stats() {
      return stats;
    },
  };
}

/**
 * Builds the whole mountain synchronously for a detail level: chunked massif
 * surface pieces plus the outer skirt. Deterministic; world-space positions;
 * normals and a baked `aOcclusion` attribute (0..1) included. Callers own and
 * must dispose the returned geometries.
 */
export function buildMountainGeometries(detail: TerrainDetail): TerrainPiece[] {
  const builder = createMountainBuilder(detail);
  builder.step(Number.POSITIVE_INFINITY);
  return builder.pieces ?? [];
}
