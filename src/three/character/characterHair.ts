import { CRANIUM_CENTER, CRANIUM_RADII, scalpHairMask, scalpSdf, smoothstep, type CharacterDetailLevel } from './characterGeometry';

/* ==========================================================================
 * Layered hair cards — PURE module (no React, no DOM; runs in Node).
 *
 * A short-to-medium, swept hairstyle grown as strand cards from the scalp in
 * HEAD-LOCAL space (the Head bone frame; the mesh is parented to that bone):
 *
 *   layer 0  base       flat, dense, short: covers the scalp everywhere;
 *   layer 1  body       the combed shape — back & down at the sides and nape,
 *                       swept back and to the right from a left side part;
 *   layer 2  top        longer, lifted cards on the top and the fringe (the
 *                       volume that reads from behind and catches the wind).
 *
 * Roots come from a Fibonacci distribution over the cranium, kept where the
 * scalp mask has hair, and are projected onto the head SDF. Each card follows
 * a comb-direction field projected onto the scalp, re-projected every step so
 * it hugs the skull at a per-layer clearance that grows toward the tip.
 *
 * Per-vertex attributes for SilkyHairShader:
 *   position, normal (card normal ≈ scalp normal, outward),
 *   aTangent  strand direction root → tip,
 *   aStrand   (u across the card 0..1, v root → tip 0..1 = tip weight,
 *              per-card random seed, layer 0..1),
 *   aLength   card length in metres (scales wind amplitude).
 * Cards are written inner layer first so the blended pass draws outer layers
 * over inner ones without per-frame sorting.
 * ========================================================================== */

export interface HairLayerSpec {
  count: number;
  /** Length multiplier relative to the style's length field. */
  length: number;
  /** Clearance above the scalp at the root (m). */
  clearance: number;
  /** Extra clearance gained toward the tip (m). */
  lift: number;
  /** Card width at the root (m). */
  width: number;
  /** Random twist of the card about the strand (radians). */
  twist: number;
  /** Only grow where the head-local y is above this (top layer). */
  minY: number;
}

export interface HairDetail {
  segments: number;
  layers: readonly HairLayerSpec[];
}

const LAYERS_HIGH: readonly HairLayerSpec[] = [
  { count: 360, length: 0.86, clearance: 0.002, lift: 0.0018, width: 0.0142, twist: 0.05, minY: -1 },
  { count: 270, length: 0.98, clearance: 0.0042, lift: 0.0032, width: 0.015, twist: 0.08, minY: -0.06 },
  { count: 140, length: 1.06, clearance: 0.006, lift: 0.0042, width: 0.016, twist: 0.08, minY: 0.04 },
];

export const HAIR_DETAIL: Readonly<Record<CharacterDetailLevel, HairDetail>> = {
  high: { segments: 6, layers: LAYERS_HIGH },
  medium: {
    segments: 5,
    layers: [
      { ...LAYERS_HIGH[0], count: 220, width: 0.0165 },
      { ...LAYERS_HIGH[1], count: 180, width: 0.0175 },
      { ...LAYERS_HIGH[2], count: 90, width: 0.018 },
    ],
  },
  low: {
    segments: 4,
    layers: [
      { ...LAYERS_HIGH[0], count: 140, width: 0.019 },
      { ...LAYERS_HIGH[1], count: 110, width: 0.021 },
      { ...LAYERS_HIGH[2], count: 56, width: 0.022 },
    ],
  },
};

export interface HairGeometryData {
  positions: Float32Array;
  normals: Float32Array;
  tangents: Float32Array;
  strand: Float32Array;
  lengths: Float32Array;
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
  triangleCount: number;
  cardCount: number;
  /** Head-local bounding sphere (includes a margin for wind displacement). */
  boundingCenter: readonly [number, number, number];
  boundingRadius: number;
}

/* ---------------------------------------------------------------------------
 * Helpers
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

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Head-local SDF of the scalp the hair grows on (neck, cranium, forehead, ears). */
const headLocalSdf = scalpSdf;

const _g = new Float64Array(3);

/** Unit outward normal of the head surface near a head-local point. */
function headNormal(x: number, y: number, z: number, out: Float64Array): void {
  const e = 0.002;
  const gx = headLocalSdf(x + e, y, z) - headLocalSdf(x - e, y, z);
  const gy = headLocalSdf(x, y + e, z) - headLocalSdf(x, y - e, z);
  const gz = headLocalSdf(x, y, z + e) - headLocalSdf(x, y, z - e);
  const l = Math.hypot(gx, gy, gz) || 1;
  out[0] = gx / l;
  out[1] = gy / l;
  out[2] = gz / l;
}

