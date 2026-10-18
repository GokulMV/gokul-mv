import * as THREE from 'three';
import type { GpuTier, Vec3Tuple } from '../../store/scrollStore';
import { jacketSdf, SOCKET_SPECS, trousersSdf } from './characterGeometry';
import { LIMB_FRAMES, REST_JOINTS, limbToBind } from './characterSkeleton';
import type { BoneName, GearSocketName } from './rigTypes';

/* ==========================================================================
 * Gear geometry — PURE module (THREE math + BufferGeometry only; no DOM).
 *
 * Four procedural expedition tools, each authored against the protagonist's
 * REST pose (characterGeometry's garment SDFs) and baked into the local frame
 * of the gear socket / bone it hangs from:
 *
 *   ExpeditionBackpack   lofted body (crisp panel seams via split rings),
 *                        drawcord snow collar, a top LID built about its own
 *                        side hinge (the gust flips it over sideways, clear
 *                        of the head), padded S-shoulder straps
 *                        shrink-wrapped onto the jacket, load lifters, sternum
 *                        strap, lower webbing, side compression straps with
 *                        ladder locks, daisy chains, axe loops, haul loop,
 *                        lid buckles (male halves ride the lid);
 *   ClimbingRopeCoil     one continuous kernmantle rope coiled seven times
 *                        into a bandolier: the coil is the convex wrap of the
 *                        torso + pack in a diagonal plane over the left
 *                        shoulder, the strands twist around each other, and a
 *                        tie-off of wraps cinches the bundle on the shoulder;
 *   DualCarbonIceAxes    two technical tools on the ICE_AXE_GRIP convention
 *                        (grip at the origin, shaft +Z, pick −Y, tip at
 *                        (0, −0.11, 0.43)): bent oval carbon shaft, moulded
 *                        grip with finger grooves, trigger / pinky rest with
 *                        spike, upper grip rest, anodised head, toothed steel
 *                        pick, adze (left) / hammer (right), and the tool's
 *                        clip carabiner that racks it head-down at the hip;
 *   TacticalHarnessRack  padded waist belt contoured to the jacket, front
 *                        buckle, belay loop, leg loops on the thighs, four
 *                        gear loops and a rack of quickdraws, lockers, a tube
 *                        belay device and an ice screw — each rack piece is
 *                        built about its own pivot so it can sway.
 *
 * Triangle budget (all four, measured): 24.9k high (tier 3) / 17.1k medium (tier 2) / 11.9k low (tier ≤ 1).
 * ========================================================================== */

export type GearDetail = 'high' | 'medium' | 'low';

export function gearDetailForTier(tier: GpuTier): GearDetail {
  return tier >= 3 ? 'high' : tier === 2 ? 'medium' : 'low';
}

interface DetailSpec {
  /** Segment multiplier for swept paths. */
  k: number;
  /** Radial segments of round tubes (rope, carabiner stock, cords). */
  tube: number;
  /** Profile points of the pack body / lid. */
  body: number;
  /** Profile points of padded straps and belts. */
  pad: number;
  /** Rope coil loops (one continuous rope) and path segments per loop. */
  ropeLoops: number;
  ropeSegments: number;
  /** Optional rack pieces (ice screw, belay device detail). */
  extras: boolean;
}

const DETAIL: Readonly<Record<GearDetail, DetailSpec>> = {
  high: { k: 1, tube: 6, body: 44, pad: 12, ropeLoops: 7, ropeSegments: 54, extras: true },
  medium: { k: 0.7, tube: 5, body: 32, pad: 10, ropeLoops: 6, ropeSegments: 44, extras: true },
  low: { k: 0.45, tube: 4, body: 22, pad: 8, ropeLoops: 5, ropeSegments: 30, extras: false },
};

/** Material slots shared by the gear (GearSheddingSystem creates one material per slot and item). */
export type GearMaterialKey =
  | 'packFabric'
  | 'packDark'
  | 'webbing'
  | 'plastic'
  | 'metal'
  | 'rope'
  | 'carbon'
  | 'steel'
  | 'anodized'
  | 'rubber'
  | 'sling';

export interface GearMesh {
  geometry: THREE.BufferGeometry;
  material: GearMaterialKey;
  castShadow: boolean;
}

/* ==========================================================================
 * Mesh accumulator
 * ========================================================================== */

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();

/** Collects indexed triangles with position / normal / uv / color, through an optional transform. */
export class MeshAccumulator {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly uv: number[] = [];
  private readonly col: number[] = [];
  private readonly idx: number[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly normalMatrix = new THREE.Matrix3();
  private hasMatrix = false;

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  /** Runs `build` with `m` composed onto the current transform. */
  withMatrix(m: THREE.Matrix4, build: () => void): void {
    const prev = this.matrix.clone();
    const prevHas = this.hasMatrix;
    this.matrix.copy(prevHas ? prev.clone().multiply(m) : m);
    this.normalMatrix.getNormalMatrix(this.matrix);
    this.hasMatrix = true;
    build();
    this.matrix.copy(prev);
    this.normalMatrix.getNormalMatrix(prev);
    this.hasMatrix = prevHas;
  }

  vertex(px: number, py: number, pz: number, nx: number, ny: number, nz: number, u: number, v: number, c: THREE.Color): number {
    _p.set(px, py, pz);
    _n.set(nx, ny, nz);
    if (this.hasMatrix) {
      _p.applyMatrix4(this.matrix);
      _n.applyMatrix3(this.normalMatrix);
    }
    const l = _n.length();
    if (l > 1e-12) _n.multiplyScalar(1 / l);
    else _n.set(0, 1, 0);
    this.pos.push(_p.x, _p.y, _p.z);
    this.nor.push(_n.x, _n.y, _n.z);
    this.uv.push(u, v);
    this.col.push(c.r, c.g, c.b);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Appends another geometry (indexed or not) in a solid colour, through the current transform. */
  appendGeometry(geometry: THREE.BufferGeometry, color: THREE.Color, uvScale = 1): void {
    const position = geometry.getAttribute('position');
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const normal = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    const base = this.vertexCount;
    for (let i = 0; i < position.count; i += 1) {
      this.vertex(
        position.getX(i),
        position.getY(i),
        position.getZ(i),
        normal.getX(i),
        normal.getY(i),
        normal.getZ(i),
        uv ? uv.getX(i) * uvScale : 0,
        uv ? uv.getY(i) * uvScale : 0,
        color,
      );
    }
    const index = geometry.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i += 3) this.tri(base + index.getX(i), base + index.getX(i + 1), base + index.getX(i + 2));
    } else {
      for (let i = 0; i < position.count; i += 3) this.tri(base + i, base + i + 1, base + i + 2);
    }
    geometry.dispose();
  }

