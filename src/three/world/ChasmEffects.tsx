import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, type RootState } from '@react-three/fiber';
import * as THREE from 'three';
import { scrollStore, smoothstep, type GpuTier } from '../../store/scrollStore';
import { adaptiveQuality } from '../perf/adaptiveQuality';
import { sceneFx } from '../fx/sceneFx';
import { PATH_PHASES, protagonistPositionAt } from '../protagonistPath';
import { PALETTE, SUN_DIRECTION, ZONES } from './worldLayout';
import { CHASM_LAYOUT, mountainSdf, noise3 } from './terrainGeometry';
import {
  BURST_SLOTS,
  PARTICLE_KIND,
  chasmFxQualityFor,
  chasmRandom,
  createAbyssMistGeometry,
  createAbyssMistMaterial,
  createChasmNoiseTexture,
  createChasmParticleGeometry,
  createChasmParticleMaterial,
  type AbyssMistMaterial,
  type ChasmFrameSpec,
  type ChasmParticleMaterial,
  type ChasmParticleSpec,
  type MistSheetSpec,
  type ParticleKind,
} from '../shaders/AbyssMistShader';
import {
  createWindRibbonGeometry,
  createWindRibbonMaterial,
  windRibbonMaxExcursion,
  type WindRibbonMaterial,
  type WindRibbonSpec,
} from '../shaders/WindRibbonShader';

/* ==========================================================================
 * Chasm effects — what makes the two gaps of the one continuous mountain
 * read as bottomless, wind-torn abysses.
 *
 *   Chasm 1 (the cleft between ledge 1 and ledge 2, jump p 0.45–0.52)
 *     churning abyss mist pooled deep in the slot, veils welling up out of
 *     it, rising mist puffs, drifting sun motes and a breeze of snow; gravel
 *     kicked off the lips at the take-off and the landing.
 *
 *   Chasm 2 (the gorge between the mid-face pillar and the summit pyramid,
 *     leap p 0.62–0.70)
 *     the same layered mist, much deeper; instanced granite blocks breaking
 *     off the gorge walls (dust burst + gravel spray) and tumbling into the
 *     abyss, bouncing off the leaning walls; violent wind ribbons and
 *     wind-borne snow streaking through the gorge; spindrift torn off the
 *     edges; gravel kicked off at the take-off and the catch.
 *
 * Placement is fitted to the real rock at mount: everything lives in each
 * chasm's local frame (terrainGeometry's CHASM_LAYOUT), and every moving
 * thing (rock trajectories with their bounces, ribbon paths including their
 * undulation, particle paths) is validated against mountainSdf so it stays
 * in open air. Rocks follow deterministic, precomputed per-event loops (no
 * physics engine, no per-frame allocation); everything else is animated on
 * the GPU from per-instance attributes.
 *
 * Activity windows: chasm 1 ≈ p 0.40–0.66, chasm 2 ≈ p 0.55–0.86, with
 * damped fades; each chasm's group is invisible (zero cost) outside them.
 * Nothing here touches React state.
 * ========================================================================== */

const { damp } = THREE.MathUtils;

/* --------------------------------------------------------------------------
 * Timeline
 * ------------------------------------------------------------------------ */

export const CHASM_FX_WINDOWS = {
  chasmOne: { inStart: 0.4, inEnd: 0.44, outStart: 0.62, outEnd: 0.66 },
  chasmTwo: { inStart: 0.55, inEnd: 0.6, outStart: 0.8, outEnd: 0.86 },
} as const;

/** The wind is fiercest while the climber is in the air over chasm 2. */
const LEAP_WIND = { inStart: 0.6, inEnd: 0.64, outStart: 0.7, outEnd: 0.76 } as const;

interface FxWindow {
  inStart: number;
  inEnd: number;
  outStart: number;
  outEnd: number;
}

function windowWeight(p: number, w: FxWindow): number {
  return smoothstep(w.inStart, w.inEnd, p) * (1 - smoothstep(w.outStart, w.outEnd, p));
}

/** Scroll-synchronised gravel kicks (progress, which chasm, burst slot). */
const KICKS = [
  { at: PATH_PHASES.ascentEnd, chasm: 1, slot: 0, source: ZONES.chasmOne.takeoff, toward: 1 },
  { at: PATH_PHASES.jumpOneEnd, chasm: 1, slot: 1, source: ZONES.chasmOne.landing, toward: -1 },
  { at: PATH_PHASES.climbOneEnd, chasm: 2, slot: 6, source: ZONES.chasmTwo.takeoff, toward: 1 },
  { at: PATH_PHASES.leapTwoEnd, chasm: 2, slot: 7, source: ZONES.chasmTwo.catch, toward: -1 },
] as const;

/* --------------------------------------------------------------------------
 * Chasm frames (xz plane): `a` along the chasm, `n` along the jump.
 * ------------------------------------------------------------------------ */

interface ChasmFrame {
  ox: number;
  oz: number;
  ax: number;
  az: number;
  nx: number;
  nz: number;
}

function frameFrom(layout: {
  origin: readonly [number, number];
  axis: readonly [number, number];
  across: readonly [number, number];
}): ChasmFrame {
  return {
    ox: layout.origin[0],
    oz: layout.origin[1],
    ax: layout.axis[0],
    az: layout.axis[1],
    nx: layout.across[0],
    nz: layout.across[1],
  };
}

const FRAME_ONE = frameFrom(CHASM_LAYOUT.chasmOne);
const FRAME_TWO = frameFrom(CHASM_LAYOUT.chasmTwo);

type Vec3 = [number, number, number];

function frameToWorld(f: ChasmFrame, a: number, n: number, y: number): Vec3 {
  return [f.ox + f.ax * a + f.nx * n, y, f.oz + f.az * a + f.nz * n];
}

function frameSpec(f: ChasmFrame): ChasmFrameSpec {
  return { originX: f.ox, originZ: f.oz, axisX: f.ax, axisZ: f.az };
}

/** Horizontal wind through the gorge: along the gorge and from the pyramid side toward the pillar. */
const WIND_TWO: Vec3 = (() => {
  const x = FRAME_TWO.ax - FRAME_TWO.nx;
  const z = FRAME_TWO.az - FRAME_TWO.nz;
  const l = Math.hypot(x, z);
  return [x / l, 0, z / l];
})();

/** Gentle breeze out of the cleft mouth. */
const WIND_ONE: Vec3 = [FRAME_ONE.ax, 0, FRAME_ONE.az];

/* --------------------------------------------------------------------------
 * Abyss mist sheets (chasm-local; deepest first = draw order).
 * Fitted to the carved rock: chasm 1 is a ~3-unit slot from y≈18 down to
 * y≈-6 that widens toward its south-east mouth; chasm 2 is a V-shaped gorge
 * (open n −4.5…3 at y 24, closing near y −4), a −2.5…6.5 along it.
 * ------------------------------------------------------------------------ */

type SheetRow = readonly [
  kind: 'layer' | 'veil',
  y: number,
  a: number,
  n: number,
  halfA: number,
  halfN: number,
  shape: number,
  depth: number,
  opacity: number,
  rank: number,
  speed: number,
];

const MIST_ONE_ROWS: readonly SheetRow[] = [
  ['layer', -5, 4.0, -0.3, 8.5, 3.0, 0.15, 1.0, 1.0, 0, 0.12],
  ['layer', -1, 2.5, -0.3, 6.8, 3.0, 0.15, 0.84, 0.95, 1, 0.18],
  ['layer', 3, 1.5, -0.2, 5.8, 2.9, 0.15, 0.68, 0.9, 2, 0.24],
  ['layer', 7, 0.3, -0.1, 4.6, 2.8, 0.15, 0.5, 0.85, 3, 0.3],
  ['veil', -6, 4.2, 0.0, 2.6, 0.55, 16, 0.9, 0.7, 5, 0.06],
  ['veil', 0, 1.0, -0.2, 2.0, 0.6, 14, 0.8, 0.75, 4, 0.07],
  ['layer', 10.5, -0.3, 0.0, 4.0, 2.7, 0.15, 0.32, 0.7, 6, 0.38],
  ['veil', 2, -1.6, 0.1, 1.9, 0.6, 13.5, 0.75, 0.7, 7, 0.08],
  ['layer', 13.5, -0.8, 0.0, 3.5, 2.5, 0.1, 0.16, 0.5, 8, 0.46],
  ['veil', 4, -0.3, 0.3, 1.6, 0.65, 10.5, 0.7, 0.55, 9, 0.09],
  // Mist breathing up out of the back of the cleft, behind the jump line.
  ['veil', 3, -2.3, 0.0, 2.0, 0.5, 18.5, 0.7, 0.5, 10, 0.07],
];