/**
 * Keeps a head-local point between `clearance` and `clearance + slack` above the skin (writes p): strands are
 * pushed out of the scalp and pulled back onto it where a tangential step would leave the skull (no shelves).
 */
function hugScalp(p: Float64Array, clearance: number, slack: number): void {
  for (let i = 0; i < 3; i += 1) {
    const d = headLocalSdf(p[0], p[1], p[2]);
    let move = 0;
    if (d < clearance) move = clearance - d;
    else if (d > clearance + slack) move = clearance + slack - d;
    if (Math.abs(move) < 1e-5) return;
    headNormal(p[0], p[1], p[2], _g);
    p[0] += _g[0] * move;
    p[1] += _g[1] * move;
    p[2] += _g[2] * move;
  }
}

/** The side part sits on the character's left (+x) of the crown. */
const PART_X = 0.027;
/** Crown whorl (head-local). */
const CROWN: readonly [number, number, number] = [-0.012, 0.118, -0.07];

/** Comb direction (not yet tangent) of the hairstyle at a head-local point. */
function combDirection(x: number, y: number, z: number, out: Float64Array): void {
  const top = smoothstep(0.055, 0.105, y);
  const front = smoothstep(-0.02, 0.07, z);
  const leftOfPart = smoothstep(PART_X - 0.007, PART_X + 0.007, x);
  // Sides and back: combed back and down.
  let cx = 0;
  let cy = -0.45;
  let cz = -1;
  // Top: swept back and to the right (−x) from the part, lifted at the front; left of the part falls to the left.
  const sx = mix(-0.55, 0.6, leftOfPart);
  const sy = mix(0.1 + 0.28 * front, -0.25, leftOfPart);
  const sz = mix(-1.0 + 0.1 * front, -0.55, leftOfPart);
  cx = mix(cx, sx, top);
  cy = mix(cy, sy, top);
  cz = mix(cz, sz, top);
  // Back of the head: falls downward.
  const back = smoothstep(-0.035, -0.085, z) * (1 - 0.65 * top);
  cx *= 1 - back * 0.7;
  cy = mix(cy, -1, back);
  cz = mix(cz, -0.22, back);
  // Crown whorl: a gentle spiral around the crown point.
  const wx = x - CROWN[0];
  const wy = y - CROWN[1];
  const wz = z - CROWN[2];
  const wd = Math.hypot(wx, wy, wz);
  const whorl = smoothstep(0.03, 0.008, wd) * 0.7;
  if (whorl > 0) {
    // Tangential swirl (clockwise seen from above) plus outward spread.
    const tx = -wz;
    const tz = wx;
    const tl = Math.hypot(tx, tz) || 1;
    cx = mix(cx, tx / tl + wx / (wd || 1) * 0.6, whorl);
    cz = mix(cz, tz / tl + wz / (wd || 1) * 0.6, whorl);
    cy = mix(cy, -0.2, whorl);
  }
  out[0] = cx;
  out[1] = cy;
  out[2] = cz;
}

/** Hair length (m) of the style at a head-local point. */
function styleLength(x: number, y: number, z: number): number {
  const top = smoothstep(0.045, 0.105, y);
  const front = smoothstep(0.0, 0.08, z);
  const low = smoothstep(0.035, -0.035, y);
  const nape = smoothstep(-0.06, -0.1, z) * low;
  let l = mix(0.052, 0.082 + 0.022 * front, top);
  l = mix(l, 0.036, low * 0.85);
  l = mix(l, 0.026, nape);
  // Side taper above the ears.
  const side = smoothstep(0.058, 0.075, Math.abs(x)) * (1 - top);
  return mix(l, l * 0.85, side);
}

/* ---------------------------------------------------------------------------
 * Build
 * ------------------------------------------------------------------------- */

const cache = new Map<CharacterDetailLevel, HairGeometryData>();

const CARDS_PER_YIELD = 6;

