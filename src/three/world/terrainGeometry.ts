import * as THREE from 'three';
import type { GpuTier } from '../../store/scrollStore';
import { PATH_PHASES, WAYPOINTS, protagonistPositionAt } from '../protagonistPath';

/* ==========================================================================
 * Terrain geometry — PURE module (no React, no DOM; runs in Node).
 *
 * ONE continuous granite mountain, described as a signed distance field
 * (negative = inside rock) and polygonised with naive surface nets:
 *
 *   ground   a heightfield for the mountain's lower body, its radiating
 *            ridges and the valleys / flanking ranges (also the far skirt);
 *   front    the stepped front face carved into the mountain: the base-camp
 *            shoulder, the Company-1 cliff with the ledge-1 terrace, the upper
 *            buttress, the ledge-2 shelf and the mid-face pillar. Every face
 *            that is climbed is shaped directly from the climb route so the
 *            rock sits just behind the climber and every standing waypoint has
 *            a surface under the feet;
 *   chasms   chasm 1, a deep cleft cut into the face (open to the south-east,
 *            closed behind, misty floor), and chasm 2, a deeper gorge between
 *            the pillar and the summit pyramid (closed by rock walls at both
 *            ends, abyss below the leap);
 *   summit   the faceted summit pyramid whose south face carries the catch lip
 *            and the scramble, topped by a tiny standing platform;
 *   detail   world-space strata / jointing / FBM displacement, suppressed close
 *            to the route so the clearances stay exact;
 *   facets   planar fracture facets cut into the rock in two octaves (slabs
 *            and chips): flat faces, sharp edges and snow-holding steps.
 *
 * Two surface-net passes: a fine one over the climb ("detail domain") and a
 * coarse one over the whole massif whose surface is tucked just under the fine
 * one where they overlap. Beyond the massif the ground heightfield continues as
 * a graded-resolution skirt mesh. Vertices close to the route are projected
 * onto the exact iso-surface. Ambient occlusion and curvature (cavity) are
 * baked per vertex; then each fine vertex takes the exact normal and the id of
 * the fracture plane that shapes it, so the facets shade flat with straight
 * creases at the mesh's resolution (in the climb corridor, where the rock must
 * stay where the animator plants hands and feet, the facets of the shared
 * corridor chip lattice shade the uncut rock). Deterministic (fixed seeds);
 * built once per detail level, optionally time-sliced.
 * ========================================================================== */

export type TerrainDetail = 'high' | 'medium' | 'low';

export interface TerrainPiece {
  /** Stable name, e.g. `massif-1-0-2`, `flank-0-1-1` or `skirt`. */
  name: string;
  /**
   * World-space, indexed geometry with `position`, `normal` (unit length; on
   * the massif pieces the exact gradient of the fracture plane that shapes the
   * vertex where one does and it lies within 45° of the area-weighted normal —
   * in the climb corridor, where the rock is kept uncut for the animator's
   * holds, the plane a corridor chip would cut there, within 30° — else the
   * area-weighted normal), `aOcclusion` (0.2..1, baked ambient occlusion),
   * `aCurvature` (-1..1: negative in creases and hollows, positive on convex
   * edges; both baked with the area-weighted normals) and `aFacet` ([0, 1): one
   * hashed id per facet — the shading plane's cell, or a 2.5-unit lattice cell
   * where no plane shapes the rock).
   */
  geometry: THREE.BufferGeometry;
  /** massif = fine climb detail, flank = coarse outer massif, skirt = far heightfield. */
  kind: 'massif' | 'flank' | 'skirt';
  triangles: number;
}

/** World-space Y of the rock surface directly under each standing waypoint. */
export const STANDING_SURFACE_Y = {
  baseCamp: -0.03,
  firstLedge: 17.95,
  chasmOneLanding: 21.91,
  chasmOneTop: 31.95,
  summit: 54.95,
} as const;

/** Top of the one-handed catch lip on the summit pyramid (Scene 6). */
export const CATCH_LIP_Y = 40;

/** Bounds of the fine (climb-detail) surface-net pass. */
export const MASSIF_DETAIL_DOMAIN = {
  x0: -24,
  x1: 24,
  y0: -26,
  y1: 58,
  z0: -48,
  z1: 17,
} as const;

/** Bounds of the whole polygonised massif (outside it only the skirt exists). */
export const MASSIF_DOMAIN = {
  x0: -50,
  x1: 50,
  y0: -66,
  y1: 58,
  z0: -98,
  z1: 36,
} as const;

/** Extent of the outer skirt heightfield (fully fogged at its edges). */
export const SKIRT_EXTENT = {
  x0: -470,
  x1: 470,
  z0: -440,
  z1: 310,
} as const;

interface DetailConfig {
  /** Fine surface-net cell size (world units). */
  cell: number;
  /** Coarse (outer massif) cell size. */
  outerCell: number;
  /** Include the finest displacement octave. */
  fineNoise: boolean;
  /** Skirt grid spacing next to the massif domain. */
  skirtNear: number;
  /** Geometric growth of skirt spacing away from the domain. */
  skirtGrowth: number;
  /** Spacing of the coarse field used for baked ambient occlusion. */
  aoSpacing: number;
  /** Size of the fracture-facet cells cut into the fine surface. */
  chipSize: number;
}