  toGeometry(name: string): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.name = name;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.vertexCount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/* ==========================================================================
 * Profiles and sweeps
 * ========================================================================== */

export interface Profile {
  x: number[];
  y: number[];
  nx: number[];
  ny: number[];
  /** 0 → 1 by perimeter (the seam vertex closes at 1). */
  v: number[];
  count: number;
}

/** Closed 2D profile from CCW points; duplicated points (crisp colour seams) share a smooth normal. */
export function makeProfile(points: ReadonlyArray<readonly [number, number]>): Profile {
  const count = points.length;
  const x = points.map((q) => q[0]);
  const y = points.map((q) => q[1]);
  const nx: number[] = new Array<number>(count).fill(0);
  const ny: number[] = new Array<number>(count).fill(0);
  const distinct = (i: number, step: number): number => {
    let j = i;
    for (let k = 0; k < count; k += 1) {
      j = (j + step + count) % count;
      if (Math.hypot(x[j] - x[i], y[j] - y[i]) > 1e-9) return j;
    }
    return (i + step + count) % count;
  };
  for (let i = 0; i < count; i += 1) {
    const a = distinct(i, -1);
    const b = distinct(i, 1);
    // Outward normal of a CCW edge (dx, dy) is (dy, −dx).
    let ex = x[i] - x[a];
    let ey = y[i] - y[a];
    let l = Math.hypot(ex, ey) || 1;
    let mx = ey / l;
    let my = -ex / l;
    ex = x[b] - x[i];
    ey = y[b] - y[i];
    l = Math.hypot(ex, ey) || 1;
    mx += ey / l;
    my += -ex / l;
    l = Math.hypot(mx, my) || 1;
    nx[i] = mx / l;
    ny[i] = my / l;
  }
  const v: number[] = [0];
  let total = 0;
  for (let i = 1; i <= count; i += 1) {
    total += Math.hypot(x[i % count] - x[i - 1], y[i % count] - y[i - 1]);
    v.push(total);
  }
  for (let i = 0; i < v.length; i += 1) v[i] /= total || 1;
  return { x, y, nx, ny, v, count };
}

export function circleProfile(r: number, segments: number): Profile {
  const pts: [number, number][] = [];
  for (let i = 0; i < segments; i += 1) {
    const a = (i / segments) * Math.PI * 2;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return makeProfile(pts);
}

/** Rounded rectangle (w along x, h along y), CCW, `perCorner` points per corner. */
export function roundedRectProfile(w: number, h: number, r: number, perCorner: number): Profile {
  const pts: [number, number][] = [];
  const rr = Math.min(r, w / 2, h / 2);
  const cx = w / 2 - rr;
  const cy = h / 2 - rr;
  const corners: [number, number, number][] = [
    [cx, cy, 0],
    [-cx, cy, Math.PI / 2],
    [-cx, -cy, Math.PI],
    [cx, -cy, (3 * Math.PI) / 2],
  ];
  for (const [ox, oy, a0] of corners) {
    for (let i = 0; i < perCorner; i += 1) {
      const a = a0 + (i / Math.max(1, perCorner - 1)) * (Math.PI / 2);
      pts.push([ox + Math.cos(a) * rr, oy + Math.sin(a) * rr]);
    }
  }
  return makeProfile(pts);
}

/**
 * Padded band cross-section (x = thickness, y = width), CCW, with crisp binding edges: points at |y| = edge are
 * duplicated so colours change sharply. `region[j]`: 0 = outer face, 1 = binding edge, 2 = inner lining.
 */
export function bandProfile(thickness: number, width: number, edgeWidth: number): { profile: Profile; region: number[] } {
  const h = thickness / 2;
  const w = width / 2;
  const e = w - edgeWidth;
  const b = Math.min(h * 0.9, edgeWidth * 0.8);
  const pts: [number, number, number][] = [
    [h, -e, 1],
    [h, -e, 0],
    [h, e, 0],
    [h, e, 1],
    [h - b * 0.3, w - b * 0.5, 1],
    [h * 0.35, w, 1],
    [-h * 0.35, w, 1],
    [-h + b * 0.3, w - b * 0.5, 1],
    [-h, e, 1],
    [-h, e, 2],
    [-h, -e, 2],
    [-h, -e, 1],
    [-h + b * 0.3, -w + b * 0.5, 1],
    [-h * 0.35, -w, 1],
    [h * 0.35, -w, 1],
    [h - b * 0.3, -w + b * 0.5, 1],
  ];
  return { profile: makeProfile(pts.map((q) => [q[0], q[1]] as [number, number])), region: pts.map((q) => q[2]) };
}

export interface SweepFrame {
  p: THREE.Vector3;
  t: THREE.Vector3;
  n: THREE.Vector3;
  b: THREE.Vector3;
  sx: number;
  sy: number;
}

export interface SweepOptions {
  closed?: boolean;
  color: THREE.Color | ((ring: number, j: number) => THREE.Color);
  /** u coordinate per metre along the path. */
  uPerMetre?: number;
  /** v coordinate span around the profile. */
  vScale?: number;
  capStart?: boolean;
  capEnd?: boolean;
}

/**
 * Sweeps `profile` (x → frame.n, y → frame.b, scaled by sx / sy) along `frames`. Frames must be right handed
 * (b = t × n) for outward-facing triangles from a CCW profile.
 */
export function sweep(acc: MeshAccumulator, frames: readonly SweepFrame[], profile: Profile, options: SweepOptions): void {
  const closed = options.closed ?? false;
  const uPer = options.uPerMetre ?? 1;
  const vScale = options.vScale ?? 1;
  const colorAt = typeof options.color === 'function' ? options.color : () => options.color as THREE.Color;
  const rings = frames.length + (closed ? 1 : 0);
  const ringSize = profile.count + 1;
  const base = acc.vertexCount;
  let u = 0;
  for (let i = 0; i < rings; i += 1) {
    const f = frames[i % frames.length];
    if (i > 0) u += f.p.distanceTo(frames[(i - 1) % frames.length].p) * uPer;
    for (let j = 0; j <= profile.count; j += 1) {
      const jj = j % profile.count;
      const px = profile.x[jj] * f.sx;
      const py = profile.y[jj] * f.sy;
      const nnx = profile.nx[jj] / Math.max(f.sx, 1e-6);
      const nny = profile.ny[jj] / Math.max(f.sy, 1e-6);
      acc.vertex(
        f.p.x + f.n.x * px + f.b.x * py,
        f.p.y + f.n.y * px + f.b.y * py,
        f.p.z + f.n.z * px + f.b.z * py,
        f.n.x * nnx + f.b.x * nny,
        f.n.y * nnx + f.b.y * nny,
        f.n.z * nnx + f.b.z * nny,
        u,
        profile.v[j] * vScale,
        colorAt(i % frames.length, jj),
      );
    }
  }
  for (let i = 0; i < rings - 1; i += 1) {
    for (let j = 0; j < profile.count; j += 1) {
      const a = base + i * ringSize + j;
      const b = a + 1;
      const c = a + ringSize + 1;
      const d = a + ringSize;
      acc.tri(a, b, c);
      acc.tri(a, c, d);
    }
  }
  if (!closed && (options.capStart || options.capEnd)) {
    const cap = (i: number, end: boolean): void => {
      const f = frames[i];
      const sign = end ? 1 : -1;
      const centre = acc.vertex(f.p.x, f.p.y, f.p.z, f.t.x * sign, f.t.y * sign, f.t.z * sign, 0.5, 0.5, colorAt(i, 0));
      const first = acc.vertexCount;
      for (let j = 0; j < profile.count; j += 1) {
        const px = profile.x[j] * f.sx;
        const py = profile.y[j] * f.sy;
        acc.vertex(
          f.p.x + f.n.x * px + f.b.x * py,
          f.p.y + f.n.y * px + f.b.y * py,
          f.p.z + f.n.z * px + f.b.z * py,
          f.t.x * sign,
          f.t.y * sign,
          f.t.z * sign,
          0.5 + profile.x[j] * 4,
          0.5 + profile.y[j] * 4,
          colorAt(i, j),
        );
      }
      for (let j = 0; j < profile.count; j += 1) {
        const a = first + j;
        const b = first + ((j + 1) % profile.count);
        if (end) acc.tri(centre, a, b);
        else acc.tri(centre, b, a);
      }
    };
    if (options.capStart) cap(0, false);
    if (options.capEnd) cap(frames.length - 1, true);
  }
}

/** Frames along points with b = component of `up(i)` orthogonal to the tangent, n = b × t (so b = t × n). */
export function framesWithUp(
  points: readonly THREE.Vector3[],
  closed: boolean,
  up: (i: number) => THREE.Vector3,
  scale: (i: number) => [number, number] = () => [1, 1],
): SweepFrame[] {
  const out: SweepFrame[] = [];
  const count = points.length;
  for (let i = 0; i < count; i += 1) {
    const prev = closed ? points[(i - 1 + count) % count] : points[Math.max(0, i - 1)];
    const next = closed ? points[(i + 1) % count] : points[Math.min(count - 1, i + 1)];
    const t = next.clone().sub(prev);
    if (t.lengthSq() < 1e-14) t.set(0, 0, 1);
    t.normalize();
    const u = up(i);
    const b = u.clone().addScaledVector(t, -u.dot(t));
    if (b.lengthSq() < 1e-10) b.set(t.y, t.z, t.x);
    b.normalize();
    const n = new THREE.Vector3().crossVectors(b, t).normalize();
    const [sx, sy] = scale(i);
    out.push({ p: points[i].clone(), t, n, b, sx, sy });
  }
  return out;
}

/** Rotation-minimising frames along an open or closed curve (closed curves unwind the holonomy). */
export function rotationMinimizingFrames(points: readonly THREE.Vector3[], closed: boolean, upHint: THREE.Vector3): SweepFrame[] {
  const count = points.length;
  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i < count; i += 1) {
    const prev = closed ? points[(i - 1 + count) % count] : points[Math.max(0, i - 1)];
    const next = closed ? points[(i + 1) % count] : points[Math.min(count - 1, i + 1)];
    const t = next.clone().sub(prev);
    if (t.lengthSq() < 1e-14) t.set(0, 0, 1);
    tangents.push(t.normalize());
  }
  const normals: THREE.Vector3[] = [];
  let n = upHint.clone().addScaledVector(tangents[0], -upHint.dot(tangents[0]));
  if (n.lengthSq() < 1e-10) n = new THREE.Vector3(tangents[0].y, tangents[0].z, tangents[0].x);
  n.normalize();
  normals.push(n.clone());
  for (let i = 1; i < count; i += 1) {
    n = n.clone().addScaledVector(tangents[i], -n.dot(tangents[i]));
    if (n.lengthSq() < 1e-10) n.set(tangents[i].y, tangents[i].z, tangents[i].x);
    normals.push(n.normalize().clone());
  }
  if (closed && count > 2) {
    // Holonomy: transport the last normal once more onto the first tangent and unwind the residual twist.
    const last = normals[count - 1].clone().addScaledVector(tangents[0], -normals[count - 1].dot(tangents[0])).normalize();
    const cross = new THREE.Vector3().crossVectors(last, normals[0]);
    const angle = Math.atan2(cross.dot(tangents[0]), last.dot(normals[0]));
    for (let i = 0; i < count; i += 1) normals[i].applyAxisAngle(tangents[i], (angle * i) / count);
  }
  return points.map((p, i) => {
    const t = tangents[i];
    const nn = normals[i];
    const b = new THREE.Vector3().crossVectors(t, nn).normalize();
    return { p: p.clone(), t, n: nn, b, sx: 1, sy: 1 };
  });
}

/** Tube along points (circle profile). */
export function tube(
  acc: MeshAccumulator,
  points: readonly THREE.Vector3[],
  radius: number | ((i: number) => number),
  segments: number,
  color: THREE.Color,
  closed: boolean,
  options: { uPerMetre?: number; caps?: boolean; up?: THREE.Vector3 } = {},
): void {
  const frames = rotationMinimizingFrames(points, closed, options.up ?? new THREE.Vector3(0, 1, 0.3));
  for (let i = 0; i < frames.length; i += 1) {
    const r = typeof radius === 'function' ? radius(i) : radius;
    frames[i].sx = r;
    frames[i].sy = r;
  }
  sweep(acc, frames, circleProfile(1, segments), {
    closed,
    color,
    uPerMetre: options.uPerMetre ?? 20,
    capStart: options.caps,
    capEnd: options.caps,
  });
}

/** Catmull-Rom resample of a polyline into `count` points (closed or open). */
export function smoothCurve(controls: readonly THREE.Vector3[], count: number, closed: boolean): THREE.Vector3[] {
  const curve = new THREE.CatmullRomCurve3(controls.map((c) => c.clone()), closed, 'centripetal');
  return curve.getSpacedPoints(closed ? count : count - 1).slice(0, count);
}

const v3 = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
const col = (hex: string): THREE.Color => new THREE.Color(hex);
const seg = (n: number, k: number, min = 3): number => Math.max(min, Math.round(n * k));

/* ==========================================================================
 * Rig-space helpers (rest pose, Root space)
 * ========================================================================== */

/** Rest transform of a gear socket in Root space. */
export function socketRestMatrix(name: GearSocketName): THREE.Matrix4 {
  const s = SOCKET_SPECS[name];
  return new THREE.Matrix4().compose(
    new THREE.Vector3(s.position[0], s.position[1], s.position[2]),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(s.rotation[0], s.rotation[1], s.rotation[2])),
    new THREE.Vector3(1, 1, 1),
  );
}

/** Rest transform of a bone pivot in Root space (identity rotation by contract). */
export function boneRestMatrix(name: BoneName): THREE.Matrix4 {
  const j = REST_JOINTS[name];
  return new THREE.Matrix4().makeTranslation(j[0], j[1], j[2]);
}

/** Torso garment field for shrink-wrapping (the sleeves are ignored: the arms move). */
function torsoField(x: number, y: number, z: number): number {
  if (Math.abs(x) > 0.215) return 0.05 + Math.abs(x) - 0.215;
  return jacketSdf(x, y, z);
}

/** From `origin + dir·start`, marches toward the origin until `field − offset` ≤ 0; returns the parameter. */
function marchInward(
  field: (x: number, y: number, z: number) => number,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  start: number,
  offset: number,
): number {
  let t = start;
  for (let i = 0; i < 96; i += 1) {
    const d = field(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t) - offset;
    if (d < 2e-4) return t;
    t -= Math.max(d * 0.9, 4e-4);
    if (t <= 0) return 0;
  }
  return t;
}

function fieldGradient(field: (x: number, y: number, z: number) => number, p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const h = 0.003;
  out.set(
    field(p.x + h, p.y, p.z) - field(p.x - h, p.y, p.z),
    field(p.x, p.y + h, p.z) - field(p.x, p.y - h, p.z),
    field(p.x, p.y, p.z + h) - field(p.x, p.y, p.z - h),
  );
  const l = out.length();
  return l > 1e-9 ? out.multiplyScalar(1 / l) : out.set(0, 0, 1);
}

/* ==========================================================================
 * Shared small parts
 * ========================================================================== */

/** Rounded box (centred), appended through the current transform. */
function roundedBox(acc: MeshAccumulator, w: number, h: number, d: number, r: number, color: THREE.Color, m: THREE.Matrix4, steps = 2): void {
  // Rounded box: a subdivided cube whose points are pushed out from the inner box along the cube-sphere direction.
  const rr = Math.min(r, w / 2, h / 2, d / 2);
  const hx = w / 2 - rr;
  const hy = h / 2 - rr;
  const hz = d / 2 - rr;
  acc.withMatrix(m, () => {
    const faces: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
      [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)],
      [v3(-1, 0, 0), v3(0, 1, 0), v3(0, 0, -1)],
      [v3(0, 1, 0), v3(0, 0, 1), v3(1, 0, 0)],
      [v3(0, -1, 0), v3(0, 0, -1), v3(1, 0, 0)],
      [v3(0, 0, 1), v3(1, 0, 0), v3(0, 1, 0)],
      [v3(0, 0, -1), v3(-1, 0, 0), v3(0, 1, 0)],
    ];
    const q = new THREE.Vector3();
    for (const [nrm, ua, va] of faces) {
      const base = acc.vertexCount;
      for (let i = 0; i <= steps; i += 1) {
        for (let j = 0; j <= steps; j += 1) {
          const a = (i / steps) * 2 - 1;
          const b = (j / steps) * 2 - 1;
          q.copy(nrm).addScaledVector(ua, a).addScaledVector(va, b);
          // Inner box point + rounded offset along the cube-sphere direction.
          const ix = THREE.MathUtils.clamp(q.x, -1, 1) * hx;
          const iy = THREE.MathUtils.clamp(q.y, -1, 1) * hy;
          const iz = THREE.MathUtils.clamp(q.z, -1, 1) * hz;
          const dir = q.clone().normalize();
          acc.vertex(ix + dir.x * rr, iy + dir.y * rr, iz + dir.z * rr, dir.x, dir.y, dir.z, (i / steps) * w * 20, (j / steps) * h * 20, color);
        }
      }
      for (let i = 0; i < steps; i += 1) {
        for (let j = 0; j < steps; j += 1) {
          const a = base + i * (steps + 1) + j;
          const b = a + steps + 1;
          acc.tri(a, b, b + 1);
          acc.tri(a, b + 1, a + 1);
        }
      }
    }
  });
}

/** Flat webbing strip along points: width along `side(i)` (unit), thickness along the surface normal. */
function webbing(
  acc: MeshAccumulator,
  points: readonly THREE.Vector3[],
  normals: readonly THREE.Vector3[],
  width: number,
  thickness: number,
  color: THREE.Color,
  options: { closed?: boolean; perCorner?: number; uPerMetre?: number; caps?: boolean; widthScale?: (i: number) => number } = {},
): void {
  const profile = roundedRectProfile(thickness, width, thickness * 0.45, options.perCorner ?? 1);
  const frames = framesWithUp(points, options.closed ?? false, (i) => {
    // b = width direction: perpendicular to the normal and the tangent.
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const t = next.clone().sub(prev).normalize();
    return new THREE.Vector3().crossVectors(t, normals[i]).normalize();
  });
  for (let i = 0; i < frames.length; i += 1) {
    // n = b × t must point along the surface normal; flip the frame if not.
    if (frames[i].n.dot(normals[i]) < 0) {
      frames[i].n.negate();
      frames[i].b.negate();
    }
    frames[i].sy = options.widthScale ? options.widthScale(i) : 1;
  }
  sweep(acc, frames, profile, {
    closed: options.closed,
    color,
    uPerMetre: options.uPerMetre ?? 30,
    vScale: 0.6,
    capStart: options.caps ?? !options.closed,
    capEnd: options.caps ?? !options.closed,
  });
}

/** Ladder-lock / side-release buckle (plastic), oriented by `m` (width along x, length along y). */
function buckle(acc: MeshAccumulator, width: number, length: number, color: THREE.Color, m: THREE.Matrix4, male = true): void {
  roundedBox(acc, width, length, 0.007, 0.0028, color, m);
  // Ridges / grip bars.
  const bars = male ? 2 : 1;
  for (let i = 0; i < bars; i += 1) {
    const y = -length * 0.32 + (i * length * 0.64) / Math.max(1, bars - 1);
    roundedBox(acc, width * 0.78, 0.0022, 0.0035, 0.001, color, m.clone().multiply(new THREE.Matrix4().makeTranslation(0, y, 0.0045)), 1);
  }
}

/* ==========================================================================
 * ExpeditionBackpack (backpack socket frame: +Z away from the back, +Y up)
 * ========================================================================== */

/** Centre of the cinched collar mouth in the backpack socket frame: where the contact paper escapes. */
export const BACKPACK_FLAP_OPENING_LOCAL: Vec3Tuple = [0, 0.21, 0.13];
/**
 * Lid hinge in the backpack socket frame: along the lid's upper edge on the climber's RIGHT (socket +X), axis
 * +Z. The gust flips the lid over sideways (a negative rotation about +Z) so it hangs beside the pack: it never
 * covers the head in the over-the-shoulder shots and leaves the collar mouth open to the camera.
 */
