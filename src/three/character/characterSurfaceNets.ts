/* ==========================================================================
 * Narrow-band surface nets — PURE module (no React, no DOM; runs in Node).
 *
 * Polygonises a signed distance function (negative inside) on a regular grid:
 *  1. the field is sampled exactly on a coarse lattice (every 2nd fine point);
 *  2. only coarse cells close enough to the surface to contain it (Lipschitz
 *     bound with a safety factor) are refined to the fine lattice; the rest
 *     are filled by trilinear interpolation of their coarse corners (which all
 *     share one sign, so no spurious surface can appear there);
 *  3. naive surface nets: one vertex per sign-changing cell (mean of the edge
 *     crossings), one quad per sign-changing lattice edge, split along the
 *     shorter diagonal;
 *  4. every vertex takes one Newton step onto the iso-surface and the
 *     normalised field gradient (tetrahedral differences) as its normal.
 *
 * The work is a generator that yields every ~`yieldEvery` field evaluations so
 * callers can time-slice it across frames; `polygonizeSdf` runs it to the end.
 * Deterministic.
 * ========================================================================== */

export type ScalarField = (x: number, y: number, z: number) => number;

export interface GridBounds {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

export interface PolygonizeOptions {
  bounds: GridBounds;
  /** Fine cell size in metres. */
  cell: number;
  /** Finite-difference step for normals / projection, as a fraction of `cell` (default 0.35). */
  normalStep?: number;
  /** Yield after roughly this much work, in field-evaluation units (default 300 ≈ well under a millisecond). */
  yieldEvery?: number;
}

export interface PolygonizedSurface {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  /** Number of field evaluations spent (profiling). */
  evaluations: number;
}

const COARSE = 2;
/** Coarse cells whose corners are all farther than this × the coarse cell size are skipped. */
const BAND_SAFETY = 1.3;

/** Tetrahedral gradient (4 evaluations), scaled by 4e. Writes into `out`. */
export function fieldGradient(field: ScalarField, x: number, y: number, z: number, e: number, out: Float64Array): void {
  const a = field(x + e, y - e, z - e);
  const b = field(x - e, y - e, z + e);
  const c = field(x - e, y + e, z - e);
  const d = field(x + e, y + e, z + e);
  out[0] = a - b - c + d;
  out[1] = -a - b + c + d;
  out[2] = -a + b - c + d;
}

export function* polygonizeSdfSteps(field: ScalarField, options: PolygonizeOptions): Generator<void, PolygonizedSurface, void> {
  const { bounds, cell: h } = options;
  const step = (options.normalStep ?? 0.35) * h;
  const yieldEvery = options.yieldEvery ?? 300;
  let evaluations = 0;
  /** Work done since the last yield (field-evaluation units; cheap loops count fractionally). */
  let work = 0;

  const span = (a: number, b: number) => Math.ceil((b - a) / h / COARSE) * COARSE + 1;
  const nx = span(bounds.x0, bounds.x1);
  const ny = span(bounds.y0, bounds.y1);
  const nz = span(bounds.z0, bounds.z1);
  const ox = bounds.x0;
  const oy = bounds.y0;
  const oz = bounds.z0;
  const sxy = nx * ny;
  const values = new Float32Array(sxy * nz);
  const state = new Uint8Array(sxy * nz); // 0 = unset, 1 = exact, 2 = interpolated

  // 1. Coarse lattice (exact).
  for (let k = 0; k < nz; k += COARSE) {
    const z = oz + k * h;
    for (let j = 0; j < ny; j += COARSE) {
      const y = oy + j * h;
      for (let i = 0; i < nx; i += COARSE) {
        const id = i + nx * j + sxy * k;
        values[id] = field(ox + i * h, y, z);
        state[id] = 1;
        evaluations += 1;
        work += 1;
      }
      if (work >= yieldEvery) {
        work = 0;
        yield;
      }
    }
  }

  // 2. Refine band cells exactly; interpolate the rest.
  const band = h * COARSE * BAND_SAFETY;
  const cnx = (nx - 1) / COARSE;
  const cny = (ny - 1) / COARSE;
  const cnz = (nz - 1) / COARSE;
  const far: number[] = [];
  for (let ck = 0; ck < cnz; ck += 1) {
    for (let cj = 0; cj < cny; cj += 1) {
      for (let ci = 0; ci < cnx; ci += 1) {
        const i0 = ci * COARSE;
        const j0 = cj * COARSE;
        const k0 = ck * COARSE;
        let minAbs = Infinity;
        for (let c = 0; c < 8; c += 1) {
          const id = i0 + (c & 1) * COARSE + nx * (j0 + ((c >> 1) & 1) * COARSE) + sxy * (k0 + ((c >> 2) & 1) * COARSE);
          const v = Math.abs(values[id]);
          if (v < minAbs) minAbs = v;
        }
        if (minAbs > band) {
          far.push(ci, cj, ck);
          work += 0.05;
          continue;
        }
        for (let k = k0; k <= k0 + COARSE; k += 1) {
          const z = oz + k * h;
          for (let j = j0; j <= j0 + COARSE; j += 1) {
            const y = oy + j * h;
            for (let i = i0; i <= i0 + COARSE; i += 1) {
              const id = i + nx * j + sxy * k;
              if (state[id] === 1) continue;
              values[id] = field(ox + i * h, y, z);
              state[id] = 1;
              evaluations += 1;
              work += 1;
            }
          }
        }
        if (work >= yieldEvery) {
          work = 0;
          yield;
        }
      }
    }
  }
  for (let n = 0; n < far.length; n += 3) {
    const i0 = far[n] * COARSE;
    const j0 = far[n + 1] * COARSE;
    const k0 = far[n + 2] * COARSE;
    const c000 = values[i0 + nx * j0 + sxy * k0];
    const c100 = values[i0 + COARSE + nx * j0 + sxy * k0];
    const c010 = values[i0 + nx * (j0 + COARSE) + sxy * k0];
    const c110 = values[i0 + COARSE + nx * (j0 + COARSE) + sxy * k0];
    const c001 = values[i0 + nx * j0 + sxy * (k0 + COARSE)];
    const c101 = values[i0 + COARSE + nx * j0 + sxy * (k0 + COARSE)];
    const c011 = values[i0 + nx * (j0 + COARSE) + sxy * (k0 + COARSE)];
    const c111 = values[i0 + COARSE + nx * (j0 + COARSE) + sxy * (k0 + COARSE)];
    for (let k = k0; k <= k0 + COARSE; k += 1) {
      const tz = (k - k0) / COARSE;
      for (let j = j0; j <= j0 + COARSE; j += 1) {
        const ty = (j - j0) / COARSE;
        for (let i = i0; i <= i0 + COARSE; i += 1) {
          const id = i + nx * j + sxy * k;
          if (state[id] !== 0) continue;
          const tx = (i - i0) / COARSE;
          const a = c000 + (c100 - c000) * tx;
          const b = c010 + (c110 - c010) * tx;
          const c = c001 + (c101 - c001) * tx;
          const d = c011 + (c111 - c011) * tx;
          const e = a + (b - a) * ty;
          const g = c + (d - c) * ty;
          values[id] = e + (g - e) * tz;
          state[id] = 2;
        }
      }
    }
    work += 1;
    if (work >= yieldEvery) {
      work = 0;
      yield;
    }
  }

  // 3. Surface nets: vertices.
  const cx = nx - 1;
  const cy = ny - 1;
  const cz = nz - 1;
  const cellVertex = new Int32Array(cx * cy * cz).fill(-1);
  const verts: number[] = [];
  const corner = new Float64Array(8);
  for (let k = 0; k < cz; k += 1) {
    for (let j = 0; j < cy; j += 1) {
      for (let i = 0; i < cx; i += 1) {
        let mask = 0;
        for (let c = 0; c < 8; c += 1) {
          const v = values[i + (c & 1) + nx * (j + ((c >> 1) & 1)) + sxy * (k + ((c >> 2) & 1))];
          corner[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
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
          sx += (a & 1) + ((b & 1) - (a & 1)) * t;
          sy += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t;
          sz += ((a >> 2) & 1) + (((b >> 2) & 1) - ((a >> 2) & 1)) * t;
          count += 1;
        }
        cellVertex[i + cx * (j + cy * k)] = verts.length / 3;
        verts.push(ox + (i + sx / count) * h, oy + (j + sy / count) * h, oz + (k + sz / count) * h);
        work += 0.3;
      }
      work += cx * 0.04;
      if (work >= yieldEvery) {
        work = 0;
        yield;
      }
    }
  }

  // 3b. Faces: one quad per sign-changing lattice edge.
  const tris: number[] = [];
  const vid = (i: number, j: number, k: number) => cellVertex[i + cx * (j + cy * k)];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (dist2(verts, a, c) <= dist2(verts, b, d)) {
      if (flip) tris.push(a, c, b, a, d, c);
      else tris.push(a, b, c, a, c, d);
    } else if (flip) tris.push(a, d, b, b, d, c);
    else tris.push(a, b, d, b, c, d);
  };
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const in0 = values[i + nx * j + sxy * k] < 0;
        if (i < cx && j > 0 && k > 0 && j < ny - 1 && k < nz - 1 && in0 !== values[i + 1 + nx * j + sxy * k] < 0) {
          quad(vid(i, j - 1, k - 1), vid(i, j, k - 1), vid(i, j, k), vid(i, j - 1, k), !in0);
        }
        if (j < cy && i > 0 && k > 0 && i < nx - 1 && k < nz - 1 && in0 !== values[i + nx * (j + 1) + sxy * k] < 0) {
          quad(vid(i - 1, j, k - 1), vid(i - 1, j, k), vid(i, j, k), vid(i, j, k - 1), !in0);
        }
        if (k < cz && i > 0 && j > 0 && i < nx - 1 && j < ny - 1 && in0 !== values[i + nx * j + sxy * (k + 1)] < 0) {
          quad(vid(i - 1, j - 1, k), vid(i, j - 1, k), vid(i, j, k), vid(i - 1, j, k), !in0);
        }
      }
      work += nx * 0.03;
      if (work >= yieldEvery) {
        work = 0;
        yield;
      }
    }
  }

  // 4. One Newton step onto the iso-surface; the gradient doubles as the normal.
  const vertexCount = verts.length / 3;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const g = new Float64Array(3);
  const inv4e = 1 / (4 * step);
  for (let v = 0; v < vertexCount; v += 1) {
    let x = verts[v * 3];
    let y = verts[v * 3 + 1];
    let z = verts[v * 3 + 2];
    const d = field(x, y, z);
    fieldGradient(field, x, y, z, step, g);
    evaluations += 5;
    const gx = g[0] * inv4e;
    const gy = g[1] * inv4e;
    const gz = g[2] * inv4e;
    const gg = gx * gx + gy * gy + gz * gz;
    if (gg > 1e-10) {
      let mx = (-d * gx) / gg;
      let my = (-d * gy) / gg;
      let mz = (-d * gz) / gg;
      const m = Math.sqrt(mx * mx + my * my + mz * mz);
      if (m > h * 0.75) {
        const s = (h * 0.75) / m;
        mx *= s;
        my *= s;
        mz *= s;
      }
      x += mx;
      y += my;
      z += mz;
    }
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
    const len = Math.sqrt(gg) || 1;
    normals[v * 3] = gx / len;
    normals[v * 3 + 1] = gy / len;
    normals[v * 3 + 2] = gz / len;
    work += 5;
    if (work >= yieldEvery) {
      work = 0;
      yield;
    }
  }

  return {
    positions,
    normals,
    indices: Uint32Array.from(tris),
    vertexCount,
    triangleCount: tris.length / 3,
    evaluations,
  };
}

/** Runs the polygoniser to completion. */
export function polygonizeSdf(field: ScalarField, options: PolygonizeOptions): PolygonizedSurface {
  const it = polygonizeSdfSteps(field, options);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/** Counts edges not shared by exactly two triangles (0 for a closed, manifold surface). */
export function openEdgeCount(indices: Uint32Array): number {
  const counts = new Map<number, number>();
  const key = (a: number, b: number) => (a < b ? a * 4194304 + b : b * 4194304 + a);
  for (let i = 0; i < indices.length; i += 3) {
    for (let e = 0; e < 3; e += 1) {
      const k = key(indices[i + e], indices[i + ((e + 1) % 3)]);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  let open = 0;
  counts.forEach((c) => {
    if (c !== 2) open += 1;
  });
  return open;
}

function dist2(v: number[], a: number, b: number): number {
  const dx = v[a * 3] - v[b * 3];
  const dy = v[a * 3 + 1] - v[b * 3 + 1];
  const dz = v[a * 3 + 2] - v[b * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

/* Cube corner c = (c & 1, (c >> 1) & 1, (c >> 2) & 1); the 12 edges as corner pairs. */
const EDGE_A = [0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3] as const;
const EDGE_B = [1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7] as const;