const DETAIL_CONFIG: Readonly<Record<TerrainDetail, DetailConfig>> = {
  high: { cell: 0.3, outerCell: 0.8, fineNoise: true, skirtNear: 1.8, skirtGrowth: 1.05, aoSpacing: 2.0, chipSize: 1.7 },
  medium: { cell: 0.42, outerCell: 1.05, fineNoise: true, skirtNear: 2.4, skirtGrowth: 1.065, aoSpacing: 2.3, chipSize: 1.9 },
  low: { cell: 0.62, outerCell: 1.45, fineNoise: false, skirtNear: 3.2, skirtGrowth: 1.09, aoSpacing: 2.8, chipSize: 2.3 },
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

/** Intersection of two distance fields with the convex edge rounded to radius r. */
function roundMax(a: number, b: number, r: number): number {
  const ua = a + r > 0 ? a + r : 0;
  const ub = b + r > 0 ? b + r : 0;
  return Math.min(-r, Math.max(a, b)) + Math.sqrt(ua * ua + ub * ub);
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
 * Chasm frames
 * ========================================================================== */

/* Chasm 1: `n` runs along the jump (ledge 1 → ledge 2), `a` along the cleft
 * towards its mouth (south-east, front-right). Origin = jump midpoint. */
const J1_LEN = Math.hypot(WAYPOINTS.chasmOneLanding[0] - WAYPOINTS.firstLedge[0], WAYPOINTS.chasmOneLanding[2] - WAYPOINTS.firstLedge[2]);
const C1N_X = (WAYPOINTS.chasmOneLanding[0] - WAYPOINTS.firstLedge[0]) / J1_LEN;
const C1N_Z = (WAYPOINTS.chasmOneLanding[2] - WAYPOINTS.firstLedge[2]) / J1_LEN;
const C1A_X = -C1N_Z;
const C1A_Z = C1N_X;
const C1_OX = (WAYPOINTS.firstLedge[0] + WAYPOINTS.chasmOneLanding[0]) / 2;
const C1_OZ = (WAYPOINTS.firstLedge[2] + WAYPOINTS.chasmOneLanding[2]) / 2;

/* Chasm 2: `n` runs along the leap (pillar top → catch), `a` along the gorge
 * towards the north-east. Origin = leap midpoint. */
const J2_LEN = Math.hypot(WAYPOINTS.chasmTwoCatch[0] - WAYPOINTS.chasmOneTop[0], WAYPOINTS.chasmTwoCatch[2] - WAYPOINTS.chasmOneTop[2]);
const C2N_X = (WAYPOINTS.chasmTwoCatch[0] - WAYPOINTS.chasmOneTop[0]) / J2_LEN;
const C2N_Z = (WAYPOINTS.chasmTwoCatch[2] - WAYPOINTS.chasmOneTop[2]) / J2_LEN;
const C2A_X = -C2N_Z;
const C2A_Z = C2N_X;
const C2_OX = (WAYPOINTS.chasmOneTop[0] + WAYPOINTS.chasmTwoCatch[0]) / 2;
const C2_OZ = (WAYPOINTS.chasmOneTop[2] + WAYPOINTS.chasmTwoCatch[2]) / 2;

const cleftA = (x: number, z: number): number => C1A_X * (x - C1_OX) + C1A_Z * (z - C1_OZ);
const cleftN = (x: number, z: number): number => C1N_X * (x - C1_OX) + C1N_Z * (z - C1_OZ);
const gorgeA = (x: number, z: number): number => C2A_X * (x - C2_OX) + C2A_Z * (z - C2_OZ);
const gorgeN = (x: number, z: number): number => C2N_X * (x - C2_OX) + C2N_Z * (z - C2_OZ);

const CLEFT_HALF_WIDTH = 3.0;
const CLEFT_BACK_A = -3.6;
const CLEFT_MOUTH_A = 21;
const CLEFT_FLOOR_Y = -8;
const GORGE_A0 = -2.5;
const GORGE_A1 = 6.5;
const GORGE_EDGE_N = -6.0;
const GORGE_FLOOR_Y = -14;

/**
 * Where the chasms are, for mist / effects placement. Frames are in the xz
 * plane: `axis` runs along the chasm (towards its open/far end), `across`
 * along the jump. All values world units.
 */
export const CHASM_LAYOUT = {
  chasmOne: {
    origin: [C1_OX, C1_OZ] as const,
    axis: [C1A_X, C1A_Z] as const,
    across: [C1N_X, C1N_Z] as const,
    halfWidth: CLEFT_HALF_WIDTH,
    backA: CLEFT_BACK_A,
    mouthA: CLEFT_MOUTH_A,
    /** Floor height at the jump line; it rises toward the back and falls toward the mouth. */
    floorY: CLEFT_FLOOR_Y,
  },
  chasmTwo: {
    origin: [C2_OX, C2_OZ] as const,
    axis: [C2A_X, C2A_Z] as const,
    across: [C2N_X, C2N_Z] as const,
    a0: GORGE_A0,
    a1: GORGE_A1,
    /** Pillar-side wall position along `across`; the pyramid wall is ~+7.2. */
    nearEdge: GORGE_EDGE_N,
    floorY: GORGE_FLOOR_Y,
  },
} as const;

/* ==========================================================================
 * Ground heightfield — the mountain's lower body, ridges, valleys and skirt.
 * ========================================================================== */

interface RidgeSpec {
  /** Polyline of [x, crestHeight, z]. */
  points: ReadonlyArray<readonly [number, number, number]>;
  /** Cross-slope (height lost per unit of horizontal distance from the crest). */
  cross: number;
}

const RIDGES: readonly RidgeSpec[] = [
  // South-west arête: continues the summit pyramid's west edge down past the upper buttress.
  { points: [[-7.5, 37, -29], [-13, 31, -22], [-20, 20, -14], [-31, 5, -3], [-52, -22, 14], [-100, -74, 48]], cross: 1.35 },
  // South-east arête: from the pyramid's east edge over the pillar's shoulder and down.
  { points: [[7.5, 37, -29], [12.5, 31, -21], [17.5, 23, -13], [27, 9, -2], [50, -20, 14], [100, -74, 48]], cross: 1.35 },
  // North, north-west and north-east ridges (seen from the summit).
  { points: [[0, 40, -44], [2, 29, -58], [6, 2, -88], [12, -45, -135]], cross: 1.3 },
  { points: [[-6, 40, -41], [-20, 23, -54], [-50, -15, -86], [-95, -66, -120]], cross: 1.35 },
  { points: [[6, 40, -41], [21, 23, -53], [52, -15, -84], [100, -66, -118]], cross: 1.35 },
  // West and east shoulders.
  { points: [[-9, 36, -36], [-27, 16, -38], [-60, -22, -44], [-120, -72, -52]], cross: 1.4 },
  { points: [[9, 36, -36], [27, 16, -36], [60, -22, -40], [120, -72, -50]], cross: 1.4 },
  // Southern spur under the base-camp shoulder.
  { points: [[0, -7, 9], [0, -15, 20], [-3, -40, 48], [-8, -90, 110]], cross: 1.3 },
  // Far flanking ranges that give the valleys depth.
  { points: [[-150, -40, -40], [-210, -10, -150], [-260, -30, -260]], cross: 0.9 },
  { points: [[160, -45, -30], [230, -15, -140], [290, -35, -250]], cross: 0.9 },
];

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
 * Height of the mountain's lower body / outer skirt at (x, z). Shared by the
 * skirt mesh and both massif passes so they agree along the domain edges.
 */
export function skirtHeight(x: number, z: number): number {
  // Broad, concave cone centred just behind the summit; the south (front) falls away faster.
  const dz = z + 40;
  const zs = dz > 0 ? dz * 1.3 : dz;
  const r = Math.sqrt(x * x + zs * zs);
  // Concave profile that flattens out (never rises again) far from the mountain.
  const rc = Math.min(r, 210);
  let h = 44 - 1.18 * r + 0.0026 * rc * rc + 0.55 * Math.max(0, r - 210);

  for (let i = 0; i < RIDGES.length; i += 1) {
    h = smax(h, ridgeHeight(RIDGES[i], x, z), 6);
  }

  // Erosion-like detail: big gullies, then finer ribs. Calmer near the climb.
  const core = smoothstep(16, 44, Math.sqrt(x * x + (z + 14) * (z + 14)));
  const big = ridged2(x * 0.021, z * 0.021, 3) - 0.42;
  const mid = noise2(x * 0.071 + 3.1, z * 0.071 - 7.7);
  const fine = noise2(x * 0.19 - 1.7, z * 0.19 + 4.4);
  h += (0.3 + 0.7 * core) * (big * 15 + mid * 3) + fine * (0.6 + 0.4 * core);

  // The stepped front face is carved from 3D blocks: keep the heightfield well
  // under it so it never bulges through the climb.
  const corridor = smoothstep(17, 9, Math.abs(x - 2)) * smoothstep(-30, -20, z) * smoothstep(5, -1, z);
  if (corridor > 0) h -= 14 * corridor;

  // Valley floors far below, softly levelled.
  return smax(h, VALLEY_FLOOR + noise2(x * 0.012, z * 0.012) * 6, 14);
}

/* ==========================================================================
 * The front face — stepped blocks carved into the mountain's south side.
 * Each block is { z < faceZ(x, y) } ∩ { y < topY(x, z) } with a rounded
 * edge; west blocks stop east of the cleft, east blocks west of it.
 * ========================================================================== */

const SY = STANDING_SURFACE_Y;

/** Face behind the catch point (the climber hangs 0.62 in front of it). */
const CATCH_LIP_Z = WAYPOINTS.chasmTwoCatch[2] - 0.62;

/**
 * A top-out lip. The climb arrives at each standing waypoint almost
 * vertically, so the face hugs the route (clearance easing from `cBase` to a
 * few centimetres) up to `r` below the top, then stands `e` in front of the
 * feet; the edge is rounded with radius `r`. The route clears the rounded edge
 * while the feet still stand on rock.
 */
interface LipSpec {
  table: RouteTable;
  top: number;
  zStand: number;
  /** How far the top edge stands in front of the feet. */
  e: number;
  /** Edge rounding radius. */
  r: number;
  /** Height over which the face converges onto the route below the rounding. */
  w: number;
  cBase: number;
  cTop: number;
  /** Lowest height the route table is followed to (below it the face is vertical). */
  yMin: number;
}

function makeLip(table: RouteTable, top: number, zStand: number, e: number, r: number, w: number, cBase: number, yMin: number): LipSpec {
  const yr = top - r;
  return { table, top, zStand, e, r, w, cBase, cTop: routeZ(table, yr) - (zStand + e), yMin };
}

function lipFaceZ(l: LipSpec, y: number): number {
  const yr = l.top - l.r;
  if (y >= yr) return l.zStand + l.e;
  const c = l.cBase + (l.cTop - l.cBase) * smoothstep(yr - l.w, yr, y);
  return routeZ(l.table, Math.max(y, l.yMin)) - c;
}

/* Lip parameters found by a numeric search that keeps every route sample clear
 * of the rock (>= 0.04 in the last unit of the top-out, >= 0.25 below) while
 * putting rock as flat and as close as possible under the feet. */
const LEDGE_ONE_LIP = makeLip(ROUTE_ASCENT, STANDING_SURFACE_Y.firstLedge, WAYPOINTS.firstLedge[2], 0.06, 0.35, 1.2, 0.75, -1e9);
const PILLAR_LIP = makeLip(ROUTE_PILLAR, STANDING_SURFACE_Y.chasmOneTop, WAYPOINTS.chasmOneTop[2], 0.06, 0.5, 1.2, 0.55, ROUTE_PILLAR.y0);
// The summit block may not overhang (a sharp top, not a capstone): w is long enough for that.
const SUMMIT_LIP = makeLip(ROUTE_SCRAMBLE, STANDING_SURFACE_Y.summit, WAYPOINTS.summit[2], 0.1, 0.35, 1.2, 0.62, CATCH_LIP_Y);

/* ---- Base-camp shoulder ------------------------------------------------- */

const CAMP_CX = 0;
const CAMP_CZ = 1.5;
const CAMP_AX = 7.6;
const CAMP_AZ = 5.7;

function baseCampTopY(x: number, z: number): number {
  const dStand = Math.sqrt(x * x + (z - 0.8) * (z - 0.8));
  const flat = smoothstep(3.0, 4.6, dStand);
  const ex = (x - CAMP_CX) / CAMP_AX;
  const ez = (z - CAMP_CZ) / CAMP_AZ;
  const el = Math.sqrt(ex * ex + ez * ez);
  const rim = smoothstep(0.72, 0.97, el) * (0.12 + 0.34 * (0.5 + 0.5 * noise2(x * 0.6 + 3.3, z * 0.6 - 1.1)));
  // A little relief outside the 1.6 disc kept flat for the feet and the gear-up (the chips facet it).
  const relief = 0.06 * noise2(x * 1.3 + 7, z * 1.3 - 2) * smoothstep(1.6, 3.0, dStand);
  return SY.baseCamp + flat * (0.1 * noise2(x * 0.38 + 4, z * 0.38) + rim) + relief;
}

function baseCampSdf(x: number, y: number, z: number): number {
  const ex = (x - CAMP_CX) / CAMP_AX;
  const ez = (z - CAMP_CZ) / CAMP_AZ;
  const plan = (Math.sqrt(ex * ex + ez * ez) - 1) * 6.2;
  const depth = y < 0 ? -y : 0;
  const side = plan - 0.42 * Math.min(depth, 14) - 0.95 * Math.max(0, depth - 14);
  return roundMax(side, y - baseCampTopY(x, z), 0.45);
}

/* ---- Company-1 cliff (lower face) with the ledge-1 terrace -------------- */

function cliffOneFaceZ(x: number, y: number): number {
  let z = lipFaceZ(LEDGE_ONE_LIP, y);
  // Plan shape: turns to face south-east toward the cleft, steps forward on the west.
  if (x > 1.2) {
    const e = x - 1.2;
    z -= 0.3 * e + 0.03 * e * e;
  }
  if (x < -3.0) z += Math.min(3.6, 0.45 * (-3.0 - x));
  return z;
}

function cliffOneTopY(x: number): number {
  return SY.firstLedge + (x < -3.4 ? Math.min(10, 1.6 * (-3.4 - x)) : 0);
}

function cliffOneSdf(x: number, y: number, z: number, n1: number): number {
  const top = cliffOneTopY(x);
  let d = roundMax((z - cliffOneFaceZ(x, y)) * 0.92, y - top, LEDGE_ONE_LIP.r);
  d = Math.max(d, n1 - 1.5, -(x + 19) - 0.3 * Math.max(0, top - y));
  return d;
}

/* ---- Upper buttress above ledge 1 -------------------------------------- */

function upperFaceZ(x: number, y: number): number {
  let z = -10.3 - 0.28 * Math.max(0, y - 18);
  if (x > 0.5) z -= 0.3 * (x - 0.5);
  if (x < -4) z += Math.min(2.6, 0.32 * (-4 - x));
  return z;
}

function upperTopY(x: number, z: number): number {
  return 26.5 + 0.45 * Math.max(0, -x - 1.5) + 0.22 * Math.max(0, -z - 16);
}

function upperSdf(x: number, y: number, z: number, n1: number): number {
  const top = upperTopY(x, z);
  let d = roundMax((z - upperFaceZ(x, y)) * 0.95, y - top, 0.6);
  d = Math.max(d, n1 - 1.5, -(x + 19) - 0.3 * Math.max(0, top - y), -(z + 36));
  return d;
}

/* ---- Ledge-2 shelf (the lower spur east of the cleft) ------------------ */

function shelfFrontZ(x: number, y: number): number {
  return -12.45 + 0.1 * (x - 5) + 0.32 * Math.max(0, 21.2 - y);
}

function shelfTopY(x: number): number {
  return SY.chasmOneLanding - (x > 7.8 ? 1.3 * (x - 7.8) : 0);
}

function shelfSdf(x: number, y: number, z: number, n1: number): number {
  let d = roundMax((z - shelfFrontZ(x, y)) * 0.95, y - shelfTopY(x), 0.3);
  d = Math.max(d, -1.5 - n1, x - 19 - 0.3 * Math.max(0, 22 - y), -(z + 36));
  return d;
}

/* ---- Mid-face pillar (Company 2) --------------------------------------- */

function pillarFaceZ(x: number, y: number): number {
  let z = lipFaceZ(PILLAR_LIP, y);
  if (x > 5.6) z -= 0.24 * (x - 5.6);
  if (x < 4.3) z -= 0.3 * (4.3 - x);
  return z;
}

function pillarTopY(x: number, z: number): number {
  // Rises toward the summit pyramid (the south-east arête), falls away to the east.
  const rise = 0.5 * Math.max(0, 0.4 * (x - 6.5) + 0.9 * (-z - 17));
  return SY.chasmOneTop + rise - 1.1 * Math.max(0, x - 11);
}

function pillarSdf(x: number, y: number, z: number, n1: number): number {
  const top = pillarTopY(x, z);
  let d = roundMax((z - pillarFaceZ(x, y)) * 0.95, y - top, PILLAR_LIP.r);
  d = Math.max(d, -1.5 - n1, x - 20 - 0.35 * Math.max(0, top - y), -(z + 36));
  return d;
}

/** All front-face blocks (negative inside), or a large value far away. */
function frontComplex(x: number, y: number, z: number): number {
  if (x < -30 || x > 30 || z < -40 || z > 30 || y > 44) return 1e3;
  const n1 = cleftN(x, z);
  let d = 1e3;
  if (z > -8 && y < 3) d = baseCampSdf(x, y, z);
  if (y < 30) d = smin(d, cliffOneSdf(x, y, z, n1), 0.7);
  if (z < -6) d = smin(d, upperSdf(x, y, z, n1), 0.9);
  if (z < -6 && y < 26) d = smin(d, shelfSdf(x, y, z, n1), 0.35);
  if (z < -10) d = smin(d, pillarSdf(x, y, z, n1), 0.8);
  // The summit pyramid's flank facets bound the face: its arêtes frame the climb.
  return smax(d, pyramidFlanks(x, y, z), 0.9);
}

/* ==========================================================================
 * Chasm carves (negative inside the empty space).
 * ========================================================================== */

function cleftFloorY(a: number): number {
  return a >= 0 ? Math.max(-34, CLEFT_FLOOR_Y - 2.4 * a) : CLEFT_FLOOR_Y - 3.6 * a;
}

function cleftCarve(x: number, y: number, z: number): number {
  const a = cleftA(x, z);
  const n = cleftN(x, z);
  let w = CLEFT_HALF_WIDTH;
  if (y < 16) w = Math.max(0.95, w - 0.075 * (16 - y));
  if (y > 25) w += 0.14 * (y - 25);
  if (a > 2) w += 0.2 * (a - 2);
  // Capsule in plan: a rounded back end, open toward the mouth.
  const aStart = CLEFT_BACK_A + w;
  const da = a < aStart ? aStart - a : 0;
  const plan = Math.sqrt(da * da + n * n) - w;
  return Math.max(plan, a - CLEFT_MOUTH_A, cleftFloorY(a) - y);
}

function gorgeCarve(x: number, y: number, z: number): number {
  const a = gorgeA(x, z);
  const n = gorgeN(x, z);
  // The pillar-side wall leans back with depth (V-shaped gorge); the pyramid
  // restores its own catch wall afterwards, so the far side reaches well past it.
  const nLo = GORGE_EDGE_N + 0.12 * Math.max(0, 31 - y);
  const nHi = 14;
  const rc = 2.6;
  const ca = (GORGE_A0 + GORGE_A1) / 2;
  const ha = (GORGE_A1 - GORGE_A0) / 2;
  const cn = (nLo + nHi) / 2;
  const hn = (nHi - nLo) / 2;
  const qa = Math.abs(a - ca) - ha + rc;
  const qn = Math.abs(n - cn) - hn + rc;
  const ox = qa > 0 ? qa : 0;
  const oy = qn > 0 ? qn : 0;
  const plan = Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qa, qn), 0) - rc;
  const end = Math.max(0, Math.abs(a - 1.5) - 2.6);
  const floor = GORGE_FLOOR_Y + 4.2 * end * end;
  return Math.max(plan, floor - y);
}