export const BACKPACK_LID_HINGE_LOCAL: Vec3Tuple = [0.15, 0.24, 0.118];

const PACK_RED = col('#8f2b22');
const PACK_DARK = col('#2a2d33');
const PACK_DARKER = col('#1b1d21');
const WEB_BLACK = col('#17181b');
const WEB_GREY = col('#3b3f46');
const BUCKLE_BLACK = col('#0f1012');
const ALU = col('#c7cbd2');
const DRAWCORD = col('#8a857b');
/** Depth offsets (socket z, from the hinge) of the two lid straps that tie the lid to the body along the hinge. */
const LID_STRAP_DZ = [-0.052, 0.052] as const;

interface PackShape {
  /** Half width (local x). */
  a: number;
  /** Depth (local z span). */
  d: number;
  /** Back face (local z). */
  back: number;
}

/** Pack body outline at height y (local). */
function packShapeAt(y: number, backAt: (y: number) => number): PackShape {
  const t = THREE.MathUtils.clamp((y + 0.375) / 0.55, 0, 1);
  const a = 0.124 + 0.03 * Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5) - 0.016 * THREE.MathUtils.smoothstep(t, 0.72, 1);
  const d = 0.168 + 0.068 * Math.sin(Math.min(1, t * 1.8) * Math.PI * 0.5) - 0.03 * THREE.MathUtils.smoothstep(t, 0.7, 1);
  return { a, d, back: backAt(y) };
}

/** Unit pack profile: x ∈ [−1, 1] across, y ∈ [−1, 1] back → front; flatter back, rounder front. */
function packUnitProfile(count: number): { pts: [number, number][]; backPanel: boolean[] } {
  const pts: [number, number][] = [];
  const backPanel: boolean[] = [];
  const raw: [number, number][] = [];
  for (let i = 0; i < count; i += 1) {
    const th = (i / count) * Math.PI * 2;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const e = s >= 0 ? 2.7 : 5.5;
    raw.push([Math.sign(c) * Math.pow(Math.abs(c), 2 / e), Math.sign(s) * Math.pow(Math.abs(s), 2 / e)]);
  }
  const PANEL = -0.84;
  for (let i = 0; i < count; i += 1) {
    const a = raw[i];
    const b = raw[(i + 1) % count];
    pts.push(a);
    backPanel.push(a[1] < PANEL);
    // Duplicate the vertex where the back panel seam crosses (crisp seam colour).
    if ((a[1] < PANEL) !== (b[1] < PANEL)) {
      const k = (PANEL - a[1]) / (b[1] - a[1]);
      const q: [number, number] = [a[0] + (b[0] - a[0]) * k, PANEL];
      pts.push(q, q);
      backPanel.push(a[1] < PANEL, b[1] < PANEL);
    }
  }
  return { pts, backPanel };
}

export interface BackpackBuild {
  body: GearMesh[];
  /** Lid meshes in the lid frame (origin at BACKPACK_LID_HINGE_LOCAL, axes of the socket). */
  lid: GearMesh[];
  triangles: number;
}

/** Most protruding jacket back (local z of the socket frame) at height y, over the pack width. */
function measureBackLocal(toRoot: THREE.Matrix4, y: number): number {
  let best = -1;
  const p = new THREE.Vector3();
  const o = new THREE.Vector3();
  const dir = new THREE.Vector3();
  for (let x = -0.12; x <= 0.1201; x += 0.04) {
    // Ray from in front of the body (local +z far out) toward the back panel plane.
    o.set(x, y, -0.25).applyMatrix4(toRoot);
    p.set(x, y, 0.25).applyMatrix4(toRoot);
    dir.copy(p).sub(o).normalize();
    // March from the far point (local z = +0.25) back toward the body.
    const t = marchInward(torsoField, o, dir, 0.5, 0);
    const local = (t - 0.25);
    if (local > best) best = local;
  }
  return best;
}