function* buildHairSteps(detail: CharacterDetailLevel): Generator<void, HairGeometryData, void> {
  const spec = HAIR_DETAIL[detail];
  const S = spec.segments;
  const positions: number[] = [];
  const normals: number[] = [];
  const tangents: number[] = [];
  const strand: number[] = [];
  const lengths: number[] = [];
  const indices: number[] = [];
  const rand = mulberry32(0x5eed1e5);
  const p = new Float64Array(3);
  const n = new Float64Array(3);
  const c = new Float64Array(3);
  const pts = new Float64Array((S + 1) * 3);
  const nrm = new Float64Array((S + 1) * 3);
  let cardCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let layerIndex = 0; layerIndex < spec.layers.length; layerIndex += 1) {
    const layer = spec.layers[layerIndex];
    const layerT = spec.layers.length > 1 ? layerIndex / (spec.layers.length - 1) : 0;
    // Oversample the sphere so roughly `count` roots survive the scalp mask.
    const samples = Math.round(layer.count * 2.6);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const phase = rand() * Math.PI * 2;
    let made = 0;
    for (let i = 0; i < samples && made < layer.count; i += 1) {
      const fy = 1 - ((i + 0.5) / samples) * 2;
      const r = Math.sqrt(Math.max(0, 1 - fy * fy));
      const th = i * golden + phase;
      // Jitter so layers do not align.
      const jx = Math.cos(th) * r + (rand() - 0.5) * 0.05;
      const jy = fy + (rand() - 0.5) * 0.05;
      const jz = Math.sin(th) * r + (rand() - 0.5) * 0.05;
      p[0] = CRANIUM_CENTER[0] + jx * CRANIUM_RADII[0] * 1.05;
      p[1] = CRANIUM_CENTER[1] + jy * CRANIUM_RADII[1] * 1.05;
      p[2] = CRANIUM_CENTER[2] + jz * CRANIUM_RADII[2] * 1.05;
      if (p[1] < layer.minY) continue;
      // Project onto the skin.
      for (let it = 0; it < 6; it += 1) {
        const d = headLocalSdf(p[0], p[1], p[2]);
        headNormal(p[0], p[1], p[2], n);
        p[0] -= n[0] * d;
        p[1] -= n[1] * d;
        p[2] -= n[2] * d;
        if (Math.abs(d) < 2e-4) break;
      }
      if (scalpHairMask(p[0], p[1], p[2]) < 0.55) continue;
      // Avoid the ears and the face: the scalp normal must not point forward-down.
      headNormal(p[0], p[1], p[2], n);
      if (n[2] > 0.75 && p[1] < 0.09) continue;
      made += 1;
      cardCount += 1;

      const seed = rand();
      const len = styleLength(p[0], p[1], p[2]) * layer.length * (0.82 + 0.36 * rand());
      const topness = smoothstep(0.05, 0.11, p[1]);
      const lift = layer.lift * (1 + 1.4 * topness * layerT);
      const clearance = layer.clearance + rand() * 0.0012;
      const twist = (rand() - 0.5) * 2 * layer.twist;
      const width = layer.width * (0.8 + 0.4 * rand());

      // Grow the strand.
      // Roots sit on the skin; each strand rises to its layer's clearance over the first third of its length.
      const rootClear = 0.0008;
      pts[0] = p[0] + n[0] * rootClear;
      pts[1] = p[1] + n[1] * rootClear;
      pts[2] = p[2] + n[2] * rootClear;
      nrm[0] = n[0];
      nrm[1] = n[1];
      nrm[2] = n[2];
      const ds = len / S;
      for (let s = 1; s <= S; s += 1) {
        const t = s / S;
        const qx = pts[(s - 1) * 3];
        const qy = pts[(s - 1) * 3 + 1];
        const qz = pts[(s - 1) * 3 + 2];
        headNormal(qx, qy, qz, n);
        combDirection(qx, qy, qz, c);
        // Tangent projection + a little lift off the scalp near the root (volume).
        const cn = c[0] * n[0] + c[1] * n[1] + c[2] * n[2];
        let dx = c[0] - n[0] * cn;
        let dy = c[1] - n[1] * cn;
        let dz = c[2] - n[2] * cn;
        const dl = Math.hypot(dx, dy, dz) || 1;
        const rise = (1 - t) * (0.08 + 0.22 * topness * layerT);
        dx = dx / dl + n[0] * rise;
        dy = dy / dl + n[1] * rise;
        dz = dz / dl + n[2] * rise;
        const l2 = Math.hypot(dx, dy, dz) || 1;
        p[0] = qx + (dx / l2) * ds;
        p[1] = qy + (dy / l2) * ds;
        p[2] = qz + (dz / l2) * ds;
        const target = rootClear + (clearance - rootClear) * smoothstep(0, 0.38, t) + lift * t;
        // Strands below the skull's equator may hang free a little (gravity); elsewhere they hug the scalp.
        const fringe = smoothstep(0.0, 0.07, p[2]) * topness * layerT;
        hugScalp(p, target + 0.005 * fringe * t, 0.0015 + 0.004 * smoothstep(0.02, -0.04, p[1]) * t + 0.005 * fringe);
        pts[s * 3] = p[0];
        pts[s * 3 + 1] = p[1];
        pts[s * 3 + 2] = p[2];
        headNormal(p[0], p[1], p[2], n);
        nrm[s * 3] = n[0];
        nrm[s * 3 + 1] = n[1];
        nrm[s * 3 + 2] = n[2];
      }

      // Emit the card.
      const base = positions.length / 3;
      for (let s = 0; s <= S; s += 1) {
        const a = Math.max(0, s - 1);
        const b = Math.min(S, s + 1);
        let tx = pts[b * 3] - pts[a * 3];
        let ty = pts[b * 3 + 1] - pts[a * 3 + 1];
        let tz = pts[b * 3 + 2] - pts[a * 3 + 2];
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl;
        ty /= tl;
        tz /= tl;
        const sx = nrm[s * 3];
        const sy = nrm[s * 3 + 1];
        const sz = nrm[s * 3 + 2];
        // Across direction b = n × t (tangent to the scalp), card normal = t × b (outward).
        let bx = sy * tz - sz * ty;
        let by = sz * tx - sx * tz;
        let bz = sx * ty - sy * tx;
        const bl = Math.hypot(bx, by, bz) || 1;
        bx /= bl;
        by /= bl;
        bz /= bl;
        let cxn = ty * bz - tz * by;
        let cyn = tz * bx - tx * bz;
        let czn = tx * by - ty * bx;
        // Twist about the strand (outer layers stand up a little).
        const ct = Math.cos(twist);
        const st = Math.sin(twist);
        const rbx = bx * ct + cxn * st;
        const rby = by * ct + cyn * st;
        const rbz = bz * ct + czn * st;
        cxn = cxn * ct - bx * st;
        cyn = cyn * ct - by * st;
        czn = czn * ct - bz * st;
        bx = rbx;
        by = rby;
        bz = rbz;
        const t = s / S;
        const w = width * (1 - 0.42 * Math.pow(t, 1.4)) * 0.5;
        for (let side = 0; side < 2; side += 1) {
          const sgn = side === 0 ? -1 : 1;
          const vx = pts[s * 3] + bx * w * sgn;
          const vy = pts[s * 3 + 1] + by * w * sgn;
          const vz = pts[s * 3 + 2] + bz * w * sgn;
          positions.push(vx, vy, vz);
          normals.push(cxn, cyn, czn);
          tangents.push(tx, ty, tz);
          strand.push(side, t, seed, layerT);
          lengths.push(len);
          if (vx < minX) minX = vx;
          if (vy < minY) minY = vy;
          if (vz < minZ) minZ = vz;
          if (vx > maxX) maxX = vx;
          if (vy > maxY) maxY = vy;
          if (vz > maxZ) maxZ = vz;
        }
      }
      for (let s = 0; s < S; s += 1) {
        const a0 = base + s * 2;
        const b0 = a0 + 1;
        const a1 = a0 + 2;
        const b1 = a0 + 3;
        indices.push(a0, b0, a1, b0, b1, a1);
      }
      if (cardCount % CARDS_PER_YIELD === 0) yield;
    }
  }

  const vertexCount = positions.length / 3;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  let radius = 0;
  for (let i = 0; i < positions.length; i += 3) {
    radius = Math.max(radius, Math.hypot(positions[i] - cx, positions[i + 1] - cy, positions[i + 2] - cz));
  }
  const result: HairGeometryData = {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    tangents: Float32Array.from(tangents),
    strand: Float32Array.from(strand),
    lengths: Float32Array.from(lengths),
    indices: vertexCount < 65536 ? Uint16Array.from(indices) : Uint32Array.from(indices),
    vertexCount,
    triangleCount: indices.length / 3,
    cardCount,
    boundingCenter: [cx, cy, cz],
    boundingRadius: radius + 0.08,
  };
  return result;
}