const MIST_TWO_ROWS: readonly SheetRow[] = [
  ['layer', 3, 1.8, -0.8, 6.0, 3.4, 0.15, 1.0, 1.0, 0, 0.12],
  ['layer', 8, 1.8, -0.9, 6.5, 4.0, 0.15, 0.86, 0.95, 1, 0.18],
  ['layer', 13, 1.8, -0.9, 7.0, 4.8, 0.15, 0.7, 0.9, 2, 0.24],
  ['layer', 18, 1.6, -0.8, 7.5, 5.8, 0.15, 0.52, 0.85, 3, 0.32],
  ['veil', 12, 0.5, 2.6, 3.2, 0.5, 20, 0.85, 0.75, 4, 0.06],
  ['veil', 14, 3.6, 3.4, 2.8, 0.5, 19, 0.85, 0.7, 5, 0.07],
  ['layer', 22.5, 1.6, -0.6, 7.8, 6.8, 0.15, 0.34, 0.75, 6, 0.42],
  ['veil', 4, 2.2, 0.4, 3.0, 0.55, 20, 0.95, 0.65, 7, 0.05],
  ['veil', 10, -1.0, 1.2, 2.6, 0.5, 18, 0.8, 0.65, 8, 0.08],
  ['layer', 26.5, 1.8, -0.4, 7.8, 7.2, 0.1, 0.18, 0.55, 9, 0.55],
  ['veil', 9, 4.6, -1.8, 2.4, 0.5, 18, 0.8, 0.6, 10, 0.07],
  ['veil', 11, 1.8, -2.6, 2.2, 0.5, 16, 0.8, 0.55, 11, 0.09],
];

/** Mist sheets that are always drawn, whatever the adaptive density. */
const MIST_CORE_SHEETS = 5;

function sheetsFrom(rows: readonly SheetRow[], seed: number): MistSheetSpec[] {
  const rand = chasmRandom(seed);
  return rows.map(([kind, y, a, n, halfA, halfN, shape, depth, opacity, rank, speed]) => ({
    kind,
    y,
    a,
    n,
    halfA,
    halfN,
    shape,
    depth,
    opacity,
    rank,
    speed,
    seed: rand(),
  }));
}

/* --------------------------------------------------------------------------
 * Signed-distance helpers (mountainSdf may overestimate distance by up to
 * its Lipschitz bound, so marching steps are divided by it).
 * ------------------------------------------------------------------------ */

export type SdfFn = (x: number, y: number, z: number) => number;

const SDF_LIPSCHITZ = 2.4;

function sdfNormal(sdf: SdfFn, p: Vec3, out: Vec3): Vec3 {
  const e = 0.15;
  const gx = sdf(p[0] + e, p[1], p[2]) - sdf(p[0] - e, p[1], p[2]);
  const gy = sdf(p[0], p[1] + e, p[2]) - sdf(p[0], p[1] - e, p[2]);
  const gz = sdf(p[0], p[1], p[2] + e) - sdf(p[0], p[1], p[2] - e);
  const l = Math.hypot(gx, gy, gz) || 1;
  out[0] = gx / l;
  out[1] = gy / l;
  out[2] = gz / l;
  return out;
}

interface WallHit {
  point: Vec3;
  normal: Vec3;
}

/** Marches from `origin` (in open air) along `dir` to the first rock surface. */
function findWall(sdf: SdfFn, origin: Vec3, dir: Vec3, maxDist: number): WallHit | null {
  if (sdf(origin[0], origin[1], origin[2]) < 0.4) return null;
  let t = 0;
  for (let i = 0; i < 64 && t < maxDist; i += 1) {
    const x = origin[0] + dir[0] * t;
    const y = origin[1] + dir[1] * t;
    const z = origin[2] + dir[2] * t;
    const d = sdf(x, y, z);
    if (d < 0.06) {
      const point: Vec3 = [x, y, z];
      return { point, normal: sdfNormal(sdf, point, [0, 0, 0]) };
    }
    t += Math.max(d / SDF_LIPSCHITZ, 0.06);
  }
  return null;
}

/** Whether a straight segment keeps `clearance` from the rock at `samples` points. */
function segmentClear(sdf: SdfFn, a: Vec3, b: Vec3, clearance: number, samples: number): boolean {
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    if (sdf(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t) < clearance) return false;
  }
  return true;
}

/* --------------------------------------------------------------------------
 * Falling rocks
 * ------------------------------------------------------------------------ */

const GRAVITY = 9.81;
/** Trajectory sample spacing (s). */
export const ROCK_TRAJ_DT = 1 / 20;
/** Seconds a rock teeters / slides out of the wall before it falls. */
const ROCK_TEETER = 0.3;
/** Longest fall (s); also the minimum gap between two events of one channel. */
const ROCK_MAX_FALL = 4.4;
const ROCK_EVENT_SPAN = ROCK_TEETER + ROCK_MAX_FALL + 0.1;
/** Rocks vanish into the gorge's mist layers (y 13–22) below this height. */
const ROCK_KILL_Y = 14;
const ROCK_MAX_BOUNCES = 5;
const ROCK_RESTITUTION = 0.32;

export const ROCK_CLASSES = [
  { name: 'large', radius: 0.6, detail: 1, rough: 0.3, seed: 11.3 },
  { name: 'medium', radius: 0.3, detail: 1, rough: 0.28, seed: 23.7 },
  { name: 'small', radius: 0.12, detail: 0, rough: 0.22, seed: 37.1 },
] as const;

/** Small fragments per rock event. */
export const ROCK_FRAGMENTS = 3;
/** Rock event channels allocated (drawn: adaptiveQuality.countFor). */
export const ROCK_CHANNELS = 6;
const ROCK_VARIANTS_PER_CHANNEL = 3;

export interface RockTrajectory {
  /** x, y, z, qx, qy, qz, qw per sample, ROCK_TRAJ_DT apart. */
  samples: Float32Array;
  count: number;
  /** Seconds of fall covered by the samples. */
  duration: number;
  /** Non-uniform base scale of this rock. */
  scale: Vec3;
  /** Collision radius used for the simulation. */
  radius: number;
  bounces: number;
}

export interface RockVariant {
  /** Where the rock tore loose and the outward wall normal there. */
  source: Vec3;
  normal: Vec3;
  /** 0 = large main block (with a medium fragment), 1 = medium main block. */
  mainClass: 0 | 1;
  main: RockTrajectory;
  secondary: RockTrajectory | null;
  fragments: RockTrajectory[];
}

export interface RockChannel {
  period: number;
  phase: number;
  variants: RockVariant[];
}

type Rand = () => number;

function randomUnit(rand: Rand, out: Vec3): Vec3 {
  const u = rand() * 2 - 1;
  const t = rand() * Math.PI * 2;
  const r = Math.sqrt(1 - u * u);
  out[0] = r * Math.cos(t);
  out[1] = u;
  out[2] = r * Math.sin(t);
  return out;
}

const _q = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _axis = new THREE.Vector3();