/* ==========================================================================
 * Summit pyramid
 * ========================================================================== */

interface PyramidPlane {
  nx: number;
  ny: number;
  nz: number;
  d: number;
}

/** Facets: outward horizontal direction, slope angle (deg), offset at the platform height. */
const PYRAMID: readonly PyramidPlane[] = (
  [
    [1.0, -0.06, 64, 0.42],
    [0.4, -0.92, 66, 0.45],
    [-0.4, -0.92, 66, 0.45],
    [-1.0, -0.06, 63, 0.42],
    [0.74, 0.67, 53, 0.95],
    [-0.74, 0.67, 55, 0.95],
  ] as const
).map(([hx, hz, deg, r0]) => {
  const l = Math.hypot(hx, hz);
  const a = (deg * Math.PI) / 180;
  const sx = (hx / l) * Math.sin(a);
  const sz = (hz / l) * Math.sin(a);
  const cy = Math.cos(a);
  const px = WAYPOINTS.summit[0] + (hx / l) * r0;
  const pz = WAYPOINTS.summit[2] + (hz / l) * r0;
  const py = SY.summit;
  return { nx: sx, ny: cy, nz: sz, d: -(sx * px + cy * py + sz * pz) };
});

/** South face of the pyramid: the catch wall below the lip, the scramble face above. */
function summitFaceZ(x: number, y: number): number {
  let z: number;
  let xr: number;
  if (y >= CATCH_LIP_Y) {
    xr = routeX(ROUTE_SCRAMBLE, Math.min(y, SY.summit));
    z = lipFaceZ(SUMMIT_LIP, y);
  } else {
    xr = WAYPOINTS.chasmTwoCatch[0];
    // Small undercut below the lip, then a steep slab leaning out toward its foot (a V-shaped gorge).
    z = CATCH_LIP_Z - 0.45 * smoothstep(CATCH_LIP_Y, CATCH_LIP_Y - 1.3, y) + 0.16 * clamp(CATCH_LIP_Y - 1.3 - y, 0, 60);
  }
  const dx = x - xr;
  if (dx > 2.4) z -= 0.08 * (dx - 2.4) * (dx - 2.4);
  if (dx < -2.8) z -= 0.08 * (-2.8 - dx) * (-2.8 - dx);
  return z;
}

/** Max over the pyramid's flank facets (everything but its south face). */
function pyramidFlanks(x: number, y: number, z: number): number {
  let d = -1e9;
  for (let i = 0; i < PYRAMID.length; i += 1) {
    const p = PYRAMID[i];
    const s = p.nx * x + p.ny * y + p.nz * z + p.d;
    if (s > d) d = s;
  }
  return d;
}

function summitSdf(x: number, y: number, z: number): number {
  return Math.max(pyramidFlanks(x, y, z), roundMax((z - summitFaceZ(x, y)) * 0.86, y - SY.summit, SUMMIT_LIP.r));
}

/* ==========================================================================
 * Detail displacement and its suppression near the route.
 * ========================================================================== */

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
  { x: WAYPOINTS.chasmTwoCatch[0], y: CATCH_LIP_Y - 0.2, z: CATCH_LIP_Z },
  { x: WAYPOINTS.summit[0], y: SY.summit, z: WAYPOINTS.summit[2] },
];

/**
 * Horizontal distances of the last point passed to routeStandDistances: to the
 * climb route (at the point's height) and to the nearest standing spot (within
 * its height band). Module scratch, so asking costs no allocation.
 */
const DIST = { route: 1e9, stand: 1e9 };
let distX = Number.NaN;
let distY = Number.NaN;
let distZ = Number.NaN;

/**
 * Fills DIST for (x, y, z). Memoised on the last point (exact equality): one
 * field evaluation asks for the same point several times (the displacement
 * mask and every chip grid), and nested evaluations elsewhere only cost a
 * recomputation.
 */
function routeStandDistances(x: number, y: number, z: number): void {
  if (x === distX && y === distY && z === distZ) return;
  distX = x;
  distY = y;
  distZ = z;
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
    if (dy > -1.6 && dy < 3) {
      const ddx = x - s.x;
      const ddz = z - s.z;
      const d = Math.sqrt(ddx * ddx + ddz * ddz);
      if (d < dStand) dStand = d;
    }
  }
  DIST.route = dRoute;
  DIST.stand = dStand;
}

/** 0 → no displacement (standing spots), ~0.2 along climbing lines, 1 → full detail. */
function detailMask(x: number, y: number, z: number): number {
  routeStandDistances(x, y, z);
  const routeAmp = 0.14 + 0.86 * smoothstep(0.9, 3.0, DIST.route);
  const standAmp = smoothstep(0.9, 2.6, DIST.stand);
  return Math.min(routeAmp, standAmp);
}

/** Upper bound of |displacement| (used to skip the noise far from any rock). */
const MAX_DISPLACEMENT = 3.7;

function displacement(x: number, y: number, z: number, fine: boolean): number {
  // Low-frequency warp shared by the joint sets so they never line up perfectly.
  const warp = noise3(x * 0.031 + 1.7, y * 0.027, z * 0.031 - 3.1);
  // Buttress-scale undulation.
  const n1 = noise3(x * 0.07, y * 0.07, z * 0.07) + 0.5 * noise3(x * 0.16 + 5.2, y * 0.16, z * 0.16 - 1.3);
  // Couloirs and spurs: sharp vertical creases where a stretched noise crosses zero.
  const cr = noise3(x * 0.075 - 4.4, y * 0.022 + warp * 0.6, z * 0.075 + 8.1);
  const crease = 1 - Math.abs(cr);
  // Vertical jointing: ribs and gullies.
  const rr = noise3(x * 0.3 + 11.3, y * 0.055, z * 0.3 - 4.2);
  const joint = 1 - Math.abs(rr);
  // Sheeting joints: tilted, irregularly spaced steps (a quick inward step that
  // holds snow, then a slow outward lean), only in some zones and not on the summit block.
  const u = y * 0.33 + x * 0.09 - z * 0.05 + warp * 2.8 + n1 * 0.5;
  const f = u - Math.floor(u);
  const saw = f < 0.16 ? f / 0.16 : (1 - f) / 0.84;
  // Step height varies from step to step (hashed per band), so the ledges never look stacked.
  const band = Math.floor(u);
  const bandAmp = 0.35 + 0.65 * (((band * 0.618034) % 1) + 1) % 1;
  const strataZone = smoothstep(0.05, 0.6, noise3(x * 0.04 + 3, y * 0.045, z * 0.04));
  const strataAmp = 0.46 * strataZone * bandAmp * (1 - 0.85 * smoothstep(40, 47, y));
  // Vertical block jointing along a rotated horizontal axis.
  const v = (x * 0.8 + z * 0.6) * 0.3 + warp * 1.7;
  const g = v - Math.floor(v);
  const blocks = g < 0.14 ? g / 0.14 : (1 - g) / 0.86;
  const blockAmp = 0.34 * smoothstep(-0.1, 0.5, noise3(x * 0.05 - 7, y * 0.04, z * 0.05 + 2));
  // Small buttresses and grooves (a few metres): sharp crests of a ridged noise.
  const mb = noise3(x * 0.21 - 2.3, y * 0.13 + 7.1, z * 0.21 + 3.3);
  const blocky = 1 - Math.abs(mb);
  // The rounded terms stay gentle: the planar slabs and chips cut afterwards give the rock its angular form.
  let d =
    0.8 * n1 +
    0.9 * (crease * crease * crease - 0.42) +
    0.28 * (blocky * blocky - 0.45) +
    0.3 * (joint * joint - 0.45) +
    strataAmp * (saw - 0.5) * 2 +
    blockAmp * (blocks - 0.5) * 2;
  if (fine) d += 0.15 * noise3(x * 0.9 - 2.1, y * 0.9, z * 0.9 + 7.7);
  return d;
}