/** Incremental (time-sliceable) hair builder; memoised per detail level on completion. */
export interface HairBuilder {
  /** Advances the build for up to `budgetMs`; returns true once `result` is available. */
  step(budgetMs: number): boolean;
  readonly result: HairGeometryData | null;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function createHairBuilder(detail: CharacterDetailLevel): HairBuilder {
  let result: HairGeometryData | null = cache.get(detail) ?? null;
  const it = result ? null : buildHairSteps(detail);
  return {
    get result() {
      return result;
    },
    step(budgetMs: number): boolean {
      if (result || !it) return true;
      const start = now();
      for (;;) {
        const r = it.next();
        if (r.done) {
          result = r.value;
          cache.set(detail, result);
          return true;
        }
        if (now() - start >= budgetMs) return false;
      }
    },
  };
}

/** Stores hair built elsewhere (the build worker) so later builders of this detail level start complete. */
export function primeHairCache(detail: CharacterDetailLevel, hair: HairGeometryData): void {
  cache.set(detail, hair);
}

/** Builds (or returns the memoised) layered hair cards in head-local space synchronously. */
export function buildHairGeometry(detail: CharacterDetailLevel): HairGeometryData {
  const builder = createHairBuilder(detail);
  builder.step(Number.POSITIVE_INFINITY);
  return builder.result as HairGeometryData;
}