/** Integrates one tumbling rock (semi-implicit Euler, SDF collisions with bounces). */
function simulateRock(
  sdf: SdfFn,
  start: Vec3,
  velocity: Vec3,
  radius: number,
  spin: number,
  scale: Vec3,
  rand: Rand,
): RockTrajectory | null {
  const maxSteps = Math.ceil(ROCK_MAX_FALL / ROCK_TRAJ_DT) + 1;
  const samples = new Float32Array(maxSteps * 7);
  const p: Vec3 = [start[0], start[1], start[2]];
  const v: Vec3 = [velocity[0], velocity[1], velocity[2]];
  const n: Vec3 = [0, 0, 0];
  const axis: Vec3 = randomUnit(rand, [0, 0, 0]);
  let omega = spin;
  _q.setFromAxisAngle(_axis.set(...randomUnit(rand, [0, 0, 0])), rand() * Math.PI * 2);
  const d0 = sdf(p[0], p[1], p[2]);
  if (d0 < radius * 0.85) return null;
  let safe = d0 / SDF_LIPSCHITZ - radius;
  let bounces = 0;
  let count = 0;
  for (let step = 0; step < maxSteps; step += 1) {
    const o = count * 7;
    samples[o] = p[0];
    samples[o + 1] = p[1];
    samples[o + 2] = p[2];
    samples[o + 3] = _q.x;
    samples[o + 4] = _q.y;
    samples[o + 5] = _q.z;
    samples[o + 6] = _q.w;
    count += 1;
    if (p[1] < ROCK_KILL_Y) break;

    v[1] -= GRAVITY * ROCK_TRAJ_DT;
    p[0] += v[0] * ROCK_TRAJ_DT;
    p[1] += v[1] * ROCK_TRAJ_DT;
    p[2] += v[2] * ROCK_TRAJ_DT;
    safe -= Math.hypot(v[0], v[1], v[2]) * ROCK_TRAJ_DT;
    if (safe < 0.25) {
      const d = sdf(p[0], p[1], p[2]);
      safe = d / SDF_LIPSCHITZ - radius;
      if (d < radius) {
        // Bounce off the wall: push out, reflect the normal component, scrub the tangential one.
        sdfNormal(sdf, p, n);
        const push = radius - d + 0.03;
        p[0] += n[0] * push;
        p[1] += n[1] * push;
        p[2] += n[2] * push;
        const vn = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
        if (vn < 0) {
          const tx = v[0] - n[0] * vn;
          const ty = v[1] - n[1] * vn;
          const tz = v[2] - n[2] * vn;
          v[0] = tx * 0.72 - n[0] * vn * ROCK_RESTITUTION;
          v[1] = ty * 0.72 - n[1] * vn * ROCK_RESTITUTION;
          v[2] = tz * 0.72 - n[2] * vn * ROCK_RESTITUTION;
        }
        bounces += 1;
        randomUnit(rand, axis);
        omega *= 1.25;
        safe = 0.02;
        // Rocks that come to rest or keep grinding along the wall are rejected.
        if (bounces > ROCK_MAX_BOUNCES || Math.hypot(v[0], v[1], v[2]) < 0.8) return null;
      }
    }
    _dq.setFromAxisAngle(_axis.set(axis[0], axis[1], axis[2]), omega * ROCK_TRAJ_DT);
    _q.premultiply(_dq);
  }
  if (p[1] >= ROCK_KILL_Y) return null;
  return {
    samples: samples.slice(0, count * 7),
    count,
    duration: (count - 1) * ROCK_TRAJ_DT,
    scale,
    radius,
    bounces,
  };
}

type WallKind = 'catch' | 'pillar' | 'east' | 'west';

/** Spawn rays for each gorge wall in the chasm-2 frame: (a range, y range, march direction). */
const ROCK_WALLS: Readonly<Record<WallKind, { a: [number, number]; y: [number, number]; n0: number; dir: 'n+' | 'n-' | 'a+' | 'a-' }>> = {
  catch: { a: [-1.5, 5.5], y: [33, 46], n0: 0.5, dir: 'n+' },
  pillar: { a: [-1.0, 5.0], y: [24, 31.5], n0: 0.5, dir: 'n-' },
  east: { a: [1.5, 1.5], y: [24, 34], n0: 0, dir: 'a+' },
  west: { a: [1.5, 1.5], y: [24, 31], n0: 0.5, dir: 'a-' },
};

/** Which wall each channel's rocks break off (the catch wall faces every leap camera). */
const CHANNEL_WALLS: readonly WallKind[] = ['catch', 'pillar', 'catch', 'east', 'catch', 'west'];

function rockScale(rand: Rand): Vec3 {
  return [0.85 + rand() * 0.35, 0.62 + rand() * 0.3, 0.8 + rand() * 0.3];
}

function* buildRockVariant(sdf: SdfFn, wall: WallKind, mainClass: 0 | 1, rand: Rand): Generator<void, RockVariant | null, void> {
  const spec = ROCK_WALLS[wall];
  const f = FRAME_TWO;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    if (attempt > 0) yield;
    const a = spec.a[0] + (spec.a[1] - spec.a[0]) * rand() + (spec.dir[0] === 'a' ? (rand() - 0.5) * 4 : 0);
    const n = spec.dir[0] === 'a' ? (rand() - 0.5) * 5 : spec.n0;
    const y = spec.y[0] + (spec.y[1] - spec.y[0]) * rand();
    const origin = frameToWorld(f, a, n, y);
    const sign = spec.dir[1] === '+' ? 1 : -1;
    const dir: Vec3 = spec.dir[0] === 'n' ? [f.nx * sign, 0, f.nz * sign] : [f.ax * sign, 0, f.az * sign];
    // Aim slightly up or down so sources spread over ledges and overhangs.
    dir[1] = (rand() - 0.5) * 0.5;
    const l = Math.hypot(dir[0], dir[1], dir[2]);
    dir[0] /= l;
    dir[1] /= l;
    dir[2] /= l;
    const hit = findWall(sdf, origin, dir, 13);
    if (!hit) continue;
    const nrm = hit.normal;
    // Steep faces only (not flat tops), facing back into the gorge.
    if (nrm[1] > 0.55 || nrm[0] * dir[0] + nrm[2] * dir[2] > -0.25) continue;
    const mainR = ROCK_CLASSES[mainClass].radius;
    const mainScale = rockScale(rand);
    const mainRadius = mainR * Math.max(...mainScale);
    const source: Vec3 = [
      hit.point[0] + nrm[0] * (mainRadius + 0.05),
      hit.point[1] + nrm[1] * (mainRadius + 0.05),
      hit.point[2] + nrm[2] * (mainRadius + 0.05),
    ];
    const push = 0.9 + rand() * 1.4;
    const v0: Vec3 = [
      nrm[0] * push + WIND_TWO[0] * 0.5 + (rand() - 0.5) * 0.6,
      0.4 + rand() * 1.1,
      nrm[2] * push + WIND_TWO[2] * 0.5 + (rand() - 0.5) * 0.6,
    ];
    const main = simulateRock(sdf, source, v0, mainRadius, (mainClass === 0 ? 1.4 : 2.6) + rand() * 1.6, mainScale, rand);
    if (!main) continue;
    yield;
    const fragment = function* (cls: 1 | 2, spread: number): Generator<void, RockTrajectory | null, void> {
      for (let k = 0; k < 4; k += 1) {
        if (k > 0) yield;
        const scale = rockScale(rand);
        const r = ROCK_CLASSES[cls].radius * Math.max(...scale);
        const off: Vec3 = randomUnit(rand, [0, 0, 0]);
        const start: Vec3 = [
          source[0] + off[0] * mainRadius * 0.6 + nrm[0] * 0.1,
          source[1] + off[1] * mainRadius * 0.6,
          source[2] + off[2] * mainRadius * 0.6 + nrm[2] * 0.1,
        ];
        const vel: Vec3 = [
          v0[0] + (rand() - 0.5) * spread + nrm[0] * 0.5,
          v0[1] + rand() * spread * 0.6,
          v0[2] + (rand() - 0.5) * spread + nrm[2] * 0.5,
        ];
        const t = simulateRock(sdf, start, vel, r, 4 + rand() * 5, scale, rand);
        if (t) return t;
      }
      return null;
    };
    const secondary = mainClass === 0 ? yield* fragment(1, 1.4) : null;
    const fragments: RockTrajectory[] = [];
    for (let k = 0; k < ROCK_FRAGMENTS; k += 1) {
      yield;
      const t = yield* fragment(2, 2.2);
      if (t) fragments.push(t);
    }
    return { source, normal: [nrm[0], nrm[1], nrm[2]], mainClass, main, secondary, fragments };
  }
  return null;
}

function* buildRockChannels(sdf: SdfFn, rand: Rand): Generator<void, RockChannel[], void> {
  const channels: RockChannel[] = [];
  for (let c = 0; c < ROCK_CHANNELS; c += 1) {
    const variants: RockVariant[] = [];
    for (let v = 0; v < ROCK_VARIANTS_PER_CHANNEL; v += 1) {
      const mainClass: 0 | 1 = (c + v) % 2 === 0 ? 0 : 1;
      const variant = yield* buildRockVariant(sdf, CHANNEL_WALLS[c % CHANNEL_WALLS.length], mainClass, rand);
      if (variant) variants.push(variant);
    }
    if (variants.length === 0) {
      const fallback = yield* buildRockVariant(sdf, 'catch', 1, rand);
      if (fallback) variants.push(fallback);
    }
    if (variants.length > 0) {
      channels.push({ period: 6.6 + rand() * 3.2, phase: (c + rand() * 0.5) / ROCK_CHANNELS, variants });
    }
  }
  return channels;
}