/* ==========================================================================
 * The field
 * ========================================================================== */

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

const DI: Box = MASSIF_DETAIL_DOMAIN;
const DO: Box = MASSIF_DOMAIN;

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
    if ((k & 3) === 3) yield;
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
    if ((k & 31) === 31) yield;
  }
  return { x0, z0, h, nx, nz, height, slope };
}

function* buildCacheForBox(box: Box, spacing: number, pad: number): Generator<void, GroundCache, void> {
  const padCells = Math.ceil(pad / spacing);
  const nx = Math.ceil((box.x1 - box.x0) / spacing) + padCells * 2 + 1;
  const nz = Math.ceil((box.z1 - box.z0) / spacing) + padCells * 2 + 1;
  return yield* buildGroundCache(box.x0 - padCells * spacing, box.z0 - padCells * spacing, spacing, nx, nz);
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

/** Horizontal distance inside the massif domain (negative outside). */
function massifEdge(x: number, z: number): number {
  return Math.min(x - DO.x0, DO.x1 - x, z - DO.z0, DO.z1 - z);
}

/** How far a point lies inside the detail domain (negative outside). */
function insideDetail(x: number, y: number, z: number): number {
  return Math.min(x - DI.x0, DI.x1 - x, z - DI.z0, DI.z1 - z, y - DI.y0);
}

/** Width of the band at the massif edge over which the 3D rock hands over to the ground heightfield. */
const EDGE_FADE = 8;

/**
 * The mountain field at a point. `g` is the ground term already evaluated
 * there (cached or exact); `fine` adds the finest displacement octave.
 */
function composeField(g: number, x: number, y: number, z: number, fine: boolean): number {
  const edge = massifEdge(x, z);
  if (edge <= 0) return g;
  const front = frontComplex(x, y, z);
  let f = smin(g, front, 1.0);
  if (x > -14 && x < 26 && z > -24 && z < 12 && y < 46) f = smax(f, -cleftCarve(x, y, z), 0.35);
  if (x > -14 && x < 20 && z > -40 && z < -6 && y < 46) f = smax(f, -gorgeCarve(x, y, z), 0.5);
  const summit = summitSdf(x, y, z);
  f = smin(f, summit, 1.0);
  let fade = 1;
  if (edge < EDGE_FADE) {
    fade = smoothstep(1, EDGE_FADE, edge);
    f = g + (f - g) * fade;
  }
  if (f < MAX_DISPLACEMENT + 1.2 && f > -(MAX_DISPLACEMENT + 1.2)) {
    // Full relief on the carved rock; gentler where the ground heightfield is the surface
    // (it carries its own erosion detail, and strong 3D noise would float flakes off it).
    const groundShare = smoothstep(-0.6, 1.2, Math.min(front, summit) - g);
    const mask = detailMask(x, y, z) * fade * (1 - 0.65 * groundShare);
    if (mask > 0) f += displacement(x, y, z, fine) * mask;
  }
  return f;
}

/* ==========================================================================
 * Fracture facets — planar chips cut into the rock.
 *
 * Space is divided into jittered (Voronoi) cells. Each cell whose centre lies
 * near the surface owns a cutting plane: the local surface, tilted by a random
 * angle and sunk a little below it. Inside its own cell a plane cuts freely; in
 * a neighbouring cell its cut is lowered in proportion to how far the point
 * lies past the bisector (|p - c_m|² - |p - c_near|², a linear function of p).
 * The cut is the max over the nearby planes, so the field stays continuous and
 * piecewise planar: flat facets, sharp convex edges and steep little steps
 * where a deeper facet meets a shallower one, never deeper than the spec's
 * `cut`. Two octaves: slabs (~4.5 units) and chips (~2 units) cut into the
 * slabs. Chips only ever remove rock. Slabs are suppressed along the route and
 * at the standing spots (detailMask); the small chips reach to within 1.25 of
 * the route and 0.9 of a standing spot, and within 2.4 of the route they come
 * from one corridor grid shared by every detail level. All are faded out by a
 * region function — the fine pass fades them out toward the edge of the detail
 * domain, the coarse pass only carries slabs well outside it, so the two
 * surfaces always meet uncut at the seam.
 * ========================================================================== */

interface ChipSpec {
  /** Cell size (world units). */
  size: number;
  /** Deepest cut below the uncut surface. */
  cut: number;
  /** Tangential tilt of the planes (0.3 ≈ up to 17°). */
  tilt: number;
  /** 0 = random tilt directions, 1 = every facet tilted down the fall line. */
  fallLine: number;
  /**
   * Range of the planes' depth below the surface at the cell. Kept narrow: a
   * cell cut much deeper than all its neighbours would read as a pit.
   */
  depth0: number;
  depth1: number;
}

/*
 * A plane's cut grows by ~tilt per unit away from its cell; tilt × reach +
 * depth stays under `cut`, so facets are never flattened onto the cap (a capped
 * floor follows the rounded uncut surface and reads as a pit).
 */
const SLAB_CHIPS = { cut: 1.1, tilt: 0.34, fallLine: 0.7, depth0: 0.24, depth1: 0.3 } as const;
const SMALL_CHIPS = { cut: 0.5, tilt: 0.36, fallLine: 0.45, depth0: 0.09, depth1: 0.12 } as const;
/** Slab cells are this many times the size of the small chips. */
const SLAB_SCALE = 2.6;
/**
 * Cell size of the chips in the route corridor, the same for every detail
 * level: the animator places hands and feet on mountainSdf (the high field),
 * so the rock under them is cut from one lattice on every tier.
 */
const CORRIDOR_CHIP_SIZE = 1.7;
/** The corridor chips hand over to the detail level's own chips between these distances from the route. */
const CORRIDOR_IN = 1.8;
const CORRIDOR_OUT = 2.4;
/**
 * Small chips fade in between these distances from the route. The animator plants hands and feet on the
 * rock 0.15-1.45 from the route (median 0.7), so the rock there stays where it holds them.
 */
const CHIP_ROUTE_IN = 1.25;
const CHIP_ROUTE_FULL = 1.8;

/**
 * How a grid's cut fades near the climb. Slabs follow the displacement mask
 * (a slab could push the wall past the climbable 1.6); small chips only remove
 * rock and come within 1.25 of the route and 0.9 of a standing spot, split
 * between the detail level's grid (outside the corridor) and the shared
 * corridor grid (inside it).
 */
const CHIP_MODE_SLAB = 0;
const CHIP_MODE_TIER = 1;
const CHIP_MODE_CORRIDOR = 2;

/** Steepness of a plane's fall-off past its cell's bisector (per cell size). */
const CHIP_PENALTY = 1.1;
/**
 * Per cell: jittered centre (3; NaN until first used), plane normal (3), plane
 * offset, state (NaN or 0 unknown, 1 no chip, 2 chip).
 */
const CHIP_STRIDE = 8;

interface ChipGrid {
  spec: ChipSpec;
  x0: number;
  y0: number;
  z0: number;
  nx: number;
  ny: number;
  nz: number;
  data: Float32Array;
  /** The uncut field the planes are fitted to. */
  base: ScalarField;
  /** Where the chips apply (0..1), before the route mask. */
  region: ScalarField;
  /** Half-width of the band around the surface in which the cut is evaluated. */
  band: number;
  salt: number;
  /** CHIP_MODE_*: how the cut fades near the route and the standing spots. */
  mode: number;
  /**
   * Scratch for chipField, per grid: fitting a plane lazily evaluates the base
   * field, which may run another grid's chipField in the middle of this one.
   */
  r2: Float64Array;
  ids: Int32Array;
}

/** Deterministic integer hash → [0, 1). */
function hash3i(i: number, j: number, k: number, salt: number): number {
  let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(k, 0x1b873593) ^ Math.imul(salt + 1, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function createChipGrid(box: Box, spec: ChipSpec, base: ScalarField, region: ScalarField, band: number, salt: number, mode: number): ChipGrid {
  const size = spec.size;
  const pad = 2;
  const x0 = box.x0 - pad * size;
  const y0 = box.y0 - pad * size;
  const z0 = box.z0 - pad * size;
  const nx = Math.ceil((box.x1 - box.x0) / size) + 2 * pad;
  const ny = Math.ceil((box.y1 - box.y0) / size) + 2 * pad;
  const nz = Math.ceil((box.z1 - box.z0) / size) + 2 * pad;
  // Cells are filled lazily (a NaN centre = not yet jittered), so creating a grid costs one allocation.
  const data = new Float32Array(nx * ny * nz * CHIP_STRIDE).fill(Number.NaN);
  return { spec, x0, y0, z0, nx, ny, nz, data, base, region, band, salt, mode, r2: new Float64Array(27), ids: new Int32Array(27) };
}

/** Fits (once) the cutting plane of a cell; false when the cell carries no chip. */
function chipPlane(g: ChipGrid, cell: number): boolean {
  const d = g.data;
  const o = cell * CHIP_STRIDE;
  const state = d[o + 7];
  if (state === 1 || state === 2) return state === 2;
  const cx = d[o];
  const cy = d[o + 1];
  const cz = d[o + 2];
  buildWork.count += 15;
  const f = g.base(cx, cy, cz);
  if (Math.abs(f) > 0.8 * g.spec.size) {
    d[o + 7] = 1;
    return false;
  }
  const e = 0.2;
  let gx = g.base(cx + e, cy, cz) - g.base(cx - e, cy, cz);
  let gy = g.base(cx, cy + e, cz) - g.base(cx, cy - e, cz);
  let gz = g.base(cx, cy, cz + e) - g.base(cx, cy, cz - e);
  const gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
  if (gl < 1e-6) {
    d[o + 7] = 1;
    return false;
  }
  gx /= gl;
  gy /= gl;
  gz /= gl;
  // Point on the surface under the centre (one Newton step is plenty at this scale).
  const sx = cx - f * gx;
  const sy = cy - f * gy;
  const sz = cz - f * gz;
  // Tilt within the tangent plane: mostly down the fall line, jittered per cell. Each facet leans
  // out at its top, so where it meets the facet above, the step between them is an up-facing
  // ledge (it holds snow) rather than an overhang. On flat ground the fall line is undefined and
  // the tilt is random.
  let tx = hash3i(cell, 7, 1, g.salt + 4) * 2 - 1;
  let ty = hash3i(cell, 7, 2, g.salt + 5) * 2 - 1;
  let tz = hash3i(cell, 7, 3, g.salt + 6) * 2 - 1;
  const tn = tx * gx + ty * gy + tz * gz;
  tx -= tn * gx;
  ty -= tn * gy;
  tz -= tn * gz;
  // Downhill tangent: -Y with its normal component removed.
  const ux = gy * gx;
  const uy = gy * gy - 1;
  const uz = gy * gz;
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
  const coherence = g.spec.fallLine * smoothstep(0.15, 0.5, ul);
  if (ul > 1e-4) {
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    const strength = 0.55 + 0.45 * hash3i(cell, 8, 8, g.salt + 8);
    tx = (tx / tl) * (1 - coherence) + (ux / ul) * coherence * strength;
    ty = (ty / tl) * (1 - coherence) + (uy / ul) * coherence * strength;
    tz = (tz / tl) * (1 - coherence) + (uz / ul) * coherence * strength;
  }
  const tilt = g.spec.tilt;
  let mx = gx + tilt * tx;
  let my = gy + tilt * ty;
  let mz = gz + tilt * tz;
  const ml = Math.sqrt(mx * mx + my * my + mz * mz);
  mx /= ml;
  my /= ml;
  mz /= ml;
  // Concave rock (hollows, gullies) is left uncut: a plane tangent at the bottom of a hollow lies
  // above its walls and would cut them back, deepening the hollow into a pit. The field's Laplacian
  // over a third of a cell (≈ twice the mean curvature) must not be markedly negative.
  const h = 0.33 * g.spec.size;
  const laplacian =
    (g.base(cx + h, cy, cz) + g.base(cx - h, cy, cz) + g.base(cx, cy + h, cz) + g.base(cx, cy - h, cz) + g.base(cx, cy, cz + h) + g.base(cx, cy, cz - h) - 6 * f) /
    (h * h);
  if (laplacian < -1.6 / g.spec.size) {
    d[o + 7] = 1;
    return false;
  }
  // Thin rock (fins, lips, the rims of shelves) is left uncut: a cut from either side could slice
  // a sliver loose. The rock must stay solid well past twice the cut depth under the surface point.
  const probe = 2 * g.spec.cut + 0.35;
  if (g.base(sx - gx * probe, sy - gy * probe, sz - gz * probe) > -0.3) {
    d[o + 7] = 1;
    return false;
  }
  const depth = g.spec.depth0 + (g.spec.depth1 - g.spec.depth0) * hash3i(cell, 9, 9, g.salt + 7);
  d[o + 3] = mx;
  d[o + 4] = my;
  d[o + 5] = mz;
  d[o + 6] = depth - (sx * mx + sy * my + sz * mz);
  d[o + 7] = 2;
  return true;
}

/**
 * The fracture plane that produced the last value of a chipped field: `plane`
 * is 1 when a facet plane is the surface there (0 when the uncut or capped
 * surface is), with the plane's exact unit gradient and its facet id in
 * [0, 1). Module scratch, valid right after an evaluation of a field built by
 * fineChippedField / coarseChippedField; the outermost winning grid (a chip
 * over a slab) sets it.
 */
const CHIP_WIN = { plane: 0, nx: 0, ny: 0, nz: 0, id: 0 };

/** Grid cells of the winning plane and of the nearest centre at the last chipEnvelope call (read right after it). */
const ENV = { best: -1, near: -1 };

/**
 * Upper envelope of the grid's facet planes at a point: the max over the 27
 * nearby cells of each cell's plane minus its bisector penalty, fitting planes
 * lazily (which evaluates the base field). -Infinity when no nearby cell
 * carries a plane or the point lies outside the grid. Fills ENV.
 */
function chipEnvelope(g: ChipGrid, x: number, y: number, z: number): number {
  const s = g.spec.size;
  const ci = Math.floor((x - g.x0) / s);
  const cj = Math.floor((y - g.y0) / s);
  const ck = Math.floor((z - g.z0) / s);
  // The grid is padded by two cells around its box, and every region lies inside the box.
  if (ci < 1 || cj < 1 || ck < 1 || ci > g.nx - 2 || cj > g.ny - 2 || ck > g.nz - 2) return -Infinity;
  const d = g.data;
  // Squared distances to the 27 candidate centres; the nearest defines the bisector penalties.
  const r2 = g.r2;
  const ids = g.ids;
  const sy = g.nx;
  const sz = g.nx * g.ny;
  let n = 0;
  let near2 = Infinity;
  let nearIdx = 0;
  for (let k = ck - 1; k <= ck + 1; k += 1) {
    for (let j = cj - 1; j <= cj + 1; j += 1) {
      const row = sy * j + sz * k;
      for (let i = ci - 1; i <= ci + 1; i += 1) {
        const cell = i + row;
        const o = cell * CHIP_STRIDE;
        if (d[o] !== d[o]) {
          d[o] = g.x0 + (i + 0.1 + 0.8 * hash3i(i, j, k, g.salt + 1)) * s;
          d[o + 1] = g.y0 + (j + 0.1 + 0.8 * hash3i(i, j, k, g.salt + 2)) * s;
          d[o + 2] = g.z0 + (k + 0.1 + 0.8 * hash3i(i, j, k, g.salt + 3)) * s;
          d[o + 7] = 0;
        }
        const dx = x - d[o];
        const dy = y - d[o + 1];
        const dz = z - d[o + 2];
        const dd = dx * dx + dy * dy + dz * dz;
        ids[n] = cell;
        r2[n] = dd;
        if (dd < near2) {
          near2 = dd;
          nearIdx = n;
        }
        n += 1;
      }
    }
  }
  const slope = CHIP_PENALTY / s;
  const reach = 2.5 + g.spec.cut;
  let cut = -Infinity;
  let bestIdx = -1;
  for (let m = 0; m < 27; m += 1) {
    const penalty = slope * (r2[m] - near2);
    // Planes penalised this much sit far below the nearest facet wherever the cut can reach;
    // skipping them also spares fitting distant cells.
    if (penalty > reach) continue;
    const cell = ids[m];
    const o = cell * CHIP_STRIDE;
    const state = d[o + 7];
    if (state === 1 || (state !== 2 && !chipPlane(g, cell))) continue;
    const plane = d[o + 3] * x + d[o + 4] * y + d[o + 5] * z + d[o + 6] - penalty;
    if (plane > cut) {
      cut = plane;
      bestIdx = m;
    }
  }
  ENV.best = bestIdx >= 0 ? ids[bestIdx] : -1;
  ENV.near = ids[nearIdx];
  return cut;
}

/**
 * Sets CHIP_WIN to the envelope plane of cell `best` (nearest centre `near`):
 * plane = m·p + d - slope (|p - c_best|² - |p - c_near|²), whose exact gradient
 * is m - 2 slope (c_near - c_best).
 */
function setChipWin(g: ChipGrid, best: number, near: number): void {
  const d = g.data;
  const ob = best * CHIP_STRIDE;
  const on = near * CHIP_STRIDE;
  const k = (2 * CHIP_PENALTY) / g.spec.size;
  const gx = d[ob + 3] - k * (d[on] - d[ob]);
  const gy = d[ob + 4] - k * (d[on + 1] - d[ob + 1]);
  const gz = d[ob + 5] - k * (d[on + 2] - d[ob + 2]);
  const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
  CHIP_WIN.plane = 1;
  CHIP_WIN.nx = gx / gl;
  CHIP_WIN.ny = gy / gl;
  CHIP_WIN.nz = gz / gl;
  CHIP_WIN.id = hash3i(best, 0, 0, g.salt + 31);
}

/** The field `f` (uncut, at x, y, z) with the grid's facets cut into it. */
function chipField(g: ChipGrid, x: number, y: number, z: number, f: number): number {
  // Far from the surface the cut cannot change the sign of the field at any
  // grid point next to a crossing, so only a band around the surface is cut.
  if (f > g.band || f < -(g.spec.cut + g.band)) return f;
  const region = g.region(x, y, z);
  if (region <= 0) return f;
  let amount: number;
  if (g.mode === CHIP_MODE_SLAB) {
    amount = smoothstep(0.25, 0.65, detailMask(x, y, z)) * region;
  } else {
    routeStandDistances(x, y, z);
    const split = smoothstep(CORRIDOR_IN, CORRIDOR_OUT, DIST.route);
    amount = Math.min(smoothstep(CHIP_ROUTE_IN, CHIP_ROUTE_FULL, DIST.route), smoothstep(0.9, 1.8, DIST.stand)) * region * (g.mode === CHIP_MODE_TIER ? split : 1 - split);
  }
  if (amount <= 0) return f;
  // Fitting planes evaluates the base field (which may set CHIP_WIN): keep the entry state (the
  // winner of the grids already applied to `f`) to restore when this grid's plane does not win.
  const winPlane = CHIP_WIN.plane;
  const winX = CHIP_WIN.nx;
  const winY = CHIP_WIN.ny;
  const winZ = CHIP_WIN.nz;
  const winId = CHIP_WIN.id;
  const cut = chipEnvelope(g, x, y, z);
  const cap = f + g.spec.cut * amount;
  if (cut > f && cut <= cap) {
    // The plane is the surface.
    setChipWin(g, ENV.best, ENV.near);
    return cut;
  }
  CHIP_WIN.plane = winPlane;
  CHIP_WIN.nx = winX;
  CHIP_WIN.ny = winY;
  CHIP_WIN.nz = winZ;
  CHIP_WIN.id = winId;
  if (cut === -Infinity) return f;
  return Math.max(f, Math.min(cut, cap));
}

/** Fine-pass chip region: full inside the detail domain, fading out over its last few units. */
const fineChipRegion: ScalarField = (x, y, z) => smoothstep(1, 5, insideDetail(x, y, z));

/** Coarse-pass slab region: only well outside the detail domain, fading out at the massif edge. */
const coarseChipRegion: ScalarField = (x, y, z) => smoothstep(4, 9, -insideDetail(x, y, z)) * smoothstep(2, 8, massifEdge(x, z));

/**
 * Band around the surface that must be cut exactly for a surface-net pass with
 * cells of `cell` units (the field changes by at most LIPSCHITZ per unit).
 */
function chipBand(cell: number): number {
  return Math.max(1, LIPSCHITZ * cell);
}

/** A fine-pass field that can also tell the facet its corridor chips would cut where the climb keeps the rock uncut. */
type FineField = ScalarField & {
  /**
   * Where the small chips are held back for the climb (hands and feet rest on the rock within ~1.5 of
   * the route; the standing spots), sets CHIP_WIN to the facet a full corridor chip would cut at
   * (x, y, z), whose field value is `f`, and returns true; false elsewhere or where no chip would cut.
   * Shading only: the rock itself stays where the animator holds it.
   */
  corridorFacet: (x: number, y: number, z: number, f: number) => boolean;
};

/** The fine field `uncut` with slabs and chips (cell size `chip`) cut into it, exact for `cell`-sized surface nets. */
function fineChippedField(uncut: ScalarField, chip: number, cell: number): FineField {
  const band = chipBand(cell);
  const slabs = createChipGrid(DI, { size: chip * SLAB_SCALE, ...SLAB_CHIPS }, uncut, fineChipRegion, band + SMALL_CHIPS.cut, 100, CHIP_MODE_SLAB);
  const slabbed: ScalarField = (x, y, z) => {
    const u = uncut(x, y, z);
    CHIP_WIN.plane = 0;
    return chipField(slabs, x, y, z, u);
  };
  // The tier's chips and the shared corridor chips have complementary amounts, so together they
  // never cut deeper than one small chip (the slab band above allows for one).
  const chips = createChipGrid(DI, { size: chip, ...SMALL_CHIPS }, slabbed, fineChipRegion, band, 200, CHIP_MODE_TIER);
  const corridor = createChipGrid(DI, { size: CORRIDOR_CHIP_SIZE, ...SMALL_CHIPS }, uncut, fineChipRegion, band, 200, CHIP_MODE_CORRIDOR);
  const field: ScalarField = (x, y, z) => chipField(corridor, x, y, z, chipField(chips, x, y, z, slabbed(x, y, z)));
  const corridorFacet = (x: number, y: number, z: number, f: number): boolean => {
    routeStandDistances(x, y, z);
    if ((DIST.route >= CHIP_ROUTE_FULL && DIST.stand >= 1.8) || fineChipRegion(x, y, z) <= 0) return false;
    const cut = chipEnvelope(corridor, x, y, z);
    if (!(cut > f && cut <= f + SMALL_CHIPS.cut)) return false;
    setChipWin(corridor, ENV.best, ENV.near);
    return true;
  };
  return Object.assign(field, { corridorFacet });
}

/** The coarse field `uncut` with slabs (cell size `chip` × SLAB_SCALE) cut into it outside the detail domain. */
function coarseChippedField(uncut: ScalarField, chip: number, cell: number): ScalarField {
  const slabs = createChipGrid(DO, { size: chip * SLAB_SCALE, ...SLAB_CHIPS }, uncut, coarseChipRegion, chipBand(cell), 300, CHIP_MODE_SLAB);
  return (x, y, z) => {
    const u = uncut(x, y, z);
    CHIP_WIN.plane = 0;
    return chipField(slabs, x, y, z, u);
  };
}

let sdfField: ScalarField | null = null;

/**
 * Signed distance (approximate, negative inside rock) of the mountain at a
 * world position, at full detail (the high-detail fine surface inside the
 * detail domain, the coarse surface's slabs outside it). Useful for placing
 * effects near rock. The first call builds a 0.5-unit ground lookup over the
 * massif (~50k samples).
 */
export function mountainSdf(x: number, y: number, z: number): number {
  if (!sdfField) {
    const steps = buildCacheForBox(DO, 0.5, 10);
    let r = steps.next();
    while (!r.done) r = steps.next();
    const cache = r.value;
    const chip = DETAIL_CONFIG.high.chipSize;
    const uncut: ScalarField = (px, py, pz) => composeField(groundAt(cache, px, py, pz), px, py, pz, true);
    // Exact within 1.6 of the surface (the band of a 0.67-unit surface net).
    const fine = fineChippedField(uncut, chip, 0.67);
    const coarse = coarseChippedField(uncut, chip, 0.67);
    sdfField = (px, py, pz) => (insideDetail(px, py, pz) > -4 ? fine(px, py, pz) : coarse(px, py, pz));
  }
  return sdfField(x, y, z);
}

/** Ground term from the cache inside its footprint, exact outside. */
function groundAt(cache: GroundCache, x: number, y: number, z: number): number {
  const inCache = x > DO.x0 - 9 && x < DO.x1 + 9 && z > DO.z0 - 9 && z < DO.z1 + 9;
  return groundTerm(inCache ? cache : null, x, y, z);
}

/* ==========================================================================
 * Sparse surface nets
 * ========================================================================== */

const BRICK = 8;
const BRICK_CELLS = BRICK * BRICK * BRICK;
/** Conservative Lipschitz bound of the field, used for the seeding march. */
const LIPSCHITZ = 2.4;
/**
 * Field evaluations between two yields of the time-sliced build (~1–2 ms on
 * a mid-range CPU). Loops without field evaluations yield every LOOP_QUANTUM
 * iterations.
 */
const WORK_QUANTUM = 500;
const LOOP_QUANTUM = 16384;

/**
 * Field evaluations done since the build last yielded, including the nested
 * ones hidden inside a single evaluation (fitting a facet plane evaluates the
 * field underneath it ~14 times). Generators that evaluate the field yield
 * once it passes WORK_QUANTUM and reset it.
 */
const buildWork = { count: 0 };

type ScalarField = (x: number, y: number, z: number) => number;

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
  push3(a: number, b: number, c: number): void {
    if (this.length + 3 > this.data.length) {
      const next = new Uint32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length] = a;
    this.data[this.length + 1] = b;
    this.data[this.length + 2] = c;
    this.length += 3;
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
function* polygonise(box: Box, cell: number, field: ScalarField): Generator<void, SurfaceMesh, void> {
  const x0 = box.x0;
  const y0 = box.y0;
  const z0 = box.z0;
  const nx = Math.ceil((box.x1 - box.x0) / cell);
  const ny = Math.ceil((box.y1 - box.y0) / cell);
  const nz = Math.ceil((box.z1 - box.z0) / cell);
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
      buildWork.count += 1;
      v = field(x0 + i * cell, y0 + j * cell, z0 + k * cell);
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
      let y = box.y1;
      let prevY = y;
      let f = field(x, y, z);
      buildWork.count += 1;
      while (f > 0 && y > box.y0) {
        prevY = y;
        y -= Math.max(cell, (f / LIPSCHITZ) * 0.9);
        f = field(x, Math.max(box.y0, y), z);
        buildWork.count += 1;
        if (buildWork.count > WORK_QUANTUM) {
          buildWork.count = 0;
          yield;
        }
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
      if (buildWork.count > WORK_QUANTUM) {
        buildWork.count = 0;
        yield;
      }
    }
  }

  // ---- Trace the connected surface.
  const pos = new GrowableF32(1 << 18);
  const surfaceCells = new GrowableU32(1 << 18);
  const corner = new Float64Array(8);
  let head = 0;
  let traced = 0;
  while (head < queue.length) {
    traced += 1;
    if (buildWork.count > WORK_QUANTUM || (traced & 16383) === 0) {
      buildWork.count = 0;
      yield;
    }
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
  /** Appends a triangle unless it is degenerate (coincident surface-net vertices). */
  const tri = (a: number, b: number, c: number): void => {
    const abx = p[b * 3] - p[a * 3];
    const aby = p[b * 3 + 1] - p[a * 3 + 1];
    const abz = p[b * 3 + 2] - p[a * 3 + 2];
    const acx = p[c * 3] - p[a * 3];
    const acy = p[c * 3 + 1] - p[a * 3 + 1];
    const acz = p[c * 3 + 2] - p[a * 3 + 2];
    const cx = aby * acz - abz * acy;
    const cy = abz * acx - abx * acz;
    const cz = abx * acy - aby * acx;
    if (cx * cx + cy * cy + cz * cz > 1e-12) idx.push3(a, b, c);
  };
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
        tri(a, b, c);
        tri(a, c, d);
      } else {
        tri(a, b, d);
        tri(b, c, d);
      }
    } else if (splitAC) {
      tri(a, c, b);
      tri(a, d, c);
    } else {
      tri(a, d, b);
      tri(b, d, c);
    }
  };

  const sc = surfaceCells.data;
  for (let n = 0; n < surfaceCells.length; n += 3) {
    if (n % 24576 === 0 || buildWork.count > WORK_QUANTUM) {
      buildWork.count = 0;
      yield;
    }
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
  return { positions, normals, indices, vertexCount, triangleCount: indices.length / 3 };
}

/**
 * Pulls the vertices close to the climb route exactly onto the iso-surface
 * (two Newton steps), so ledges and lips sit where the route expects them.
 */
function* projectNearRoute(mesh: SurfaceMesh, field: ScalarField, maxStep: number): Generator<void, number, void> {
  const p = mesh.positions;
  const e = 0.03;
  let moved = 0;
  for (let v = 0; v < mesh.vertexCount; v += 1) {
    if ((v & 4095) === 4095 || buildWork.count > WORK_QUANTUM) {
      buildWork.count = 0;
      yield;
    }
    let x = p[v * 3];
    let y = p[v * 3 + 1];
    let z = p[v * 3 + 2];
    if (detailMask(x, y, z) >= 0.999) continue;
    buildWork.count += 14;
    for (let it = 0; it < 2; it += 1) {
      const f = field(x, y, z);
      const gx = (field(x + e, y, z) - field(x - e, y, z)) / (2 * e);
      const gy = (field(x, y + e, z) - field(x, y - e, z)) / (2 * e);
      const gz = (field(x, y, z + e) - field(x, y, z - e)) / (2 * e);
      const g2 = gx * gx + gy * gy + gz * gz;
      if (g2 < 1e-8) break;
      let s = f / g2;
      const len = Math.abs(s) * Math.sqrt(g2);
      if (len > maxStep) s *= maxStep / len;
      x -= s * gx;
      y -= s * gy;
      z -= s * gz;
    }
    p[v * 3] = x;
    p[v * 3 + 1] = y;
    p[v * 3 + 2] = z;
    moved += 1;
  }
  return moved;
}

/**
 * Removes connected components that neither reach the domain boundary nor are
 * the largest one: loose debris the noise can pinch off. Returns the count.
 */
function* removeFloatingComponents(mesh: SurfaceMesh, box: Box, cell: number): Generator<void, number, void> {
  const n = mesh.vertexCount;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i += 1) parent[i] = i;
  const find = (a: number): number => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) {
      const next = parent[a];
      parent[a] = r;
      a = next;
    }
    return r;
  };
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = find(idx[t]);
    const b = find(idx[t + 1]);
    const c = find(idx[t + 2]);
    if (b !== a) parent[b] = a;
    if (c !== a && c !== b) parent[c] = a;
    if (t % (LOOP_QUANTUM * 3) === 0) yield;
  }
  const size = new Int32Array(n);
  const touches = new Uint8Array(n);
  const p = mesh.positions;
  const m = cell * 1.5;
  let largest = -1;
  for (let v = 0; v < n; v += 1) {
    const r = find(v);
    size[r] += 1;
    const x = p[v * 3];
    const y = p[v * 3 + 1];
    const z = p[v * 3 + 2];
    if (x < box.x0 + m || x > box.x1 - m || y < box.y0 + m || y > box.y1 - m || z < box.z0 + m || z > box.z1 - m) touches[r] = 1;
    if (largest < 0 || size[r] > size[largest]) largest = r;
    if (v % LOOP_QUANTUM === LOOP_QUANTUM - 1) yield;
  }
  yield;
  let removed = 0;
  let w = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const r = find(idx[t]);
    if (r !== largest && touches[r] === 0) {
      removed += 1;
      continue;
    }
    idx[w] = idx[t];
    idx[w + 1] = idx[t + 1];
    idx[w + 2] = idx[t + 2];
    w += 3;
    if (t % (LOOP_QUANTUM * 3) === 0) yield;
  }
  if (removed > 0) {
    mesh.indices = idx.slice(0, w);
    mesh.triangleCount = w / 3;
  }
  return removed;
}