export function buildBackpack(detail: GearDetail): BackpackBuild {
  const D = DETAIL[detail];
  const toRoot = socketRestMatrix('backpack');
  const toLocal = toRoot.clone().invert();

  // Back panel: follows the most protruding back (shoulder blades), convexified and padded.
  const backSamples: { y: number; z: number }[] = [];
  for (let y = -0.4; y <= 0.26; y += 0.055) backSamples.push({ y, z: measureBackLocal(toRoot, y) + 0.008 });
  const backAt = (y: number): number => {
    // Running envelope: the padded panel never dips into the lumbar curve by more than 1.2 cm.
    let maxZ = -1;
    for (const s of backSamples) maxZ = Math.max(maxZ, s.z - Math.abs(s.y - y) * 0.06);
    let z = maxZ;
    for (let i = 0; i < backSamples.length - 1; i += 1) {
      const a = backSamples[i];
      const b = backSamples[i + 1];
      if (y >= a.y && y <= b.y) z = Math.max(a.z + ((b.z - a.z) * (y - a.y)) / (b.y - a.y), maxZ - 0.012);
    }
    return z;
  };

  const fabric = new MeshAccumulator();
  const dark = new MeshAccumulator();
  const web = new MeshAccumulator();
  const plastic = new MeshAccumulator();

  /* ---- Body ---- */
  const unit = packUnitProfile(D.body);
  const profile = makeProfile(unit.pts);
  const ringYs = [-0.386, -0.381, -0.372, -0.358, -0.335, -0.335, -0.3, -0.24, -0.16, -0.08, 0, 0.07, 0.125, 0.155, 0.17, 0.176];
  const bottomSeam = 5; // ring index where the red body starts (rings 0..4 are the dark base)
  const frames: SweepFrame[] = ringYs.map((y, i) => {
    const s = packShapeAt(Math.max(y, -0.372), backAt);
    // Round the bottom edge: the first rings tuck in.
    const tuck = i === 0 ? 0.82 : i === 1 ? 0.93 : i === 2 ? 0.98 : 1;
    const centreZ = s.back + s.d / 2;
    return { p: v3(0, y, centreZ), t: v3(0, 1, 0), n: v3(-1, 0, 0), b: v3(0, 0, 1), sx: s.a * tuck, sy: (s.d / 2) * tuck };
  });
  // Re-centre each ring so the back face stays on the back panel even when tucked.
  for (let i = 0; i < frames.length; i += 1) {
    const s = packShapeAt(Math.max(ringYs[i], -0.372), backAt);
    frames[i].p.z = s.back + frames[i].sy;
  }
  sweep(fabric, frames, profile, {
    color: (ring, j) => (ring < bottomSeam ? PACK_DARK : unit.backPanel[j] ? PACK_DARK : PACK_RED),
    uPerMetre: 28,
    vScale: 25,
    capStart: true,
  });

  /* ---- Collar (dark, cinched by a drawcord) ---- */
  const collarYs = [0.17, 0.183, 0.195, 0.203, 0.208, 0.21];
  const top = packShapeAt(0.176, backAt);
  const collarFrames: SweepFrame[] = collarYs.map((y, i) => {
    const k = i / (collarYs.length - 1);
    const pinch = 1 - 0.7 * Math.pow(k, 0.8);
    const sx = top.a * 0.97 * pinch + 0.04 * (1 - pinch) * 0.4;
    const sy = (top.d / 2) * 0.95 * pinch + 0.03 * (1 - pinch) * 0.3;
    const cz = THREE.MathUtils.lerp(top.back + top.d / 2, BACKPACK_FLAP_OPENING_LOCAL[2], k);
    return { p: v3(0, y, cz), t: v3(0, 1, 0), n: v3(-1, 0, 0), b: v3(0, 0, 1), sx, sy };
  });
  const collarProfile = makeProfile(packUnitProfile(Math.max(14, Math.round(D.body * 0.5))).pts);
  sweep(dark, collarFrames, collarProfile, { color: PACK_DARK, uPerMetre: 28, vScale: 20 });
  // The dark hole of the mouth.
  const mouth = collarFrames[collarFrames.length - 1];
  {
    const c = dark.vertex(mouth.p.x, mouth.p.y - 0.004, mouth.p.z, 0, 1, 0, 0.5, 0.5, col('#050506'));
    const first = dark.vertexCount;
    for (let j = 0; j < collarProfile.count; j += 1) {
      dark.vertex(mouth.p.x + collarProfile.x[j] * mouth.sx, mouth.p.y, mouth.p.z + collarProfile.y[j] * mouth.sy, 0, 1, 0, 0, 0, col('#0a0a0b'));
    }
    for (let j = 0; j < collarProfile.count; j += 1) dark.tri(c, first + ((j + 1) % collarProfile.count), first + j);
  }
  // Drawcord around the mouth + cord lock.
  {
    const pts: THREE.Vector3[] = [];
    const n = Math.max(16, seg(28, D.k));
    for (let i = 0; i < n; i += 1) {
      const th = (i / n) * Math.PI * 2;
      pts.push(v3(Math.cos(th) * (mouth.sx + 0.003), mouth.p.y - 0.002, mouth.p.z + Math.sin(th) * (mouth.sy + 0.003)));
    }
    tube(web, pts, 0.0024, D.tube, DRAWCORD, true);
    const lockPos = v3(0.012, mouth.p.y - 0.012, mouth.p.z + mouth.sy + 0.012);
    tube(web, [v3(0.004, mouth.p.y - 0.002, mouth.p.z + mouth.sy + 0.003), lockPos], 0.0022, D.tube, DRAWCORD, false);
    roundedBox(plastic, 0.012, 0.016, 0.009, 0.004, BUCKLE_BLACK, new THREE.Matrix4().makeTranslation(lockPos.x, lockPos.y - 0.006, lockPos.z));
  }

  /* ---- Rim piping (seam between body and collar) ---- */
  {
    const ring = frames[frames.length - 1];
    const pts: THREE.Vector3[] = [];
    for (let j = 0; j < profile.count; j += 1) {
      pts.push(v3(profile.x[j] * ring.sx * 1.004, ring.p.y - 0.001, ring.p.z + profile.y[j] * ring.sy * 1.004));
    }
    tube(dark, pts, 0.0035, Math.max(4, D.tube - 1), PACK_DARKER, true);
  }

  /* ---- Front surface helper ---- */
  const frontPoint = (x: number, y: number, lift: number, out = new THREE.Vector3()): THREE.Vector3 => {
    const s = packShapeAt(THREE.MathUtils.clamp(y, -0.372, 0.176), backAt);
    const u = THREE.MathUtils.clamp(Math.abs(x) / s.a, 0, 0.999);
    const f = Math.pow(1 - Math.pow(u, 2.7), 1 / 2.7);
    return out.set(x, y, s.back + s.d / 2 + (s.d / 2) * f + lift);
  };
  const frontNormal = (x: number, y: number): THREE.Vector3 => {
    const a = frontPoint(x - 0.004, y, 0);
    const b = frontPoint(x + 0.004, y, 0);
    const c = frontPoint(x, y - 0.004, 0);
    const d = frontPoint(x, y + 0.004, 0);
    return new THREE.Vector3().crossVectors(b.sub(a), d.sub(c)).normalize();
  };
  /** Point on the body side surface at height y and profile angle (0 = +x side, π/2 = front). */
  const bodyPoint = (y: number, th: number, lift: number): THREE.Vector3 => {
    const s = packShapeAt(THREE.MathUtils.clamp(y, -0.372, 0.176), backAt);
    const c = Math.cos(th);
    const sn = Math.sin(th);
    const e = sn >= 0 ? 2.7 : 5.5;
    const ux = Math.sign(c) * Math.pow(Math.abs(c), 2 / e);
    const uy = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / e);
    const p = v3(ux * s.a, y, s.back + s.d / 2 + uy * (s.d / 2));
    const nrm = v3(ux / s.a, 0, uy / (s.d / 2)).normalize();
    return p.addScaledVector(nrm, lift);
  };
  const bodyNormal = (y: number, th: number): THREE.Vector3 => bodyPoint(y, th, 0.01).sub(bodyPoint(y, th, 0)).normalize();

  /* ---- Daisy chains (two rows of bar-tacked loops) ---- */
  for (const x of [-0.052, 0.052]) {
    const pts: THREE.Vector3[] = [];
    const nrms: THREE.Vector3[] = [];
    const n = seg(36, D.k, 18);
    for (let i = 0; i < n; i += 1) {
      const y = -0.3 + (i / (n - 1)) * 0.36;
      const loop = Math.max(0, Math.sin(((y + 0.3) / 0.06) * Math.PI));
      pts.push(frontPoint(x, y, 0.0025 + 0.006 * loop * loop));
      nrms.push(frontNormal(x, y));
    }
    webbing(web, pts, nrms, 0.019, 0.0022, WEB_BLACK, {});
  }

  /* ---- Ice-axe loops at the bottom front ---- */
  for (const x of [-0.07, 0.07]) {
    const pts: THREE.Vector3[] = [];
    const nrms: THREE.Vector3[] = [];
    const n = seg(14, D.k, 8);
    for (let i = 0; i < n; i += 1) {
      const k = i / (n - 1);
      const y = -0.36 + 0.05 * k;
      pts.push(frontPoint(x, y, 0.003 + 0.016 * Math.sin(k * Math.PI)));
      nrms.push(frontNormal(x, y));
    }
    webbing(web, pts, nrms, 0.02, 0.0024, WEB_GREY, {});
  }

  /* ---- Side compression straps with ladder locks ---- */
  for (const y of [-0.19, 0.02]) {
    for (const side of [1, -1]) {
      const pts: THREE.Vector3[] = [];
      const nrms: THREE.Vector3[] = [];
      const n = seg(18, D.k, 8);
      // From the back panel corner around the side to the front corner.
      const th0 = side > 0 ? -0.62 : Math.PI + 0.62;
      const th1 = side > 0 ? 0.95 : Math.PI - 0.95;
      for (let i = 0; i < n; i += 1) {
        const th = th0 + (th1 - th0) * (i / (n - 1));
        pts.push(bodyPoint(y, th, 0.0026));
        nrms.push(bodyNormal(y, th));
      }
      webbing(web, pts, nrms, 0.022, 0.0022, WEB_BLACK, {});
      // Ladder lock at the front end, tail hanging.
      const end = pts[pts.length - 1];
      const nrm = nrms[nrms.length - 1];
      const tangent = end.clone().sub(pts[pts.length - 2]).normalize();
      const m = new THREE.Matrix4().makeBasis(tangent, v3(0, 1, 0), nrm).setPosition(end.clone().addScaledVector(nrm, 0.003));
      buckle(plastic, 0.027, 0.03, BUCKLE_BLACK, m.clone().multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)));
      const tail: THREE.Vector3[] = [];
      const tailN: THREE.Vector3[] = [];
      for (let i = 0; i < 6; i += 1) {
        const k = i / 5;
        tail.push(end.clone().addScaledVector(tangent, 0.012 + 0.01 * k).add(v3(0, -0.075 * k, 0)).addScaledVector(nrm, 0.004 + 0.006 * k));
        tailN.push(nrm);
      }
      webbing(web, tail, tailN, 0.022, 0.0022, WEB_BLACK, {});
    }
  }

  /* ---- Haul loop at the top of the back panel ---- */
  {
    const pts: THREE.Vector3[] = [];
    const nrms: THREE.Vector3[] = [];
    const n = 10;
    const z = backAt(0.17) + 0.01;
    for (let i = 0; i < n; i += 1) {
      const k = i / (n - 1);
      const th = Math.PI * k;
      pts.push(v3(-Math.cos(th) * 0.03, 0.17 + Math.sin(th) * 0.035, z - 0.004));
      nrms.push(v3(0, 0, -1));
    }
    webbing(web, pts, nrms, 0.02, 0.003, WEB_GREY, {});
  }

  /* ---- Female lid buckles on the body front (male halves are on the lid) ---- */
  for (const x of [-0.072, 0.072]) {
    const pts: THREE.Vector3[] = [];
    const nrms: THREE.Vector3[] = [];
    for (let i = 0; i < 6; i += 1) {
      const y = 0.03 + (i / 5) * 0.048;
      pts.push(frontPoint(x, y, 0.0022));
      nrms.push(frontNormal(x, y));
    }
    webbing(web, pts, nrms, 0.02, 0.0022, WEB_BLACK, {});
    const p = frontPoint(x, 0.09, 0.0055);
    const nrm = frontNormal(x, 0.09);
    const m = new THREE.Matrix4().makeBasis(v3(1, 0, 0), new THREE.Vector3().crossVectors(nrm, v3(1, 0, 0)).normalize(), nrm).setPosition(p);
    buckle(plastic, 0.026, 0.03, BUCKLE_BLACK, m, false);
  }

  /* ---- Lid straps, body half: sewn down the +x side, adjustable, rising free to the lid's hinge line ---- */
  /** Point on the body's +x side surface at height y and depth z (socket frame), lifted along its normal. */
  const sidePoint = (y: number, z: number, lift: number, nOut: THREE.Vector3): THREE.Vector3 => {
    const s = packShapeAt(THREE.MathUtils.clamp(y, -0.372, 0.176), backAt);
    const h = s.d / 2;
    const w = THREE.MathUtils.clamp((z - (s.back + h)) / h, -0.97, 0.97);
    const e = w >= 0 ? 2.7 : 5.5;
    const u = Math.pow(1 - Math.pow(Math.abs(w), e), 1 / e);
    // Gradient of |x/a|^e + |w|^e: ∝ (u^(e−1)/a, 0, sign(w)·|w|^(e−1)/h).
    nOut.set(Math.pow(u, e - 1) / s.a, 0, (Math.sign(w) * Math.pow(Math.abs(w), e - 1)) / h).normalize();
    return v3(u * s.a, y, z).addScaledVector(nOut, lift);
  };
  for (const dz of LID_STRAP_DZ) {
    const z = BACKPACK_LID_HINGE_LOCAL[2] + dz;
    const pts: THREE.Vector3[] = [];
    const nrms: THREE.Vector3[] = [];
    const nrm = new THREE.Vector3();
    for (const y of [0.07, 0.095, 0.12, 0.145, 0.163, 0.174]) {
      pts.push(sidePoint(y, z, 0.0026, nrm));
      nrms.push(nrm.clone());
    }
    const corner = pts[pts.length - 1].clone();
    const hingePoint = v3(BACKPACK_LID_HINGE_LOCAL[0], BACKPACK_LID_HINGE_LOCAL[1], z);
    for (let i = 1; i <= 4; i += 1) {
      const k = i / 4;
      pts.push(corner.clone().lerp(hingePoint, k).add(v3(0.004 * Math.sin(k * Math.PI), 0, 0)));
      nrms.push(v3(1, 0, 0));
    }
    webbing(web, pts, nrms, 0.02, 0.0024, WEB_BLACK, {});
    // Ladder-lock adjuster on the side panel.
    const at = sidePoint(0.118, z, 0.0055, nrm);
    const across = new THREE.Vector3().crossVectors(v3(0, 1, 0), nrm).normalize();
    buckle(plastic, 0.025, 0.026, BUCKLE_BLACK, new THREE.Matrix4().makeBasis(across, new THREE.Vector3().crossVectors(nrm, across), nrm).setPosition(at));
  }

  /* ---- Shoulder straps, load lifters, sternum strap, lower webbing (Root space → socket frame) ---- */
  const strapAcc = new MeshAccumulator();
  const strapEnds: { front: THREE.Vector3; frontN: THREE.Vector3; side: number }[] = [];
  strapAcc.withMatrix(toLocal, () => {
    for (const side of [1, -1]) {
      const pts: THREE.Vector3[] = [];
      const nrms: THREE.Vector3[] = [];
      const widths: number[] = [];
      const n = seg(28, D.k, 12);
      const origin = new THREE.Vector3();
      const dir = new THREE.Vector3();
      const g = new THREE.Vector3();
      for (let i = 0; i < n; i += 1) {
        const k = i / (n - 1);
        // φ: 2.45 (back, emerging from the pack) → over the shoulder → −1.0 (front, bottom of the padding).
        const phi = 2.45 - k * 3.45;
        const x = side * (0.074 + 0.04 * Math.sin(Math.min(1, k * 1.6) * Math.PI * 0.5) + 0.012 * k);
        origin.set(x, 1.33, -0.02);
        dir.set(0, Math.sin(phi), Math.cos(phi));
        const t = marchInward(torsoField, origin, dir, 0.42, 0.0105);
        const p = origin.clone().addScaledVector(dir, t);
        fieldGradient(torsoField, p, g);
        pts.push(p);
        nrms.push(g.clone());
        widths.push(k < 0.12 ? 0.7 + 2.5 * k : 1);
      }
      // Padded strap: thickness 13 mm, width 62 mm, red binding on both edges.
      const band = bandProfile(0.013, 0.062, 0.0045);
      const strapProfile = band.profile;
      const frames2 = framesWithUp(pts, false, (i) => {
        const prev = pts[Math.max(0, i - 1)];
        const next = pts[Math.min(pts.length - 1, i + 1)];
        const tt = next.clone().sub(prev).normalize();
        return new THREE.Vector3().crossVectors(tt, nrms[i]).normalize();
      });
      for (let i = 0; i < frames2.length; i += 1) {
        if (frames2[i].n.dot(nrms[i]) < 0) {
          frames2[i].n.negate();
          frames2[i].b.negate();
        }
        frames2[i].sy = widths[i];
      }
      sweep(strapAcc, frames2, strapProfile, {
        color: (_ring, j) => (band.region[j] === 1 ? PACK_RED : band.region[j] === 2 ? PACK_DARKER : PACK_DARK),
        uPerMetre: 14,
        vScale: 1.2,
        capStart: true,
        capEnd: true,
      });
      strapEnds.push({ front: pts[pts.length - 1].clone(), frontN: nrms[nrms.length - 1].clone(), side });

      // Load lifter: from the strap's top-back to the pack's upper side corner.
      const lifterFrom = pts[Math.round(n * 0.2)].clone().addScaledVector(nrms[Math.round(n * 0.2)], 0.008);
      const lifterTo = v3(-side * 0.118, 0.155, backAt(0.155) + 0.035).applyMatrix4(toRoot);
      const lp: THREE.Vector3[] = [];
      const ln: THREE.Vector3[] = [];
      for (let i = 0; i < 6; i += 1) {
        const k = i / 5;
        lp.push(lifterFrom.clone().lerp(lifterTo, k).add(v3(0, 0.012 * Math.sin(k * Math.PI), 0)));
        ln.push(v3(0, 1, 0).lerp(v3(side, 0.2, -0.2).normalize(), k).normalize());
      }
      webbing(strapAcc, lp, ln, 0.018, 0.0022, WEB_BLACK, {});
    }

    // Sternum strap between the straps, with a side-release buckle.
    const yS = 1.31;
    const left = new THREE.Vector3();
    const right = new THREE.Vector3();
    const findOnStrap = (side: number, out: THREE.Vector3): void => {
      const origin = v3(side * 0.112, 1.33, -0.02);
      const phi = Math.asin(THREE.MathUtils.clamp((yS - 1.33) / 0.15, -1, 1));
      const dir = v3(0, Math.sin(phi), Math.cos(phi)).normalize();
      out.copy(origin).addScaledVector(dir, marchInward(torsoField, origin, dir, 0.42, 0.018));
    };
    findOnStrap(1, left);
    findOnStrap(-1, right);
    const sp: THREE.Vector3[] = [];
    const sn: THREE.Vector3[] = [];
    for (let i = 0; i < 9; i += 1) {
      const k = i / 8;
      sp.push(left.clone().lerp(right, k).add(v3(0, 0, 0.012 * Math.sin(k * Math.PI))));
      sn.push(v3(0, 0, 1));
    }
    webbing(strapAcc, sp, sn, 0.016, 0.0022, WEB_BLACK, {});
    const mid = sp[4].clone().add(v3(0, 0, 0.004));
    buckle(strapAcc, 0.024, 0.036, BUCKLE_BLACK, new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(mid));

    // Lower webbing: from the bottom of each padded strap around the ribs to the pack's bottom corner.
    for (const end of strapEnds) {
      const target = v3(-end.side * 0.128, -0.335, backAt(-0.335) + 0.03).applyMatrix4(toRoot);
      const pts: THREE.Vector3[] = [];
      const nrms: THREE.Vector3[] = [];
      const g = new THREE.Vector3();
      const n = seg(18, D.k, 8);
      for (let i = 0; i < n; i += 1) {
        const k = i / (n - 1);
        // Around the side: azimuth from the strap end (front) to the back corner.
        const a0 = Math.atan2(end.front.x, end.front.z);
        const a1 = Math.atan2(target.x, target.z);
        let da = a1 - a0;
        if (end.side > 0 && da < 0) da += Math.PI * 2;
        if (end.side < 0 && da > 0) da -= Math.PI * 2;
        const a = a0 + da * k;
        const y = THREE.MathUtils.lerp(end.front.y, target.y, k);
        const origin = v3(0, y, -0.02);
        const dir = v3(Math.sin(a), 0, Math.cos(a));
        const t = marchInward(torsoField, origin, dir, 0.4, 0.004);
        const p = origin.clone().addScaledVector(dir, t);
        if (k > 0.85) p.lerp(target, (k - 0.85) / 0.15);
        pts.push(p);
        nrms.push(fieldGradient(torsoField, p, g).clone());
      }
      webbing(strapAcc, pts, nrms, 0.02, 0.0024, WEB_BLACK, {});
      // Ladder lock where the webbing meets the padding.
      const tdir = pts[1].clone().sub(pts[0]).normalize();
      const m = new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(end.frontN, tdir).normalize(), tdir, end.frontN).setPosition(pts[0].clone().addScaledVector(end.frontN, 0.006));
      buckle(strapAcc, 0.03, 0.026, BUCKLE_BLACK, m);
    }
  });

  /* ---- Lid (authored in the socket frame, then moved to its side hinge) ---- */
  const lidFabric = new MeshAccumulator();
  const lidWeb = new MeshAccumulator();
  const lidPlastic = new MeshAccumulator();
  const lidC = v3(0, 0.214, 0.118);
  const lidR = v3(0.158, 0.044, 0.127);
  const spe = (w: number, m: number): number => Math.sign(w) * Math.pow(Math.abs(w), m);
  /** Lid surface point: a draped superellipsoid (underside hangs at the rim, the top domes, the front droops). */
  const lidPoint = (phi: number, th: number, out: THREE.Vector3): THREE.Vector3 => {
    const cp = spe(Math.cos(phi), 0.42);
    const sp = spe(Math.sin(phi), 0.42);
    let x = lidR.x * cp * spe(Math.cos(th), 0.36);
    let y = lidR.y * sp;
    const zz = lidR.z * cp * spe(Math.sin(th), 0.36);
    const rim = Math.min(1, (x / lidR.x) ** 2 + (zz / lidR.z) ** 2);
    if (y < 0) y -= 0.018 * rim;
    else y += 0.009 * (1 - rim);
    y -= 0.012 * Math.max(0, zz / lidR.z);
    x *= 1 + 0.03 * Math.max(0, zz / lidR.z);
    return out.set(x, y + lidC.y, zz + lidC.z);
  };
  const lidNormal = (phi: number, th: number, out: THREE.Vector3): THREE.Vector3 => {
    const e = 1e-3;
    const a = lidPoint(phi, th + e, new THREE.Vector3()).sub(lidPoint(phi, th - e, new THREE.Vector3()));
    const b = lidPoint(Math.min(phi + e, Math.PI / 2), th, new THREE.Vector3()).sub(lidPoint(Math.max(phi - e, -Math.PI / 2), th, new THREE.Vector3()));
    out.crossVectors(b, a);
    if (out.lengthSq() < 1e-16) return out.set(0, Math.sign(phi), 0);
    return out.normalize();
  };
  {
    const nu = Math.max(16, Math.round(D.body * 0.9));
    const nv = Math.max(8, Math.round(D.body * 0.32));
    const base = lidFabric.vertexCount;
    const p = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    for (let i = 0; i <= nv; i += 1) {
      const phi = -Math.PI / 2 + (i / nv) * Math.PI;
      for (let j = 0; j <= nu; j += 1) {
        const th = (j / nu) * Math.PI * 2;
        lidPoint(phi, th, p);
        lidNormal(phi, th, nrm);
        const isZip = Math.abs(phi - 0.42) < 0.05 && Math.sin(th) > 0.12;
        const under = phi < -0.55;
        lidFabric.vertex(p.x, p.y, p.z, nrm.x, nrm.y, nrm.z, (j / nu) * 24, (i / nv) * 7, isZip ? PACK_DARKER : under ? PACK_DARK : PACK_RED);
      }
    }
    for (let i = 0; i < nv; i += 1) {
      for (let j = 0; j < nu; j += 1) {
        const a = base + i * (nu + 1) + j;
        const b = a + nu + 1;
        lidFabric.tri(a, b + 1, a + 1);
        lidFabric.tri(a, b, b + 1);
      }
    }
  }
  // Zip teeth along the front-top of the lid, with a corded pull.
  {
    const pts: THREE.Vector3[] = [];
    const n = seg(36, D.k, 14);
    const p = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    for (let i = 0; i < n; i += 1) {
      const th = THREE.MathUtils.lerp(0.2, Math.PI - 0.2, i / (n - 1));
      lidPoint(0.42, th, p);
      lidNormal(0.42, th, nrm);
      pts.push(p.clone().addScaledVector(nrm, 0.0012));
    }
    tube(lidWeb, pts, 0.0024, Math.max(4, D.tube - 1), PACK_DARKER, false, { caps: true });
    const pull = pts[Math.round(n * 0.3)];
    tube(lidWeb, [pull.clone(), pull.clone().add(v3(0.004, -0.016, 0.01)), pull.clone().add(v3(0.006, -0.03, 0.012))], 0.0017, 4, col('#d8492c'), false, { caps: true });
    roundedBox(lidPlastic, 0.008, 0.016, 0.005, 0.002, BUCKLE_BLACK, new THREE.Matrix4().makeTranslation(pull.x + 0.006, pull.y - 0.038, pull.z + 0.013));
  }
  // Lid buckle tabs (male halves) from the lid's front-bottom edge down onto the body front.
  for (const x of [-0.072, 0.072]) {
    const tp: THREE.Vector3[] = [];
    const tn: THREE.Vector3[] = [];
    const lp = new THREE.Vector3();
    const ln = new THREE.Vector3();
    // Lid front-bottom edge at this x: search the lid's lower front for the point with matching x.
    const thx = Math.acos(THREE.MathUtils.clamp(Math.sign(x) * Math.pow(Math.abs(x) / (lidR.x * 0.9), 1 / 0.36), -1, 1));
    lidPoint(-0.25, thx, lp);
    lidNormal(-0.25, thx, ln);
    const start = lp.clone().addScaledVector(ln, 0.002);
    const endPt = frontPoint(x, 0.134, 0.0042);
    for (let i = 0; i < 6; i += 1) {
      const k = i / 5;
      const q = start.clone().lerp(endPt, k);
      const onFront = frontPoint(x, q.y, 0.0042);
      if (q.z < onFront.z) q.z = onFront.z;
      tp.push(q);
      tn.push(k < 0.3 ? ln.clone() : frontNormal(x, q.y));
    }
    webbing(lidWeb, tp, tn, 0.02, 0.0022, WEB_BLACK, {});
    const nrm = frontNormal(x, 0.121);
    const m = new THREE.Matrix4()
      .makeBasis(v3(1, 0, 0), new THREE.Vector3().crossVectors(nrm, v3(1, 0, 0)).normalize(), nrm)
      .setPosition(frontPoint(x, 0.121, 0.0058));
    buckle(lidPlastic, 0.024, 0.03, BUCKLE_BLACK, m, true);
  }
  // Lid straps, lid half: from the hinge line (shared with the body half, so the two meet on the hinge axis at
  // every lid angle) along a meridian onto the top of the lid, ending in a bar tack.
  for (const dz of LID_STRAP_DZ) {
    const th0 = Math.sign(dz) * Math.asin(Math.pow(Math.abs(dz) / lidR.z, 1 / 0.36));
    const pts: THREE.Vector3[] = [v3(BACKPACK_LID_HINGE_LOCAL[0], BACKPACK_LID_HINGE_LOCAL[1], BACKPACK_LID_HINGE_LOCAL[2] + dz)];
    const nrms: THREE.Vector3[] = [v3(1, 0, 0)];
    const p = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    for (const phi of [0.6, 0.72, 0.84, 0.96]) {
      lidPoint(phi, th0, p);
      lidNormal(phi, th0, nrm);
      pts.push(p.clone().addScaledVector(nrm, 0.0022));
      nrms.push(nrm.clone());
    }
    nrms[0].lerp(nrms[1], 0.5).normalize();
    webbing(lidWeb, pts, nrms, 0.02, 0.0024, WEB_BLACK, {});
    const tack = pts[pts.length - 2];
    const tn = nrms[nrms.length - 2];
    const along = pts[pts.length - 1].clone().sub(pts[pts.length - 3]).normalize();
    const across = new THREE.Vector3().crossVectors(along, tn).normalize();
    roundedBox(lidPlastic, 0.021, 0.006, 0.0032, 0.0012, PACK_DARKER, new THREE.Matrix4().makeBasis(across, along, tn).setPosition(tack.clone().addScaledVector(tn, 0.0012)), 1);
  }

  const body: GearMesh[] = [
    { geometry: fabric.toGeometry('Backpack.fabric'), material: 'packFabric', castShadow: true },
    { geometry: dark.toGeometry('Backpack.collar'), material: 'packDark', castShadow: true },
    { geometry: strapAcc.toGeometry('Backpack.straps'), material: 'packDark', castShadow: true },
    { geometry: web.toGeometry('Backpack.webbing'), material: 'webbing', castShadow: false },
    { geometry: plastic.toGeometry('Backpack.buckles'), material: 'plastic', castShadow: false },
  ];
  const toHinge = new THREE.Matrix4().makeTranslation(-BACKPACK_LID_HINGE_LOCAL[0], -BACKPACK_LID_HINGE_LOCAL[1], -BACKPACK_LID_HINGE_LOCAL[2]);
  const lid: GearMesh[] = [
    { geometry: lidFabric.toGeometry('Backpack.lid').applyMatrix4(toHinge), material: 'packFabric', castShadow: true },
    { geometry: lidWeb.toGeometry('Backpack.lidWebbing').applyMatrix4(toHinge), material: 'webbing', castShadow: false },
    { geometry: lidPlastic.toGeometry('Backpack.lidBuckles').applyMatrix4(toHinge), material: 'plastic', castShadow: false },
  ];
  for (const m of lid) m.geometry.computeBoundingSphere();
  return { body, lid, triangles: countTriangles(body) + countTriangles(lid) };
}