/* --------------------------------------------------------------------------
 * Wind ribbons (chasm 2)
 * ------------------------------------------------------------------------ */

export const WIND_RIBBON_MAX = 36;

/** Climber's body centre along the chasm-2 leap (ribbons keep clear of it). */
function leapBodySamples(): Vec3[] {
  const out: Vec3[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i <= 24; i += 1) {
    const p = PATH_PHASES.climbOneEnd + ((PATH_PHASES.leapTwoEnd - PATH_PHASES.climbOneEnd) * i) / 24;
    protagonistPositionAt(p, v);
    out.push([v.x, v.y + 0.9, v.z]);
  }
  return out;
}

function bezierPoint(r: WindRibbonSpec, s: number, out: Vec3): Vec3 {
  const u = 1 - s;
  for (let k = 0; k < 3; k += 1) out[k] = u * u * r.p0[k] + 2 * u * s * r.p1[k] + s * s * r.p2[k];
  return out;
}

/** Ribbons eddying inside the upper gorge (the rest sweep across above it). */
const DEEP_RIBBONS = 8;

function* buildWindRibbons(sdf: SdfFn, rand: Rand): Generator<void, WindRibbonSpec[], void> {
  const f = FRAME_TWO;
  const body = leapBodySamples();
  const ribbons: WindRibbonSpec[] = [];
  const pt: Vec3 = [0, 0, 0];
  let deepCount = 0;
  for (let attempt = 0; attempt < 520 && ribbons.length < WIND_RIBBON_MAX; attempt += 1) {
    if ((attempt & 1) === 1) yield;
    // Deep ribbons run down the gorge's length and climb out over its east end wall.
    const deep = deepCount < DEEP_RIBBONS && (attempt & 1) === 0;
    let p0: Vec3;
    let p1: Vec3;
    let p2: Vec3;
    let wide = false;
    if (deep) {
      // Eddies inside the upper gorge, along the wind; their ends fade in mid-air.
      const c = frameToWorld(f, 2 + (rand() - 0.5) * 3, -0.5 + (rand() - 0.5) * 3, 25 + rand() * 6);
      const yaw = (rand() - 0.5) * 0.9;
      const dx = WIND_TWO[0] * Math.cos(yaw) - WIND_TWO[2] * Math.sin(yaw);
      const dz = WIND_TWO[0] * Math.sin(yaw) + WIND_TWO[2] * Math.cos(yaw);
      const h = (8 + rand() * 4) / 2;
      const drop = (rand() - 0.3) * 2;
      p0 = [c[0] - dx * h, c[1] + drop, c[2] - dz * h];
      p1 = [c[0], c[1] - 0.5 - rand(), c[2]];
      p2 = [c[0] + dx * h, c[1] - drop, c[2] + dz * h];
    } else {
      const a = -1.5 + rand() * 7.5;
      const n = -5.5 + rand() * 11.5;
      const y = 32 + rand() * 17;
      const c = frameToWorld(f, a, n, y);
      const yaw = (rand() - 0.5) * 0.6;
      const pitch = (rand() - 0.5) * 0.12;
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const dx = WIND_TWO[0] * cy - WIND_TWO[2] * sy;
      const dz = WIND_TWO[0] * sy + WIND_TWO[2] * cy;
      const h = (18 + rand() * 16) / 2;
      const sag = (rand() - 0.6) * 2.6;
      const bend = (rand() - 0.5) * 3.2;
      wide = rand() < 0.2;
      p0 = [c[0] - dx * h, c[1] - pitch * h, c[2] - dz * h];
      p1 = [c[0] - dz * bend, c[1] + sag, c[2] + dx * bend];
      p2 = [c[0] + dx * h, c[1] + pitch * h, c[2] + dz * h];
    }
    const spec: WindRibbonSpec = {
      p0,
      p1,
      p2,
      halfWidth: wide ? 0.32 + rand() * 0.3 : 0.05 + rand() * 0.11,
      amplitude: deep ? 0.15 + rand() * 0.25 : 0.2 + rand() * 0.45,
      wavelength: 8 + rand() * 9,
      flowSpeed: 15 + rand() * 11,
      period: 1.5 + rand() * 1.7,
      phase: rand(),
      opacity: wide ? 0.16 + rand() * 0.12 : 0.32 + rand() * 0.34,
      seed: rand(),
      rank: 0,
    };
    const excursion = windRibbonMaxExcursion(spec);
    let ok = true;
    for (let i = 0; i <= 20 && ok; i += 1) {
      bezierPoint(spec, i / 20, pt);
      if (sdf(pt[0], pt[1], pt[2]) < excursion + 0.6) ok = false;
      for (let b = 0; b < body.length && ok; b += 1) {
        const q = body[b];
        if (Math.hypot(pt[0] - q[0], pt[1] - q[1], pt[2] - q[2]) < excursion + 0.9) ok = false;
      }
    }
    if (!ok) continue;
    if (deep) deepCount += 1;
    spec.rank = ribbons.length;
    ribbons.push(spec);
  }
  return ribbons;
}

/* --------------------------------------------------------------------------
 * Particles
 * ------------------------------------------------------------------------ */

const DUST_PER_BURST = 6;
const GRAVEL_PER_BURST = 13;

function particle(
  kind: ParticleKind,
  pos: Vec3,
  vel: Vec3,
  period: number,
  phase: number,
  size: number,
  swirl: number,
  slot: number,
): ChasmParticleSpec {
  return {
    kind,
    x: pos[0],
    y: pos[1],
    z: pos[2],
    vx: vel[0],
    vy: vel[1],
    vz: vel[2],
    period,
    phase,
    size,
    swirl,
    slot,
    rank: 0,
  };
}

interface AmbientRecipe {
  kind: ParticleKind;
  count: number;
  /** Returns a candidate start, velocity, period, size and swirl, or null. */
  make: (rand: Rand) => { start: Vec3; vel: Vec3; period: number; size: number; swirl: number } | null;
}

function* buildAmbient(
  sdf: SdfFn,
  recipes: readonly AmbientRecipe[],
  rand: Rand,
  out: ChasmParticleSpec[],
): Generator<void, void, void> {
  for (const r of recipes) {
    let made = 0;
    for (let attempt = 0; attempt < r.count * 5 && made < r.count; attempt += 1) {
      if ((attempt & 3) === 3) yield;
      const c = r.make(rand);
      if (!c) continue;
      const end: Vec3 = [
        c.start[0] + c.vel[0] * c.period,
        c.start[1] + c.vel[1] * c.period,
        c.start[2] + c.vel[2] * c.period,
      ];
      const length = Math.hypot(end[0] - c.start[0], end[1] - c.start[1], end[2] - c.start[2]);
      const clearance = c.swirl * 1.45 + c.size + 0.25;
      if (!segmentClear(sdf, c.start, end, clearance, Math.max(3, Math.ceil(length / Math.max(0.8, clearance * 1.5))))) continue;
      out.push(particle(r.kind, c.start, c.vel, c.period, rand(), c.size, c.swirl, 0));
      made += 1;
    }
  }
}

function buildBursts(slots: readonly number[], rand: Rand, out: ChasmParticleSpec[]): void {
  const u: Vec3 = [0, 0, 0];
  for (const slot of slots) {
    for (let i = 0; i < DUST_PER_BURST; i += 1) {
      randomUnit(rand, u);
      const r = Math.cbrt(rand());
      out.push(
        particle(
          PARTICLE_KIND.dust,
          [u[0] * r, u[1] * r * 0.7, u[2] * r],
          [(rand() - 0.5) * 1.1, (rand() - 0.3) * 0.7, (rand() - 0.5) * 1.1],
          1,
          rand(),
          0.65 + rand() * 0.6,
          0,
          slot,
        ),
      );
    }
    for (let i = 0; i < GRAVEL_PER_BURST; i += 1) {
      randomUnit(rand, u);
      out.push(
        particle(
          PARTICLE_KIND.gravel,
          [u[0] * 0.6, u[1] * 0.45, u[2] * 0.6],
          [(rand() - 0.5) * 2.4, rand() * 1.6, (rand() - 0.5) * 2.4],
          1,
          rand(),
          0.028 + rand() * 0.05,
          0.9 + rand() * 1.9,
          slot,
        ),
      );
    }
  }
}

/** Deterministic shuffle of the ranks so lowering the density thins every kind evenly. */
function assignRanks(particles: ChasmParticleSpec[], rand: Rand): void {
  const order = particles.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  order.forEach((index, rank) => {
    particles[index].rank = rank;
  });
}