function* accumulateNormals(positions: Float32Array, indices: Uint32Array, normals: Float32Array): Generator<void, void, void> {
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
    if (t % (LOOP_QUANTUM * 3) === 0) yield;
  }
  yield;
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.sqrt(normals[i] * normals[i] + normals[i + 1] * normals[i + 1] + normals[i + 2] * normals[i + 2]) || 1;
    normals[i] /= l;
    normals[i + 1] /= l;
    normals[i + 2] /= l;
  }
}

/* ==========================================================================
 * Facet ids and facet-plane normals
 * ========================================================================== */

/** Size of the lattice whose cells give the facet id where no fracture plane shapes the rock. */
const FACET_LATTICE = 2.5;

function latticeFacet(x: number, y: number, z: number): number {
  return hash3i(Math.floor(x / FACET_LATTICE), Math.floor(y / FACET_LATTICE), Math.floor(z / FACET_LATTICE), 977);
}

/** Lattice facet ids for every vertex (surfaces the fracture planes never shape: flanks, skirt). */
function* latticeFacets(positions: Float32Array): Generator<void, Float32Array, void> {
  const count = positions.length / 3;
  const out = new Float32Array(count);
  for (let v = 0; v < count; v += 1) {
    out[v] = latticeFacet(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    if ((v & 16383) === 16383) yield;
  }
  return out;
}

/** Plane normals further than this (cosine) from the area-weighted normal are not used (crease vertices). */
const FACET_NORMAL_MIN_COS = 0.7071;
/** The same for the shading-only corridor facets (no geometric crease backs them up). */
const CORRIDOR_FACET_MIN_COS = 0.866;

/**
 * Facet-plane vertex normals and facet ids for a fine surface: the field is
 * evaluated once at each (final) vertex position; where a fracture plane is
 * the surface there, its exact gradient replaces the area-weighted normal
 * (unless they disagree by more than 45°, as at the vertices on a sharp
 * crease) and its cell gives the facet id. Where the climb keeps the rock
 * uncut, the facet a corridor chip would cut there shades it instead (within
 * 30°). Elsewhere the area-weighted normal stays and the id comes from a
 * lattice cell. `mesh.normals` must hold the area-weighted normals; they are
 * overwritten. Returns the number of planar normals written.
 */
function* facetNormals(mesh: SurfaceMesh, field: FineField, facetOut: Float32Array): Generator<void, number, void> {
  const p = mesh.positions;
  const n = mesh.normals;
  let planar = 0;
  for (let v = 0; v < mesh.vertexCount; v += 1) {
    if ((v & 4095) === 4095 || buildWork.count > WORK_QUANTUM) {
      buildWork.count = 0;
      yield;
    }
    const x = p[v * 3];
    const y = p[v * 3 + 1];
    const z = p[v * 3 + 2];
    buildWork.count += 3;
    const f = field(x, y, z);
    let minCos = FACET_NORMAL_MIN_COS;
    if (CHIP_WIN.plane === 0) {
      if (!field.corridorFacet(x, y, z, f)) {
        facetOut[v] = latticeFacet(x, y, z);
        continue;
      }
      minCos = CORRIDOR_FACET_MIN_COS;
    }
    facetOut[v] = CHIP_WIN.id;
    const o = v * 3;
    if (CHIP_WIN.nx * n[o] + CHIP_WIN.ny * n[o + 1] + CHIP_WIN.nz * n[o + 2] >= minCos) {
      n[o] = CHIP_WIN.nx;
      n[o + 1] = CHIP_WIN.ny;
      n[o + 2] = CHIP_WIN.nz;
      planar += 1;
    }
  }
  return planar;
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
  const x0 = DO.x0 - pad;
  const y0 = DO.y0;
  const z0 = DO.z0 - pad;
  const nx = Math.ceil((DO.x1 - DO.x0 + pad * 2) / spacing);
  const ny = Math.ceil((DO.y1 + 10 - DO.y0) / spacing);
  const nz = Math.ceil((DO.z1 - DO.z0 + pad * 2) / spacing);
  const data = new Float32Array((nx + 1) * (ny + 1) * (nz + 1));
  let o = 0;
  for (let k = 0; k <= nz; k += 1) {
    const z = z0 + k * spacing;
    for (let j = 0; j <= ny; j += 1) {
      const y = y0 + j * spacing;
      for (let i = 0; i <= nx; i += 1) {
        const x = x0 + i * spacing;
        data[o] = composeField(groundTerm(cache, x, y, z), x, y, z, false);
        o += 1;
      }
      buildWork.count += nx + 1;
      if (buildWork.count > WORK_QUANTUM) {
        buildWork.count = 0;
        yield;
      }
    }
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
    // Overhang undersides and deep chasm floors see less sky.
    const skyBias = 0.06 * clamp(-ny, 0, 1) + 0.12 * smoothstep(-4, -26, py);
    ao[v] = clamp(1 - occ * 1.2 - skyBias, 0.2, 1);
  }
  return ao;
}

/* ==========================================================================
 * Baked curvature (cavity): the mesh Laplacian along the normal, smoothed.
 * ========================================================================== */

/**
 * Per-vertex curvature in -1..1 (negative in creases and hollows, positive on
 * convex edges), measured on the 1-ring Laplacian and smoothed over two rings
 * so the surface-net staircase does not show. `cell` is the mesh resolution.
 */
function* bakeCurvature(positions: Float32Array, normals: Float32Array, indices: Uint32Array, cell: number): Generator<void, Float32Array, void> {
  const count = positions.length / 3;
  const sum = new Float32Array(count * 3);
  const weight = new Float32Array(count);
  const addEdge = (a: number, b: number): void => {
    sum[a * 3] += positions[b * 3];
    sum[a * 3 + 1] += positions[b * 3 + 1];
    sum[a * 3 + 2] += positions[b * 3 + 2];
    weight[a] += 1;
  };
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    addEdge(a, b);
    addEdge(a, c);
    addEdge(b, a);
    addEdge(b, c);
    addEdge(c, a);
    addEdge(c, b);
    if (t % (LOOP_QUANTUM * 3) === 0) yield;
  }
  let curv = new Float32Array(count);
  const gain = 1 / (0.22 * cell);
  for (let v = 0; v < count; v += 1) {
    const w = weight[v];
    if (w === 0) continue;
    const lx = sum[v * 3] / w - positions[v * 3];
    const ly = sum[v * 3 + 1] / w - positions[v * 3 + 1];
    const lz = sum[v * 3 + 2] / w - positions[v * 3 + 2];
    // Neighbours below the tangent plane (Laplacian against the normal) = convex.
    curv[v] = -(lx * normals[v * 3] + ly * normals[v * 3 + 1] + lz * normals[v * 3 + 2]) * gain;
    if (v % (LOOP_QUANTUM * 4) === 0) yield;
  }
  yield;
  for (let pass = 0; pass < 2; pass += 1) {
    const acc = new Float32Array(count);
    const accW = new Float32Array(count);
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t];
      const b = indices[t + 1];
      const c = indices[t + 2];
      const m = curv[a] + curv[b] + curv[c];
      acc[a] += m;
      acc[b] += m;
      acc[c] += m;
      accW[a] += 3;
      accW[b] += 3;
      accW[c] += 3;
      if (t % (LOOP_QUANTUM * 3) === 0) yield;
    }
    for (let v = 0; v < count; v += 1) curv[v] = accW[v] > 0 ? acc[v] / accW[v] : 0;
    curv = curv.slice();
    yield;
  }
  for (let v = 0; v < count; v += 1) curv[v] = clamp(curv[v], -1, 1);
  return curv;
}