function countTriangles(meshes: readonly GearMesh[]): number {
  let n = 0;
  for (const m of meshes) {
    const index = m.geometry.getIndex();
    n += index ? index.count / 3 : m.geometry.getAttribute('position').count / 3;
  }
  return n;
}

/** Signed distance to the closed pack (body + lid) in Root space, for the rope wrap. */
function packFieldRoot(toLocal: THREE.Matrix4): (x: number, y: number, z: number) => number {
  const q = new THREE.Vector3();
  const box = (px: number, py: number, pz: number, hx: number, hy: number, hz: number, r: number): number => {
    const dx = Math.abs(px) - hx + r;
    const dy = Math.abs(py) - hy + r;
    const dz = Math.abs(pz) - hz + r;
    const ox = Math.max(dx, 0);
    const oy = Math.max(dy, 0);
    const oz = Math.max(dz, 0);
    return Math.hypot(ox, oy, oz) + Math.min(Math.max(dx, dy, dz), 0) - r;
  };
  return (x, y, z) => {
    q.set(x, y, z).applyMatrix4(toLocal);
    const body = box(q.x, q.y + 0.1, q.z - 0.125, 0.152, 0.285, 0.118, 0.07);
    const lid = box(q.x, q.y - 0.214, q.z - 0.138, 0.166, 0.05, 0.148, 0.04);
    return Math.min(body, lid);
  };
}

/* ==========================================================================
 * ClimbingRopeCoil (ropeCoil socket frame = Chest axes at the left shoulder top)
 * ========================================================================== */

export const ROPE_RADIUS = 0.0052;
/** Rope texture repeats per metre of rope (the sheath texture holds 16 braid periods per repeat). */
export const ROPE_U_PER_METRE = 4;
const ROPE_RING = 0.0123;

export interface RopeBuild {
  meshes: GearMesh[];
  /** Coil centreline (socket frame), for the fall proxies. */
  centreline: THREE.Vector3[];
  triangles: number;
}

/** The bandolier loop: convex wrap of torso + pack (+ straps) in a diagonal plane over the left shoulder. */
export function ropeCoilCentreline(samples: number): { points: THREE.Vector3[]; normal: THREE.Vector3 } {
  const toLocal = socketRestMatrix('ropeCoil').invert();
  const packLocal = socketRestMatrix('backpack').invert();
  const pack = packFieldRoot(packLocal);
  const clearance = ROPE_RING + ROPE_RADIUS + 0.013;
  const field = (x: number, y: number, z: number): number => Math.min(torsoField(x, y, z), pack(x, y, z));
  const shoulder = new THREE.Vector3(...SOCKET_SPECS.ropeCoil.position);
  const hip = v3(-0.172, 0.985, 0);
  const e1 = hip.clone().sub(shoulder);
  e1.z = 0;
  e1.normalize();
  const e2 = v3(0, 0, 1);
  const normal = new THREE.Vector3().crossVectors(e1, e2).normalize();
  const centre = shoulder.clone().addScaledVector(e1, 0.3).add(v3(0, 0, -0.1));
  const raw: [number, number][] = [];
  const dir = new THREE.Vector3();
  const N = 120;
  for (let i = 0; i < N; i += 1) {
    const a = (i / N) * Math.PI * 2;
    dir.copy(e1).multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a));
    const t = marchInward(field, centre, dir, 0.75, clearance);
    if (t > 0.02 && t < 0.74) raw.push([Math.cos(a) * t, Math.sin(a) * t]);
  }
  // Convex hull (monotone chain): a coil under tension spans the hollows.
  raw.sort((p, q) => (p[0] === q[0] ? p[1] - q[1] : p[0] - q[0]));
  const crossZ = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of raw) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const p = raw[i];
    while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  let hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  // Chaikin smoothing (rounds the corners of the wrap).
  for (let it = 0; it < 3; it += 1) {
    const next: [number, number][] = [];
    for (let i = 0; i < hull.length; i += 1) {
      const a = hull[i];
      const b = hull[(i + 1) % hull.length];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    hull = next;
  }
  // Start the loop on the front of the left shoulder so the seam hides under the tie-off wraps.
  const tieU = new THREE.Vector3(0, 0.02, 0.07).add(shoulder).sub(centre);
  const tu = tieU.dot(e1);
  const tw = tieU.dot(e2);
  let start = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < hull.length; i += 1) {
    const d = (hull[i][0] - tu) ** 2 + (hull[i][1] - tw) ** 2;
    if (d < best) {
      best = d;
      start = i;
    }
  }
  hull = hull.slice(start).concat(hull.slice(0, start));
  const pts3 = hull.map(([u, w]) => centre.clone().addScaledVector(e1, u).addScaledVector(e2, w));
  // Uniform resample, then into the socket frame.
  const curve = new THREE.CatmullRomCurve3(pts3, true, 'centripetal');
  const points = curve.getSpacedPoints(samples).slice(0, samples).map((p) => p.applyMatrix4(toLocal));
  return { points, normal };
}