function* buildParticlesOne(sdf: SdfFn, rand: Rand): Generator<void, ChasmParticleSpec[], void> {
  const f = FRAME_ONE;
  const out: ChasmParticleSpec[] = [];
  const up = (a: number, n: number, y: number): Vec3 => frameToWorld(f, a, n, y);
  yield* buildAmbient(
    sdf,
    [
      {
        kind: PARTICLE_KIND.puff,
        count: 22,
        make: (r) => {
          const start = up(-2 + r() * 9, (r() - 0.5) * 2, -2 + r() * 9);
          const rise = 0.8 + r() * 0.7;
          const drift = 0.2 + r() * 0.3;
          return {
            start,
            vel: [WIND_ONE[0] * drift, rise, WIND_ONE[2] * drift],
            period: 6 + r() * 4,
            size: 1.1 + r() * 1.3,
            swirl: 0.25,
          };
        },
      },
      {
        kind: PARTICLE_KIND.mote,
        count: 56,
        make: (r) => {
          const start = up(-2.5 + r() * 11, (r() - 0.5) * 2.6, 8 + r() * 20);
          const drift = 0.15 + r() * 0.3;
          return {
            start,
            vel: [WIND_ONE[0] * drift, 0.12 + r() * 0.2, WIND_ONE[2] * drift],
            period: 7 + r() * 5,
            size: 0.022 + r() * 0.022,
            swirl: 0.35 + r() * 0.45,
          };
        },
      },
      {
        kind: PARTICLE_KIND.puff,
        count: 18,
        make: (r) => {
          // Spindrift torn off the ledge lips by the breeze out of the cleft.
          const side = r() < 0.5 ? -1 : 1;
          const origin = up(-1.5 + r() * 5, 0, side < 0 ? 15.5 + r() * 3 : 18 + r() * 5);
          const hit = findWall(sdf, origin, [f.nx * side, 0, f.nz * side], 6);
          if (!hit) return null;
          const size = 0.35 + r() * 0.5;
          const off = size + 0.6 + r() * 0.4;
          const speed = 1.3 + r() * 1.4;
          return {
            start: [hit.point[0] + hit.normal[0] * off, hit.point[1] + 0.5 + r() * 0.6, hit.point[2] + hit.normal[2] * off],
            vel: [WIND_ONE[0] * speed + hit.normal[0] * 0.3, 0.35 + r() * 0.5, WIND_ONE[2] * speed + hit.normal[2] * 0.3],
            period: 2.2 + r() * 1.6,
            size,
            swirl: 0.15,
          };
        },
      },
      {
        kind: PARTICLE_KIND.windSnow,
        count: 64,
        make: (r) => {
          const speed = 3.5 + r() * 4;
          const travel = 7 + r() * 8;
          const c = up(-1 + r() * 9, (r() - 0.5) * 3.2, 14 + r() * 15);
          const yaw = (r() - 0.5) * 0.5;
          const dx = WIND_ONE[0] * Math.cos(yaw) - WIND_ONE[2] * Math.sin(yaw);
          const dz = WIND_ONE[0] * Math.sin(yaw) + WIND_ONE[2] * Math.cos(yaw);
          return {
            start: [c[0] - dx * travel * 0.5, c[1], c[2] - dz * travel * 0.5],
            vel: [dx * speed, (r() - 0.5) * 0.6, dz * speed],
            period: travel / speed,
            size: 0.02 + r() * 0.022,
            swirl: 0.12 + r() * 0.2,
          };
        },
      },
    ],
    rand,
    out,
  );
  buildBursts([0, 1], rand, out);
  assignRanks(out, rand);
  return out;
}

function* buildParticlesTwo(sdf: SdfFn, rand: Rand, rockSlots: number): Generator<void, ChasmParticleSpec[], void> {
  const f = FRAME_TWO;
  const out: ChasmParticleSpec[] = [];
  const at = (a: number, n: number, y: number): Vec3 => frameToWorld(f, a, n, y);
  yield* buildAmbient(
    sdf,
    [
      {
        kind: PARTICLE_KIND.windSnow,
        count: 110,
        make: (r) => {
          const speed = 9 + r() * 8;
          const travel = 14 + r() * 12;
          const c = at(-2 + r() * 8.5, -5 + r() * 10.5, 27 + r() * 22);
          const yaw = (r() - 0.5) * 0.5;
          const dx = WIND_TWO[0] * Math.cos(yaw) - WIND_TWO[2] * Math.sin(yaw);
          const dz = WIND_TWO[0] * Math.sin(yaw) + WIND_TWO[2] * Math.cos(yaw);
          return {
            start: [c[0] - dx * travel * 0.5, c[1], c[2] - dz * travel * 0.5],
            vel: [dx * speed, (r() - 0.45) * 1.4, dz * speed],
            period: travel / speed,
            size: 0.022 + r() * 0.026,
            swirl: 0.12 + r() * 0.25,
          };
        },
      },
      {
        kind: PARTICLE_KIND.puff,
        count: 26,
        make: (r) => {
          // Spindrift torn off the gorge edges.
          const lip = r() < 0.5;
          const origin = at(-1 + r() * 6, 0.5, lip ? 30.5 + r() * 3 : 37 + r() * 9);
          const sign = lip ? -1 : 1;
          const hit = findWall(sdf, origin, [f.nx * sign, 0, f.nz * sign], 10);
          if (!hit) return null;
          const size = 0.35 + r() * 0.5;
          const s = size + 0.6 + r() * 0.4;
          const start: Vec3 = [hit.point[0] + hit.normal[0] * s, hit.point[1] + 0.4, hit.point[2] + hit.normal[2] * s];
          const speed = 2.4 + r() * 1.8;
          return {
            start,
            vel: [WIND_TWO[0] * speed + hit.normal[0] * 0.6, 0.3 + r() * 0.5, WIND_TWO[2] * speed + hit.normal[2] * 0.6],
            period: 1.1 + r() * 0.9,
            size,
            swirl: 0.12,
          };
        },
      },
      {
        kind: PARTICLE_KIND.puff,
        count: 14,
        make: (r) => {
          // Mist puffs welling up out of the abyss.
          const start = at(-0.5 + r() * 5.5, -2.2 + r() * 4.2, 17 + r() * 7);
          return {
            start,
            vel: [WIND_TWO[0] * 0.25, 0.7 + r() * 0.6, WIND_TWO[2] * 0.25],
            period: 5 + r() * 3,
            size: 0.8 + r() * 0.9,
            swirl: 0.2,
          };
        },
      },
      {
        kind: PARTICLE_KIND.mote,
        count: 60,
        make: (r) => {
          const start = at(-1.5 + r() * 7.5, -4 + r() * 8.5, 19 + r() * 27);
          const drift = 0.35 + r() * 0.5;
          return {
            start,
            vel: [WIND_TWO[0] * drift, 0.12 + r() * 0.25, WIND_TWO[2] * drift],
            period: 6 + r() * 5,
            size: 0.022 + r() * 0.022,
            swirl: 0.45 + r() * 0.55,
          };
        },
      },
    ],
    rand,
    out,
  );
  const slots: number[] = [];
  for (let s = 0; s < rockSlots; s += 1) slots.push(s);
  for (const k of KICKS) if (k.chasm === 2) slots.push(k.slot);
  buildBursts(slots, rand, out);
  assignRanks(out, rand);
  return out;
}

/* --------------------------------------------------------------------------
 * The full layout (pure: deterministic, no GPU objects; testable in Node)
 * ------------------------------------------------------------------------ */

export interface ChasmFxLayout {
  mistOne: MistSheetSpec[];
  mistTwo: MistSheetSpec[];
  particlesOne: ChasmParticleSpec[];
  particlesTwo: ChasmParticleSpec[];
  ribbons: WindRibbonSpec[];
  rockChannels: RockChannel[];
  boundsOne: THREE.Sphere;
  boundsTwo: THREE.Sphere;
  /** Number of signed-distance evaluations the layout needed. */
  sdfCalls: number;
}

/**
 * The layout as a resumable job: each `next()` does a small slice of the work
 * (one rock variant, a few ribbon or particle candidates), so the component
 * can spread it over frames long before the chasms come into play.
 */