/* ==========================================================================
 * Chunking (frustum / shadow culling) with globally consistent normals.
 * ========================================================================== */

interface ChunkSpec {
  box: Box;
  sizeXZ: number;
  sizeY: number;
  prefix: string;
  kind: 'massif' | 'flank';
  /** Optional triangle filter (receives the three vertex indices). */
  keep: ((a: number, b: number, c: number) => boolean) | null;
}

function* chunkSurface(
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  ao: Float32Array,
  curvature: Float32Array,
  facet: Float32Array,
  spec: ChunkSpec,
): Generator<void, TerrainPiece[], void> {
  const { box } = spec;
  const cnx = Math.ceil((box.x1 - box.x0) / spec.sizeXZ);
  const cny = Math.ceil((box.y1 - box.y0) / spec.sizeY);
  const cnz = Math.ceil((box.z1 - box.z0) / spec.sizeXZ);
  const chunkCount = cnx * cny * cnz;
  const triCount = indices.length / 3;
  const triChunk = new Int32Array(triCount);
  const offsets = new Int32Array(chunkCount + 1);
  for (let t = 0; t < triCount; t += 1) {
    const ia = indices[t * 3];
    const ib = indices[t * 3 + 1];
    const ic = indices[t * 3 + 2];
    if (spec.keep && !spec.keep(ia, ib, ic)) {
      triChunk[t] = -1;
      continue;
    }
    const a = ia * 3;
    const b = ib * 3;
    const c = ic * 3;
    const cx = (positions[a] + positions[b] + positions[c]) / 3;
    const cy = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3;
    const cz = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
    const i = clamp(Math.floor((cx - box.x0) / spec.sizeXZ), 0, cnx - 1);
    const j = clamp(Math.floor((cy - box.y0) / spec.sizeY), 0, cny - 1);
    const k = clamp(Math.floor((cz - box.z0) / spec.sizeXZ), 0, cnz - 1);
    const ch = i + cnx * (j + cny * k);
    triChunk[t] = ch;
    offsets[ch + 1] += 1;
    if (t % LOOP_QUANTUM === 0) yield;
  }
  for (let ch = 0; ch < chunkCount; ch += 1) offsets[ch + 1] += offsets[ch];
  // Counting sort of triangles by chunk.
  const order = new Int32Array(offsets[chunkCount]);
  const cursor = offsets.slice(0, chunkCount);
  for (let t = 0; t < triCount; t += 1) {
    const ch = triChunk[t];
    if (ch < 0) continue;
    order[cursor[ch]] = t;
    cursor[ch] += 1;
    if (t % (LOOP_QUANTUM * 4) === 0) yield;
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
      if ((n - begin) % LOOP_QUANTUM === LOOP_QUANTUM - 1) yield;
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
    const crv = new Float32Array(vc);
    const fac = new Float32Array(vc);
    for (let l = 0; l < vc; l += 1) {
      const g = used[l];
      pos[l * 3] = positions[g * 3];
      pos[l * 3 + 1] = positions[g * 3 + 1];
      pos[l * 3 + 2] = positions[g * 3 + 2];
      nor[l * 3] = normals[g * 3];
      nor[l * 3 + 1] = normals[g * 3 + 1];
      nor[l * 3 + 2] = normals[g * 3 + 2];
      occ[l] = ao[g];
      crv[l] = curvature[g];
      fac[l] = facet[g];
      remap[g] = -1;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geometry.setAttribute('aOcclusion', new THREE.BufferAttribute(occ, 1));
    geometry.setAttribute('aCurvature', new THREE.BufferAttribute(crv, 1));
    geometry.setAttribute('aFacet', new THREE.BufferAttribute(fac, 1));
    geometry.setIndex(new THREE.BufferAttribute(local, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const i = ch % cnx;
    const j = Math.floor(ch / cnx) % cny;
    const k = Math.floor(ch / (cnx * cny));
    pieces.push({ name: `${spec.prefix}-${i}-${j}-${k}`, geometry, kind: spec.kind, triangles: tris });
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

const SKIRT_OVERLAP = 2.4;

function* buildSkirt(cfg: DetailConfig): Generator<void, TerrainPiece, void> {
  const pad = 14;
  const xs = axisCoordinates(SKIRT_EXTENT.x0, SKIRT_EXTENT.x1, DO.x0 - pad, DO.x1 + pad, cfg.skirtNear, cfg.skirtGrowth);
  const zs = axisCoordinates(SKIRT_EXTENT.z0, SKIRT_EXTENT.z1, DO.z0 - pad, DO.z1 + pad, cfg.skirtNear, cfg.skirtGrowth);
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
      const inside = massifEdge(x, z);
      // Tuck the overlap band just under the massif surface so the seams never show.
      if (inside > 0) y -= 0.45 * smoothstep(0, 1.6, inside) + Math.max(0, inside - SKIRT_OVERLAP) * 2;
      const o = i + w * k;
      heights[o] = y;
      positions[o * 3] = x;
      positions[o * 3 + 1] = y;
      positions[o * 3 + 2] = z;
    }
    if ((k & 3) === 3) yield;
  }
  const tri: number[] = [];
  for (let k = 0; k < hgt - 1; k += 1) {
    for (let i = 0; i < w - 1; i += 1) {
      // Skip cells wholly inside the domain beyond the overlap band.
      if (
        massifEdge(xs[i], zs[k]) > SKIRT_OVERLAP &&
        massifEdge(xs[i + 1], zs[k]) > SKIRT_OVERLAP &&
        massifEdge(xs[i], zs[k + 1]) > SKIRT_OVERLAP &&
        massifEdge(xs[i + 1], zs[k + 1]) > SKIRT_OVERLAP
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
    if ((k & 15) === 15) yield;
  }
  const indices = new Uint32Array(tri);
  const normals = new Float32Array(vertexCount * 3);
  yield* accumulateNormals(positions, indices, normals);

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
    if ((o & 4095) === 4095) yield;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('aOcclusion', new THREE.BufferAttribute(ao, 1));
  // The skirt is far away and smooth: no cavity detail.
  geometry.setAttribute('aCurvature', new THREE.BufferAttribute(new Float32Array(vertexCount), 1));
  geometry.setAttribute('aFacet', new THREE.BufferAttribute(yield* latticeFacets(positions), 1));
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
  /** Fine climb-detail surface. */
  massifTriangles: number;
  /** Coarse outer massif surface (after dropping what the fine pass covers). */
  flankTriangles: number;
  skirtTriangles: number;
  totalTriangles: number;
  pieces: number;
  /** Vertices snapped onto the exact surface near the route. */
  projectedVertices: number;
  /** Triangles of loose noise debris removed from the surface. */
  debrisTriangles: number;
  /** Pure CPU time spent building (excludes idle time between incremental steps). */
  milliseconds: number;
}

/** Depth of the band (inside the detail domain) where the coarse surface is tucked under the fine one. */
const TUCK_BAND = 3;
const TUCK_DEPTH = 0.7;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** The full build as a resumable sequence of small steps (each well under a millisecond). */
function* mountainBuildSteps(
  detail: TerrainDetail,
  onStats: (stats: Omit<MountainBuildStats, 'milliseconds'>) => void,
): Generator<void, TerrainPiece[], void> {
  const cfg = DETAIL_CONFIG[detail];

  // ---- Fine pass over the climb.
  const innerCache = yield* buildCacheForBox(DI, cfg.cell, 2);
  const innerUncut: ScalarField = (x, y, z) => composeField(groundTerm(innerCache, x, y, z), x, y, z, cfg.fineNoise);
  const innerField = fineChippedField(innerUncut, cfg.chipSize, cfg.cell);
  const inner = yield* polygonise(DI, cfg.cell, innerField);
  const debris = yield* removeFloatingComponents(inner, DI, cfg.cell);
  const projected = yield* projectNearRoute(inner, innerField, cfg.cell * 0.75);
  yield* accumulateNormals(inner.positions, inner.indices, inner.normals);

  // ---- Coarse pass over the whole massif, tucked under the fine surface inside the detail domain.
  const outerCache = yield* buildCacheForBox(DO, cfg.outerCell, 12);
  const outerUncut: ScalarField = (x, y, z) => composeField(groundTerm(outerCache, x, y, z), x, y, z, false);
  const outerSlabbed = coarseChippedField(outerUncut, cfg.chipSize, cfg.outerCell);
  const outerField: ScalarField = (x, y, z) => {
    const inside = insideDetail(x, y, z);
    return inside > 0 ? outerUncut(x, y, z) + TUCK_DEPTH * smoothstep(0, TUCK_BAND, inside) : outerSlabbed(x, y, z);
  };
  const outer = yield* polygonise(DO, cfg.outerCell, outerField);
  const outerDebris = yield* removeFloatingComponents(outer, DO, cfg.outerCell);
  yield* accumulateNormals(outer.positions, outer.indices, outer.normals);

  // ---- Occlusion for both.
  const coarse = yield* buildCoarseField(outerCache, cfg.aoSpacing);
  const innerAo = yield* bakeOcclusion(coarse, inner.positions, inner.normals);
  const outerAo = yield* bakeOcclusion(coarse, outer.positions, outer.normals);
  const innerCurv = yield* bakeCurvature(inner.positions, inner.normals, inner.indices, cfg.cell);
  const outerCurv = yield* bakeCurvature(outer.positions, outer.normals, outer.indices, cfg.outerCell);

  // ---- Facets: the fine surface shades with its fracture planes (after the bakes, which keep the
  // area-weighted normals); the flanks only carry lattice facet ids.
  const innerFacet = new Float32Array(inner.vertexCount);
  yield* facetNormals(inner, innerField, innerFacet);
  const outerFacet = yield* latticeFacets(outer.positions);

  const pieces = yield* chunkSurface(inner.positions, inner.normals, inner.indices, innerAo, innerCurv, innerFacet, {
    box: DI,
    sizeXZ: 16,
    sizeY: 28,
    prefix: 'massif',
    kind: 'massif',
    keep: null,
  });
  const massifTriangles = pieces.reduce((s, p) => s + p.triangles, 0);

  // Drop coarse triangles that lie wholly where the fine surface already covers them.
  const op = outer.positions;
  const dropDepth = TUCK_BAND + 2 * cfg.outerCell;
  const deep = (v: number): boolean => insideDetail(op[v * 3], op[v * 3 + 1], op[v * 3 + 2]) > dropDepth;
  const flankPieces = yield* chunkSurface(outer.positions, outer.normals, outer.indices, outerAo, outerCurv, outerFacet, {
    box: DO,
    sizeXZ: 34,
    sizeY: 62,
    prefix: 'flank',
    kind: 'flank',
    keep: (a, b, c) => !(deep(a) && deep(b) && deep(c)),
  });
  const flankTriangles = flankPieces.reduce((s, p) => s + p.triangles, 0);
  for (const piece of flankPieces) pieces.push(piece);

  const skirt = yield* buildSkirt(cfg);
  pieces.push(skirt);
  onStats({
    detail,
    massifTriangles,
    flankTriangles,
    skirtTriangles: skirt.triangles,
    totalTriangles: massifTriangles + flankTriangles + skirt.triangles,
    pieces: pieces.length,
    projectedVertices: projected,
    debrisTriangles: debris + outerDebris,
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
 * Builds the whole mountain synchronously for a detail level: chunked fine
 * massif pieces, coarse flank pieces and the outer skirt. Deterministic;
 * world-space positions; normals, baked `aOcclusion` (0.2..1), `aCurvature`
 * (-1..1) and the `aFacet` id ([0, 1)) included (see TerrainPiece). Callers
 * own and must dispose the returned geometries.
 */
export function buildMountainGeometries(detail: TerrainDetail): TerrainPiece[] {
  const builder = createMountainBuilder(detail);
  builder.step(Number.POSITIVE_INFINITY);
  return builder.pieces ?? [];
}