export function buildRopeCoil(detail: GearDetail): RopeBuild {
  const D = DETAIL[detail];
  const loops = D.ropeLoops;
  const perLoop = D.ropeSegments;
  const { points: centre, normal } = ropeCoilCentreline(perLoop);
  const loopLength = centre.reduce((s, p, i) => s + p.distanceTo(centre[(i + 1) % centre.length]), 0);
  // Frames of the coil centreline: b = plane normal, n = in-plane outward.
  const frames = framesWithUp(centre, true, () => normal);
  const acc = new MeshAccumulator();
  const wrapAcc = new MeshAccumulator();
  const ropeColor = col('#ffffff');
  // Tie-off region at the start of the loop (the shoulder): the bundle is cinched under the wraps.
  const wrapSpan = 0.085 / loopLength;
  const cinch = (s: number): number => {
    const d = Math.min(Math.abs(s), Math.abs(1 - s));
    return 1 - 0.3 * (1 - THREE.MathUtils.smoothstep(d, wrapSpan * 0.5, wrapSpan * 0.9));
  };
  const sample = (s: number, out: THREE.Vector3, nOut: THREE.Vector3, bOut: THREE.Vector3): void => {
    const f = s * perLoop;
    const i0 = Math.floor(f) % perLoop;
    const i1 = (i0 + 1) % perLoop;
    const k = f - Math.floor(f);
    out.copy(frames[i0].p).lerp(frames[i1].p, k);
    nOut.copy(frames[i0].n).lerp(frames[i1].n, k).normalize();
    bOut.copy(frames[i0].b).lerp(frames[i1].b, k).normalize();
  };
  // One continuous rope: S ∈ [0, loops); ψ(S) = 2π·(loops + 1)/loops·S makes loop k flow into loop k + 1.
  const total = loops * perLoop;
  const pts: THREE.Vector3[] = [];
  const c = new THREE.Vector3();
  const nn = new THREE.Vector3();
  const bb = new THREE.Vector3();
  for (let i = 0; i < total; i += 1) {
    const S = i / perLoop;
    const s = S - Math.floor(S);
    sample(s, c, nn, bb);
    const psi = ((2 * Math.PI * (loops + 1)) / loops) * S;
    const wob = 1 + 0.12 * Math.sin(s * Math.PI * 2 * 3 + Math.floor(S) * 1.7) * THREE.MathUtils.smoothstep(Math.min(s, 1 - s), wrapSpan, wrapSpan * 2);
    const r = ROPE_RING * cinch(s) * wob;
    // Gravity sag: the free part of the coil hangs a little away from the body below the shoulder.
    pts.push(c.clone().addScaledVector(nn, Math.cos(psi) * r).addScaledVector(bb, Math.sin(psi) * r));
  }
  tube(acc, pts, ROPE_RADIUS, Math.max(4, D.tube - 1), ropeColor, true, { uPerMetre: ROPE_U_PER_METRE, up: normal });
  // Tie-off wraps (a helix around the cinched bundle at the shoulder).
  {
    const turns = detail === 'low' ? 4 : 6;
    const n = seg(turns * 10, D.k, turns * 7);
    const wp: THREE.Vector3[] = [];
    for (let i = 0; i < n; i += 1) {
      const k = i / (n - 1);
      const s = (k - 0.5) * wrapSpan * 1.4;
      sample(((s % 1) + 1) % 1, c, nn, bb);
      const psi = k * turns * Math.PI * 2;
      // Tuck the ends into the bundle.
      const tuck = THREE.MathUtils.smoothstep(k, 0, 0.06) * (1 - THREE.MathUtils.smoothstep(k, 0.94, 1));
      const r = ROPE_RING * 0.7 + (ROPE_RADIUS * 2 + 0.001) * (0.35 + 0.65 * tuck);
      wp.push(c.clone().addScaledVector(nn, Math.cos(psi) * r).addScaledVector(bb, Math.sin(psi) * r));
    }
    tube(wrapAcc, wp, ROPE_RADIUS * 0.98, Math.max(4, D.tube - 1), ropeColor, false, { uPerMetre: ROPE_U_PER_METRE, caps: true, up: normal });
  }
  const meshes: GearMesh[] = [
    { geometry: acc.toGeometry('RopeCoil.coil'), material: 'rope', castShadow: true },
    { geometry: wrapAcc.toGeometry('RopeCoil.wraps'), material: 'rope', castShadow: true },
  ];
  return { meshes, centreline: centre.map((p) => p.clone()), triangles: countTriangles(meshes) };
}

/* ==========================================================================
 * DualCarbonIceAxes (grip frame: origin at the palm grip, shaft +Z, pick −Y)
 * ========================================================================== */

/** The tool's clip carabiner: hangs through the trigger hole (its top wire in the hole), loop plane XZ. */
const AXE_CLIP = { height: 0.062, width: 0.032, stock: 0.0032, hole: [0, -0.017, -0.082] as Vec3Tuple } as const;

export const ICE_AXE_DIMENSIONS = {
  /** Pommel (bottom of the trigger) along the shaft. */
  pommelZ: -0.092,
  /** Head block centre along the shaft. */
  headZ: 0.448,
  /** Pick tip (matches poseLibrary ICE_AXE_GRIP: (0, −pickReach, shaftLength)). */
  pickTip: [0, -0.11, 0.43] as Vec3Tuple,
  /** Inner far end of the clip carabiner (where the racked tool hangs from the hip holster), in the grip frame. */
  clipTop: [0, AXE_CLIP.hole[1], AXE_CLIP.hole[2] - AXE_CLIP.height + 3 * AXE_CLIP.stock] as Vec3Tuple,
} as const;

export interface IceAxeBuild {
  meshes: GearMesh[];
  triangles: number;
}

/** Shaft bow (toward +Y, away from the pick) at height z. */
function shaftBow(z: number): number {
  if (z <= 0.085) return 0;
  const k = THREE.MathUtils.clamp((z - 0.085) / 0.345, 0, 1);
  return 0.034 * Math.sin(Math.PI * Math.pow(k, 0.85));
}

/** Carabiner centreline in its own plane (x across, y down from the top inner point at 0). */
function carabinerOutline(kind: 'D' | 'pear' | 'oval' | 'mini', height: number, width: number, stock: number, n: number, bentGate = false): THREE.Vector3[] {
  const top = -stock;
  const bottom = -height + stock;
  let ctrl: THREE.Vector3[];
  if (kind === 'pear') {
    ctrl = [v3(0, top, 0), v3(width * 0.42, top - 0.008, 0), v3(width * 0.5, top - height * 0.3, 0), v3(width * 0.2, bottom + 0.008, 0), v3(0, bottom, 0), v3(-width * 0.2, bottom + 0.012, 0), v3(-width * 0.42, top - height * 0.45, 0), v3(-width * 0.34, top - 0.006, 0)];
  } else if (kind === 'oval' || kind === 'mini') {
    ctrl = [v3(0, top, 0), v3(width * 0.45, top - height * 0.1, 0), v3(width * 0.5, top - height * 0.5, 0), v3(width * 0.45, bottom + height * 0.1, 0), v3(0, bottom, 0), v3(-width * 0.45, bottom + height * 0.1, 0), v3(-width * 0.5, top - height * 0.5, 0), v3(-width * 0.45, top - height * 0.1, 0)];
  } else {
    // Offset D: spine on −x, gate on +x angled toward the narrow bottom basket.
    const g = bentGate ? -0.006 : 0;
    ctrl = [
      v3(-width * 0.08, top, 0),
      v3(width * 0.36, top - height * 0.06, 0),
      v3(width * 0.5, top - height * 0.24, 0),
      v3(width * 0.32 + g, top - height * 0.62, 0),
      v3(width * 0.12, bottom + height * 0.04, 0),
      v3(-width * 0.18, bottom, 0),
      v3(-width * 0.44, bottom + height * 0.16, 0),
      v3(-width * 0.5, top - height * 0.45, 0),
      v3(-width * 0.42, top - height * 0.1, 0),
    ];
  }
  return smoothCurve(ctrl, n, true);
}

function carabiner(
  acc: MeshAccumulator,
  kind: 'D' | 'pear' | 'oval' | 'mini',
  height: number,
  width: number,
  stock: number,
  color: THREE.Color,
  m: THREE.Matrix4,
  D: DetailSpec,
  options: { bentGate?: boolean; locking?: THREE.Color } = {},
): void {
  const n = seg(kind === 'mini' ? 14 : 20, D.k, 10);
  acc.withMatrix(m, () => {
    const pts = carabinerOutline(kind, height, width, stock, n, options.bentGate);
    tube(acc, pts, stock, Math.max(4, D.tube - 1), color, true, { up: v3(0, 0, 1) });
    if (options.locking) {
      // Locking sleeve over the gate (+x side).
      const a = pts[Math.round(n * 0.2)];
      const b = pts[Math.round(n * 0.3)];
      tube(acc, [a.clone(), a.clone().lerp(b, 0.5), b.clone()], stock * 1.65, Math.max(5, D.tube), options.locking, false, { caps: true, up: v3(0, 0, 1) });
    }
  });
}