export function* chasmFxLayoutSteps(sdf: SdfFn = mountainSdf): Generator<void, ChasmFxLayout, void> {
  let calls = 0;
  const counted: SdfFn = (x, y, z) => {
    calls += 1;
    return sdf(x, y, z);
  };
  const rand = chasmRandom(0x9e3779b1);
  const rockChannels = yield* buildRockChannels(counted, chasmRandom(0x51ed270b));
  const ribbons = yield* buildWindRibbons(counted, chasmRandom(0x2f6b4d19));
  const particlesOne = yield* buildParticlesOne(counted, chasmRandom(0x6a09e667));
  const particlesTwo = yield* buildParticlesTwo(counted, chasmRandom(0xbb67ae85), ROCK_CHANNELS);
  const c1 = frameToWorld(FRAME_ONE, 3, 0, 6);
  const c2 = frameToWorld(FRAME_TWO, 1.5, 0.5, 26);
  return {
    mistOne: sheetsFrom(MIST_ONE_ROWS, Math.floor(rand() * 1e9)),
    mistTwo: sheetsFrom(MIST_TWO_ROWS, Math.floor(rand() * 1e9)),
    particlesOne,
    particlesTwo,
    ribbons,
    rockChannels,
    boundsOne: new THREE.Sphere(new THREE.Vector3(...c1), 28),
    boundsTwo: new THREE.Sphere(new THREE.Vector3(...c2), 34),
    sdfCalls: calls,
  };
}

/** Runs the whole layout job synchronously (tests, tools). */
export function buildChasmFxLayout(sdf: SdfFn = mountainSdf): ChasmFxLayout {
  const steps = chasmFxLayoutSteps(sdf);
  let r = steps.next();
  while (!r.done) r = steps.next();
  return r.value;
}

/* --------------------------------------------------------------------------
 * GPU resources
 * ------------------------------------------------------------------------ */

/** Low-poly broken granite block: displaced icosahedron with a couple of fracture planes. */
function createRockGeometry(radius: number, detail: number, rough: number, seed: number): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(1, detail);
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const rand = chasmRandom(Math.floor(seed * 1000));
  const cuts: Vec3[] = [randomUnit(rand, [0, 0, 0]), randomUnit(rand, [0, 0, 0])];
  const cutDist = [0.62 + rand() * 0.15, 0.7 + rand() * 0.15];
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const l = Math.hypot(x, y, z) || 1;
    const ux = x / l;
    const uy = y / l;
    const uz = z / l;
    let r = 1 + rough * (noise3(ux * 1.7 + seed, uy * 1.7 - seed, uz * 1.7 + seed * 0.5) + 0.5 * noise3(ux * 3.9 - seed, uy * 3.9, uz * 3.9 + seed));
    for (let k = 0; k < cuts.length; k += 1) {
      const c = cuts[k];
      const d = ux * c[0] + uy * c[1] + uz * c[2];
      if (d > 0.05) r = Math.min(r, cutDist[k] / d);
    }
    pos.setXYZ(i, ux * r * radius, uy * r * radius, uz * r * radius);
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

type RockInstancedMesh = THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

interface RockMeshes {
  meshes: [RockInstancedMesh, RockInstancedMesh, RockInstancedMesh];
  geometries: THREE.BufferGeometry[];
  material: THREE.MeshStandardMaterial;
  /** Static per-slot tint (granite variation) per mesh. */
  tints: [Float32Array, Float32Array, Float32Array];
}