export function buildIceAxe(detail: GearDetail, variant: 'adze' | 'hammer'): IceAxeBuild {
  const D = DETAIL[detail];
  const carbonAcc = new MeshAccumulator();
  const steelAcc = new MeshAccumulator();
  const anodAcc = new MeshAccumulator();
  const rubberAcc = new MeshAccumulator();
  const clipAcc = new MeshAccumulator();
  const white = col('#ffffff');
  const headColor = col('#c2342a');
  const rubberDark = col('#1b1c1f');
  const rubberAccent = col('#c2342a');

  /* ---- Carbon shaft (oval, bent) ---- */
  {
    const n = seg(24, D.k, 10);
    const pts: THREE.Vector3[] = [];
    const scales: [number, number][] = [];
    for (let i = 0; i < n; i += 1) {
      const z = THREE.MathUtils.lerp(-0.06, 0.432, i / (n - 1));
      pts.push(v3(0, shaftBow(z), z));
      const taper = 1 - 0.16 * THREE.MathUtils.smoothstep(z, 0.1, 0.43);
      scales.push([0.0094 * taper, 0.0128 * taper]);
    }
    const frames = framesWithUp(pts, false, () => v3(0, 1, 0), (i) => scales[i]);
    // framesWithUp: b = +Y-ish (pick plane), n = b × t ⇒ x axis. Profile x → n (X, narrow), y → b (Y, deep).
    const prof = makeProfile(
      Array.from({ length: Math.max(8, D.tube + 4) }, (_, i) => {
        const a = (i / Math.max(8, D.tube + 4)) * Math.PI * 2;
        const c = Math.cos(a);
        const s = Math.sin(a);
        return [Math.sign(c) * Math.pow(Math.abs(c), 0.8), Math.sign(s) * Math.pow(Math.abs(s), 0.8)] as [number, number];
      }),
    );
    sweep(carbonAcc, frames, prof, { color: white, uPerMetre: 40, vScale: 2.4, capStart: true, capEnd: true });
  }

  /* ---- Moulded grip with finger grooves ---- */
  {
    const n = seg(22, D.k, 10);
    const pts: THREE.Vector3[] = [];
    const scales: [number, number][] = [];
    for (let i = 0; i < n; i += 1) {
      const z = THREE.MathUtils.lerp(-0.07, 0.078, i / (n - 1));
      pts.push(v3(0, -0.002, z));
      const groove = z > -0.05 && z < 0.06 ? 0.0014 * Math.pow(Math.max(0, Math.sin(((z + 0.05) / 0.0275) * Math.PI)), 2) : 0;
      const flare = 0.0016 * THREE.MathUtils.smoothstep(z, 0.05, 0.078) + 0.002 * (1 - THREE.MathUtils.smoothstep(z, -0.07, -0.05));
      scales.push([0.0128 - groove * 0.4 + flare, 0.0168 - groove + flare]);
    }
    const frames = framesWithUp(pts, false, () => v3(0, 1, 0), (i) => scales[i]);
    const count = Math.max(8, D.tube + 4);
    const prof = makeProfile(
      Array.from({ length: count }, (_, i) => {
        const a = (i / count) * Math.PI * 2;
        return [Math.cos(a), Math.sin(a)] as [number, number];
      }),
    );
    sweep(rubberAcc, frames, prof, {
      color: (ring) => (ring === n - 2 || ring === n - 1 ? rubberAccent : rubberDark),
      uPerMetre: 30,
      vScale: 2,
      capStart: true,
      capEnd: true,
    });
    // Upper grip rest (second hand position) on the pick side.
    roundedBox(rubberAcc, 0.014, 0.018, 0.026, 0.006, rubberAccent, new THREE.Matrix4().makeTranslation(0, -0.019, 0.135).multiply(new THREE.Matrix4().makeRotationX(-0.35)));
  }

  /* ---- Trigger / pinky rest + spike (aluminium plate with a clip hole) ---- */
  {
    const shape = new THREE.Shape();
    // Shape in (u = −y, v = z): the hooked rest curls toward the pick side under the fist.
    shape.moveTo(-0.012, -0.066);
    shape.bezierCurveTo(-0.004, -0.074, 0.014, -0.076, 0.028, -0.07);
    shape.bezierCurveTo(0.036, -0.066, 0.04, -0.056, 0.036, -0.05);
    shape.lineTo(0.03, -0.054);
    shape.bezierCurveTo(0.02, -0.062, 0.008, -0.06, 0.004, -0.052);
    shape.lineTo(0.004, -0.046);
    shape.lineTo(-0.012, -0.046);
    shape.lineTo(-0.012, -0.066);
    const hole = new THREE.Path();
    hole.absarc(0.017, -0.066, 0.0035, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    const ext = new THREE.ExtrudeGeometry(shape, { depth: 0.014, bevelEnabled: true, bevelThickness: 0.0018, bevelSize: 0.0016, bevelSegments: 1, curveSegments: Math.max(4, Math.round(8 * D.k)) });
    // Shape (u, v, w) → grip frame (x = w − 0.007, y = −u, z = v − 0.016).
    const m = new THREE.Matrix4().makeBasis(v3(0, -1, 0), v3(0, 0, 1), v3(1, 0, 0)).setPosition(-0.007, 0, -0.016);
    anodAcc.withMatrix(m, () => anodAcc.appendGeometry(ext, headColor, 20));
    // Spike / pommel point.
    const cone = new THREE.ConeGeometry(0.0062, 0.026, Math.max(5, D.tube), 1);
    const mc = new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition(0, 0.004, -0.095);
    steelAcc.withMatrix(mc, () => steelAcc.appendGeometry(cone, white, 20));
  }

  /* ---- Head block ---- */
  const hz = ICE_AXE_DIMENSIONS.headZ;
  roundedBox(anodAcc, 0.02, 0.05, 0.05, 0.007, headColor, new THREE.Matrix4().makeTranslation(0, 0.006, hz));
  roundedBox(steelAcc, 0.0215, 0.012, 0.036, 0.003, white, new THREE.Matrix4().makeTranslation(0, -0.006, hz + 0.004));

  /* ---- Toothed pick (extruded steel, curving down to the tip) ---- */
  {
    const tip = ICE_AXE_DIMENSIONS.pickTip;
    const shape = new THREE.Shape();
    // (u = −y outward from the head, v = z)
    const u0 = 0.012;
    shape.moveTo(u0, hz + 0.018);
    shape.bezierCurveTo(0.05, hz + 0.022, 0.09, hz + 0.008, -tip[1] + 0.004, tip[2] + 0.0035);
    shape.lineTo(-tip[1] + 0.006, tip[2] - 0.0015);
    // Teeth along the lower edge, back toward the head.
    const teeth = detail === 'low' ? 4 : 7;
    for (let i = 0; i < teeth; i += 1) {
      const k0 = i / teeth;
      const k1 = (i + 0.55) / teeth;
      const pAt = (k: number): [number, number] => {
        const u = THREE.MathUtils.lerp(-tip[1] - 0.004, u0 + 0.01, k);
        const v = THREE.MathUtils.lerp(tip[2] - 0.004, hz - 0.012, k) - 0.006 * Math.sin(k * Math.PI);
        return [u, v];
      };
      const [ua, va] = pAt(k0);
      const [ub, vb] = pAt(k1);
      shape.lineTo(ua, va - 0.0045);
      shape.lineTo(ub, vb);
    }
    shape.lineTo(u0 + 0.004, hz - 0.016);
    shape.lineTo(u0, hz - 0.012);
    shape.lineTo(u0, hz + 0.018);
    const ext = new THREE.ExtrudeGeometry(shape, { depth: 0.0042, bevelEnabled: true, bevelThickness: 0.0006, bevelSize: 0.0006, bevelSegments: 1, curveSegments: Math.max(4, Math.round(10 * D.k)) });
    const m = new THREE.Matrix4().makeBasis(v3(0, -1, 0), v3(0, 0, 1), v3(1, 0, 0)).setPosition(-0.0021, 0, 0);
    steelAcc.withMatrix(m, () => steelAcc.appendGeometry(ext, white, 20));
  }

  /* ---- Adze or hammer on the +Y side ---- */
  if (variant === 'adze') {
    const shape = new THREE.Shape();
    // Plate in (u = x across, v = +y out from the head), tapering wider toward the blade.
    shape.moveTo(-0.009, 0.0);
    shape.lineTo(0.009, 0.0);
    shape.lineTo(0.021, 0.05);
    shape.quadraticCurveTo(0.0, 0.056, -0.021, 0.05);
    shape.lineTo(-0.009, 0.0);
    const ext = new THREE.ExtrudeGeometry(shape, { depth: 0.0035, bevelEnabled: true, bevelThickness: 0.0006, bevelSize: 0.0006, bevelSegments: 1, curveSegments: 4 });
    // Plate lies across x, extends along +y, droops 0.25 rad toward −z.
    const m = new THREE.Matrix4()
      .makeTranslation(0, 0.026, hz + 0.008)
      .multiply(new THREE.Matrix4().makeRotationX(-0.28))
      .multiply(new THREE.Matrix4().makeBasis(v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)).setPosition(0, 0, -0.0017));
    steelAcc.withMatrix(m, () => steelAcc.appendGeometry(ext, white, 20));
  } else {
    const cyl = new THREE.CylinderGeometry(0.0105, 0.0115, 0.034, Math.max(6, D.tube + 2), 1);
    steelAcc.withMatrix(new THREE.Matrix4().makeTranslation(0, 0.046, hz + 0.002), () => steelAcc.appendGeometry(cyl, white, 20));
  }

  /* ---- Clip carabiner hanging from the trigger hole (racks the tool head-down at the hip) ---- */
  {
    // Outline frame: top inner point at the origin, hanging along −y; R_x(+90°) maps −y → −Z and keeps x → X.
    const m = new THREE.Matrix4()
      .makeTranslation(AXE_CLIP.hole[0], AXE_CLIP.hole[1], AXE_CLIP.hole[2] + AXE_CLIP.stock)
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    carabiner(clipAcc, 'mini', AXE_CLIP.height, AXE_CLIP.width, AXE_CLIP.stock, col('#d9a62a'), m, D);
  }

  const meshes: GearMesh[] = [
    { geometry: carbonAcc.toGeometry('IceAxe.shaft'), material: 'carbon', castShadow: true },
    { geometry: steelAcc.toGeometry('IceAxe.steel'), material: 'steel', castShadow: true },
    { geometry: anodAcc.toGeometry('IceAxe.head'), material: 'anodized', castShadow: true },
    { geometry: rubberAcc.toGeometry('IceAxe.grip'), material: 'rubber', castShadow: true },
    { geometry: clipAcc.toGeometry('IceAxe.clip'), material: 'anodized', castShadow: false },
  ];
  return { meshes, triangles: countTriangles(meshes) };
}

/**
 * Holstered (racked) transform of an axe in its hip-holster socket frame (Pelvis axes): the clip hangs from the
 * socket point, the tool hangs head-down from its trigger hole, pick toward the back, tilted out from the thigh.
 * `side` = +1 for the left hip (+X), −1 for the right.
 */
export function iceAxeHolsterMatrix(side: 1 | -1, out = new THREE.Matrix4()): THREE.Matrix4 {
  // R_x(+90°): shaft (+Z) → −Y (down), pick (−Y) → −Z (back); then tilt the head outward.
  const q = new THREE.Quaternion().setFromAxisAngle(v3(0, 0, 1), side * 0.1).multiply(new THREE.Quaternion().setFromAxisAngle(v3(1, 0, 0), Math.PI / 2));
  const clip = v3(...ICE_AXE_DIMENSIONS.clipTop).applyQuaternion(q);
  const pivot = v3(side * 0.024, 0.004, 0.006);
  return out.compose(pivot.sub(clip), q, new THREE.Vector3(1, 1, 1));
}

/** Hang pivot of a racked axe in the holster socket frame (top of its clip). */
export function iceAxeHolsterPivot(side: 1 | -1): THREE.Vector3 {
  return v3(side * 0.024, 0.004, 0.006);
}

/* ==========================================================================
 * TacticalHarnessRack (harness socket frame = Pelvis axes at the waist; leg loops in the UpLeg frames)
 * ========================================================================== */

export interface RackPiece {
  /** Meshes in the piece frame (pivot at the origin, hanging along −Y; the piece's plane is XY). */
  meshes: GearMesh[];
  /** Pivot position in the harness socket frame. */
  pivot: THREE.Vector3;
  /** Rest orientation of the piece frame in the harness socket frame (X along the belt, Z outward). */
  rest: THREE.Quaternion;
}

export interface HarnessBuild {
  belt: GearMesh[];
  legLoops: Record<'LeftUpLeg' | 'RightUpLeg', GearMesh[]>;
  rack: RackPiece[];
  triangles: number;
}