function createRockMeshes(bounds: THREE.Sphere): RockMeshes {
  const material = new THREE.MeshStandardMaterial({
    name: 'ChasmRock',
    color: 0xffffff,
    roughness: 0.93,
    metalness: 0,
    flatShading: true,
  });
  const capacities = [ROCK_CHANNELS, ROCK_CHANNELS, ROCK_CHANNELS * ROCK_FRAGMENTS];
  const geometries = ROCK_CLASSES.map((c) => createRockGeometry(c.radius, c.detail, c.rough, c.seed));
  const granite = new THREE.Color(PALETTE.granite);
  const dark = new THREE.Color(PALETTE.graniteDark);
  const rand = chasmRandom(0x3c6ef372);
  const tints = capacities.map((cap) => {
    const t = new Float32Array(cap * 3);
    const c = new THREE.Color();
    for (let i = 0; i < cap; i += 1) {
      c.copy(dark).lerp(granite, 0.35 + rand() * 0.65).multiplyScalar(0.9 + rand() * 0.35);
      t[i * 3] = c.r;
      t[i * 3 + 1] = c.g;
      t[i * 3 + 2] = c.b;
    }
    return t;
  }) as [Float32Array, Float32Array, Float32Array];
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const black = new THREE.Color(0, 0, 0);
  const make = (i: number): RockInstancedMesh => {
    const mesh = new THREE.InstancedMesh(geometries[i], material, capacities[i]);
    mesh.name = `chasm-rocks-${ROCK_CLASSES[i].name}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let k = 0; k < capacities[i]; k += 1) {
      mesh.setMatrixAt(k, zero);
      mesh.setColorAt(k, black);
    }
    mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.boundingSphere = bounds.clone();
    mesh.count = 0;
    return mesh;
  };
  const meshes: [RockInstancedMesh, RockInstancedMesh, RockInstancedMesh] = [make(0), make(1), make(2)];
  return { meshes, geometries, material, tints };
}

const RIBBON_SEGMENTS: Readonly<Record<GpuTier, number>> = { 0: 24, 1: 36, 2: 52, 3: 64 };

interface ChasmFx {
  root: THREE.Group;
  groupOne: THREE.Group;
  groupTwo: THREE.Group;
  layout: ChasmFxLayout;
  noise: THREE.DataTexture;
  mistOne: AbyssMistMaterial;
  mistTwo: AbyssMistMaterial;
  particlesOne: ChasmParticleMaterial;
  particlesTwo: ChasmParticleMaterial;
  ribbons: WindRibbonMaterial;
  rocks: RockMeshes;
  geometries: THREE.BufferGeometry[];
  dispose: () => void;
}

function createChasmFx(tier: GpuTier, layout: ChasmFxLayout): ChasmFx {
  const quality = chasmFxQualityFor(tier);
  const noise = createChasmNoiseTexture();
  const sun = SUN_DIRECTION.clone().normalize();

  const mistOne = createAbyssMistMaterial(noise, quality, { top: '#b3c1d8', deep: '#34405c', lit: '#f0c49b' }, sun);
  const mistTwo = createAbyssMistMaterial(noise, quality, { top: '#bccadf', deep: '#3a4764', lit: PALETTE.cloudLining }, sun);
  const particleColors = { snow: '#e6eef8', dust: '#8d8884', gravel: '#3b3f46', sun: PALETTE.sun };
  const windOne = new THREE.Vector3(...WIND_ONE).multiplyScalar(1.2);
  const windTwo = new THREE.Vector3(...WIND_TWO).multiplyScalar(3.2);
  const particlesOne = createChasmParticleMaterial(noise, particleColors, sun, windOne);
  const particlesTwo = createChasmParticleMaterial(noise, particleColors, sun, windTwo);
  const ribbons = createWindRibbonMaterial(noise, { lit: '#e8f0fa', shadow: '#9aabc6', sun: PALETTE.cloudLining }, sun);

  const mistOneGeometry = createAbyssMistGeometry(frameSpec(FRAME_ONE), layout.mistOne, layout.boundsOne);
  const mistTwoGeometry = createAbyssMistGeometry(frameSpec(FRAME_TWO), layout.mistTwo, layout.boundsTwo);
  const particlesOneGeometry = createChasmParticleGeometry(layout.particlesOne, layout.boundsOne);
  const particlesTwoGeometry = createChasmParticleGeometry(layout.particlesTwo, layout.boundsTwo);
  const ribbonGeometry = createWindRibbonGeometry(layout.ribbons, RIBBON_SEGMENTS[tier], layout.boundsTwo);
  const rocks = createRockMeshes(layout.boundsTwo);

  const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material, name: string, order: number): THREE.Mesh => {
    const m = new THREE.Mesh(geometry, material);
    m.name = name;
    m.renderOrder = order;
    m.matrixAutoUpdate = false;
    m.castShadow = false;
    m.receiveShadow = false;
    return m;
  };

  const groupOne = new THREE.Group();
  groupOne.name = 'chasm-1-fx';
  groupOne.add(
    mesh(mistOneGeometry, mistOne.material, 'chasm-1-mist', 2),
    mesh(particlesOneGeometry, particlesOne.material, 'chasm-1-particles', 3),
  );
  groupOne.visible = false;

  const groupTwo = new THREE.Group();
  groupTwo.name = 'chasm-2-fx';
  groupTwo.add(
    ...rocks.meshes,
    mesh(mistTwoGeometry, mistTwo.material, 'chasm-2-mist', 2),
    mesh(particlesTwoGeometry, particlesTwo.material, 'chasm-2-particles', 3),
    mesh(ribbonGeometry, ribbons.material, 'chasm-2-wind-ribbons', 4),
  );
  groupTwo.visible = false;

  const root = new THREE.Group();
  root.name = 'chasm-effects';
  root.add(groupOne, groupTwo);

  const geometries = [mistOneGeometry, mistTwoGeometry, particlesOneGeometry, particlesTwoGeometry, ribbonGeometry];
  return {
    root,
    groupOne,
    groupTwo,
    layout,
    noise,
    mistOne,
    mistTwo,
    particlesOne,
    particlesTwo,
    ribbons,
    rocks,
    geometries,
    dispose: () => {
      for (const g of geometries) g.dispose();
      for (const g of rocks.geometries) g.dispose();
      for (const m of rocks.meshes) m.dispose();
      rocks.material.dispose();
      mistOne.material.dispose();
      mistTwo.material.dispose();
      particlesOne.material.dispose();
      particlesTwo.material.dispose();
      ribbons.material.dispose();
      noise.dispose();
    },
  };
}

/* --------------------------------------------------------------------------
 * Per-frame update (no allocations)
 * ------------------------------------------------------------------------ */

interface FrameState {
  time: number;
  fadeOne: number;
  fadeTwo: number;
  gust: number;
  leap: number;
  lastProgress: number;
  lastCycle: Int32Array;
  /** Damped adaptive-quality counts (the shaders fade the boundary rank, so nothing pops). */
  mistOneCount: number;
  particlesOneCount: number;
  mistTwoCount: number;
  particlesTwoCount: number;
  ribbonCount: number;
  /** Rock channels in play; only changes while the boundary channel is idle. */
  rockChannels: number;
}

function createFrameState(startTime: number): FrameState {
  return {
    time: startTime,
    fadeOne: 0,
    fadeTwo: 0,
    gust: 0.8,
    leap: 0,
    lastProgress: -1,
    lastCycle: new Int32Array(ROCK_CHANNELS).fill(-2147483648),
    mistOneCount: -1,
    particlesOneCount: -1,
    mistTwoCount: -1,
    particlesTwoCount: -1,
    ribbonCount: -1,
    rockChannels: -1,
  };
}

const COUNT_LAMBDA = 1.6;

/** Damps a drawn count toward the adaptive target (starts at the target). */
function dampCount(current: number, target: number, dt: number): number {
  return current < 0 ? target : dampTo(current, target, COUNT_LAMBDA, dt);
}

const FADE_LAMBDA = 3.2;

function dampTo(current: number, target: number, lambda: number, dt: number): number {
  const next = damp(current, target, lambda, dt);
  return Math.abs(next - target) < 1e-4 ? target : next;
}

function hash01(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x165667b1, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _matrix = new THREE.Matrix4();
const _color = new THREE.Color();
const _quatB = new THREE.Quaternion();
const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

/** Writes one rock instance for local event time `local` (s since the event began). */
function placeRock(
  mesh: RockInstancedMesh,
  tints: Float32Array,
  slot: number,
  traj: RockTrajectory | null,
  local: number,
  isMain: boolean,
  normal: Vec3,
  fade: number,
): void {
  const fall = local - ROCK_TEETER;
  if (!traj || local < 0 || fall > traj.duration || (!isMain && fall < 0)) {
    mesh.setMatrixAt(slot, ZERO_MATRIX);
    return;
  }
  const s = traj.samples;
  let i = 0;
  let f = 0;
  if (fall > 0) {
    const x = fall / ROCK_TRAJ_DT;
    i = Math.min(Math.floor(x), traj.count - 2);
    f = Math.min(x - i, 1);
    if (i < 0) {
      i = 0;
      f = 0;
    }
  }
  const o0 = i * 7;
  const o1 = Math.min(i + 1, traj.count - 1) * 7;
  _pos.set(s[o0] + (s[o1] - s[o0]) * f, s[o0 + 1] + (s[o1 + 1] - s[o0 + 1]) * f, s[o0 + 2] + (s[o1 + 2] - s[o0 + 2]) * f);
  _quat.fromArray(s, o0 + 3);
  if (f > 0) _quatB.fromArray(s, o1 + 3);
  if (f > 0) _quat.slerp(_quatB, f);
  let envelope: number;
  if (fall < 0) {
    // Tearing loose: the block slides out of the wall, then drops.
    const e = smoothstep(0, ROCK_TEETER, local);
    const back = traj.radius * 0.75 * (1 - e);
    _pos.x -= normal[0] * back;
    _pos.y -= normal[1] * back;
    _pos.z -= normal[2] * back;
    envelope = smoothstep(0, 0.12, local);
  } else {
    envelope = (isMain ? 1 : smoothstep(0, 0.1, fall)) * (1 - smoothstep(traj.duration - 0.35, traj.duration, fall));
  }
  envelope *= fade;
  _scale.set(traj.scale[0] * envelope, traj.scale[1] * envelope, traj.scale[2] * envelope);
  _matrix.compose(_pos, _quat, _scale);
  mesh.setMatrixAt(slot, _matrix);
  // Deeper in the gorge less sky reaches the rock.
  const shade = 0.3 + 0.7 * smoothstep(ROCK_KILL_Y, ROCK_KILL_Y + 22, _pos.y);
  _color.setRGB(tints[slot * 3] * shade, tints[slot * 3 + 1] * shade, tints[slot * 3 + 2] * shade);
  mesh.setColorAt(slot, _color);
}

function writeBurst(
  material: ChasmParticleMaterial,
  slot: number,
  x: number,
  y: number,
  z: number,
  start: number,
  dx: number,
  dy: number,
  dz: number,
  size: number,
): void {
  if (slot < 0 || slot >= BURST_SLOTS) return;
  material.uniforms.uBurstPos.value[slot].set(x, y, z, start);
  material.uniforms.uBurstDir.value[slot].set(dx, dy, dz, size);
}

export interface RockEvent {
  /** Loop cycle index (changes once per channel period). */
  cycle: number;
  variant: number;
  /** Seconds since this cycle's event began (negative: not yet). */
  local: number;
}

/** Which variant channel `c` plays at effects time `time`, and how far into it. */
export function rockEventAt(ch: RockChannel, c: number, time: number, out: RockEvent): RockEvent {
  const T = ch.period;
  const tc = time + ch.phase * T;
  const k = Math.floor(tc / T);
  const jitter = hash01(k, c * 7 + 1) * Math.max(0, T - ROCK_EVENT_SPAN);
  out.cycle = k;
  out.local = tc - k * T - jitter;
  out.variant = Math.floor(hash01(k, c * 7 + 3) * ch.variants.length) % ch.variants.length;
  return out;
}

/** Fall time (s) of a rock event at local time `local` (negative while it tears loose). */
export function rockFallTime(local: number): number {
  return local - ROCK_TEETER;
}

const _event: RockEvent = { cycle: 0, variant: 0, local: 0 };

/** Whether channel `c` has no rock in the air at effects time `time`. */
function rockChannelIdle(ch: RockChannel, c: number, time: number): boolean {
  rockEventAt(ch, c, time, _event);
  const v = ch.variants[_event.variant];
  let duration = v.main.duration;
  if (v.secondary) duration = Math.max(duration, v.secondary.duration);
  for (let f = 0; f < v.fragments.length; f += 1) duration = Math.max(duration, v.fragments[f].duration);
  return _event.local < 0 || rockFallTime(_event.local) > duration;
}

function updateRocks(fx: ChasmFx, st: FrameState, target: number, scale: number): void {
  const { meshes, tints } = fx.rocks;
  const channels = fx.layout.rockChannels;
  const t = st.time;
  // Channels join or leave only between their events, so no rock ever pops mid-fall.
  if (st.rockChannels < 0) st.rockChannels = target;
  while (st.rockChannels < target && rockChannelIdle(channels[st.rockChannels], st.rockChannels, t)) st.rockChannels += 1;
  while (st.rockChannels > target && rockChannelIdle(channels[st.rockChannels - 1], st.rockChannels - 1, t)) st.rockChannels -= 1;
  const activeChannels = st.rockChannels;
  for (let c = 0; c < channels.length; c += 1) {
    const ch = channels[c];
    if (c >= activeChannels) {
      meshes[0].setMatrixAt(c, ZERO_MATRIX);
      meshes[1].setMatrixAt(c, ZERO_MATRIX);
      for (let k = 0; k < ROCK_FRAGMENTS; k += 1) meshes[2].setMatrixAt(c * ROCK_FRAGMENTS + k, ZERO_MATRIX);
      continue;
    }
    rockEventAt(ch, c, t, _event);
    const k = _event.cycle;
    const local = _event.local;
    const variant = ch.variants[_event.variant];
    if (st.lastCycle[c] !== k) {
      st.lastCycle[c] = k;
      const src = variant.source;
      const nrm = variant.normal;
      writeBurst(
        fx.particlesTwo,
        c,
        src[0],
        src[1],
        src[2],
        t - local + ROCK_TEETER,
        nrm[0],
        nrm[1],
        nrm[2],
        ROCK_CLASSES[variant.mainClass].radius,
      );
    }
    const large = variant.mainClass === 0;
    placeRock(meshes[0], tints[0], c, large ? variant.main : null, local, true, variant.normal, scale);
    placeRock(meshes[1], tints[1], c, large ? variant.secondary : variant.main, local, !large, variant.normal, scale);
    for (let f = 0; f < ROCK_FRAGMENTS; f += 1) {
      placeRock(meshes[2], tints[2], c * ROCK_FRAGMENTS + f, variant.fragments[f] ?? null, local, false, variant.normal, scale);
    }
  }
  for (let m = 0; m < 3; m += 1) {
    const mesh = meshes[m];
    mesh.count = m === 2 ? activeChannels * ROCK_FRAGMENTS : activeChannels;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}

/** Progress change per frame above which the climber is "teleporting" (reload, HUD jump): no kicks. */
const KICK_MAX_STEP = 0.01;

function updateKicks(fx: ChasmFx, st: FrameState, p: number): void {
  const last = st.lastProgress;
  st.lastProgress = p;
  if (last < 0 || Math.abs(p - last) > KICK_MAX_STEP) return;
  for (let i = 0; i < KICKS.length; i += 1) {
    const kick = KICKS[i];
    if (last < kick.at && p >= kick.at) {
      const frame = kick.chasm === 1 ? FRAME_ONE : FRAME_TWO;
      const material = kick.chasm === 1 ? fx.particlesOne : fx.particlesTwo;
      const dx = frame.nx * kick.toward;
      const dz = frame.nz * kick.toward;
      // The lip edge just in front of the feet, toward the gap.
      writeBurst(material, kick.slot, kick.source[0] + dx * 0.45, kick.source[1] - 0.15, kick.source[2] + dz * 0.45, st.time, dx, -0.25, dz, 0.28);
    }
  }
}

function updateChasmFx(fx: ChasmFx, st: FrameState, state: RootState, delta: number): void {
  const dt = Math.min(Math.max(delta, 0), 0.1);
  st.time += dt;
  const p = scrollStore.dampedProgress;
  const lit = sceneFx.exposure > 0.002;
  st.fadeOne = dampTo(st.fadeOne, lit ? windowWeight(p, CHASM_FX_WINDOWS.chasmOne) : 0, FADE_LAMBDA, dt);
  st.fadeTwo = dampTo(st.fadeTwo, lit ? windowWeight(p, CHASM_FX_WINDOWS.chasmTwo) : 0, FADE_LAMBDA, dt);
  st.leap = dampTo(st.leap, windowWeight(p, LEAP_WIND), 2.5, dt);
  // Gusts: two beating sines, stronger during the leap.
  const beat = 0.5 + 0.5 * Math.sin(st.time * 0.83) * Math.sin(st.time * 0.37 + 1.3);
  st.gust = dampTo(st.gust, Math.min(1.3, 0.62 + 0.3 * beat + 0.35 * st.leap), 4, dt);
  updateKicks(fx, st, p);

  const showOne = st.fadeOne > 0.002;
  const showTwo = st.fadeTwo > 0.002;
  fx.groupOne.visible = showOne;
  fx.groupTwo.visible = showTwo;
  const t = st.time;

  if (showOne) {
    const mist = fx.mistOne.uniforms;
    mist.uTime.value = t;
    mist.uIntensity.value = st.fadeOne;
    st.mistOneCount = dampCount(st.mistOneCount, adaptiveQuality.countFor(fx.layout.mistOne.length, MIST_CORE_SHEETS), dt);
    mist.uCount.value = st.mistOneCount;
    const parts = fx.particlesOne.uniforms;
    parts.uTime.value = t;
    parts.uFade.value = st.fadeOne;
    st.particlesOneCount = dampCount(st.particlesOneCount, adaptiveQuality.countFor(fx.layout.particlesOne.length, 24), dt);
    parts.uCount.value = st.particlesOneCount;
  }

  if (showTwo) {
    const mist = fx.mistTwo.uniforms;
    mist.uTime.value = t;
    mist.uIntensity.value = st.fadeTwo;
    st.mistTwoCount = dampCount(st.mistTwoCount, adaptiveQuality.countFor(fx.layout.mistTwo.length, MIST_CORE_SHEETS), dt);
    mist.uCount.value = st.mistTwoCount;
    const parts = fx.particlesTwo.uniforms;
    parts.uTime.value = t;
    parts.uFade.value = st.fadeTwo;
    st.particlesTwoCount = dampCount(st.particlesTwoCount, adaptiveQuality.countFor(fx.layout.particlesTwo.length, 40), dt);
    parts.uCount.value = st.particlesTwoCount;
    const rib = fx.ribbons.uniforms;
    rib.uTime.value = t;
    rib.uIntensity.value = st.fadeTwo * (0.8 + 0.35 * st.leap);
    rib.uGust.value = st.gust;
    st.ribbonCount = dampCount(st.ribbonCount, adaptiveQuality.countFor(fx.layout.ribbons.length, 6), dt);
    rib.uCount.value = st.ribbonCount;
    const cam = state.camera as THREE.PerspectiveCamera;
    const fov = cam.isPerspectiveCamera ? cam.fov : 45;
    rib.uPixel.value = (2 * Math.tan((fov * Math.PI) / 360)) / Math.max(1, state.size.height * state.viewport.dpr);
    const rockTarget = Math.min(fx.layout.rockChannels.length, adaptiveQuality.countFor(ROCK_CHANNELS, 2));
    // Opaque blocks cannot fade: they grow in / shrink out with the window instead of popping.
    updateRocks(fx, st, rockTarget, smoothstep(0.05, 0.6, st.fadeTwo));
  }
}

/* --------------------------------------------------------------------------
 * Component
 * ------------------------------------------------------------------------ */

/**
 * Mutable build settings. `frameBudgetMs` is the CPU time per frame spent
 * fitting the layout to the rock; set it to Infinity to build in the first
 * frame (screenshots / tests).
 */
export const chasmFxBuildSettings = {
  frameBudgetMs: 2.5,
  /** Initial value of the effects clock (s); the loops are deterministic in it. */
  startTime: 0,
};

interface ChasmFxHandle {
  /** Stable, empty until the layout job finishes; then holds both chasm groups. */
  root: THREE.Group;
  steps: Generator<void, ChasmFxLayout, void> | null;
  fx: ChasmFx | null;
}

export function ChasmEffects(): JSX.Element {
  const tier = scrollStore.gpuTier;
  const handle = useMemo<ChasmFxHandle>(() => {
    const root = new THREE.Group();
    root.name = 'chasm-effects';
    return { root, steps: null, fx: null };
  }, [tier]);
  const frame = useRef<FrameState>(createFrameState(chasmFxBuildSettings.startTime));

  useLayoutEffect(() => {
    handle.steps = chasmFxLayoutSteps(mountainSdf);
    frame.current = createFrameState(chasmFxBuildSettings.startTime);
    return () => {
      handle.steps = null;
      const fx = handle.fx;
      if (fx) {
        handle.root.remove(fx.root);
        fx.dispose();
        handle.fx = null;
      }
    };
  }, [handle]);

  useFrame((state, delta) => {
    if (!handle.fx) {
      const steps = handle.steps;
      if (!steps) return;
      const t0 = performance.now();
      let r = steps.next();
      while (!r.done && performance.now() - t0 < chasmFxBuildSettings.frameBudgetMs) r = steps.next();
      if (!r.done) return;
      handle.steps = null;
      handle.fx = createChasmFx(tier, r.value);
      handle.root.add(handle.fx.root);
    }
    updateChasmFx(handle.fx, frame.current, state, delta);
  });

  return <primitive object={handle.root} />;
}

export default ChasmEffects;