export function buildHarness(detail: GearDetail): HarnessBuild {
  const D = DETAIL[detail];
  const toLocal = socketRestMatrix('harness').invert();
  const socketY = SOCKET_SPECS.harness.position[1];
  // Everything is built in Root rest space and moved into the socket / bone frames at the end.
  const beltAcc = new MeshAccumulator();
  const webAcc = new MeshAccumulator();
  const metalAcc = new MeshAccumulator();
  const HARNESS = col('#30333a');
  const HARNESS_EDGE = col('#b9352b');
  const PAD_LINING = col('#4a4f58');

  /* ---- Waist belt contoured to the jacket ---- */
  const n = seg(40, D.k, 22);
  const contour: THREE.Vector3[] = [];
  const contourN: THREE.Vector3[] = [];
  const g = new THREE.Vector3();
  const angles: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2; // 0 = front (+Z), increasing toward +X (the character's left)
    angles.push(a);
    const origin = v3(0, socketY, -0.008);
    const dir = v3(Math.sin(a), 0, Math.cos(a));
    const t = marchInward(jacketSdf, origin, dir, 0.42, 0.0085);
    const p = origin.clone().addScaledVector(dir, t);
    contour.push(p);
    fieldGradient(jacketSdf, p, g);
    contourN.push(g.clone());
  }
  // Belt height: 7.5 cm padded at the back, 4.4 cm at the front buckle.
  const beltWidth = (a: number): number => 0.044 + 0.031 * (0.5 - 0.5 * Math.cos(a));
  {
    const band = bandProfile(0.013, 1, 0.07);
    const prof = band.profile;
    const frames = framesWithUp(contour, true, (i) => {
      // Width axis: vertical, tilted to lie on the surface.
      const up = v3(0, 1, 0);
      return up.addScaledVector(contourN[i], -up.dot(contourN[i])).normalize();
    });
    for (let i = 0; i < frames.length; i += 1) {
      if (frames[i].n.dot(contourN[i]) < 0) {
        frames[i].n.negate();
        frames[i].b.negate();
      }
      frames[i].sx = 1;
      frames[i].sy = beltWidth(angles[i]);
    }
    sweep(beltAcc, frames, prof, {
      closed: true,
      color: (_ring, j) => (band.region[j] === 1 ? HARNESS_EDGE : band.region[j] === 2 ? PAD_LINING : HARNESS),
      uPerMetre: 22,
      vScale: 2,
    });
  }

  const contourAt = (a: number, lift: number, dy: number): { p: THREE.Vector3; n: THREE.Vector3; t: THREE.Vector3 } => {
    const f = ((((a / (Math.PI * 2)) % 1) + 1) % 1) * n;
    const i0 = Math.floor(f) % n;
    const i1 = (i0 + 1) % n;
    const k = f - Math.floor(f);
    const p = contour[i0].clone().lerp(contour[i1], k);
    const nn = contourN[i0].clone().lerp(contourN[i1], k).normalize();
    const t = contour[i1].clone().sub(contour[i0]).normalize();
    p.addScaledVector(nn, lift).add(v3(0, dy, 0));
    return { p, n: nn, t };
  };

  /* ---- Front buckle (aluminium double-back) + belay loop ---- */
  {
    const f = contourAt(0, 0.011, 0);
    const m = new THREE.Matrix4().makeBasis(v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)).setPosition(f.p);
    roundedBox(metalAcc, 0.05, 0.036, 0.006, 0.004, ALU, m);
    roundedBox(metalAcc, 0.038, 0.006, 0.008, 0.0025, ALU, m.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.004, 0.003)));
    roundedBox(metalAcc, 0.038, 0.006, 0.008, 0.0025, ALU, m.clone().multiply(new THREE.Matrix4().makeTranslation(0, -0.008, 0.003)));
    // Belay loop: a vertical webbing loop hanging from the belt's bottom edge at the front.
    const lp: THREE.Vector3[] = [];
    const ln: THREE.Vector3[] = [];
    const c0 = contourAt(0, 0.012, -0.024);
    const nl = seg(22, D.k, 12);
    for (let i = 0; i < nl; i += 1) {
      const th = (i / nl) * Math.PI * 2;
      lp.push(c0.p.clone().add(v3(0, -0.048 + Math.cos(th) * 0.046, 0)).addScaledVector(c0.n, 0.008 + Math.sin(th) * 0.011));
      ln.push(c0.n.clone().multiplyScalar(Math.sin(th)).add(v3(0, Math.cos(th), 0)).normalize());
    }
    webbing(webAcc, lp, ln, 0.021, 0.006, HARNESS_EDGE, { closed: true });
  }

  /* ---- Gear loops (stiff sheathed arcs under the belt) ---- */
  const loopAngles = [1.08, 2.06, -1.08, -2.06];
  const loopPoint = (a0: number, beta: number): THREE.Vector3 => {
    const base = contourAt(a0 + beta * 0.17, 0.006, 0);
    const sag = 1 - beta * beta;
    return base.p.addScaledVector(base.n, 0.007 + 0.016 * sag).add(v3(0, -beltWidth(a0) * 0.5 - 0.004 - 0.032 * sag, 0));
  };
  for (const a of loopAngles) {
    const pts: THREE.Vector3[] = [];
    const nl = seg(14, D.k, 8);
    for (let i = 0; i < nl; i += 1) pts.push(loopPoint(a, -1 + (2 * i) / (nl - 1)));
    tube(webAcc, pts, 0.0042, Math.max(4, D.tube - 1), col('#5a5f68'), false, { caps: true });
  }

  /* ---- Leg loops (UpLeg frames) ---- */
  const legLoops = {} as Record<'LeftUpLeg' | 'RightUpLeg', GearMesh[]>;
  for (const bone of ['LeftUpLeg', 'RightUpLeg'] as const) {
    const side = bone === 'LeftUpLeg' ? 1 : -1;
    const frame = side > 0 ? LIMB_FRAMES.legL : LIMB_FRAMES.legR;
    const hipJ = REST_JOINTS[bone];
    const legField = (x: number, y: number, z: number): number => {
      const b = limbToBind(frame, x, y, z);
      return trousersSdf(b.x, b.y, b.z);
    };
    const centre = v3(hipJ[0] + side * 0.006, 0.785, 0.004);
    const tilt = 0.24; // the front of the loop sits higher
    const ex = v3(1, 0, 0);
    const ez = v3(0, Math.sin(tilt), Math.cos(tilt));
    const loopUp = new THREE.Vector3().crossVectors(ez, ex).normalize();
    const nn = seg(26, D.k, 12);
    const pts: THREE.Vector3[] = [];
    const nrm: THREE.Vector3[] = [];
    for (let i = 0; i < nn; i += 1) {
      const a = (i / nn) * Math.PI * 2;
      const dir = ez.clone().multiplyScalar(Math.cos(a)).addScaledVector(ex, Math.sin(a)).normalize();
      const t = THREE.MathUtils.clamp(marchInward(legField, centre, dir, 0.098, 0.0075), 0.05, 0.097);
      pts.push(centre.clone().addScaledVector(dir, t));
      nrm.push(dir.clone());
    }
    const acc = new MeshAccumulator();
    const band = bandProfile(0.011, 0.042, 0.003);
    const prof = band.profile;
    const frames = framesWithUp(pts, true, (i) => loopUp.clone().addScaledVector(nrm[i], -loopUp.dot(nrm[i])).normalize());
    for (let i = 0; i < frames.length; i += 1) {
      if (frames[i].n.dot(nrm[i]) < 0) {
        frames[i].n.negate();
        frames[i].b.negate();
      }
    }
    sweep(acc, frames, prof, {
      closed: true,
      color: (_r, j) => (band.region[j] === 1 ? HARNESS_EDGE : band.region[j] === 2 ? PAD_LINING : HARNESS),
      uPerMetre: 22,
      vScale: 2,
    });
    // Leg-loop buckle on the outside of the thigh.
    const k = side > 0 ? Math.round(nn * 0.25) % nn : Math.round(nn * 0.75) % nn;
    const bp = pts[k].clone().addScaledVector(nrm[k], 0.008);
    const tangent = new THREE.Vector3().crossVectors(loopUp, nrm[k]).normalize();
    roundedBox(acc, 0.03, 0.022, 0.005, 0.003, ALU, new THREE.Matrix4().makeBasis(tangent, new THREE.Vector3().crossVectors(nrm[k], tangent), nrm[k]).setPosition(bp));
    legLoops[bone] = [{ geometry: acc.toGeometry(`Harness.${bone}`).applyMatrix4(boneRestMatrix(bone).invert()), material: 'webbing', castShadow: true }];
  }

  /* ---- Rack: each piece hangs from a gear loop about its own pivot ---- */
  const rack: RackPiece[] = [];
  interface RackAcc {
    anod: MeshAccumulator;
    metal: MeshAccumulator;
    sling: MeshAccumulator;
  }
  const piece = (a0: number, beta: number, build: (acc: RackAcc) => void): void => {
    const pivot = loopPoint(a0, beta).add(v3(0, -0.0042, 0)).applyMatrix4(toLocal);
    const c = contourAt(a0 + beta * 0.17, 0, 0);
    const zAxis = c.n.clone().setY(0).normalize();
    const xAxis = c.t.clone().setY(0);
    xAxis.addScaledVector(zAxis, -xAxis.dot(zAxis)).normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    const rest = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
    const acc: RackAcc = { anod: new MeshAccumulator(), metal: new MeshAccumulator(), sling: new MeshAccumulator() };
    build(acc);
    const meshes: GearMesh[] = [];
    if (acc.anod.triangleCount) meshes.push({ geometry: acc.anod.toGeometry('Harness.rack.anodized'), material: 'anodized', castShadow: false });
    if (acc.metal.triangleCount) meshes.push({ geometry: acc.metal.toGeometry('Harness.rack.metal'), material: 'metal', castShadow: false });
    if (acc.sling.triangleCount) meshes.push({ geometry: acc.sling.toGeometry('Harness.rack.sling'), material: 'sling', castShadow: false });
    rack.push({ meshes, pivot, rest });
  };
  const I = new THREE.Matrix4();
  const quickdraw =
    (topColor: string, bottomColor: string, slingColor: string) =>
    (acc: RackAcc): void => {
      carabiner(acc.anod, 'D', 0.074, 0.043, 0.0045, col(topColor), I, D);
      // Dogbone sling between the baskets.
      const sp: THREE.Vector3[] = [];
      const sn: THREE.Vector3[] = [];
      for (let i = 0; i < 7; i += 1) {
        sp.push(v3(-0.004, -0.062 - (i / 6) * 0.105, 0));
        sn.push(v3(0, 0, 1));
      }
      webbing(acc.sling, sp, sn, 0.017, 0.0075, col(slingColor), { widthScale: (i) => (i === 0 || i === 6 ? 1.15 : 1) });
      // Bar tacks.
      roundedBox(acc.sling, 0.019, 0.006, 0.0085, 0.002, col('#1a1b1f'), new THREE.Matrix4().makeTranslation(-0.004, -0.078, 0), 1);
      roundedBox(acc.sling, 0.019, 0.006, 0.0085, 0.002, col('#1a1b1f'), new THREE.Matrix4().makeTranslation(-0.004, -0.152, 0), 1);
      // Bottom (rope) carabiner: bent gate, turned so its gate faces the other way.
      const mb = new THREE.Matrix4().makeTranslation(-0.004, -0.158, 0).multiply(new THREE.Matrix4().makeRotationY(Math.PI));
      carabiner(acc.anod, 'D', 0.074, 0.043, 0.0048, col(bottomColor), mb, D, { bentGate: true });
    };
  piece(1.08, -0.42, quickdraw('#d9a62a', '#c9ccd2', '#2f6fb3'));
  piece(1.08, 0.38, quickdraw('#c33b2c', '#c33b2c', '#9aa1ab'));
  piece(-1.08, -0.38, quickdraw('#3b74c9', '#3b74c9', '#9aa1ab'));
  piece(-1.08, 0.42, quickdraw('#7d4fc2', '#4f9a52', '#2f6fb3'));
  // Back-left: HMS locker + tube belay device on its cable.
  piece(2.06, 0.0, (acc) => {
    carabiner(acc.metal, 'pear', 0.1, 0.068, 0.0055, ALU, I, D, { locking: col('#d9a62a') });
    if (D.extras) {
      const m = new THREE.Matrix4().makeTranslation(0.004, -0.112, 0.004).multiply(new THREE.Matrix4().makeRotationZ(0.12));
      roundedBox(acc.anod, 0.05, 0.062, 0.03, 0.01, col('#3f4652'), m);
      roundedBox(acc.anod, 0.012, 0.036, 0.032, 0.004, col('#16181c'), m.clone().multiply(new THREE.Matrix4().makeTranslation(-0.011, 0.004, 0)));
      roundedBox(acc.anod, 0.012, 0.036, 0.032, 0.004, col('#16181c'), m.clone().multiply(new THREE.Matrix4().makeTranslation(0.011, 0.004, 0)));
      tube(acc.metal, smoothCurve([v3(-0.012, -0.08, 0.004), v3(0, -0.092, 0.006), v3(0.012, -0.08, 0.004)], 8, false), 0.0016, 4, ALU, false, { caps: true });
    }
  });
  // Back-right: locking D + ice screw.
  piece(-2.06, 0.0, (acc) => {
    carabiner(acc.anod, 'D', 0.08, 0.05, 0.005, col('#d9a62a'), I, D, { locking: col('#2a2c31') });
    if (D.extras) {
      // Ice screw: hanger plate, threaded body, crank knob.
      const top = -0.07;
      roundedBox(acc.metal, 0.024, 0.03, 0.003, 0.004, col('#c33b2c'), new THREE.Matrix4().makeTranslation(0.002, top - 0.006, 0));
      const nT = seg(48, D.k, 20);
      const body: THREE.Vector3[] = [];
      for (let i = 0; i < nT; i += 1) body.push(v3(0.002, top - 0.02 - (i / (nT - 1)) * 0.12, 0));
      tube(acc.metal, body, (i) => 0.0085 + 0.0011 * Math.max(0, Math.sin(i * 1.9)), Math.max(6, D.tube + 2), ALU, false, { caps: true });
      roundedBox(acc.metal, 0.006, 0.006, 0.02, 0.002, col('#c33b2c'), new THREE.Matrix4().makeTranslation(0.002, top - 0.02, 0.012));
    }
  });

  const belt: GearMesh[] = [
    { geometry: beltAcc.toGeometry('Harness.belt').applyMatrix4(toLocal), material: 'webbing', castShadow: true },
    { geometry: webAcc.toGeometry('Harness.loops').applyMatrix4(toLocal), material: 'webbing', castShadow: false },
    { geometry: metalAcc.toGeometry('Harness.metal').applyMatrix4(toLocal), material: 'metal', castShadow: false },
  ];
  for (const m of belt) m.geometry.computeBoundingSphere();
  let triangles = countTriangles(belt) + countTriangles(legLoops.LeftUpLeg) + countTriangles(legLoops.RightUpLeg);
  for (const r of rack) triangles += countTriangles(r.meshes);
  return { belt, legLoops, rack, triangles };
}

/* ==========================================================================
 * Everything
 * ========================================================================== */

export interface GearGeometrySet {
  detail: GearDetail;
  backpack: BackpackBuild;
  rope: RopeBuild;
  axes: { left: IceAxeBuild; right: IceAxeBuild };
  harness: HarnessBuild;
  triangles: number;
}

export function disposeGearGeometry(set: GearGeometrySet): void {
  const all: GearMesh[] = [
    ...set.backpack.body,
    ...set.backpack.lid,
    ...set.rope.meshes,
    ...set.axes.left.meshes,
    ...set.axes.right.meshes,
    ...set.harness.belt,
    ...set.harness.legLoops.LeftUpLeg,
    ...set.harness.legLoops.RightUpLeg,
  ];
  for (const r of set.harness.rack) all.push(...r.meshes);
  for (const m of all) m.geometry.dispose();
}

/** Time-sliceable builder: one tool per step. */
export interface GearGeometryBuilder {
  readonly done: boolean;
  /** Builds the next pieces within `budgetMs` (at least one piece per call). */
  step(budgetMs: number): void;
  /** The finished set (builds the rest synchronously if needed). */
  result(): GearGeometrySet;
}

export function createGearGeometryBuilder(detail: GearDetail): GearGeometryBuilder {
  let backpack: BackpackBuild | null = null;
  let rope: RopeBuild | null = null;
  let left: IceAxeBuild | null = null;
  let right: IceAxeBuild | null = null;
  let harness: HarnessBuild | null = null;
  const steps: (() => void)[] = [
    () => {
      left = buildIceAxe(detail, 'adze');
      right = buildIceAxe(detail, 'hammer');
    },
    () => {
      harness = buildHarness(detail);
    },
    () => {
      rope = buildRopeCoil(detail);
    },
    () => {
      backpack = buildBackpack(detail);
    },
  ];
  let next = 0;
  let set: GearGeometrySet | null = null;
  const finish = (): GearGeometrySet => {
    while (next < steps.length) steps[next++]();
    if (!set) {
      const b = backpack as BackpackBuild | null;
      const r = rope as RopeBuild | null;
      const l = left as IceAxeBuild | null;
      const rt = right as IceAxeBuild | null;
      const h = harness as HarnessBuild | null;
      if (!b || !r || !l || !rt || !h) throw new Error('gear build incomplete');
      set = { detail, backpack: b, rope: r, axes: { left: l, right: rt }, harness: h, triangles: b.triangles + r.triangles + l.triangles + rt.triangles + h.triangles };
    }
    return set;
  };
  return {
    get done() {
      return next >= steps.length;
    },
    step(budgetMs: number) {
      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      do {
        if (next >= steps.length) return;
        steps[next++]();
      } while ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0 < budgetMs);
    },
    result: finish,
  };
}

export function buildGearGeometry(detail: GearDetail): GearGeometrySet {
  return createGearGeometryBuilder(detail).result();
}
