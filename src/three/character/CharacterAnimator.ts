import * as THREE from 'three';
import { GEAR_DROP_AT, GEAR_EQUIP_AT, clamp01, smootherstep, smoothstep, type Vec3Tuple } from '../../store/scrollStore';
import { sampleCameraRig } from '../camera/cameraSpline';
import {
  CATCH_HANG,
  PATH_PHASES,
  WAYPOINTS,
  catchSwingAt,
  hangingCentreOfMass,
  protagonistPositionAt,
  type CatchSwing,
} from '../protagonistPath';
import { mountainSdf } from '../world/terrainGeometry';
import { ENDING, NEXT_MOUNTAIN } from '../world/worldLayout';
import { createTwoBoneResult, dampQuaternion, dampVector3, lookRotation, solveTwoBone, yawRotation } from './ik';
import {
  LIMB_INDICES,
  LIMB_LEFT_FOOT,
  LIMB_LEFT_HAND,
  LIMB_RIGHT_FOOT,
  LIMB_RIGHT_HAND,
  armFK,
  axeFrame,
  blendBodyPose,
  copyBodyPose,
  createBodyPose,
  handRotation,
  iceAxePickTip,
  isArm,
  legFK,
  limbSide,
  makeLimbRest,
  palmFrame,
  torsoRotation,
  type BodyPose,
  type LimbIndex,
  type LimbPose,
  type LimbRest,
} from './poseLibrary';
import { BONE_NAMES, ICE_AXES_IN_HANDS, iceAxeModeAt, type AnimationState, type BoneName, type CharacterRigHandle, type GearSocketName } from './rigTypes';

export { ICE_AXE_GRIP } from './poseLibrary';

/* ==========================================================================
 * CharacterAnimator — procedural, scroll-driven skeletal animation of the
 * protagonist. PURE TypeScript (no React, no DOM): runs in Node for tests.
 *
 * Every frame `update(progress, delta, elapsed)`:
 *   1. evaluates the pose generator(s) for `progress` — a deterministic
 *      function of progress; `elapsed` only drives secondary motion
 *      (breathing, wind flutter, idle micro-motion) — crossfading between
 *      neighbouring generators inside short overlap windows;
 *   2. resolves the gaze and the reach constraints of the TARGET pose;
 *   3. damps the current pose toward the target (THREE.MathUtils.damp for
 *      scalars and vectors, slerp with 1 − e^(−λΔt) for rotations);
 *   4. places rig.root EXACTLY on protagonistPositionAt(progress) (feet),
 *      yawed to the damped facing, and solves the limbs: forward kinematics
 *      blended with analytic two-bone IK whose goals are world-space contact
 *      points on the real rock (mountainSdf) — planted hands, ice-axe picks
 *      and feet land exactly on their holds because IK runs after damping.
 *
 * Contact holds are precomputed once from the SDF (time-sliced across the
 * first frames, finished synchronously if a climb is reached first): no SDF
 * query happens per frame. Zero allocation per frame.
 * ========================================================================== */

export type SdfFunction = (x: number, y: number, z: number) => number;

export interface CharacterAnimatorOptions {
  /** Signed distance of the rock (negative inside). Defaults to terrainGeometry's mountainSdf. */
  sdf?: SdfFunction;
  /**
   * CPU budget per update (ms) for building the contact tables until they are ready. Default 1.5. With
   * blockingPrepare: false, 0 leaves the build to prepareStep() (idle time) unless progress is waiting on it.
   */
  precomputeBudgetMs?: number;
  /**
   * What update() does when progress needs tables that are not built yet (a deep link or a fast fling into a
   * climb right after load). true (default, tests): build them synchronously (a 0.1–0.3 s main-thread task).
   * false (the live app): never block — keep the climber hidden, build `urgentBudgetMs` per update (the caller
   * also pumps prepareStep() in idle time), then snap straight to the pose once ready.
   */
  blockingPrepare?: boolean;
  /** Build budget per update (ms) while hidden waiting for tables (blockingPrepare: false). Default 8. */
  urgentBudgetMs?: number;
  /** Progress below which the character is hidden (the cloud curtain still covers base camp). Default 0.035. */
  hiddenBefore?: number;
  /** Time-driven secondary motion (breathing, wind flutter, micro head motion). Default true. */
  secondaryMotion?: boolean;
  /**
   * Keeps the backpack's top flap on ENDING.paperOrigin from the turn toward
   * the next mountain onward, by shifting the body (feet stay planted).
   * `local` is the flap point in the backpack socket's local frame (from
   * GearSheddingSystem); `null` disables the correction.
   */
  backpackFlap?: { local: Vec3Tuple; target?: Vec3Tuple; maxCorrection?: number } | null;
  /** Solver detail: 'low' runs one leg-contact iteration instead of three (GPU tier ≤ 1). Default 'high'. */
  detail?: 'high' | 'low';
}

export interface LimbContact {
  /** 0..1: how firmly the limb is planted on rock / ground (damped). */
  readonly planted: number;
  /** World position the contact point actually reached this frame. */
  readonly position: THREE.Vector3;
  /** World position the pose wanted it at (the hold). */
  readonly target: THREE.Vector3;
  /** Surface normal at the hold (world). */
  readonly normal: THREE.Vector3;
}

export interface CharacterContacts {
  readonly leftHand: LimbContact;
  readonly rightHand: LimbContact;
  readonly leftFoot: LimbContact;
  readonly rightFoot: LimbContact;
}

export interface CharacterAnimator {
  /** Pose the rig for `progress` (scrollStore.dampedProgress), frame `delta` and total `elapsed` seconds. */
  update(progress: number, delta: number, elapsed: number): void;
  readonly state: AnimationState;
  /** 0 → 1 over the first moments of the current state (1 once settled into it). */
  readonly stateBlend: number;
  /** 0..1 gust strength for hair and clothes. */
  readonly wind: number;
  /** World direction the wind blows toward (unit). */
  readonly windDirection: THREE.Vector3;
  readonly contacts: CharacterContacts;
  /** False while hidden behind the opening cloud curtain (rig.root.visible follows it). */
  readonly visible: boolean;
  /** True once the contact tables are built. */
  readonly ready: boolean;
  /** Builds the contact tables synchronously (tests, or before a deep link into a climb). */
  prepare(): void;
  /** Advances the contact-table build by about `budgetMs` (idle-time scheduling). Returns `ready`. */
  prepareStep(budgetMs: number): boolean;
  /** Makes the next update jump straight to the target pose (no damping). */
  snap(): void;
  /** Precomputed holds of a climb (0 wall 1, 1 wall 2, 2 scramble) for a limb: [x, y, z, nx, ny, nz, kind] per hold. */
  debugHolds(climb: number, limb: number): Float32Array;
  /** Target pelvis position before / after the reach constraints of the last update (diagnostics). */
  debugPelvis(): { readonly beforeReach: THREE.Vector3; readonly afterReach: THREE.Vector3 };
  dispose(): void;
}

/* ==========================================================================
 * Timeline
 * ========================================================================== */

export const ANIMATION_STATE_RANGES: ReadonlyArray<{ readonly state: AnimationState; readonly start: number; readonly end: number }> = [
  { state: 'HERO_IDLE', start: 0, end: 0.18 },
  { state: 'EQUIPPING_STANCE', start: 0.18, end: 0.28 },
  { state: 'CLIMB_WALL_1', start: 0.28, end: 0.45 },
  { state: 'JUMP_CHASM_1', start: 0.45, end: 0.52 },
  { state: 'CLIMB_WALL_2', start: 0.52, end: 0.62 },
  { state: 'EXTREME_LEAP_CHASM_2', start: 0.62, end: 0.71 },
  { state: 'PURE_SKILL_SCRAMBLE', start: 0.71, end: 0.78 },
  { state: 'SUMMIT_MASTERY', start: 0.78, end: 0.86 },
  { state: 'LAST_PULL', start: 0.86, end: 0.945 },
  { state: 'GUST', start: 0.945, end: 1 },
];

export function animationStateIndexAt(progress: number): number {
  for (let i = 0; i < ANIMATION_STATE_RANGES.length; i += 1) {
    if (progress < ANIMATION_STATE_RANGES[i].end) return i;
  }
  return ANIMATION_STATE_RANGES.length - 1;
}

export function animationStateAt(progress: number): AnimationState {
  return ANIMATION_STATE_RANGES[animationStateIndexAt(progress)].state;
}

/** Facing (Root yaw) the climber turns to in the ending, toward the next mountain (−Z). */
export const FACING_NEXT_MOUNTAIN = Math.PI;

/** Generator windows; consecutive generators overlap where they crossfade. */
const SEG = {
  baseEnd: 0.2875,
  climb1: [0.2835, 0.4475],
  ledge1: [0.4435, 0.5265],
  climb2: [0.5235, 0.6115],
  leap2: [0.6075, 0.7115],
  scramble: [0.7085, 0.7815],
  summit: 0.7775,
} as const;

const GE = GEAR_EQUIP_AT;
const AXE_EQUIP = GEAR_EQUIP_AT.iceAxes;
const AXE_DROP = GEAR_DROP_AT.iceAxes;

const PI = Math.PI;
const ICE_AXE_WINDOWS = ICE_AXES_IN_HANDS;
const UP = new THREE.Vector3(0, 1, 0);

/* Facing directions of the two jumps (yaw: 0 faces +Z, forward = (sin, 0, cos)). */
const JUMP1_YAW = Math.atan2(WAYPOINTS.chasmOneLanding[0] - WAYPOINTS.firstLedge[0], WAYPOINTS.chasmOneLanding[2] - WAYPOINTS.firstLedge[2]);
const LEAP2_YAW =
  Math.atan2(WAYPOINTS.chasmTwoCatch[0] - WAYPOINTS.chasmOneTop[0], WAYPOINTS.chasmTwoCatch[2] - WAYPOINTS.chasmOneTop[2]) + 2 * PI;

/* ==========================================================================
 * Small math helpers (allocation free)
 * ========================================================================== */

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Share of a moving limb in the pelvis reach constraint over its move (t 0 → 1): eased across the whole move. */
function moveReach(t: number): number {
  const s = Math.sin(PI * t);
  return 1 - s * s;
}

/** How planted a limb is over its move (t 0 → 1): leaves the hold quickly but smoothly, settles on the next. */
function movePlant(t: number): number {
  return 1 - smoothstep(0, 0.22, t) * (1 - smoothstep(0.78, 1, t));
}

/** Smooth 0 → 1 → 0 bump over [a, b] (C1, peak 1 at the middle). */
function bump(p: number, a: number, b: number): number {
  const s = clamp01((p - a) / (b - a));
  const k = s * (1 - s);
  return 16 * k * k;
}

/** 0 → 1 over [a0, a1], back to 0 over [b0, b1]. */
function windowWeight(p: number, a0: number, a1: number, b0: number, b1: number): number {
  return smoothstep(a0, a1, p) * (1 - smoothstep(b0, b1, p));
}

/** Rotates the xz offset (x = local left, z = local forward) by a facing yaw into world xz. */
function yawOffset(yaw: number, x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return out.set(x * c + z * s, 0, -x * s + z * c);
}

/* ==========================================================================
 * FK keyframe tracks (whole-body poses for jumps, hangs and turns)
 * ========================================================================== */

const FK_PARAMS = [
  'pitch',
  'roll',
  'twist',
  'spine',
  'chest',
  'neck',
  'head',
  'spineTwist',
  'chestSide',
  'lRaise',
  'lSpread',
  'lElbow',
  'lElbowOut',
  'rRaise',
  'rSpread',
  'rElbow',
  'rElbowOut',
  'lHip',
  'lHipOut',
  'lKnee',
  'lKneeOut',
  'rHip',
  'rHipOut',
  'rKnee',
  'rKneeOut',
] as const;
type FKParam = (typeof FK_PARAMS)[number];
const FK_COUNT = FK_PARAMS.length;
const FKI = Object.fromEntries(FK_PARAMS.map((name, i) => [name, i])) as Record<FKParam, number>;

const FK_NEUTRAL: Partial<Record<FKParam, number>> = {
  lRaise: 0.06,
  lSpread: 0.13,
  lElbow: 0.22,
  lElbowOut: 0.3,
  rRaise: 0.06,
  rSpread: 0.13,
  rElbow: 0.22,
  rElbowOut: 0.3,
  lHipOut: 0.03,
  lKnee: 0.06,
  lKneeOut: 0.15,
  rHipOut: 0.03,
  rKnee: 0.06,
  rKneeOut: 0.15,
};

function fkVector(values: Partial<Record<FKParam, number>>): Float64Array {
  const v = new Float64Array(FK_COUNT);
  for (const name of FK_PARAMS) v[FKI[name]] = values[name] ?? FK_NEUTRAL[name] ?? 0;
  return v;
}

interface FkTrack {
  readonly ps: Float64Array;
  readonly values: Float64Array[];
  /** Catmull-Rom tangents per key (per parameter). */
  readonly tangents: Float64Array[];
}

/** Keys at progress values, interpolated with a monotone-free Catmull-Rom (C1, fluid). */
function fkTrack(keys: ReadonlyArray<readonly [number, Partial<Record<FKParam, number>>]>): FkTrack {
  const ps = Float64Array.from(keys.map((k) => k[0]));
  const values = keys.map((k) => fkVector(k[1]));
  const tangents = values.map((_, i) => {
    const m = new Float64Array(FK_COUNT);
    if (i === 0 || i === values.length - 1) return m;
    const dp = ps[i + 1] - ps[i - 1];
    for (let j = 0; j < FK_COUNT; j += 1) m[j] = (values[i + 1][j] - values[i - 1][j]) / dp;
    return m;
  });
  return { ps, values, tangents };
}

function evalTrack(track: FkTrack, p: number, out: Float64Array): Float64Array {
  const ps = track.ps;
  const n = ps.length;
  if (p <= ps[0]) {
    out.set(track.values[0]);
    return out;
  }
  if (p >= ps[n - 1]) {
    out.set(track.values[n - 1]);
    return out;
  }
  let i = 0;
  while (i < n - 2 && p >= ps[i + 1]) i += 1;
  const h = ps[i + 1] - ps[i];
  const s = (p - ps[i]) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  const a = track.values[i];
  const b = track.values[i + 1];
  const ma = track.tangents[i];
  const mb = track.tangents[i + 1];
  for (let j = 0; j < FK_COUNT; j += 1) out[j] = h00 * a[j] + h10 * h * ma[j] + h01 * b[j] + h11 * h * mb[j];
  return out;
}

/* ---- Jump 1 (ledge 1 → ledge 2): load, explode, tuck, open, two-point landing. ---- */
const JUMP1_TRACK = fkTrack([
  [0.4445, { pitch: 0.12, spine: 0.08, chest: 0.04 }],
  [0.4475, { pitch: 0.5, spine: 0.28, chest: 0.12, neck: -0.25, head: -0.12, lRaise: -0.75, lSpread: 0.18, lElbow: 0.35, rRaise: -0.8, rSpread: 0.18, rElbow: 0.35 }],
  [0.4495, { pitch: 0.42, spine: 0.12, chest: 0.0, neck: -0.2, lRaise: 1.2, lSpread: 0.15, lElbow: 0.5, rRaise: 1.3, rSpread: 0.15, rElbow: 0.5, lHip: 0.15, rHip: 0.1, lKnee: 0.4, rKnee: 0.45 }],
  [0.4535, { pitch: 0.3, spine: -0.05, chest: -0.08, neck: -0.15, lRaise: 2.5, lSpread: 0.3, lElbow: 0.25, rRaise: 2.55, rSpread: 0.3, rElbow: 0.25, lHip: -0.3, lKnee: 0.35, rHip: -0.15, rKnee: 0.7 }],
  [0.462, { pitch: 0.45, spine: 0.3, chest: 0.25, neck: -0.25, lRaise: 1.5, lSpread: 0.35, lElbow: 1.2, rRaise: 1.5, rSpread: 0.35, rElbow: 1.2, lHip: 1.6, lHipOut: 0.12, lKnee: 2.0, rHip: 1.7, rHipOut: 0.12, rKnee: 2.1 }],
  [0.478, { pitch: 0.32, spine: 0.42, chest: 0.32, neck: -0.35, lRaise: 1.15, lSpread: 0.3, lElbow: 1.7, lElbowOut: 0.6, rRaise: 1.15, rSpread: 0.3, rElbow: 1.7, rElbowOut: 0.6, lHip: 2.0, lHipOut: 0.14, lKnee: 2.3, rHip: 2.0, rHipOut: 0.14, rKnee: 2.3 }],
  [0.494, { pitch: 0.12, spine: 0.15, chest: 0.05, neck: -0.2, head: -0.1, lRaise: 1.35, lSpread: 0.95, lElbow: 0.45, rRaise: 1.35, rSpread: 0.95, rElbow: 0.45, lHip: 1.0, lKnee: 1.1, rHip: 0.9, rKnee: 1.0 }],
  [0.508, { pitch: 0.06, spine: 0.08, chest: 0.0, neck: 0.15, head: 0.1, lRaise: 1.1, lSpread: 0.75, lElbow: 0.35, rRaise: 1.1, rSpread: 0.75, rElbow: 0.35, lHip: 0.55, lKnee: 0.5, rHip: 0.5, rKnee: 0.45 }],
  [0.5185, { pitch: 0.12, spine: 0.1, chest: 0.05, neck: 0.25, head: 0.15, lRaise: 0.9, lSpread: 0.55, lElbow: 0.35, rRaise: 0.95, rSpread: 0.55, rElbow: 0.35, lHip: 0.35, lKnee: 0.3, rHip: 0.35, rKnee: 0.3 }],
  [0.5215, { pitch: 0.55, spine: 0.32, chest: 0.12, neck: -0.2, head: -0.1, lRaise: 1.25, lSpread: 0.35, lElbow: 0.55, rRaise: 1.3, rSpread: 0.35, rElbow: 0.55 }],
  [0.5245, { pitch: 0.16, spine: 0.08, chest: 0.02 }],
]);

/* ---- Chasm 2 dive: explosive step, launch, running dive, reach for the lip. ---- */
const LEAP2_TRACK = fkTrack([
  [0.619, { pitch: 0.1, spine: 0.05, neck: -0.05 }],
  [0.6245, { pitch: 0.28, spine: 0.08, lRaise: 0.9, lElbow: 1.3, rRaise: -0.6, rElbow: 0.8, neck: -0.12, rHip: 0.6, rKnee: 1.2 }],
  [0.6295, { pitch: 0.5, spine: 0.2, chest: 0.08, neck: -0.3, lRaise: -0.7, lSpread: 0.2, lElbow: 0.5, rRaise: -0.75, rSpread: 0.2, rElbow: 0.5, rHip: 1.3, rKnee: 2.05 }],
  [0.6325, { pitch: 0.75, spine: 0.0, chest: -0.12, neck: -0.45, head: -0.2, lRaise: 2.4, lSpread: 0.25, lElbow: 0.2, rRaise: 2.5, rSpread: 0.2, rElbow: 0.2, lHip: 0.1, lKnee: 0.5, rHip: 1.25, rKnee: 1.55 }],
  [0.64, { pitch: 1.05, spine: -0.12, chest: -0.15, neck: -0.55, head: -0.25, lRaise: 2.7, lSpread: 0.3, lElbow: 0.15, rRaise: 2.75, rSpread: 0.25, rElbow: 0.12, lHip: -0.25, lKnee: 0.6, rHip: -0.45, rKnee: 0.3 }],
  [0.648, { pitch: 0.95, spine: -0.05, chest: -0.1, neck: -0.5, head: -0.2, lRaise: 2.2, lSpread: 0.6, lElbow: 0.3, rRaise: 2.8, rSpread: 0.2, rElbow: 0.15, lHip: 0.55, lKnee: 1.3, rHip: -0.4, rKnee: 0.45 }],
  [0.656, { pitch: 0.75, spine: 0.0, chest: -0.05, neck: -0.42, head: -0.15, lRaise: 1.8, lSpread: 0.9, lElbow: 0.4, rRaise: 2.75, rSpread: 0.25, rElbow: 0.15, lHip: -0.35, lKnee: 0.5, rHip: 0.6, rKnee: 1.35 }],
  [0.664, { pitch: 0.45, spine: 0.05, chest: -0.05, neck: -0.3, head: -0.05, lRaise: 1.4, lSpread: 1.2, lElbow: 0.45, rRaise: 2.85, rSpread: 0.22, rElbow: 0.1, lHip: 0.45, lKnee: 1.0, rHip: -0.2, rKnee: 0.55 }],
  [0.672, { pitch: 0.18, spine: 0.02, chest: -0.08, neck: 0.1, head: 0.15, lRaise: 1.0, lSpread: 1.25, lElbow: 0.5, rRaise: 2.95, rSpread: 0.2, rElbow: 0.08, lHip: 0.3, lKnee: 0.6, rHip: 0.2, rKnee: 0.5 }],
  [0.68, { pitch: 0.05, spine: 0.0, chest: -0.06, neck: 0.25, head: 0.2, lRaise: 0.8, lSpread: 1.1, lElbow: 0.5, rRaise: 3.0, rSpread: 0.15, rElbow: 0.05, lHip: 0.35, lKnee: 0.65, rHip: 0.15, rKnee: 0.45 }],
]);

/* ==========================================================================
 * Rig measurement
 * ========================================================================== */

interface SocketBinding {
  bone: BoneName;
  /** Socket origin in its bone's frame. */
  offset: THREE.Vector3;
  /** Socket orientation relative to its bone. */
  rotation: THREE.Quaternion;
}

interface RigInfo {
  rest: Record<BoneName, THREE.Vector3>;
  height: number;
  restPelvisY: number;
  shinLength: number;
  footHeight: number;
  footLength: number;
  armRest: [LimbRest, LimbRest];
  legRest: [LimbRest, LimbRest];
  armReach: number;
  legReach: number;
  /** Per arm [L, R], in the hand frame from the wrist. */
  grip: [THREE.Vector3, THREE.Vector3];
  palm: [THREE.Vector3, THREE.Vector3];
  pick: [THREE.Vector3, THREE.Vector3];
  /** Per leg [L, R], in the shin frame from the ankle. */
  sole: [THREE.Vector3, THREE.Vector3];
  ball: [THREE.Vector3, THREE.Vector3];
  edge: [THREE.Vector3, THREE.Vector3];
  sockets: Record<GearSocketName, SocketBinding>;
}

const DEFAULT_SOCKETS: Record<GearSocketName, { bone: BoneName; offset: Vec3Tuple }> = {
  backpack: { bone: 'Chest', offset: [0, 0.11, -0.15] },
  ropeCoil: { bone: 'Chest', offset: [0.12, 0.17, 0] },
  harness: { bone: 'Pelvis', offset: [0, -0.02, 0] },
  hipHolsterL: { bone: 'Pelvis', offset: [0.17, -0.05, -0.03] },
  hipHolsterR: { bone: 'Pelvis', offset: [-0.17, -0.05, -0.03] },
  handGripL: { bone: 'LeftHand', offset: [0, -0.085, 0.01] },
  handGripR: { bone: 'RightHand', offset: [0, -0.085, 0.01] },
};

/** Socket position in its bone's frame (walks intermediate groups); falls back to the contract defaults. */
function bindSocket(rig: CharacterRigHandle, name: GearSocketName): SocketBinding {
  const socket = rig.sockets[name];
  const boneOf = new Map<THREE.Object3D, BoneName>();
  for (const bone of BONE_NAMES) boneOf.set(rig.bones[bone], bone);
  const m = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();
  let node: THREE.Object3D | null = socket ?? null;
  if (node) {
    if (boneOf.has(node)) return { bone: boneOf.get(node) as BoneName, offset: new THREE.Vector3(), rotation: new THREE.Quaternion() };
    m.compose(node.position, node.quaternion, node.scale);
    let parent: THREE.Object3D | null = node.parent;
    while (parent) {
      const bone = boneOf.get(parent);
      if (bone) {
        const offset = new THREE.Vector3();
        const rotation = new THREE.Quaternion();
        m.decompose(offset, rotation, new THREE.Vector3());
        return { bone, offset, rotation };
      }
      tmp.compose(parent.position, parent.quaternion, parent.scale);
      m.premultiply(tmp);
      parent = parent.parent;
    }
  }
  const fallback = DEFAULT_SOCKETS[name];
  // Contract default: the backpack socket's +Z points away from the back.
  const rotation = name === 'backpack' ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI) : new THREE.Quaternion();
  return { bone: fallback.bone, offset: new THREE.Vector3(...fallback.offset), rotation };
}

function measureRig(rig: CharacterRigHandle): RigInfo {
  const rest = {} as Record<BoneName, THREE.Vector3>;
  for (const name of BONE_NAMES) rest[name] = rig.restPositions[name].clone();
  const dims = rig.dimensions;
  // shinLength runs from the knee to the ankle (or to the sole when the boot is rigid with the shin): the
  // remainder of the knee height is the foot below the IK end joint.
  const shinLength = dims.shinLength;
  const kneeY = rest.Pelvis.y + rest.LeftUpLeg.y + rest.LeftLeg.y;
  const footHeight = Math.max(0, kneeY - shinLength);
  const footLength = 0.16 * dims.height;
  const armRest: [LimbRest, LimbRest] = [
    makeLimbRest(rest.LeftForeArm, rest.LeftHand, new THREE.Vector3(0, 0, -1)),
    makeLimbRest(rest.RightForeArm, rest.RightHand, new THREE.Vector3(0, 0, -1)),
  ];
  const shin = new THREE.Vector3(0, -shinLength, 0);
  const legRest: [LimbRest, LimbRest] = [
    makeLimbRest(rest.LeftLeg, shin, new THREE.Vector3(0, 0, 1)),
    makeLimbRest(rest.RightLeg, shin, new THREE.Vector3(0, 0, 1)),
  ];
  const sockets = {} as Record<GearSocketName, SocketBinding>;
  for (const name of Object.keys(DEFAULT_SOCKETS) as GearSocketName[]) sockets[name] = bindSocket(rig, name);
  const gripOf = (name: 'handGripL' | 'handGripR', hand: BoneName): THREE.Vector3 => {
    const b = sockets[name];
    if (b.bone === hand) return b.offset.clone();
    return new THREE.Vector3(...DEFAULT_SOCKETS[name].offset);
  };
  const grip: [THREE.Vector3, THREE.Vector3] = [gripOf('handGripL', 'LeftHand'), gripOf('handGripR', 'RightHand')];
  // Palm surface: 2 cm from the grip centre toward the palm (left palm faces −X, right +X).
  const palm: [THREE.Vector3, THREE.Vector3] = [grip[0].clone().add(new THREE.Vector3(-0.02, 0, 0)), grip[1].clone().add(new THREE.Vector3(0.02, 0, 0))];
  const pick: [THREE.Vector3, THREE.Vector3] = [iceAxePickTip(grip[0], new THREE.Vector3()), iceAxePickTip(grip[1], new THREE.Vector3())];
  // Foot landmarks measured from the point under the knee line (the heel sits ~0.07 behind it).
  const fwd = footLength * 0.23;
  const sole: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(0, -footHeight, fwd), new THREE.Vector3(0, -footHeight, fwd)];
  const ball: [THREE.Vector3, THREE.Vector3] = [
    new THREE.Vector3(0, -footHeight + 0.008, footLength * 0.41),
    new THREE.Vector3(0, -footHeight + 0.008, footLength * 0.41),
  ];
  // Inside edge of the ball of the foot (climbing: the foot turned out, its medial edge on the hold).
  const edge: [THREE.Vector3, THREE.Vector3] = [
    new THREE.Vector3(-0.045, -footHeight + 0.014, footLength * 0.39),
    new THREE.Vector3(0.045, -footHeight + 0.014, footLength * 0.39),
  ];
  return {
    rest,
    height: dims.height,
    restPelvisY: rest.Pelvis.y,
    shinLength,
    footHeight,
    footLength,
    armRest,
    legRest,
    armReach: armRest[0].upperLength + armRest[0].lowerLength,
    legReach: legRest[0].upperLength + legRest[0].lowerLength,
    grip,
    palm,
    pick,
    sole,
    ball,
    edge,
    sockets,
  };
}

/* ==========================================================================
 * Contact tables (precomputed from the SDF)
 * ========================================================================== */

interface GroundSpot {
  cx: number;
  cz: number;
  half: number;
  step: number;
  n: number;
  heights: Float32Array;
  ready: boolean;
}

type StandKey = 'base' | 'ledge1' | 'landing' | 'pillar' | 'summit';

const STAND_SPOTS: Record<StandKey, { cx: number; cy: number; cz: number; half: number }> = {
  base: { cx: 0, cy: WAYPOINTS.baseCamp[1], cz: 0.1, half: 0.8 },
  ledge1: { cx: -0.05, cy: WAYPOINTS.firstLedge[1], cz: -8.5, half: 0.8 },
  landing: { cx: 5, cy: WAYPOINTS.chasmOneLanding[1], cz: -13.95, half: 0.8 },
  pillar: { cx: 5.1, cy: WAYPOINTS.chasmOneTop[1], cz: -16.6, half: 0.8 },
  summit: { cx: 0, cy: WAYPOINTS.summit[1], cz: -35.15, half: 0.7 },
};

function groundY(spot: GroundSpot, x: number, z: number): number {
  const n = spot.n;
  const fx = THREE.MathUtils.clamp((x - (spot.cx - spot.half)) / spot.step, 0, n - 1 - 1e-6);
  const fz = THREE.MathUtils.clamp((z - (spot.cz - spot.half)) / spot.step, 0, n - 1 - 1e-6);
  const i = Math.floor(fx);
  const k = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - k;
  const h = spot.heights;
  const a = h[i + n * k];
  const b = h[i + 1 + n * k];
  const c = h[i + n * (k + 1)];
  const d = h[i + 1 + n * (k + 1)];
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}

interface ClimbSpec {
  key: 'wall1' | 'wall2' | 'scramble';
  pStart: number;
  pEnd: number;
  /** Arc length of route climbed per full cycle (m): each hand moves once per cycle. */
  cycle: number;
  /** Per limb [LH, RH, LF, RF]: period in cycles (the feet take two shorter steps per hand move). */
  periods: readonly [number, number, number, number];
  /** Per limb: fraction of its period spent moving between holds. */
  moves: readonly [number, number, number, number];
  /** Per limb: phase offsets in own periods (in (0, 1]); a move ends when (c / period − offset) is whole. */
  offsets: readonly [number, number, number, number];
  leadIn: readonly [number, number];
  handReach: number;
  pickReach: number;
  footReach: number;
  handSpread: number;
  footSpread: number;
  handArc: number;
  footArc: number;
  bob: number;
  sway: number;
  stand: StandKey | 'lip';
  /** Pelvis stand-off from the rock (m). */
  hipGap: number;
  /** How far the torso leans back from the wall (radians): hips in, chest out, arms long. */
  chestLean: number;
}

const CLIMBS: readonly ClimbSpec[] = [
  {
    key: 'wall1',
    pStart: PATH_PHASES.ascentStart,
    pEnd: PATH_PHASES.ascentEnd,
    cycle: 1.0,
    periods: [1, 1, 0.5, 0.5],
    moves: [0.3, 0.3, 0.36, 0.36],
    offsets: [0.8, 0.3, 0.95, 0.45],
    leadIn: [0.2905, 0.3005],
    handReach: 1.8,
    pickReach: 2.15,
    footReach: 0.42,
    handSpread: 0.27,
    footSpread: 0.17,
    handArc: 0.2,
    footArc: 0.1,
    bob: 0.05,
    sway: 0.06,
    stand: 'base',
    hipGap: 0.36,
    chestLean: 0.24,
  },
  {
    key: 'wall2',
    pStart: PATH_PHASES.jumpOneEnd,
    pEnd: PATH_PHASES.climbOneEnd,
    cycle: 0.95,
    periods: [1, 1, 0.5, 0.5],
    moves: [0.32, 0.32, 0.38, 0.38],
    offsets: [0.8, 0.3, 0.95, 0.45],
    leadIn: [0.5255, 0.5335],
    handReach: 1.8,
    pickReach: 2.15,
    footReach: 0.42,
    handSpread: 0.27,
    footSpread: 0.17,
    handArc: 0.2,
    footArc: 0.1,
    bob: 0.05,
    sway: 0.07,
    stand: 'landing',
    hipGap: 0.36,
    chestLean: 0.24,
  },
  {
    key: 'scramble',
    pStart: PATH_PHASES.leapTwoEnd,
    pEnd: PATH_PHASES.scrambleEnd,
    cycle: 1.15,
    periods: [1, 1, 0.5, 0.5],
    moves: [0.45, 0.45, 0.45, 0.45],
    offsets: [0.95, 0.45, 0.95, 0.45],
    leadIn: [0.7095, 0.7165],
    handReach: 1.78,
    pickReach: 1.78,
    footReach: 0.44,
    handSpread: 0.3,
    footSpread: 0.19,
    handArc: 0.14,
    footArc: 0.12,
    bob: 0.08,
    sway: 0.05,
    stand: 'lip',
    hipGap: 0.3,
    chestLean: 0.14,
  },
];

const HOLD_STRIDE = 7; // x, y, z, nx, ny, nz, kind (0 rock, 1 ground, 2 lip edge grip)
const FRAME_STEP = 0.2;

interface ClimbTable {
  spec: ClimbSpec;
  /** Progress samples and the arc length at each. */
  ps: Float64Array;
  ss: Float64Array;
  total: number;
  /** Frames every FRAME_STEP of arc length from s = frameS0. */
  frameS0: number;
  frameCount: number;
  anchor: Float32Array;
  normal: Float32Array;
  pelvis: Float32Array;
  /** Holds per limb (index 0 = hold 0; hold −1 is the pre-climb contact). */
  holds: [Float32Array, Float32Array, Float32Array, Float32Array];
  holdCount: [number, number, number, number];
  /** Arc length already covered when the lead-in starts. */
  s0: number;
  /** Height of the standing surface at the end of the climb. */
  topY: number;
  /** Mantle hand spots on the top surface [left, right], and the outward wall normal just below the lip. */
  topHands: [THREE.Vector3, THREE.Vector3];
  /** Where ice-axe picks hook the lip edge [left, right]. */
  topEdge: [THREE.Vector3, THREE.Vector3];
  topNormal: THREE.Vector3;
  /** Per frame: how far the hip anchor may move toward the rock before it gets too close (m). */
  pelvisRoom: Float32Array;
  ready: boolean;
}

interface LipGrip {
  right: THREE.Vector3;
  left: THREE.Vector3;
  normal: THREE.Vector3;
  footRight: THREE.Vector3;
  footLeft: THREE.Vector3;
  ready: boolean;
}

/* ==========================================================================
 * The animator
 * ========================================================================== */

export function createCharacterAnimator(rig: CharacterRigHandle, options: CharacterAnimatorOptions = {}): CharacterAnimator {
  const sdf: SdfFunction = options.sdf ?? mountainSdf;
  const budgetMs = options.precomputeBudgetMs ?? 1.5;
  const blockingPrepare = options.blockingPrepare ?? true;
  const urgentBudgetMs = options.urgentBudgetMs ?? 8;
  const hiddenBefore = options.hiddenBefore ?? 0.035;
  const secondary = options.secondaryMotion ?? true;
  const legIterations = options.detail === 'low' ? 1 : 3;
  const flapOption = options.backpackFlap === undefined ? { local: [0, 0.21, 0.13] as Vec3Tuple } : options.backpackFlap;
  const flapLocal = flapOption ? new THREE.Vector3(...flapOption.local) : null;
  const flapTarget = new THREE.Vector3(...(flapOption?.target ?? ENDING.paperOrigin));
  const flapMax = flapOption?.maxCorrection ?? 0.15;

  const info = measureRig(rig);
  const R = info.rest;

  /* ------------------------------------------------------------------
   * SDF helpers (precompute only)
   * ------------------------------------------------------------------ */

  const gradient = (x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 => {
    // Tetrahedral central differences (4 evaluations).
    const h = 0.012;
    const a = sdf(x + h, y - h, z - h);
    const b = sdf(x - h, y - h, z + h);
    const c = sdf(x - h, y + h, z - h);
    const d = sdf(x + h, y + h, z + h);
    out.set(a - b - c + d, -a - b + c + d, -a + b - c + d);
    const l = out.length();
    return l > 1e-9 ? out.multiplyScalar(1 / l) : out.set(0, 1, 0);
  };

  const _pg = new THREE.Vector3();
  /** Projects `p` onto the zero set along the gradient (Newton); writes the normal. Returns |residual|. */
  const project = (p: THREE.Vector3, normal: THREE.Vector3): number => {
    let d = sdf(p.x, p.y, p.z);
    for (let it = 0; it < 8 && Math.abs(d) > 4e-4; it += 1) {
      gradient(p.x, p.y, p.z, _pg);
      p.addScaledVector(_pg, -d);
      d = sdf(p.x, p.y, p.z);
    }
    gradient(p.x, p.y, p.z, normal);
    return Math.abs(d);
  };

  /**
   * Marches from `p` along `dir` (unit) until the rock (sphere tracing), then refines onto the zero set.
   * Keeps the height of a hold instead of letting a gradient projection slide down a leaning wall.
   * Returns false when no rock was found within `maxDist`.
   */
  const projectAlong = (p: THREE.Vector3, dir: THREE.Vector3, maxDist: number, normal: THREE.Vector3): boolean => {
    let travelled = 0;
    let d = sdf(p.x, p.y, p.z);
    for (let it = 0; it < 80 && travelled < maxDist; it += 1) {
      if (d < 0.002) break;
      const stepLen = Math.max(0.003, d * 0.8);
      p.addScaledVector(dir, stepLen);
      travelled += stepLen;
      d = sdf(p.x, p.y, p.z);
    }
    if (travelled >= maxDist) return false;
    return project(p, normal) < 0.004;
  };

  /** Ground height under (x, z) by sphere tracing down from `fromY`. */
  const traceDown = (x: number, z: number, fromY: number, minY: number): number => {
    let y = fromY;
    let d = sdf(x, y, z);
    for (let it = 0; it < 400 && y > minY; it += 1) {
      if (d < 0.002) break;
      y -= Math.max(0.006, d * 0.8);
      d = sdf(x, y, z);
    }
    if (d < 0) {
      // Overshot into rock: bisect back up.
      let lo = y;
      let hi = y + 0.05;
      for (let it = 0; it < 12; it += 1) {
        const mid = (lo + hi) * 0.5;
        if (sdf(x, mid, z) < 0) lo = mid;
        else hi = mid;
      }
      y = hi;
    }
    return Math.max(y, minY);
  };

  /* ------------------------------------------------------------------
   * Tables
   * ------------------------------------------------------------------ */

  const spots = {} as Record<StandKey, GroundSpot>;
  for (const key of Object.keys(STAND_SPOTS) as StandKey[]) {
    const s = STAND_SPOTS[key];
    const step = 0.14;
    const n = Math.round((2 * s.half) / step) + 1;
    spots[key] = { cx: s.cx, cz: s.cz, half: s.half, step, n, heights: new Float32Array(n * n).fill(s.cy), ready: false };
  }

  const climbs: ClimbTable[] = CLIMBS.map((spec) => ({
    spec,
    ps: new Float64Array(0),
    ss: new Float64Array(0),
    total: 0,
    frameS0: 0,
    frameCount: 0,
    anchor: new Float32Array(0),
    normal: new Float32Array(0),
    pelvis: new Float32Array(0),
    holds: [new Float32Array(0), new Float32Array(0), new Float32Array(0), new Float32Array(0)],
    holdCount: [0, 0, 0, 0],
    s0: 0,
    topY: 0,
    topHands: [new THREE.Vector3(), new THREE.Vector3()],
    topEdge: [new THREE.Vector3(), new THREE.Vector3()],
    topNormal: new THREE.Vector3(0, 0, 1),
    pelvisRoom: new Float32Array(0),
    ready: false,
  }));

  const lip: LipGrip = {
    right: new THREE.Vector3(...CATCH_HANG.grip),
    left: new THREE.Vector3(...CATCH_HANG.grip),
    normal: new THREE.Vector3(0, 0, 1),
    footRight: new THREE.Vector3(...CATCH_HANG.grip),
    footLeft: new THREE.Vector3(...CATCH_HANG.grip),
    ready: false,
  };

  const pillarTakeoff = new THREE.Vector3(4.95, WAYPOINTS.chasmOneTop[1], -16.85);

  /* Arc length ↔ progress and the path by arc length (with linear extrapolation). */
  const tablePathAtS = (t: ClimbTable, s: number, out: THREE.Vector3): THREE.Vector3 => {
    const ss = t.ss;
    const n = ss.length;
    if (s <= 0) {
      protagonistPositionAt(t.ps[0], out);
      // Below the start: continue down the first frame's wall-up direction.
      out.addScaledVector(_frameUpStart(t), s);
      return out;
    }
    if (s >= t.total) {
      protagonistPositionAt(t.ps[n - 1], out);
      out.y += s - t.total;
      return out;
    }
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ss[mid] <= s) lo = mid;
      else hi = mid;
    }
    const f = (s - ss[lo]) / Math.max(1e-9, ss[hi] - ss[lo]);
    return protagonistPositionAt(t.ps[lo] + (t.ps[hi] - t.ps[lo]) * f, out);
  };

  const _upStart = new THREE.Vector3();
  const _frameUpStart = (t: ClimbTable): THREE.Vector3 => {
    // Wall-up direction at the start (from the first two path samples above the start).
    protagonistPositionAt(t.ps[0], _upStart);
    const k = Math.min(t.ps.length - 1, 40);
    protagonistPositionAt(t.ps[k], _scratchA);
    _upStart.subVectors(_scratchA, _upStart);
    if (_upStart.lengthSq() < 1e-8) return _upStart.set(0, 1, 0);
    return _upStart.normalize();
  };

  const tableSAtP = (t: ClimbTable, p: number): number => {
    const ps = t.ps;
    const n = ps.length;
    if (p <= ps[0]) return 0;
    if (p >= ps[n - 1]) return t.total;
    const f = ((p - ps[0]) / (ps[n - 1] - ps[0])) * (n - 1);
    const i = Math.min(n - 2, Math.floor(f));
    return t.ss[i] + (t.ss[i + 1] - t.ss[i]) * (f - i);
  };

  const tablePAtS = (t: ClimbTable, s: number): number => {
    if (s <= 0) return t.ps[0];
    if (s >= t.total) return t.ps[t.ps.length - 1];
    let lo = 0;
    let hi = t.ss.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t.ss[mid] <= s) lo = mid;
      else hi = mid;
    }
    const f = (s - t.ss[lo]) / Math.max(1e-9, t.ss[hi] - t.ss[lo]);
    return t.ps[lo] + (t.ps[hi] - t.ps[lo]) * f;
  };

  /** Interpolated frame at arc length s: anchor (path), outward normal and pelvis anchor. */
  const frameAt = (t: ClimbTable, s: number, anchor: THREE.Vector3, normal: THREE.Vector3, pelvis: THREE.Vector3): void => {
    const f = THREE.MathUtils.clamp((s - t.frameS0) / FRAME_STEP, 0, t.frameCount - 1 - 1e-6);
    const i = Math.floor(f);
    const w = f - i;
    const a = i * 3;
    const b = a + 3;
    anchor.set(lerp(t.anchor[a], t.anchor[b], w), lerp(t.anchor[a + 1], t.anchor[b + 1], w), lerp(t.anchor[a + 2], t.anchor[b + 2], w));
    normal.set(lerp(t.normal[a], t.normal[b], w), lerp(t.normal[a + 1], t.normal[b + 1], w), lerp(t.normal[a + 2], t.normal[b + 2], w)).normalize();
    pelvis.set(lerp(t.pelvis[a], t.pelvis[b], w), lerp(t.pelvis[a + 1], t.pelvis[b + 1], w), lerp(t.pelvis[a + 2], t.pelvis[b + 2], w));
  };

  /** How far the hip anchor may move toward the rock at arc length s. */
  const roomAt = (t: ClimbTable, s: number): number => {
    const f = THREE.MathUtils.clamp((s - t.frameS0) / FRAME_STEP, 0, t.frameCount - 1 - 1e-6);
    const i = Math.floor(f);
    return lerp(t.pelvisRoom[i], t.pelvisRoom[i + 1], f - i);
  };

  /** Wall-up (tangent) and lateral (character's left when facing the rock) for an outward normal. */
  const wallBasis = (normal: THREE.Vector3, up: THREE.Vector3, left: THREE.Vector3): void => {
    up.copy(UP).addScaledVector(normal, -normal.dot(UP));
    if (up.lengthSq() < 1e-6) up.set(0, 0, -1);
    up.normalize();
    left.crossVectors(up, normal).negate(); // up × (−n)
    left.normalize();
  };

  const _scratchA = new THREE.Vector3();
  const _scratchN = new THREE.Vector3();
  const _scratchU = new THREE.Vector3();
  const _scratchL = new THREE.Vector3();
  const _scratchH = new THREE.Vector3();

  function hash01(a: number, b: number, c: number): number {
    let h = Math.imul(a + 17, 0x27d4eb2d) ^ Math.imul(b + 101, 0x165667b1) ^ Math.imul(c + 7, 0x1b873593);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  }

  function* buildSpot(spot: GroundSpot, cy: number): Generator<void, void, void> {
    const n = spot.n;
    for (let k = 0; k < n; k += 1) {
      for (let i = 0; i < n; i += 1) {
        const x = spot.cx - spot.half + i * spot.step;
        const z = spot.cz - spot.half + k * spot.step;
        spot.heights[i + n * k] = traceDown(x, z, cy + 0.6, cy - 3);
        // One march per unit: the first SDF queries in a region also fill its lazily built chip cells.
        yield;
      }
    }
    spot.ready = true;
  }

  /** Stance whose final foot placement the first (ground) foot holds of a climb reuse. */
  const groundStanceFor = (spec: ClimbSpec): Stance | null => {
    if (spec.stand === 'base') return BASE_STANCE;
    if (spec.stand === 'landing') return LANDING_STANCE;
    return null;
  };

  /** Stance the climb tops out into (its initial foot placement receives the last foot holds). */
  const topStanceFor = (spec: ClimbSpec): Stance => {
    if (spec.key === 'wall1') return LEDGE1_STANCE;
    if (spec.key === 'wall2') return PILLAR_STANCE;
    return SUMMIT_ARRIVAL;
  };

  function* buildClimb(t: ClimbTable, index: number): Generator<void, void, void> {
    const spec = t.spec;
    // 1. Arc length table.
    const N = 900;
    t.ps = new Float64Array(N + 1);
    t.ss = new Float64Array(N + 1);
    const prev = new THREE.Vector3();
    const cur = new THREE.Vector3();
    for (let i = 0; i <= N; i += 1) {
      const p = spec.pStart + ((spec.pEnd - spec.pStart) * i) / N;
      t.ps[i] = p;
      protagonistPositionAt(Math.min(p, spec.pEnd - 1e-7), cur);
      t.ss[i] = i === 0 ? 0 : t.ss[i - 1] + cur.distanceTo(prev);
      prev.copy(cur);
    }
    t.total = t.ss[N];
    t.s0 = tableSAtP(t, spec.leadIn[0]);
    yield;

    // 2. Frames: wall normal and pelvis anchor along the route (including margins below and above).
    const s0 = -2.4;
    const s1 = t.total + 2.6;
    const count = Math.ceil((s1 - s0) / FRAME_STEP) + 1;
    t.frameS0 = s0;
    t.frameCount = count;
    t.anchor = new Float32Array(count * 3);
    const rawN = new Float32Array(count * 3);
    const rawGap = new Float32Array(count);
    const a = new THREE.Vector3();
    const q = new THREE.Vector3();
    const n1 = new THREE.Vector3();
    const n2 = new THREE.Vector3();
    const dirIn = new THREE.Vector3(0, 0, -1);
    const prevN = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < count; i += 1) {
      const s = s0 + i * FRAME_STEP;
      tablePathAtS(t, s, a);
      t.anchor[i * 3] = a.x;
      t.anchor[i * 3 + 1] = a.y;
      t.anchor[i * 3 + 2] = a.z;
      // Direction into the wall: away from the gradient at chest height (horizontal part).
      gradient(a.x, a.y + 1.1, a.z, n1);
      n1.y = 0;
      if (n1.lengthSq() > 1e-4) dirIn.copy(n1).normalize().negate();
      // Wall normal: average of horizontal hits at three heights (the ground never interferes).
      n1.set(0, 0, 0);
      let hits = 0;
      for (const h of [0.55, 1.0, 1.45]) {
        q.set(a.x, a.y + h, a.z);
        if (projectAlong(q, dirIn, 1.7, n2)) {
          n1.add(n2);
          hits += 1;
        }
      }
      if (hits > 0) prevN.copy(n1.normalize());
      rawN[i * 3] = prevN.x;
      rawN[i * 3 + 1] = prevN.y;
      rawN[i * 3 + 2] = prevN.z;
      yield;
    }
    // Smooth normals along the route (±0.4 m box filter), limit how far they tip upward.
    t.normal = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      n1.set(0, 0, 0);
      for (let k = -2; k <= 2; k += 1) {
        const j = THREE.MathUtils.clamp(i + k, 0, count - 1);
        n1.x += rawN[j * 3];
        n1.y += rawN[j * 3 + 1];
        n1.z += rawN[j * 3 + 2];
      }
      n1.normalize();
      if (n1.y > 0.6) {
        const hl = Math.hypot(n1.x, n1.z) || 1;
        const k = Math.sqrt(1 - 0.36) / hl;
        n1.set(n1.x * k, 0.6, n1.z * k);
      }
      t.normal[i * 3] = n1.x;
      t.normal[i * 3 + 1] = n1.y;
      t.normal[i * 3 + 2] = n1.z;
    }
    yield;
    // The stance the climb tops out into starts facing the wall the climber just left.
    {
      frameAt(t, t.total, q, n1, n2);
      const endYaw = Math.atan2(-n1.x, -n1.z);
      topStanceFor(spec).yawFrom = endYaw < 0 ? endYaw + 2 * PI : endYaw;
    }

    // Top-out: the standing surface, the mantle hand spots and the wall direction just below the lip.
    tablePathAtS(t, t.total, a);
    const topEnd = new THREE.Vector3().copy(a);
    frameAt(t, t.total - 0.7, q, n1, n2);
    t.topNormal.set(n1.x, 0, n1.z).normalize();
    wallBasis(t.topNormal, _scratchU, _scratchL);
    const topSurface = traceDown(a.x - t.topNormal.x * 0.15, a.z - t.topNormal.z * 0.15, a.y + 1.2, a.y - 2.5);
    t.topY = topSurface;
    yield;
    if (spec.key === 'scramble') {
      // The scramble curves onto the summit from the side: its top-out spots sit toward the approach, where the
      // body still is when the hands reach over (centred on the end they would be a sideways lunge away).
      tablePathAtS(t, t.total - 0.9, q);
      const lateral = (q.x - a.x) * _scratchL.x + (q.z - a.z) * _scratchL.z;
      a.addScaledVector(_scratchL, lateral * 0.8);
    }
    for (let k = 0; k < 2; k += 1) {
      const side = k === 0 ? 1 : -1;
      const h = t.topHands[k];
      // Mantle spots: the hands (fists around the axes on the walls) press on the top just beyond the lip.
      h.copy(a).addScaledVector(t.topNormal, spec.key === 'scramble' ? -0.2 : -0.24).addScaledVector(_scratchL, side * (spec.key === 'scramble' ? 0.2 : 0.24));
      h.y = traceDown(h.x, h.z, a.y + 1.2, a.y - 2.5);
      yield;
      const edge = t.topEdge[k];
      edge.copy(a).addScaledVector(t.topNormal, -0.05).addScaledVector(_scratchL, side * 0.24);
      edge.y = traceDown(edge.x, edge.z, a.y + 1.2, a.y - 2.5);
      yield;
    }
    yield;

    // Pelvis stand-off: horizontal distance to the rock at hip height, along −n.
    for (let i = 0; i < count; i += 1) {
      a.set(t.anchor[i * 3], t.anchor[i * 3 + 1] + 0.95, t.anchor[i * 3 + 2]);
      n1.set(t.normal[i * 3], 0, t.normal[i * 3 + 2]);
      if (n1.lengthSq() < 1e-6) n1.set(0, 0, 1);
      n1.normalize();
      let dist = 0;
      let d = sdf(a.x, a.y, a.z);
      for (let it = 0; it < 40 && dist < 1.6; it += 1) {
        if (d < 0.003) break;
        const stepLen = Math.max(0.006, d * 0.8);
        dist += stepLen;
        d = sdf(a.x - n1.x * dist, a.y, a.z - n1.z * dist);
      }
      rawGap[i] = Math.min(dist, 1.6);
      if ((i & 1) === 1) yield;
    }
    t.pelvis = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      let g = 0;
      let wsum = 0;
      for (let k = -2; k <= 2; k += 1) {
        const j = THREE.MathUtils.clamp(i + k, 0, count - 1);
        const w = 3 - Math.abs(k);
        g += rawGap[j] * w;
        wsum += w;
      }
      g /= wsum;
      n1.set(t.normal[i * 3], 0, t.normal[i * 3 + 2]).normalize();
      // Until the mantle carries them over, the hips stay in front of the lip edge (feet still on the face).
      const edgeAhead = (topEnd.x - t.anchor[i * 3]) * -t.topNormal.x + (topEnd.z - t.anchor[i * 3 + 2]) * -t.topNormal.z;
      const shift = Math.min(THREE.MathUtils.clamp(g - spec.hipGap, -0.15, 0.75), Math.max(-0.15, edgeAhead - 0.24));
      t.pelvis[i * 3] = t.anchor[i * 3] - n1.x * shift;
      t.pelvis[i * 3 + 1] = t.anchor[i * 3 + 1] + 0.95;
      t.pelvis[i * 3 + 2] = t.anchor[i * 3 + 2] - n1.z * shift;
    }
    yield;

    // Keep the hip anchors (and the chest above them) clear of the rock.
    for (let i = 0; i < count; i += 1) {
      a.set(t.pelvis[i * 3], t.pelvis[i * 3 + 1], t.pelvis[i * 3 + 2]);
      for (let it = 0; it < 6; it += 1) {
        const dHip = sdf(a.x, a.y, a.z) - 0.24;
        const dChest = sdf(a.x, a.y + 0.45, a.z) - 0.22;
        const worst = Math.min(dHip, dChest);
        if (worst >= 0) break;
        if (dHip <= dChest) gradient(a.x, a.y, a.z, n1);
        else gradient(a.x, a.y + 0.45, a.z, n1);
        a.addScaledVector(n1, -worst + 0.01);
      }
      t.pelvis[i * 3] = a.x;
      t.pelvis[i * 3 + 1] = a.y;
      t.pelvis[i * 3 + 2] = a.z;
      if ((i & 3) === 3) yield;
    }
    t.pelvisRoom = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      const d = Math.min(sdf(t.pelvis[i * 3], t.pelvis[i * 3 + 1], t.pelvis[i * 3 + 2]), sdf(t.pelvis[i * 3], t.pelvis[i * 3 + 1] + 0.45, t.pelvis[i * 3 + 2]));
      t.pelvisRoom[i] = Math.max(0, d - 0.2);
      if ((i & 7) === 7) yield;
    }

    // 3. Holds per limb.
    const L = spec.cycle;
    for (const limb of LIMB_INDICES) {
      const o = spec.offsets[limb];
      const P = spec.periods[limb] * L;
      const maxIndex = Math.ceil((t.total + L) / P - o) + 2;
      const count2 = Math.max(1, maxIndex + 1);
      const arr = new Float32Array(count2 * HOLD_STRIDE);
      const side = limbSide(limb);
      for (let i = 0; i < count2; i += 1) {
        // Hold i is grabbed when the cycle coordinate c = (i + o)·P, i.e. once the lead-in is done at s = c − L + s0.
        const sGrab = (i + o) * P - L + t.s0;
        // Holds are placed relative to the body at the MIDDLE of the time they are held (the body climbs past
        // them, so on a curving route they do not trail behind); the reach is measured from the grab.
        const hold = (1 - spec.moves[limb]) * P * 0.5;
        // Hands start from where the climber stands (never from below the start); feet may begin on the ground
        // (on the lip, the scramble's feet also start at the lip).
        const sAnchor = isArm(limb) || spec.stand === 'lip' ? Math.max(0, sGrab) : sGrab;
        frameAt(t, Math.min(sAnchor + hold, t.total), a, n1, n2);
        const anchorLift = sAnchor + hold <= t.total ? hold : Math.max(0, t.total - sAnchor);
        wallBasis(n1, _scratchU, _scratchL);
        _scratchH.set(n1.x, 0, n1.z);
        if (_scratchH.lengthSq() < 1e-6) _scratchH.set(0, 0, 1);
        _scratchH.normalize().negate();
        const jitterLat = (hash01(index, limb * 131 + i, 3) - 0.5) * 0.14;
        const jitterUp = (hash01(index, limb * 131 + i, 9) - 0.5) * 0.12;
        let kind = 0;
        let placed = false;
        if (isArm(limb)) {
          // Progress at the grab: during the lead-in the cycle advances by itself (c = L · leadIn(p)).
          const cGrab = (i + o) * P;
          const pg = cGrab <= L ? lerp(spec.leadIn[0], spec.leadIn[1], cGrab / L) : tablePAtS(t, sGrab);
          const axe = iceAxeModeAt(pg, AXE_EQUIP, AXE_DROP) === 'hands';
          const reach = (axe ? spec.pickReach : spec.handReach) + jitterUp - anchorLift;
          q.copy(a).addScaledVector(_scratchU, reach);
          if (q.y > t.topY - 0.3) {
            // Near the top the hands grip the lip's edge itself (fists around the axes on the walls): the face
            // just under each lip bulges out toward the route, so a tool hanging there would clip it.
            q.copy(t.topEdge[side > 0 ? 0 : 1]);
            n2.copy(t.topNormal).add(UP).normalize();
            kind = 2;
            placed = true;
          } else {
            q.copy(a).addScaledVector(_scratchU, reach).addScaledVector(_scratchL, side * spec.handSpread + jitterLat);
          }
        } else {
          const reach = spec.footReach + jitterUp * 0.6 - anchorLift;
          const stance = groundStanceFor(spec);
          const top = topStanceFor(spec);
          if (sGrab + reach + anchorLift < 0.32 && stance) {
            // Still on the ground at the foot of the wall: the feet stay where the previous stance put them.
            stanceFootAt(stance, 1, side, q);
            n2.set(0, 1, 0);
            kind = 1;
            placed = true;
          } else if (sGrab + reach + anchorLift > t.total - 0.02 && top) {
            // Top-out: step onto the top where the next stance starts.
            stanceFootAt(top, 0, side, q);
            n2.set(0, 1, 0);
            kind = 1;
            placed = true;
          } else {
            q.copy(a).addScaledVector(_scratchU, reach).addScaledVector(_scratchL, side * spec.footSpread + jitterLat * 0.6);
          }
        }
        if (!placed) {
          // Onto the rock: horizontally into the wall from in front of the climber, else straight into the
          // face along its normal, else straight down, else the nearest rock; a hit must stay near the wish.
          _scratchN.copy(q);
          let ok = false;
          for (let attempt = 0; attempt < 4 && !ok; attempt += 1) {
            q.copy(_scratchN);
            if (attempt === 0) {
              q.addScaledVector(_scratchH, -0.25);
              ok = projectAlong(q, _scratchH, 2.0, n2);
            } else if (attempt === 1) {
              _scratchU.copy(n1).negate();
              q.addScaledVector(_scratchU, -0.25);
              ok = projectAlong(q, _scratchU, 2.0, n2);
              wallBasis(n1, _scratchU, _scratchL);
            } else if (attempt === 2) {
              _scratchU.set(0, -1, 0);
              ok = projectAlong(q, _scratchU, 1.5, n2);
              wallBasis(n1, _scratchU, _scratchL);
            } else {
              ok = project(q, n2) < 0.004;
            }
            if (ok && q.distanceTo(_scratchN) > 1.2) ok = false;
            yield;
          }
          if (!ok && i > 0) {
            q.set(arr[(i - 1) * HOLD_STRIDE], arr[(i - 1) * HOLD_STRIDE + 1], arr[(i - 1) * HOLD_STRIDE + 2]).addScaledVector(_scratchU, P * 0.5);
            n2.set(arr[(i - 1) * HOLD_STRIDE + 3], arr[(i - 1) * HOLD_STRIDE + 4], arr[(i - 1) * HOLD_STRIDE + 5]);
            project(q, n2);
          }
        }
        arr[i * HOLD_STRIDE] = q.x;
        arr[i * HOLD_STRIDE + 1] = q.y;
        arr[i * HOLD_STRIDE + 2] = q.z;
        arr[i * HOLD_STRIDE + 3] = n2.x;
        arr[i * HOLD_STRIDE + 4] = n2.y;
        arr[i * HOLD_STRIDE + 5] = n2.z;
        arr[i * HOLD_STRIDE + 6] = kind;
        yield;
      }
      t.holds[limb] = arr;
      t.holdCount[limb] = count2;
    }
    t.ready = true;
  }

  function* buildLip(): Generator<void, void, void> {
    // The lip's nose: the most protruding rock (max z) around the grip height, then projected.
    const g = CATCH_HANG.grip;
    function* findNose(x: number, out: THREE.Vector3): Generator<void, void, void> {
      let bestZ = -1e9;
      let bestY = g[1];
      for (let y = g[1] - 0.25; y <= g[1] + 0.25; y += 0.025) {
        yield;
        let z = g[2] + 0.6;
        let d = sdf(x, y, z);
        for (let it = 0; it < 60 && d > 0.002; it += 1) {
          z -= Math.max(0.003, d * 0.8);
          d = sdf(x, y, z);
        }
        if (z > bestZ) {
          bestZ = z;
          bestY = y;
        }
      }
      // Grip on top of the nose: a little above the most protruding point.
      out.set(x, bestY + 0.04, bestZ + 0.02);
      project(out, _scratchN);
    }
    yield* findNose(g[0], lip.right);
    yield;
    // Character faces −Z at the lip: its left is world −X.
    yield* findNose(g[0] - 0.36, lip.left);
    yield;
    gradient(lip.right.x, lip.right.y, lip.right.z, lip.normal);
    yield* findNose(g[0] - 0.08, lip.footRight);
    yield* findNose(g[0] - 0.3, lip.footLeft);
    yield;
    // Pillar takeoff: march from the stand spot along the leap until the ground drops away.
    const spot = spots.pillar;
    const dirX = Math.sin(LEAP2_YAW);
    const dirZ = Math.cos(LEAP2_YAW);
    const g0 = groundY(spot, STAND_SPOTS.pillar.cx, STAND_SPOTS.pillar.cz);
    let edge = 0;
    for (let s = 0; s < 0.75; s += 0.02) {
      const h = traceDown(STAND_SPOTS.pillar.cx + dirX * s, STAND_SPOTS.pillar.cz + dirZ * s, g0 + 0.6, g0 - 3);
      if (h < g0 - 0.2) break;
      edge = s;
      yield;
    }
    const s = Math.max(0, edge - 0.08);
    pillarTakeoff.set(STAND_SPOTS.pillar.cx + dirX * s, 0, STAND_SPOTS.pillar.cz + dirZ * s);
    pillarTakeoff.y = traceDown(pillarTakeoff.x, pillarTakeoff.z, g0 + 0.6, g0 - 3);
    lip.ready = true;
  }

  function* buildAll(): Generator<void, void, void> {
    // Base camp first (needed from the very start), then everything in route order.
    yield* buildSpot(spots.base, STAND_SPOTS.base.cy);
    yield* buildClimb(climbs[0], 0);
    yield* buildSpot(spots.ledge1, STAND_SPOTS.ledge1.cy);
    yield* buildSpot(spots.landing, STAND_SPOTS.landing.cy);
    yield* buildClimb(climbs[1], 1);
    yield* buildSpot(spots.pillar, STAND_SPOTS.pillar.cy);
    yield* buildLip();
    yield* buildClimb(climbs[2], 2);
    yield* buildSpot(spots.summit, STAND_SPOTS.summit.cy);
  }

  let builder: Generator<void, void, void> | null = buildAll();
  let ready = false;

  const stepBuild = (ms: number): void => {
    if (!builder) return;
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    for (;;) {
      const r = builder.next();
      if (r.done) {
        builder = null;
        ready = true;
        return;
      }
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now - start >= ms) return;
    }
  };

  const prepare = (): void => stepBuild(Number.POSITIVE_INFINITY);

  /* ------------------------------------------------------------------
   * Target-pose FK (world transforms of the torso from a BodyPose)
   * ------------------------------------------------------------------ */

  interface TorsoFK {
    qRoot: THREE.Quaternion;
    qPelvis: THREE.Quaternion;
    qSpine: THREE.Quaternion;
    qChest: THREE.Quaternion;
    qNeck: THREE.Quaternion;
    qHead: THREE.Quaternion;
    pPelvis: THREE.Vector3;
    pSpine: THREE.Vector3;
    pChest: THREE.Vector3;
    pNeck: THREE.Vector3;
    pHead: THREE.Vector3;
    shoulder: [THREE.Vector3, THREE.Vector3];
    hip: [THREE.Vector3, THREE.Vector3];
  }

  const createTorsoFK = (): TorsoFK => ({
    qRoot: new THREE.Quaternion(),
    qPelvis: new THREE.Quaternion(),
    qSpine: new THREE.Quaternion(),
    qChest: new THREE.Quaternion(),
    qNeck: new THREE.Quaternion(),
    qHead: new THREE.Quaternion(),
    pPelvis: new THREE.Vector3(),
    pSpine: new THREE.Vector3(),
    pChest: new THREE.Vector3(),
    pNeck: new THREE.Vector3(),
    pHead: new THREE.Vector3(),
    shoulder: [new THREE.Vector3(), new THREE.Vector3()],
    hip: [new THREE.Vector3(), new THREE.Vector3()],
  });

  const _fkV = new THREE.Vector3();
  const torsoFK = (pose: BodyPose, fk: TorsoFK): TorsoFK => {
    yawRotation(pose.yaw, fk.qRoot);
    fk.qPelvis.multiplyQuaternions(fk.qRoot, pose.pelvisRot);
    fk.pPelvis.copy(pose.pelvisPos);
    fk.qSpine.multiplyQuaternions(fk.qPelvis, pose.spine);
    fk.pSpine.copy(fk.pPelvis).add(_fkV.copy(R.Spine).applyQuaternion(fk.qPelvis));
    fk.qChest.multiplyQuaternions(fk.qSpine, pose.chest);
    fk.pChest.copy(fk.pSpine).add(_fkV.copy(R.Chest).applyQuaternion(fk.qSpine));
    fk.qNeck.multiplyQuaternions(fk.qChest, pose.neck);
    fk.pNeck.copy(fk.pChest).add(_fkV.copy(R.Neck).applyQuaternion(fk.qChest));
    fk.qHead.multiplyQuaternions(fk.qNeck, pose.head);
    fk.pHead.copy(fk.pNeck).add(_fkV.copy(R.Head).applyQuaternion(fk.qNeck));
    fk.shoulder[0].copy(fk.pChest).add(_fkV.copy(R.LeftArm).applyQuaternion(fk.qChest));
    fk.shoulder[1].copy(fk.pChest).add(_fkV.copy(R.RightArm).applyQuaternion(fk.qChest));
    fk.hip[0].copy(fk.pPelvis).add(_fkV.copy(R.LeftUpLeg).applyQuaternion(fk.qPelvis));
    fk.hip[1].copy(fk.pPelvis).add(_fkV.copy(R.RightUpLeg).applyQuaternion(fk.qPelvis));
    return fk;
  };

  /** World position of a torso-mounted socket (+ a local offset in the socket's bone frame). */
  const socketWorld = (fk: TorsoFK, name: GearSocketName, extra: THREE.Vector3 | null, out: THREE.Vector3): THREE.Vector3 => {
    const b = info.sockets[name];
    if (extra) out.copy(extra).applyQuaternion(b.rotation).add(b.offset);
    else out.copy(b.offset);
    switch (b.bone) {
      case 'Pelvis':
      case 'LeftUpLeg':
      case 'RightUpLeg':
        return out.applyQuaternion(fk.qPelvis).add(fk.pPelvis);
      case 'Spine':
        return out.applyQuaternion(fk.qSpine).add(fk.pSpine);
      case 'Neck':
      case 'Head':
        return out.applyQuaternion(fk.qNeck).add(fk.pNeck);
      default:
        return out.applyQuaternion(fk.qChest).add(fk.pChest);
    }
  };

  /** Point given in a bone frame of the target pose (Chest or Pelvis) → world. */
  const chestPoint = (fk: TorsoFK, x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 =>
    out.set(x, y, z).applyQuaternion(fk.qChest).add(fk.pChest);
  const pelvisPoint = (fk: TorsoFK, x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 =>
    out.set(x, y, z).applyQuaternion(fk.qPelvis).add(fk.pPelvis);

  /* ------------------------------------------------------------------
   * Pose building helpers
   * ------------------------------------------------------------------ */

  const fkScratch = new Float64Array(FK_COUNT);

  /** Writes an FK parameter vector into the pose (torso + limbs in FK, IK weights cleared). */
  const applyFK = (v: Float64Array, out: BodyPose): void => {
    torsoRotation(v[FKI.pitch], v[FKI.roll], v[FKI.twist], out.pelvisRot);
    torsoRotation(v[FKI.spine], 0, v[FKI.spineTwist], out.spine);
    torsoRotation(v[FKI.chest], v[FKI.chestSide], 0, out.chest);
    torsoRotation(v[FKI.neck], 0, 0, out.neck);
    torsoRotation(v[FKI.head], 0, 0, out.head);
    const L = out.limbs;
    armFK(info.armRest[0], 1, v[FKI.lRaise], v[FKI.lSpread], v[FKI.lElbow], v[FKI.lElbowOut], L[0].fkUpper, L[0].fkLower);
    armFK(info.armRest[1], -1, v[FKI.rRaise], v[FKI.rSpread], v[FKI.rElbow], v[FKI.rElbowOut], L[1].fkUpper, L[1].fkLower);
    handRotation(0.12 + 0.1 * clamp01(v[FKI.lElbow]), 0.05, 0, 1, L[0].fkEnd);
    handRotation(0.12 + 0.1 * clamp01(v[FKI.rElbow]), 0.05, 0, -1, L[1].fkEnd);
    legFK(info.legRest[0], 1, v[FKI.lHip], v[FKI.lHipOut], v[FKI.lKnee], v[FKI.lKneeOut], L[2].fkUpper, L[2].fkLower);
    legFK(info.legRest[1], -1, v[FKI.rHip], v[FKI.rHipOut], v[FKI.rKnee], v[FKI.rKneeOut], L[3].fkUpper, L[3].fkLower);
    for (let i = 0; i < 4; i += 1) {
      L[i].ik = 0;
      L[i].plant = 0;
      L[i].reach = 0;
      L[i].fkEnd.normalize();
    }
    out.wallNormal.set(0, 0, 0);
    out.wallRoom = 10;
  };

  /** Neutral FK on every limb (used as the fallback beneath IK). */
  const neutralFK = (out: BodyPose): void => {
    fkScratch.set(NEUTRAL_VECTOR);
    applyFK(fkScratch, out);
  };
  const NEUTRAL_VECTOR = fkVector({});

  const _foot = new THREE.Vector3();
  const _pole = new THREE.Vector3();

  /** Plants a foot (IK) on standing ground: sole on (x, groundY, z), toes along `footYaw`. */
  const plantFoot = (limb: LimbPose, side: 1 | -1, x: number, y: number, z: number, footYaw: number, lift: number, toeOut: number): void => {
    limb.ik = 1;
    limb.target.set(x, y + 0.004 + lift, z);
    yawOffset(footYaw, side * Math.sin(toeOut), Math.cos(toeOut), _pole);
    _pole.y = 0.04;
    limb.pole.copy(_pole).normalize();
    limb.effector.copy(info.sole[side > 0 ? 0 : 1]);
    limb.plant = 1 - clamp01(lift / 0.05);
    limb.reach = limb.plant;
    limb.normal.set(0, 1, 0);
  };

  interface StanceStep {
    foot: 0 | 1;
    start: number;
    end: number;
    /** Turn fraction (0..1) the foot is placed for at the end of this step. */
    frac: number;
  }

  interface Stance {
    spot: GroundSpot;
    yawFrom: number;
    yawTo: number;
    turnStart: number;
    turnEnd: number;
    centerFrom: readonly [number, number];
    centerTo: readonly [number, number];
    width: number;
    /** Left foot forward / right foot back (contrapposto), metres. */
    stagger: number;
    toeOut: number;
    steps: readonly StanceStep[];
  }

  const _stanceFoot = new THREE.Vector3();

  /** Foot position on the stance for a given turn fraction. */
  const stanceFootAt = (st: Stance, frac: number, side: 1 | -1, out: THREE.Vector3): number => {
    const yaw = lerp(st.yawFrom, st.yawTo, frac);
    const cx = lerp(st.centerFrom[0], st.centerTo[0], frac);
    const cz = lerp(st.centerFrom[1], st.centerTo[1], frac);
    yawOffset(yaw, side * st.width, side > 0 ? st.stagger : -st.stagger, _stanceFoot);
    out.set(cx + _stanceFoot.x, 0, cz + _stanceFoot.z);
    out.y = groundY(st.spot, out.x, out.z);
    return yaw;
  };

  const _stepFrom = new THREE.Vector3();
  const _stepTo = new THREE.Vector3();
  const _feetMid = new THREE.Vector3();

  /**
   * Evaluates a (turning) stance at p: yaw, planted / stepping feet. Returns
   * the facing yaw; `_feetMid` receives the midpoint of the feet on the ground.
   */
  const evalStance = (st: Stance, p: number, out: BodyPose, liftHeight: number): number => {
    const turn = smootherstep(st.turnStart, st.turnEnd, p);
    const yaw = lerp(st.yawFrom, st.yawTo, turn);
    _feetMid.set(0, 0, 0);
    for (let f = 0; f < 2; f += 1) {
      const side: 1 | -1 = f === 0 ? 1 : -1;
      let planted = 0;
      let active: StanceStep | null = null;
      for (let si = 0; si < st.steps.length; si += 1) {
        const step = st.steps[si];
        if (step.foot !== f) continue;
        if (p >= step.end) planted = step.frac;
        else if (p > step.start && !active) active = step;
      }
      const limb = out.limbs[f === 0 ? LIMB_LEFT_FOOT : LIMB_RIGHT_FOOT];
      if (active) {
        const e = smootherstep(active.start, active.end, p);
        const yawA = stanceFootAt(st, planted, side, _stepFrom);
        const yawB = stanceFootAt(st, active.frac, side, _stepTo);
        _foot.lerpVectors(_stepFrom, _stepTo, e);
        const lift = liftHeight * Math.sin(PI * e);
        plantFoot(limb, side, _foot.x, _foot.y, _foot.z, lerp(yawA, yawB, e), lift, st.toeOut);
        _feetMid.add(_foot);
      } else {
        const footYaw = stanceFootAt(st, planted, side, _foot);
        plantFoot(limb, side, _foot.x, _foot.y, _foot.z, footYaw, 0, st.toeOut);
        _feetMid.add(_foot);
      }
    }
    _feetMid.multiplyScalar(0.5);
    out.yaw = yaw;
    return yaw;
  };

  const _pelvisOff = new THREE.Vector3();

  /** Standing pelvis: above the feet, lowered by `crouch`, shifted (local left / forward) and rotated. */
  const standPelvis = (out: BodyPose, crouch: number, shiftX: number, shiftZ: number, pitch: number, roll: number, twist: number): void => {
    yawOffset(out.yaw, shiftX, shiftZ, _pelvisOff);
    out.pelvisPos.set(_feetMid.x + _pelvisOff.x, _feetMid.y + info.restPelvisY - 0.035 - crouch, _feetMid.z + _pelvisOff.z);
    torsoRotation(pitch, roll, twist, out.pelvisRot);
  };

  /** Time-driven breathing (0 when secondary motion is off). */
  const breath = (t: number, rate: number): number => (secondary ? Math.sin((t * 2 * PI) / rate) : 0);
  const micro = (t: number, a: number, b: number): number =>
    secondary ? 0.6 * Math.sin(t * a) + 0.4 * Math.sin(t * b + 1.3) : 0;

  const _gaze = new THREE.Vector3();
  const _camPos = new THREE.Vector3();
  const _camLook = new THREE.Vector3();

  /** World position of the camera at a progress value (deterministic: the authored rig). */
  const cameraAt = (p: number, out: THREE.Vector3): THREE.Vector3 => {
    sampleCameraRig(p, out, _camLook);
    return out;
  };

  const _handQ = new THREE.Quaternion();
  const _fingers = new THREE.Vector3();
  const _palmN = new THREE.Vector3();
  const _tmpV = new THREE.Vector3();
  const _tmpV2 = new THREE.Vector3();

  /** Arm IK toward a world point with the palm/grip as the contact. */
  const reachArm = (
    limb: LimbPose,
    side: 1 | -1,
    weight: number,
    target: THREE.Vector3,
    fingers: THREE.Vector3,
    palmNormal: THREE.Vector3,
    pole: THREE.Vector3,
    useGrip: boolean,
    plant = 0,
  ): void => {
    if (weight <= 0) return;
    const arm = side > 0 ? 0 : 1;
    // Blend from the current (FK or IK) goal toward this reach. Reaching for gear is not a rock contact.
    if (limb.ik <= 0) {
      limb.target.copy(target);
      limb.pole.copy(pole);
      limb.effector.copy(useGrip ? info.grip[arm] : info.palm[arm]);
      palmFrame(side, fingers, palmNormal, limb.hand);
      limb.ik = weight;
      limb.plant = plant;
      limb.reach = plant;
      limb.normal.set(0, 1, 0);
      return;
    }
    limb.plant = lerp(limb.plant, plant, weight);
    limb.reach = lerp(limb.reach, plant, weight);
    limb.target.lerp(target, weight);
    limb.pole.lerp(pole, weight).normalize();
    limb.effector.lerp(useGrip ? info.grip[arm] : info.palm[arm], weight);
    palmFrame(side, fingers, palmNormal, _handQ);
    limb.hand.slerp(_handQ, weight);
    limb.ik = lerp(limb.ik, 1, weight);
  };

  /* ------------------------------------------------------------------
   * Generator: base camp (idle, equipping, the turn to the wall)
   * ------------------------------------------------------------------ */

  const BASE_STANCE: Stance = {
    spot: spots.base,
    yawFrom: 0,
    yawTo: PI,
    turnStart: 0.2785,
    turnEnd: 0.2885,
    centerFrom: [0.0, 0.02],
    centerTo: [0.0, -0.06],
    width: 0.15,
    stagger: 0.05,
    toeOut: 0.12,
    steps: [
      { foot: 0, start: 0.279, end: 0.2825, frac: 0.33 },
      { foot: 1, start: 0.2815, end: 0.285, frac: 0.67 },
      { foot: 0, start: 0.284, end: 0.2875, frac: 1 },
      { foot: 1, start: 0.2865, end: 0.2895, frac: 1 },
    ],
  };

  const fkBase = createTorsoFK();
  const _gearPt = new THREE.Vector3();
  const _down = new THREE.Vector3(0, -1, 0);
  const _side = new THREE.Vector3();

  /** Hands to the hip holsters (drawing / holstering the ice axes); weight 0..1. */
  const handsToHolsters = (fk: TorsoFK, out: BodyPose, weight: number): void => {
    if (weight <= 0) return;
    for (let arm = 0; arm < 2; arm += 1) {
      const side: 1 | -1 = arm === 0 ? 1 : -1;
      socketWorld(fk, arm === 0 ? 'hipHolsterL' : 'hipHolsterR', null, _gearPt);
      _tmpV.set(side * 0.03, 0.07, 0.03).applyQuaternion(fk.qPelvis);
      _gearPt.add(_tmpV);
      _palmN.set(-side, 0, 0).applyQuaternion(fk.qPelvis);
      _side.set(side * 0.6, -0.2, -0.75).applyQuaternion(fk.qPelvis).normalize();
      reachArm(out.limbs[arm], side, weight, _gearPt, _down, _palmN, _side, true);
    }
  };

  const genBase = (p: number, t: number, out: BodyPose): void => {
    neutralFK(out);
    evalStance(BASE_STANCE, p, out, 0.07);
    const yaw = out.yaw;
    const b = breath(t, 4.2);
    // Gear check gestures: weights per item.
    const wPack = windowWeight(p, GE.backpack - 0.009, GE.backpack - 0.003, GE.backpack + 0.004, GE.backpack + 0.011);
    const wRope = windowWeight(p, GE.rope - 0.009, GE.rope - 0.003, GE.rope + 0.004, GE.rope + 0.011);
    const wAxes = windowWeight(p, GE.iceAxes - 0.009, GE.iceAxes - 0.003, GE.iceAxes + 0.004, GE.iceAxes + 0.011);
    const wHarness = windowWeight(p, GE.harness - 0.009, GE.harness - 0.003, GE.harness + 0.005, GE.harness + 0.012);
    const wDraw = smoothstep(0.2835, 0.2895, p);
    const look = Math.max(wPack, wRope, wAxes, wHarness);
    const packDip = 0.025 * bump(p, GE.backpack - 0.002, GE.backpack + 0.008);
    const crouch = 0.02 + 0.03 * wAxes + 0.02 * wHarness + packDip + 0.04 * bump(p, 0.278, 0.29);
    standPelvis(out, crouch, 0.022 * (1 - wDraw), -0.015 - 0.03 * wAxes, 0.02 + 0.08 * look + 0.06 * wAxes, -0.035 * (1 - wDraw), 0.04 * (1 - wDraw));
    torsoRotation(-0.04 + 0.03 * look - 0.012 * b, 0.02, 0.0, out.spine);
    torsoRotation(-0.06 + 0.06 * look + 0.08 * wAxes - 0.02 * b + 0.04 * packDip * 10, -0.015, 0, out.chest);
    // Arms relaxed with a breathing shrug.
    armFK(info.armRest[0], 1, 0.05, 0.14 + 0.01 * b, 0.24, 0.3, out.limbs[0].fkUpper, out.limbs[0].fkLower);
    armFK(info.armRest[1], -1, 0.08, 0.13 + 0.01 * b, 0.3, 0.3, out.limbs[1].fkUpper, out.limbs[1].fkLower);

    // Gaze: camera → into the distance → back over the shoulder at the wall → camera; gear checks look down at it.
    torsoFK(out, fkBase);
    cameraAt(p, _camPos);
    const wDistance = windowWeight(p, 0.103, 0.112, 0.133, 0.142);
    const wWall = windowWeight(p, 0.146, 0.154, 0.166, 0.174);
    _gaze.copy(_camPos);
    _tmpV.set(-9, 3.4, 13);
    _gaze.lerp(_tmpV, wDistance);
    _tmpV.set(-4.2, 3.6, -1.4);
    _gaze.lerp(_tmpV, wWall);
    out.gazeWeight = 0.85;
    if (wWall > 0) {
      // Glance back at the wall: the torso helps the head turn.
      torsoRotation(-0.04, 0.02, -0.18 * wWall, out.spine);
    }

    // Equipping: hands to each piece of gear as it locks on.
    if (wPack > 0) {
      const tug = 0.03 * bump(p, GE.backpack - 0.001, GE.backpack + 0.005);
      for (let arm = 0; arm < 2; arm += 1) {
        const side: 1 | -1 = arm === 0 ? 1 : -1;
        chestPoint(fkBase, side * 0.1, 0.02 - tug, 0.14, _gearPt);
        _fingers.set(-side * 0.25, 1, 0.1).applyQuaternion(fkBase.qChest).normalize();
        _palmN.set(0, 0, -1).applyQuaternion(fkBase.qChest);
        _side.set(side * 0.8, -0.5, -0.3).applyQuaternion(fkBase.qChest).normalize();
        reachArm(out.limbs[arm], side, wPack, _gearPt, _fingers, _palmN, _side, true);
      }
      chestPoint(fkBase, 0.12, -0.15, 0.6, _tmpV);
      _gaze.lerp(_tmpV, wPack);
    }
    if (wRope > 0) {
      socketWorld(fkBase, 'ropeCoil', _tmpV2.set(-0.02, 0.0, 0.1), _gearPt);
      _fingers.set(-0.3, 0.2, -1).applyQuaternion(fkBase.qChest).normalize();
      _palmN.set(0.4, -0.6, 0.0).applyQuaternion(fkBase.qChest).normalize();
      _side.set(-0.5, -0.8, 0.0).applyQuaternion(fkBase.qChest).normalize();
      reachArm(out.limbs[1], -1, wRope, _gearPt, _fingers, _palmN, _side, true);
      socketWorld(fkBase, 'ropeCoil', _tmpV2.set(0.05, -0.05, 0.25), _tmpV);
      _gaze.lerp(_tmpV, wRope);
    }
    if (wAxes > 0) {
      handsToHolsters(fkBase, out, wAxes);
      pelvisPoint(fkBase, 0, -0.4, 0.5, _tmpV);
      _gaze.lerp(_tmpV, wAxes);
    }
    if (wHarness > 0) {
      const cinch = 0.035 * bump(p, GE.harness - 0.001, GE.harness + 0.006);
      for (let arm = 0; arm < 2; arm += 1) {
        const side: 1 | -1 = arm === 0 ? 1 : -1;
        pelvisPoint(fkBase, side * (0.075 + cinch), 0.04, 0.15, _gearPt);
        _fingers.set(-side * 0.6, -0.8, 0).applyQuaternion(fkBase.qPelvis).normalize();
        _palmN.set(0, 0, -1).applyQuaternion(fkBase.qPelvis);
        _side.set(side, -0.3, -0.4).applyQuaternion(fkBase.qPelvis).normalize();
        reachArm(out.limbs[arm], side, wHarness, _gearPt, _fingers, _palmN, _side, true);
      }
      pelvisPoint(fkBase, 0, -0.2, 0.6, _tmpV);
      _gaze.lerp(_tmpV, wHarness);
    }
    // The turn to the wall: the gaze leads, then the hands reach back for the axes.
    const wTurn = smoothstep(0.276, 0.282, p);
    if (wTurn > 0) {
      _tmpV.set(0.4, 3.2, -4.0);
      _gaze.lerp(_tmpV, wTurn);
    }
    handsToHolsters(fkBase, out, wDraw);
    out.gaze.copy(_gaze);
    // Idle micro motion of the head.
    torsoRotation(0.02 * micro(t, 0.37, 0.71), 0, 0.03 * micro(t, 0.29, 0.53), out.head);
    out.yaw = yaw;
  };

  /* ------------------------------------------------------------------
   * Generator: climbing (both walls and the scramble)
   * ------------------------------------------------------------------ */

  const _fA = new THREE.Vector3();
  const _fN = new THREE.Vector3();
  const _fP = new THREE.Vector3();
  const _wUp = new THREE.Vector3();
  const _wLeft = new THREE.Vector3();
  const _hold0 = new THREE.Vector3();
  const _hold1 = new THREE.Vector3();
  const _n0 = new THREE.Vector3();
  const _n1 = new THREE.Vector3();
  const _shaft = new THREE.Vector3();
  const _pick = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _bodyQ = new THREE.Quaternion();
  const _yawQ = new THREE.Quaternion();
  const _qTmp = new THREE.Quaternion();
  const _qTmp2 = new THREE.Quaternion();
  const _mEnd = new THREE.Vector3();
  const fkClimb = createTorsoFK();
  const _swing: CatchSwing = { out: 0, side: 0 };

  const readHold = (tbl: ClimbTable, limb: LimbIndex, i: number, pos: THREE.Vector3, normal: THREE.Vector3): number => {
    const arr = tbl.holds[limb];
    const k = THREE.MathUtils.clamp(i, 0, tbl.holdCount[limb] - 1) * HOLD_STRIDE;
    pos.set(arr[k], arr[k + 1], arr[k + 2]);
    normal.set(arr[k + 3], arr[k + 4], arr[k + 5]);
    return arr[k + 6];
  };

  /** Pre-climb contact for a limb (hold index −1). */
  const preClimbContact = (tbl: ClimbTable, limb: LimbIndex, fk: TorsoFK, pos: THREE.Vector3, normal: THREE.Vector3): void => {
    const side = limbSide(limb);
    if (tbl.spec.stand === 'lip') {
      if (isArm(limb)) pos.copy(side > 0 ? lip.left : lip.right);
      else pos.copy(side > 0 ? lip.footLeft : lip.footRight);
      normal.copy(lip.normal);
      return;
    }
    if (isArm(limb)) {
      socketWorld(fk, side > 0 ? 'hipHolsterL' : 'hipHolsterR', null, pos);
      _tmpV.set(side * 0.03, 0.07, 0.03).applyQuaternion(fk.qPelvis);
      pos.add(_tmpV);
      normal.set(0, 1, 0);
      return;
    }
    // Feet: the first ground hold of the stance.
    readHold(tbl, limb, 0, pos, normal);
  };

  /**
   * 0..1: how much the climbing hands hold their ice axes. The gear system swaps the tools between holster and
   * fist at the window edges (ICE_AXES_IN_HANDS); the grip eases across ±0.001 around them so the hand
   * configuration never switches in a single step.
   */
  const AXE_GRIP_EASE = 0.001;
  const climbAxeWeight = (p: number): number => {
    let w = 0;
    for (let k = 0; k < ICE_AXE_WINDOWS.length; k += 1) {
      const a = ICE_AXE_WINDOWS[k][0];
      const b = ICE_AXE_WINDOWS[k][1];
      w = Math.max(w, smoothstep(a - AXE_GRIP_EASE, a + AXE_GRIP_EASE, p) * (1 - smoothstep(b - AXE_GRIP_EASE, b + AXE_GRIP_EASE, p)));
    }
    return w;
  };

  const _cfgWristB = new THREE.Vector3();
  const _cfgEB = new THREE.Vector3();
  const _cfgQB = new THREE.Quaternion();

  /** Planted configuration on a rock hold: the axe-pick configuration blended with the palm one by `axeW`. */
  const holdConfig = (
    axeW: number,
    side: 1 | -1,
    armIndex: number,
    point: THREE.Vector3,
    normal: THREE.Vector3,
    outWrist: THREE.Vector3,
    outQ: THREE.Quaternion,
    outE: THREE.Vector3,
  ): void => {
    if (axeW >= 1) {
      armConfig('axe', side, armIndex, point, normal, false, outWrist, outQ, outE);
      return;
    }
    armConfig('palm', side, armIndex, point, normal, false, outWrist, outQ, outE);
    if (axeW <= 0) return;
    armConfig('axe', side, armIndex, point, normal, false, _cfgWristB, _cfgQB, _cfgEB);
    outWrist.lerp(_cfgWristB, axeW);
    outE.lerp(_cfgEB, axeW);
    outQ.slerp(_cfgQB, axeW);
  };

  const _cfgWrist0 = new THREE.Vector3();
  const _cfgWrist1 = new THREE.Vector3();
  const _cfgE0 = new THREE.Vector3();
  const _cfgE1 = new THREE.Vector3();
  const _cfgQ0 = new THREE.Quaternion();
  const _cfgQ1 = new THREE.Quaternion();
  const _goal2 = new THREE.Vector3();
  const _xAxis = new THREE.Vector3(1, 0, 0);

  /**
   * A planted hand configuration in the climb's current wall frame: the hand orientation, the contact
   * offset (effector) and the resulting wrist position for a contact `point` with surface `normal`.
   * `topPress` marks a bare-hand press on a top surface (fingers forward over the top).
   */
  const armConfig = (
    kind: 'holster' | 'axe' | 'palm' | 'edge',
    side: 1 | -1,
    armIndex: number,
    point: THREE.Vector3,
    normal: THREE.Vector3,
    topPress: boolean,
    outWrist: THREE.Vector3,
    outQ: THREE.Quaternion,
    outE: THREE.Vector3,
  ): void => {
    if (kind === 'holster') {
      _palmN.set(-side, 0, 0).applyQuaternion(fkClimb.qPelvis);
      palmFrame(side, _down, _palmN, outQ);
      outE.copy(info.grip[armIndex]);
      _tmpV2.copy(point);
    } else if (kind === 'axe') {
      // Shaft up the face leaning into it; the pick into the rock (both from the wall frame: a bump under the
      // pick must not tilt the tool into the rock).
      _shaft.copy(_wUp).addScaledVector(_fN, -0.3).normalize();
      _pick.copy(_fN).negate();
      axeFrame(_shaft, _pick, outQ);
      outE.copy(info.pick[armIndex]);
      _tmpV2.copy(point).addScaledVector(topPress ? UP : normal, 0.004);
    } else {
      if (kind === 'edge') {
        // Gripping a lip's edge: fingers curl over the top, the wrist hangs out in front of the bulge below it.
        _fingers.set(-_fN.x, 0, -_fN.z).normalize().multiplyScalar(0.6).addScaledVector(UP, 0.8).addScaledVector(_wLeft, -side * 0.25).normalize();
        _palmN.copy(normal).negate();
      } else if (topPress) {
        _fingers.set(-_fN.x, 0, -_fN.z).normalize().addScaledVector(_wLeft, -side * 0.3).normalize();
        _palmN.set(0, -1, 0);
      } else {
        _fingers.copy(_wUp).addScaledVector(_wLeft, -side * 0.3).normalize();
        _palmN.copy(normal).negate();
      }
      palmFrame(side, _fingers, _palmN, outQ);
      outE.copy(info.palm[armIndex]);
      _tmpV2.copy(point).addScaledVector(topPress ? UP : normal, 0.012);
    }
    outWrist.copy(outE).applyQuaternion(outQ);
    outWrist.subVectors(_tmpV2, outWrist);
  };

  /** Progress over which the scramble rises out of the muscle-up crouch (done as the first hand takes its hold). */
  const LIP_RISE = 0.003;

  /** Closest a travelling wrist may pass the shoulder (an arm folded flat makes the elbow spin). */
  const KEEP_OUT = 0.26;
  const _ko = new THREE.Vector3();

  /**
   * A hand travelling between holds swings past the shoulder on the outside and in front of it (toward the
   * rock) instead of brushing through it; `weight` is the move's lift (0 on the holds, so plants are exact).
   */
  const shoulderKeepOut = (wrist: THREE.Vector3, shoulder: THREE.Vector3, side: 1 | -1, weight: number): void => {
    _ko.subVectors(wrist, shoulder);
    let d = _ko.length();
    const near = (1 - smoothstep(KEEP_OUT * 0.4, KEEP_OUT * 1.6, d)) * weight;
    if (near <= 0) return;
    wrist.addScaledVector(_wLeft, side * 0.5 * KEEP_OUT * near).addScaledVector(_fN, -0.25 * KEEP_OUT * near);
    _ko.subVectors(wrist, shoulder);
    d = _ko.length();
    if (d >= KEEP_OUT || d < 1e-6) return;
    // C1 remap of the distance onto [KEEP_OUT / 2, KEEP_OUT].
    const g = KEEP_OUT * 0.5 + (d * d) / (2 * KEEP_OUT);
    wrist.copy(shoulder).addScaledVector(_ko, lerp(d, g, weight) / d);
  };

  const genClimb = (tbl: ClimbTable, p: number, t: number, out: BodyPose): void => {
    const spec = tbl.spec;
    const L = spec.cycle;
    neutralFK(out);
    const s = tableSAtP(tbl, p);
    // The limb clock starts with the lead-in (the path may already creep before it).
    const c = Math.max(0, s - tbl.s0) + L * smootherstep(spec.leadIn[0], spec.leadIn[1], p);
    frameAt(tbl, s, _fA, _fN, _fP);
    wallBasis(_fN, _wUp, _wLeft);
    const yaw = Math.atan2(-_fN.x, -_fN.z);
    out.yaw = yaw < 0 ? yaw + 2 * PI : yaw;
    const axeW = climbAxeWeight(p);

    // Torso faces the rock (−n), leaning with the wall.
    _fwd.copy(_fN).negate();
    _fwd.y = THREE.MathUtils.clamp(_fwd.y, -0.55, 0.3);
    lookRotation(_fwd, _wUp, _bodyQ);

    // Per-limb move phases.
    let reachSide = 0;
    let stepDrop = 0;
    let gazeW = 0;
    _gaze.copy(_fA).addScaledVector(_wUp, 3).addScaledVector(_fN, 0.4);
    for (let li = 0; li < 4; li += 1) {
      const limb = LIMB_INDICES[li];
      const m = spec.moves[limb];
      const psi = c / (spec.periods[limb] * L) - spec.offsets[limb];
      const i = Math.floor(psi);
      const f = psi - i;
      const moving = f > 1 - m;
      const tm = moving ? (f - (1 - m)) / m : 0;
      const side = limbSide(limb);
      if (isArm(limb)) {
        if (moving) {
          reachSide += side * Math.sin(PI * tm);
          if (i + 1 >= 0) {
            readHold(tbl, limb, i + 1, _tmpV, _n1);
            const gw = Math.sin(PI * Math.min(1, tm * 1.4));
            _gaze.lerp(_tmpV, gw * 0.85);
            gazeW = Math.max(gazeW, gw);
          }
        }
      } else if (moving) {
        stepDrop += Math.sin(PI * tm);
      }
    }

    // Pelvis: anchored to the rock stand-off, bobbing with the pulls, swaying off the reaching hand.
    const bob = spec.bob * Math.sin((2 * PI * 2 * c) / L + 0.6);
    out.pelvisPos.copy(_fP).addScaledVector(_wUp, bob - 0.05 * stepDrop).addScaledVector(_wLeft, -spec.sway * reachSide);
    // While a foot still stands on the ground at the foot of a wall the hips can be no higher than standing over
    // it; they rise as that foot steps onto the rock (the path itself starts climbing a little earlier).
    if (spec.stand !== 'lip') {
      for (let leg = 2; leg < 4; leg += 1) {
        const limb = LIMB_INDICES[leg];
        const m = spec.moves[limb];
        const psi = c / (spec.periods[limb] * L) - spec.offsets[limb];
        const i = Math.floor(psi);
        const f = psi - i;
        const g0 = i < 0 || readHold(tbl, limb, i, _tmpV, _n0) === 1 ? 1 : 0;
        if (i < 0) readHold(tbl, limb, 0, _tmpV, _n0);
        const g1 = readHold(tbl, limb, i + 1, _tmpV2, _n1) === 1 ? 1 : 0;
        const ee = f > 1 - m ? smootherstep(0, 1, (f - (1 - m)) / m) : 0;
        const gw = lerp(g0, g1, ee);
        if (gw <= 0) continue;
        const capY = lerp(_tmpV.y, _tmpV2.y, ee) + info.restPelvisY - 0.04;
        if (out.pelvisPos.y > capY) out.pelvisPos.y = lerp(out.pelvisPos.y, capY, gw);
      }
    }
    // The scramble starts where the muscle-up finishes — crouched on the lip, hands beside the feet, chest over
    // them — and rises out of it as the first holds are taken.
    const crouch = spec.stand === 'lip' ? 1 - smootherstep(spec.leadIn[0], spec.leadIn[0] + LIP_RISE, p) : 0;
    if (crouch > 0) {
      muscleUpFinish(_tmpV, _qTmp);
      out.pelvisPos.lerp(_tmpV, crouch);
      _bodyQ.slerp(_qTmp, crouch);
    }
    // Mantle at the top: hands on the top surface, a press with the hips at the lip and the torso over the
    // hands, two step-ups onto the top, then standing up over the next stance.
    const S = tbl.total;
    const mantle = smoothstep(S - 1.15, S - 0.42, s);
    const standUp = smoothstep(S - 0.4, S - 0.015, s);
    const topStance = topStanceFor(spec);
    if (mantle > 0) {
      tablePathAtS(tbl, S, _mEnd);
      _tmpV.copy(_mEnd).addScaledVector(tbl.topNormal, 0.2);
      _tmpV.y = tbl.topY + 0.24;
      out.pelvisPos.lerp(_tmpV, mantle);
      stanceFootAt(topStance, 0, 1, _tmpV);
      stanceFootAt(topStance, 0, -1, _tmpV2);
      _tmpV.add(_tmpV2).multiplyScalar(0.5);
      _tmpV.y += info.restPelvisY - 0.06;
      out.pelvisPos.lerp(_tmpV, standUp);
      // Lean over the lip during the press, then stand tall.
      _fwd.set(-tbl.topNormal.x, 0, -tbl.topNormal.z).normalize();
      lookRotation(_fwd, UP, _qTmp);
      torsoRotation(0.75, 0, 0, _qTmp2);
      _qTmp.multiply(_qTmp2);
      _bodyQ.slerp(_qTmp, mantle * (1 - standUp));
      lookRotation(_fwd, UP, _qTmp);
      torsoRotation(0.08, 0, 0, _qTmp2);
      _qTmp.multiply(_qTmp2);
      _bodyQ.slerp(_qTmp, standUp);
    }
    _yawQ.setFromAxisAngle(UP, out.yaw).invert();
    out.pelvisRot.multiplyQuaternions(_yawQ, _bodyQ);
    torsoRotation(-spec.chestLean * (1 - mantle) * (1 - crouch) + 0.05 * stepDrop, 0.06 * reachSide, -0.08 * reachSide, _qTmp);
    out.pelvisRot.multiply(_qTmp);
    torsoRotation(-0.06 + 0.12 * stepDrop, 0.05 * reachSide, 0.1 * reachSide, out.spine);
    torsoRotation(-0.1 - 0.06 * Math.abs(reachSide), 0.1 * reachSide, 0.05 * reachSide, out.chest);
    torsoFK(out, fkClimb);
    // The reach constraints may not pull the hips into the rock (over the lip is fine once mantling).
    out.wallNormal.set(_fN.x, 0, _fN.z).normalize();
    out.wallRoom = lerp(roomAt(tbl, s), 10, mantle);

    // Limbs on the holds.
    for (let li = 0; li < 4; li += 1) {
      const limb = LIMB_INDICES[li];
      const m = spec.moves[limb];
      const psi = c / (spec.periods[limb] * L) - spec.offsets[limb];
      const i = Math.floor(psi);
      const f = psi - i;
      const lp = out.limbs[limb];
      const side = limbSide(limb);
      const arm = isArm(limb);
      // Hold the limb is planted on (or leaving), and the next.
      if (i < 0) preClimbContact(tbl, limb, fkClimb, _hold0, _n0);
      else readHold(tbl, limb, i, _hold0, _n0);
      readHold(tbl, limb, i + 1, _hold1, _n1);
      let e = 0;
      let lift = 0;
      let plant = 1;
      let reachW = 1;
      if (f > 1 - m) {
        const tm = (f - (1 - m)) / m;
        e = smootherstep(0, 1, tm);
        // Eased in and out: the hold is let go before the hand or foot visibly travels.
        const arc = Math.sin(PI * tm);
        lift = arc * arc;
        plant = movePlant(tm);
        reachW = moveReach(tm);
      }
      // A hold repeated (top-out spots) is not left and re-grabbed.
      if (_hold0.distanceToSquared(_hold1) < 1e-4) {
        e = 0;
        lift = 0;
        plant = 1;
        reachW = 1;
      }
      lp.target.lerpVectors(_hold0, _hold1, e);
      lp.normal.lerpVectors(_n0, _n1, e).normalize();
      lp.ik = 1;
      lp.plant = plant;
      lp.reach = reachW;
      // Rising out of the muscle-up crouch the hands push off the lip (out of reach once standing).
      if (arm && i < 0 && spec.stand === 'lip') {
        lp.plant *= crouch;
        lp.reach *= crouch;
      }
      // Mantle overrides: both hands reach the top spots, then the feet step up one after the other.
      let topW = 0;
      if (mantle > 0 || s > S - 1.4) {
        let w: number;
        const late = spec.key === 'scramble' ? 0.35 : 0;
        if (arm) w = side > 0 ? smootherstep(S - 1.4 + late, S - 1.08 + late, s) : smootherstep(S - 1.22 + late, S - 0.9 + late, s);
        else w = side < 0 ? smootherstep(S - 0.56, S - 0.3, s) : smootherstep(S - 0.3, S - 0.05, s);
        if (w > 0) {
          const arc = Math.sin(PI * w);
          if (!arm) {
            // Step up onto the top: the foot rises above the lip first, then moves in over it.
            stanceFootAt(topStance, 0, side, _hold1);
            const rise = smootherstep(0, 0.55, w);
            const across = smootherstep(0.35, 1, w);
            const y = lerp(lp.target.y, _hold1.y, rise) + 0.1 * arc;
            lp.target.lerp(_hold1, across);
            lp.target.y = y;
            lp.target.addScaledVector(tbl.topNormal, 0.06 * arc);
          }
          lp.normal.lerp(UP, w).normalize();
          lp.plant = Math.min(lerp(lp.plant, 1, w), movePlant(w));
          lp.reach = Math.min(lerp(lp.reach, 1, w), moveReach(w));
          if (w > 0.999) lp.plant = 1;
          // The regular cycle's step fades out: the override carries its own arc (the hands lift over the lip).
          lift = arm ? Math.max(lift * (1 - w), arc) : lift * (1 - w);
          e = Math.max(e, w);
          topW = w;
        }
      }
      if (arm) {
        // Arms: interpolate the WRIST between two planted configurations (holster / axe pick / palm), with
        // the hand orientation slerped and (with axes) cocked back mid-swing around the fist, so the arm
        // travels on a clean arc instead of dragging the fist past the face.
        const armIndex = side > 0 ? 0 : 1;
        const pre0 = i < 0 && spec.stand !== 'lip';
        const top1 = topW > 0;
        const edge0 = i >= 0 && readHold(tbl, limb, i, _tmpV, _tmpV2) > 1.5;
        const edge1 = readHold(tbl, limb, i + 1, _tmpV, _tmpV2) > 1.5;
        if (pre0) armConfig('holster', side, armIndex, _hold0, _n0, false, _cfgWrist0, _cfgQ0, _cfgE0);
        else if (i < 0 && spec.stand === 'lip') {
          // Palms pressing on the lip from the muscle-up; standing up they push off and come up by the hips.
          pelvisPoint(fkClimb, side * 0.22, -0.02, 0.16, _tmpV);
          _hold0.lerp(_tmpV, 1 - crouch);
          armConfig('palm', side, armIndex, _hold0, UP, true, _cfgWrist0, _cfgQ0, _cfgE0);
        } else if (edge0) armConfig('edge', side, armIndex, _hold0, _n0, false, _cfgWrist0, _cfgQ0, _cfgE0);
        else holdConfig(axeW, side, armIndex, _hold0, _n0, _cfgWrist0, _cfgQ0, _cfgE0);
        if (top1) {
          // The mantle target: the hands press on the top (with the axes still in the fists on the walls).
          _hold1.copy(tbl.topHands[armIndex]);
          armConfig('palm', side, armIndex, _hold1, UP, true, _cfgWrist1, _cfgQ1, _cfgE1);
        } else {
          if (edge1) armConfig('edge', side, armIndex, _hold1, _n1, false, _cfgWrist1, _cfgQ1, _cfgE1);
          else holdConfig(axeW, side, armIndex, _hold1, _n1, _cfgWrist1, _cfgQ1, _cfgE1);
        }
        const k = top1 ? topW : e;
        _goal2.lerpVectors(_cfgWrist0, _cfgWrist1, top1 ? smootherstep(0.3, 1, k) : k);
        if (top1) _goal2.y = lerp(_cfgWrist0.y, _cfgWrist1.y, smootherstep(0, 0.6, k)) + 0.08 * Math.sin(PI * k);
        _goal2.addScaledVector(_fN, spec.handArc * lift).addScaledVector(_wUp, 0.05 * lift);
        if (lift > 0) shoulderKeepOut(_goal2, fkClimb.shoulder[armIndex], side, lift);
        lp.hand.slerpQuaternions(_cfgQ0, _cfgQ1, k);
        if (axeW > 0 && lift > 0 && !edge1) {
          _qTmp.setFromAxisAngle(_xAxis, -1.0 * lift * axeW);
          lp.hand.multiply(_qTmp);
        }
        lp.effector.lerpVectors(_cfgE0, _cfgE1, k);
        lp.target.copy(lp.effector).applyQuaternion(lp.hand).add(_goal2);
        lp.pole.copy(_wLeft).multiplyScalar(side * 0.55).addScaledVector(_fN, 0.6).addScaledVector(_wUp, -0.65).normalize();
      } else {
        const legIndex = side > 0 ? 0 : 1;
        const ground0 = (i < 0 && spec.stand !== 'lip') || (i >= 0 && readHold(tbl, limb, i, _tmpV, _tmpV2) === 1);
        const ground1 = readHold(tbl, limb, i + 1, _tmpV, _tmpV2) === 1;
        lp.target.addScaledVector(_fN, spec.footArc * lift);
        lp.effector.lerpVectors(ground0 ? info.sole[legIndex] : info.edge[legIndex], ground1 ? info.sole[legIndex] : info.edge[legIndex], e);
        lp.target.addScaledVector(lp.normal, 0.008);
        const onGround = Math.max(lerp(ground0 ? 1 : 0, ground1 ? 1 : 0, e), topW);
        if (topW > 0) lp.effector.lerp(info.sole[legIndex], topW);
        const stepUp = topW > 0 && topW < 1 ? Math.sin(PI * topW) : 0;
        // Knees turned out on the wall (frog), forward on the ground.
        lp.pole
          .copy(_wLeft)
          .multiplyScalar(side * (0.9 - 0.75 * onGround))
          .addScaledVector(_fN, 0.45 * (1 - onGround))
          .addScaledVector(_wUp, -0.2 * (1 - onGround))
          .addScaledVector(_fwd, 0.9 * onGround)
          .addScaledVector(UP, 1.2 * stepUp)
          .addScaledVector(_wLeft, side * 0.6 * stepUp)
          .normalize();
      }
    }
    // Standing up from the mantle the hands leave the top: to the holsters on the walls (the axes go back at
    // 0.445 and 0.615), loose at the summit.
    if (spec.stand !== 'lip') {
      const axeEnd = spec.key === 'wall1' ? ICE_AXE_WINDOWS[0][1] : ICE_AXE_WINDOWS[1][1];
      handsToHolsters(fkClimb, out, Math.max(standUp, smoothstep(axeEnd - 0.0045, axeEnd - 0.0005, p)));
    } else if (standUp > 0) {
      for (let arm = 0; arm < 2; arm += 1) {
        out.limbs[arm].ik *= 1 - standUp;
        out.limbs[arm].plant *= 1 - standUp;
        out.limbs[arm].reach *= 1 - standUp;
      }
    }
    out.gaze.copy(_gaze);
    out.gazeWeight = 0.55 + 0.3 * gazeW;
    torsoRotation(0.015 * micro(t, 0.9, 1.7), 0, 0, out.head);
  };

  /* ------------------------------------------------------------------
   * Generator: ledge 1 → jump across chasm 1 → landing on ledge 2
   * ------------------------------------------------------------------ */

  const LEDGE1_STANCE: Stance = {
    spot: spots.ledge1,
    yawFrom: PI,
    yawTo: JUMP1_YAW,
    turnStart: 0.4415,
    turnEnd: 0.4465,
    centerFrom: [0.0, -8.38],
    centerTo: [-0.08, -8.45],
    width: 0.13,
    stagger: 0.02,
    toeOut: 0.1,
    steps: [
      { foot: 1, start: 0.4418, end: 0.4442, frac: 0.6 },
      { foot: 0, start: 0.4436, end: 0.446, frac: 1 },
      { foot: 1, start: 0.4452, end: 0.4472, frac: 1 },
    ],
  };

  const LANDING_STANCE: Stance = {
    spot: spots.landing,
    yawFrom: JUMP1_YAW,
    yawTo: PI,
    turnStart: 0.5225,
    turnEnd: 0.5268,
    centerFrom: [5.0, -13.85],
    centerTo: [5.0, -13.95],
    width: 0.16,
    stagger: 0.0,
    toeOut: 0.12,
    steps: [
      { foot: 0, start: 0.5228, end: 0.5248, frac: 0.6 },
      { foot: 1, start: 0.5243, end: 0.5263, frac: 1 },
      { foot: 0, start: 0.5255, end: 0.5272, frac: 1 },
    ],
  };

  const fkLedge = createTorsoFK();
  const _comOffset = new THREE.Vector3();
  const _standPelvis = new THREE.Vector3();
  const _path = new THREE.Vector3();

  const genLedge1 = (p: number, t: number, out: BodyPose): void => {
    const takeoff = PATH_PHASES.ascentEnd;
    const landing = PATH_PHASES.jumpOneEnd;
    evalTrack(JUMP1_TRACK, p, fkScratch);
    applyFK(fkScratch, out);
    const pitch = fkScratch[FKI.pitch];
    // Standing / loading on ledge 1.
    let standW = 1 - smoothstep(takeoff - 0.0012, takeoff + 0.0008, p);
    let landW = smoothstep(landing - 0.0035, landing - 0.0005, p);
    if (p < 0.49) {
      evalStance(LEDGE1_STANCE, p, out, 0.06);
      const load = bump(p, 0.4445, 0.4505);
      const crouch = 0.02 + 0.3 * load;
      standPelvis(out, crouch, 0, -0.12 * load, 0, 0, 0);
      _standPelvis.copy(out.pelvisPos);
      torsoRotation(pitch, 0, 0, out.pelvisRot);
      landW = 0;
    } else {
      evalStance(LANDING_STANCE, p, out, 0.06);
      const absorb = bump(p, landing - 0.0015, landing + 0.0075);
      standPelvis(out, 0.03 + 0.36 * absorb, 0, -0.1 * absorb, 0, 0, 0);
      _standPelvis.copy(out.pelvisPos);
      torsoRotation(pitch, 0, 0, out.pelvisRot);
      standW = 0;
    }
    const feetW = Math.max(standW, landW);
    for (let f = 2; f < 4; f += 1) {
      out.limbs[f].ik *= feetW;
      out.limbs[f].plant *= feetW;
      out.limbs[f].reach *= feetW;
    }
    // Airborne: the body's centre follows the path's ballistic arc + 1.0 (offsets fade in / out).
    protagonistPositionAt(p, _path);
    _path.y += 1.0;
    if (p < 0.49) {
      _comOffset.copy(_standPelvis).sub(_path);
      const fade = 1 - smoothstep(takeoff, takeoff + 0.012, p);
      _path.addScaledVector(_comOffset, fade);
      out.pelvisPos.lerpVectors(_path, _standPelvis, standW);
      out.yaw = lerp(JUMP1_YAW, out.yaw, standW);
    } else {
      _comOffset.copy(_standPelvis).sub(_path);
      const fade = smoothstep(landing - 0.014, landing, p);
      _path.addScaledVector(_comOffset, fade);
      out.pelvisPos.lerpVectors(_path, _standPelvis, landW);
      out.yaw = lerp(JUMP1_YAW, out.yaw, landW);
    }
    torsoFK(out, fkLedge);
    // Holster the axes at the top-out (0.445), draw them on landing (0.525).
    const holster = windowWeight(p, 0.4405, 0.4445, 0.4455, 0.448);
    const draw = smoothstep(0.5215, 0.5248, p);
    handsToHolsters(fkLedge, out, Math.max(holster, draw));
    // Gaze: the landing spot across the chasm, then the pillar.
    _gaze.set(WAYPOINTS.chasmOneLanding[0], WAYPOINTS.chasmOneLanding[1] + 0.3, WAYPOINTS.chasmOneLanding[2]);
    _tmpV.set(WAYPOINTS.chasmOneLanding[0], WAYPOINTS.chasmOneLanding[1] + 4, WAYPOINTS.chasmOneLanding[2] - 2);
    _gaze.lerp(_tmpV, smoothstep(0.5215, 0.526, p));
    out.gaze.copy(_gaze);
    out.gazeWeight = 0.7 * (1 - bump(p, 0.458, 0.49));
    void t;
  };

  /* ------------------------------------------------------------------
   * Generator: chasm 2 — explosive step, dive, one-handed catch, hang, muscle-up
   * ------------------------------------------------------------------ */

  const PILLAR_STANCE: Stance = {
    spot: spots.pillar,
    yawFrom: PI,
    yawTo: LEAP2_YAW,
    turnStart: 0.6125,
    turnEnd: 0.619,
    centerFrom: [5.05, -16.45],
    centerTo: [5.1, -16.6],
    width: 0.13,
    stagger: 0.0,
    toeOut: 0.1,
    steps: [
      { foot: 0, start: 0.613, end: 0.6155, frac: 0.6 },
      { foot: 1, start: 0.615, end: 0.6175, frac: 1 },
      { foot: 0, start: 0.6168, end: 0.619, frac: 1 },
    ],
  };

  const fkLeap = createTorsoFK();
  const _gripMid = new THREE.Vector3();
  const _hangCom = new THREE.Vector3();
  const _hangUp = new THREE.Vector3();
  const _lipLeft = new THREE.Vector3();
  const _lipOut = new THREE.Vector3();

  /** Muscle-up keys: pelvis offset from the grips' midpoint (along lip-left, up, out) and torso pitch. */
  const MUSCLE_UP = {
    tau: [0, 0.3, 0.5, 0.72, 0.88, 1],
    up: [-1.1, -0.62, -0.3, 0.02, 0.14, 0.3],
    out: [0.12, 0.2, 0.24, 0.27, 0.3, 0.34],
    pitch: [0.0, 0.12, 0.75, 0.85, 0.7, 0.55],
    hip: [0.25, 0.85, 1.05, 0.45, 0.5, 0.6],
    knee: [0.35, 1.1, 1.25, 0.6, 0.8, 1.0],
  } as const;

  const _mfMid = new THREE.Vector3();
  const _mfOut = new THREE.Vector3();
  const _mfQ = new THREE.Quaternion();

  /** Pelvis position and world body rotation at the end of the muscle-up (both hands on the lip, chest over it). */
  const muscleUpFinish = (pos: THREE.Vector3, q: THREE.Quaternion): void => {
    const k = MUSCLE_UP.tau.length - 1;
    _mfOut.set(lip.normal.x, 0, lip.normal.z).normalize();
    _mfMid.lerpVectors(lip.left, lip.right, 0.5);
    pos.copy(_mfMid).addScaledVector(UP, MUSCLE_UP.up[k]).addScaledVector(_mfOut, MUSCLE_UP.out[k]);
    _mfOut.negate();
    lookRotation(_mfOut, UP, q);
    torsoRotation(MUSCLE_UP.pitch[k], 0, 0, _mfQ);
    q.multiply(_mfQ);
  };

  const sampleKeys = (taus: readonly number[], values: readonly number[], tau: number): number => {
    if (tau <= taus[0]) return values[0];
    for (let i = 0; i < taus.length - 1; i += 1) {
      if (tau <= taus[i + 1]) return lerp(values[i], values[i + 1], smootherstep(taus[i], taus[i + 1], tau));
    }
    return values[values.length - 1];
  };

  const _leapAir = createBodyPose();
  const _leapHang = createBodyPose();
  /** Half-width of the crossfade from the dive into the hang around the catch. */
  const CATCH_BLEND = 0.0016;

  /** Pillar top → explosive step → takeoff → dive → reaching for the lip (valid up to the catch). */
  const leapAir = (p: number, out: BodyPose): void => {
    const P = PATH_PHASES;
    evalTrack(LEAP2_TRACK, p, fkScratch);
    applyFK(fkScratch, out);
    const pitch = fkScratch[FKI.pitch];
    evalStance(PILLAR_STANCE, p, out, 0.07);
    const stepR = smootherstep(0.6195, 0.6245, p);
    const stepL = smootherstep(0.6245, 0.6292, p);
    const yawL = out.yaw;
    // Right foot steps toward the edge, then the left (takeoff) foot plants at the edge.
    if (stepR > 0) {
      _foot.copy(out.limbs[LIMB_RIGHT_FOOT].target).lerp(_tmpV.set(pillarTakeoff.x - 0.12 * Math.cos(yawL), pillarTakeoff.y, pillarTakeoff.z + 0.12 * Math.sin(yawL)), stepR * 0.6);
      _foot.y = groundY(spots.pillar, _foot.x, _foot.z);
      plantFoot(out.limbs[LIMB_RIGHT_FOOT], -1, _foot.x, _foot.y, _foot.z, yawL, 0.08 * Math.sin(PI * stepR), 0.1);
    }
    if (stepL > 0) {
      _foot.copy(out.limbs[LIMB_LEFT_FOOT].target).lerp(pillarTakeoff, stepL);
      _foot.y = groundY(spots.pillar, _foot.x, _foot.z);
      plantFoot(out.limbs[LIMB_LEFT_FOOT], 1, _foot.x, _foot.y, _foot.z, yawL, 0.08 * Math.sin(PI * stepL), 0.1);
      // The right foot swings through and leaves the ground.
      out.limbs[LIMB_RIGHT_FOOT].ik *= 1 - smoothstep(0.6265, 0.6295, p);
      out.limbs[LIMB_RIGHT_FOOT].plant *= 1 - smoothstep(0.6265, 0.6295, p);
      out.limbs[LIMB_RIGHT_FOOT].reach *= 1 - smoothstep(0.6265, 0.6295, p);
    }
    _feetMid.copy(out.limbs[LIMB_LEFT_FOOT].target).add(out.limbs[LIMB_RIGHT_FOOT].target).multiplyScalar(0.5);
    _feetMid.lerp(out.limbs[LIMB_LEFT_FOOT].target, smoothstep(0.626, 0.63, p));
    _feetMid.y -= 0.004;
    const load = bump(p, 0.6265, 0.6328);
    standPelvis(out, 0.03 + 0.26 * load + 0.04 * bump(p, 0.615, 0.621), 0, -0.05 + 0.1 * stepR, 0, 0, 0);
    torsoRotation(pitch, 0, 0, out.pelvisRot);
    _standPelvis.copy(out.pelvisPos);
    // Takeoff: feet leave; the centre of mass joins the ballistic arc.
    const air = smoothstep(P.leapTwoTakeoff - 0.0008, P.leapTwoTakeoff + 0.0006, p);
    for (let f = 2; f < 4; f += 1) {
      out.limbs[f].ik *= 1 - air;
      out.limbs[f].plant *= 1 - air;
      out.limbs[f].reach *= 1 - air;
    }
    if (air > 0) {
      protagonistPositionAt(p, _path);
      _path.y += CATCH_HANG.comHeight;
      // Offset at takeoff fades out over the early flight.
      protagonistPositionAt(P.leapTwoTakeoff, _tmpV);
      _tmpV.y += CATCH_HANG.comHeight;
      _comOffset.copy(_standPelvis).sub(_tmpV);
      const fade = 1 - smoothstep(P.leapTwoTakeoff, P.leapTwoTakeoff + 0.016, p);
      _path.addScaledVector(_comOffset, fade);
      out.pelvisPos.lerpVectors(_standPelvis, _path, air);
      // In the air the body turns from the leap heading toward the wall.
      out.yaw = lerp(out.yaw, lerp(LEAP2_YAW, PI, smoothstep(0.664, P.leapTwoCatch, p)), air);
    }
    torsoFK(out, fkLeap);
    handsToHolsters(fkLeap, out, windowWeight(p, 0.6105, 0.6145, 0.6155, 0.6185));
    // Reach: the RightHand closes on the lip at the catch.
    const reach = smoothstep(0.6705, 0.6792, p);
    if (reach > 0) {
      lipHandFrame(_fingers, _palmN);
      _side.copy(_lipLeft).multiplyScalar(-0.6).addScaledVector(_lipOut, 0.5).addScaledVector(UP, -0.5).normalize();
      reachArm(out.limbs[LIMB_RIGHT_HAND], -1, reach, lip.right, _fingers, _palmN, _side, false);
      out.limbs[LIMB_RIGHT_HAND].plant = smoothstep(0.677, 0.68, p);
      out.limbs[LIMB_RIGHT_HAND].reach = out.limbs[LIMB_RIGHT_HAND].plant;
      out.limbs[LIMB_RIGHT_HAND].normal.copy(lip.normal);
    }
    out.gaze.set(CATCH_HANG.grip[0], CATCH_HANG.grip[1], CATCH_HANG.grip[2]);
    out.gazeWeight = 0.8;
  };

  /** Fingers over the lip, palm on its top-front. */
  const lipHandFrame = (fingers: THREE.Vector3, palm: THREE.Vector3): void => {
    fingers.set(0, 0.45, 0).addScaledVector(_lipOut, -0.75).normalize();
    palm.set(0, -0.65, 0).addScaledVector(_lipOut, -0.75).normalize();
  };

  /** The one-handed hang below the lip, then the muscle-up onto ledge 3 (valid from the catch). */
  const leapHang = (p: number, out: BodyPose): void => {
    const P = PATH_PHASES;
    neutralFK(out);
    const tauHang = clamp01((p - P.leapTwoCatch) / (P.hangEnd - P.leapTwoCatch));
    const tauMU = clamp01((p - P.hangEnd) / (P.leapTwoEnd - P.hangEnd));
    catchSwingAt(Math.max(p, P.leapTwoCatch), _swing);
    const twoHands = smoothstep(0.6922, 0.6985, p);
    _gripMid.copy(lip.right).lerp(_tmpV.lerpVectors(lip.right, lip.left, 0.5), twoHands);
    out.yaw = PI;
    // Pelvis: the swinging centre of mass (= path + comHeight), shifted under both hands once they are on.
    hangingCentreOfMass(_swing, _hangCom);
    _hangCom.x += _gripMid.x - lip.right.x;
    _hangCom.z += _gripMid.z - lip.right.z;
    if (tauMU <= 0) {
      out.pelvisPos.copy(_hangCom);
    } else {
      const up = sampleKeys(MUSCLE_UP.tau, MUSCLE_UP.up, tauMU);
      const outward = sampleKeys(MUSCLE_UP.tau, MUSCLE_UP.out, tauMU);
      out.pelvisPos.copy(_gripMid).addScaledVector(UP, up).addScaledVector(_lipOut, outward);
      // Start exactly from the dead hang.
      _tmpV.copy(_gripMid).addScaledVector(UP, MUSCLE_UP.up[0]).addScaledVector(_lipOut, MUSCLE_UP.out[0]);
      out.pelvisPos.addScaledVector(_tmpV2.subVectors(_hangCom, _tmpV), 1 - smoothstep(0, 0.3, tauMU));
    }
    // Torso: hangs along the centre-of-mass → hands line (one-handed it rolls so the right shoulder sits under
    // the grip); through the muscle-up its up axis turns to the vertical and it pitches over the lip.
    _hangUp.subVectors(_gripMid, _hangCom).normalize();
    _hangUp.lerp(UP, smoothstep(0, 0.35, tauMU)).normalize();
    _fwd.copy(_lipOut).negate();
    lookRotation(_fwd, _hangUp, _bodyQ);
    const oneArmRoll = -0.38 * (1 - twoHands);
    const muPitch = sampleKeys(MUSCLE_UP.tau, MUSCLE_UP.pitch, tauMU);
    torsoRotation(muPitch, -oneArmRoll, 0, _qTmp);
    _bodyQ.multiply(_qTmp);
    _yawQ.setFromAxisAngle(UP, out.yaw).invert();
    out.pelvisRot.multiplyQuaternions(_yawQ, _bodyQ);
    torsoRotation(-0.04 - 0.08 * (1 - tauMU), 0, 0, out.spine);
    torsoRotation(-0.08, 0, 0, out.chest);
    // Legs: dangle and trail the swing; tuck during the pull; the right foot steps onto the lip.
    const legLag = -0.7 * _swing.out;
    const hangHip = 0.2 + legLag + 0.1 * bump(tauHang, 0.1, 0.5);
    const hangKnee = 0.35 + 0.25 * bump(tauHang, 0.05, 0.45);
    const hip = lerp(hangHip, sampleKeys(MUSCLE_UP.tau, MUSCLE_UP.hip, tauMU), smoothstep(0, 0.15, tauMU));
    const knee = lerp(hangKnee, sampleKeys(MUSCLE_UP.tau, MUSCLE_UP.knee, tauMU), smoothstep(0, 0.15, tauMU));
    legFK(info.legRest[0], 1, hip + 0.08, 0.1 - 0.4 * _swing.side, knee + 0.1, 0.35, out.limbs[LIMB_LEFT_FOOT].fkUpper, out.limbs[LIMB_LEFT_FOOT].fkLower);
    legFK(info.legRest[1], -1, hip - 0.05, 0.1 + 0.4 * _swing.side, knee, 0.35, out.limbs[LIMB_RIGHT_FOOT].fkUpper, out.limbs[LIMB_RIGHT_FOOT].fkLower);
    // The free (left) arm swings for balance until it reaches up for the lip.
    armFK(info.armRest[0], 1, 0.35 + 0.3 * _swing.out, 1.15 - 0.45 * _swing.side, 0.5, 0.6, out.limbs[LIMB_LEFT_HAND].fkUpper, out.limbs[LIMB_LEFT_HAND].fkLower);
    torsoFK(out, fkLeap);
    // Hands on the lip. Elbows: out to the side while hanging, back and up through the press.
    lipHandFrame(_fingers, _palmN);
    const press = smoothstep(0.35, 0.7, tauMU);
    for (let arm = 0; arm < 2; arm += 1) {
      const side: 1 | -1 = arm === 0 ? 1 : -1;
      _side
        .copy(_lipLeft)
        .multiplyScalar(side * (0.75 - 0.5 * press))
        .addScaledVector(_lipOut, 0.4 + 0.6 * press)
        .addScaledVector(UP, 0.3 * press - 0.4 * (1 - press))
        .normalize();
      const w = arm === 0 ? twoHands : 1;
      reachArm(out.limbs[arm], side, w, arm === 0 ? lip.left : lip.right, _fingers, _palmN, _side, false);
      out.limbs[arm].plant = w;
      out.limbs[arm].reach = w;
      out.limbs[arm].normal.copy(lip.normal);
    }
    // Right foot onto the lip at the end of the muscle-up.
    const footUp = smootherstep(0.84, 0.97, tauMU);
    if (footUp > 0) {
      const lp = out.limbs[LIMB_RIGHT_FOOT];
      lp.ik = footUp;
      lp.target.copy(lip.footRight).addScaledVector(lip.normal, 0.008);
      lp.effector.copy(info.edge[1]);
      lp.pole.copy(_lipLeft).multiplyScalar(-0.9).addScaledVector(_lipOut, 0.5).normalize();
      lp.plant = footUp;
      lp.reach = footUp;
      lp.normal.copy(lip.normal);
    }
    out.gaze.copy(_gripMid);
    out.gaze.y += 0.25 + 1.2 * press;
    out.gaze.addScaledVector(_lipOut, -0.6 * press);
    out.gazeWeight = 0.85;
  };

  const genLeap2 = (p: number, t: number, out: BodyPose): void => {
    const P = PATH_PHASES;
    _lipLeft.set(lip.left.x - lip.right.x, 0, lip.left.z - lip.right.z).normalize();
    _lipOut.copy(lip.normal);
    _lipOut.y = 0;
    _lipOut.normalize();
    if (p <= P.leapTwoCatch - CATCH_BLEND) {
      leapAir(p, out);
    } else if (p >= P.leapTwoCatch + CATCH_BLEND) {
      leapHang(p, out);
    } else {
      leapAir(p, _leapAir);
      bakeLimbs(_leapAir);
      leapHang(p, _leapHang);
      bakeLimbs(_leapHang);
      blendBodyPose(_leapAir, _leapHang, smootherstep(P.leapTwoCatch - CATCH_BLEND, P.leapTwoCatch + CATCH_BLEND, p), out);
    }
    void t;
  };

  /* ------------------------------------------------------------------
   * Generator: the summit — arrival, mastery, the turn, the last pull, the gust
   * ------------------------------------------------------------------ */

  const SUMMIT_ARRIVAL: Stance = {
    spot: spots.summit,
    yawFrom: PI,
    yawTo: 0,
    turnStart: 0.7815,
    turnEnd: 0.7925,
    centerFrom: [0.0, -35.27],
    centerTo: [0.0, -35.2],
    width: 0.14,
    stagger: 0.05,
    toeOut: 0.13,
    steps: [
      { foot: 1, start: 0.782, end: 0.7855, frac: 0.35 },
      { foot: 0, start: 0.7845, end: 0.788, frac: 0.7 },
      { foot: 1, start: 0.787, end: 0.7905, frac: 1 },
      { foot: 0, start: 0.7895, end: 0.793, frac: 1 },
    ],
  };

  const SUMMIT_TURN: Stance = {
    spot: spots.summit,
    yawFrom: 0,
    yawTo: FACING_NEXT_MOUNTAIN,
    turnStart: 0.8605,
    turnEnd: 0.8795,
    centerFrom: [0.0, -35.2],
    centerTo: [0.0, -35.05],
    // Same feet as the arrival stance ends on (the switch at 0.86 must not move them).
    width: 0.14,
    stagger: 0.05,
    toeOut: 0.13,
    steps: [
      { foot: 0, start: 0.861, end: 0.866, frac: 0.35 },
      { foot: 1, start: 0.8645, end: 0.8695, frac: 0.7 },
      { foot: 0, start: 0.868, end: 0.873, frac: 1 },
      { foot: 1, start: 0.8715, end: 0.8765, frac: 1 },
    ],
  };

  const fkSummit = createTorsoFK();
  const _flap = new THREE.Vector3();
  const _flapShift = new THREE.Vector3();

  const genSummit = (p: number, t: number, out: BodyPose): void => {
    neutralFK(out);
    // The arrival stance hands over to the turning stance at 0.86 (identical feet there); the posture eases
    // from the composed survey into the settled ending around it.
    evalStance(p >= 0.86 ? SUMMIT_TURN : SUMMIT_ARRIVAL, p, out, 0.07);
    const endW = smoothstep(0.852, 0.868, p);
    const b = lerp(breath(t, 3.6), breath(t, 5.2), endW);
    const recover = 1 - smoothstep(0.78, 0.83, p);
    const gust = smoothstep(ENDING.paperGustStart, ENDING.paperGustStart + 0.004, p);
    const gustHold = gust * (1 - 0.35 * smoothstep(ENDING.paperStick, 0.975, p));
    const arrive = 1 - smoothstep(0.778, 0.786, p);
    const settle = smoothstep(0.88, 0.9, p);
    const crouch = 0.03 + 0.25 * arrive + 0.012 * settle + 0.045 * gustHold + 0.01 * recover * b;
    standPelvis(out, crouch, lerp(0.03, 0.01, endW), -0.02, 0.35 * arrive + 0.07 * gustHold, lerp(-0.045, -0.02, endW), lerp(0.05, 0.02, endW));
    torsoRotation(0.2 * arrive - 0.045 - 0.02 * b * (1 + recover) + 0.03 * gustHold, 0.015, 0, out.spine);
    torsoRotation(-0.07 - 0.025 * b * (1 + recover) + 0.02 * gustHold, -0.01, 0, out.chest);
    // Arms: composed and loose; the left arm braces out in the gust.
    armFK(info.armRest[0], 1, 0.06 + 0.25 * gustHold, 0.14 + 0.32 * gustHold, 0.25 + 0.2 * gustHold, 0.35, out.limbs[0].fkUpper, out.limbs[0].fkLower);
    armFK(info.armRest[1], -1, 0.07, 0.12, 0.28, 0.3, out.limbs[1].fkUpper, out.limbs[1].fkLower);
    torsoFK(out, fkSummit);
    // The right hand on the backpack strap: briefly while surveying, then through the last pull.
    const strap = Math.max(windowWeight(p, 0.812, 0.818, 0.83, 0.837), smoothstep(0.878, 0.89, p));
    if (strap > 0) {
      chestPoint(fkSummit, -0.1, 0.02, 0.14, _gearPt);
      _fingers.set(0.25, 1, 0.1).applyQuaternion(fkSummit.qChest).normalize();
      _palmN.set(0, 0, -1).applyQuaternion(fkSummit.qChest);
      _side.set(-0.8, -0.6, -0.2).applyQuaternion(fkSummit.qChest).normalize();
      reachArm(out.limbs[LIMB_RIGHT_HAND], -1, strap, _gearPt, _fingers, _palmN, _side, true);
    }
    // Gaze: the camera, the range, the camera again; then up at the next mountain; the gust turns the head.
    cameraAt(p, _camPos);
    _gaze.copy(_camPos);
    const survey = windowWeight(p, 0.797, 0.806, 0.836, 0.846);
    _tmpV.set(-55, 50, 10);
    _gaze.lerp(_tmpV, survey);
    _tmpV.set(NEXT_MOUNTAIN.summit[0], NEXT_MOUNTAIN.summit[1], NEXT_MOUNTAIN.summit[2]);
    _gaze.lerp(_tmpV, smoothstep(0.858, 0.874, p));
    if (arrive > 0) {
      _tmpV.set(0, 55.5, -36.5);
      _gaze.lerp(_tmpV, arrive);
    }
    if (gust > 0) {
      // Head turns slightly away from the gust (toward the character's left) and dips.
      const away = 0.3 * gustHold + 0.06 * micro(t, 2.1, 3.3) * gust;
      yawOffset(out.yaw, Math.sin(away) * 30, Math.cos(away) * 30, _tmpV);
      _tmpV.add(fkSummit.pHead);
      _tmpV.y += 4;
      _gaze.lerp(_tmpV, 0.65 * gustHold);
    }
    out.gaze.copy(_gaze);
    out.gazeWeight = 0.8;
    torsoRotation(0.015 * micro(t, 0.31, 0.67), 0, 0.02 * micro(t, 0.23, 0.47), out.head);

    // Keep the backpack's top flap on the paper origin (feet stay planted; the body shifts).
    if (flapLocal) {
      const w = smoothstep(0.872, 0.888, p);
      if (w > 0) {
        socketWorld(fkSummit, 'backpack', flapLocal, _flap);
        _flapShift.subVectors(flapTarget, _flap);
        const len = _flapShift.length();
        if (len > flapMax) _flapShift.multiplyScalar(flapMax / len);
        out.pelvisPos.addScaledVector(_flapShift, w);
      }
    }
  };

  /* ------------------------------------------------------------------
   * Timeline evaluation (crossfades between generators)
   * ------------------------------------------------------------------ */

  const poseA = createBodyPose();
  const poseB = createBodyPose();
  const target = createBodyPose();

  const fkBake = createTorsoFK();
  const _bkUpper = new THREE.Quaternion();
  const _bkLower = new THREE.Quaternion();
  const _bkHand = new THREE.Quaternion();
  const _bkTmpQ = new THREE.Quaternion();
  const _bkMid = new THREE.Vector3();
  const _bkEnd = new THREE.Vector3();
  const _bkPole = new THREE.Vector3();
  const _bkLine = new THREE.Vector3();
  const _bkRest = new THREE.Vector3();
  const _bkContact = new THREE.Vector3();

  /**
   * Turns every limb of a generator pose into a full-IK goal: an FK limb contributes its own end joint (as
   * the goal), the direction its middle joint points (as the pole) and its hand orientation; partial IK
   * weights blend those with the contact goal. Every field is then meaningful, so poses blend and damp
   * without ever mixing in stale values, and the solver always runs plain two-bone IK.
   */
  const bakeLimbs = (pose: BodyPose): void => {
    torsoFK(pose, fkBake);
    for (let li = 0; li < 4; li += 1) {
      const limb = LIMB_INDICES[li];
      const lp = pose.limbs[limb];
      const arm = isArm(limb);
      const sideIndex = limbSide(limb) > 0 ? 0 : 1;
      const w = THREE.MathUtils.clamp(lp.ik, 0, 1);
      lp.plant = clamp01(lp.plant) * w;
      lp.reach = clamp01(lp.reach) * w;
      if (w >= 1) {
        lp.ik = 1;
        continue;
      }
      const parentQ = arm ? fkBake.qChest : fkBake.qPelvis;
      const joint = arm ? fkBake.shoulder[sideIndex] : fkBake.hip[sideIndex];
      const rest = arm ? info.armRest[sideIndex] : info.legRest[sideIndex];
      _bkUpper.multiplyQuaternions(parentQ, lp.fkUpper);
      _bkMid.copy(R[LOWER_BONES[limb]]).applyQuaternion(_bkUpper).add(joint);
      _bkLower.multiplyQuaternions(_bkUpper, lp.fkLower);
      if (arm) {
        _bkEnd.copy(R[HAND_BONES[sideIndex]]).applyQuaternion(_bkLower).add(_bkMid);
        _bkHand.multiplyQuaternions(_bkLower, lp.fkEnd);
        if (w <= 0) {
          lp.hand.copy(_bkHand);
          lp.effector.copy(info.grip[sideIndex]);
        } else {
          // (slerpQuaternions copies its first argument into `this`: never pass `this` as the second.)
          _bkTmpQ.copy(lp.hand);
          lp.hand.slerpQuaternions(_bkHand, _bkTmpQ, w);
          lp.effector.lerpVectors(info.grip[sideIndex], lp.effector, w);
        }
        _bkContact.copy(lp.effector).applyQuaternion(lp.hand).add(_bkEnd);
      } else {
        _bkEnd.set(0, -info.shinLength, 0).applyQuaternion(_bkLower).add(_bkMid);
        if (w <= 0) lp.effector.copy(info.sole[sideIndex]);
        _bkContact.copy(lp.effector).applyQuaternion(_bkLower).add(_bkEnd);
      }
      // Pole: where the FK middle joint actually sits off the root → end line (the rest pole carried by the
      // upper bone can project to nothing in a deep tuck); the rotated rest pole only for a straight limb.
      _bkLine.subVectors(_bkEnd, joint).normalize();
      _bkPole.subVectors(_bkMid, joint);
      _bkPole.addScaledVector(_bkLine, -_bkPole.dot(_bkLine));
      const bendLen = _bkPole.length();
      _bkRest.copy(rest.poleAxis).applyQuaternion(_bkUpper);
      const useBend = THREE.MathUtils.smoothstep(bendLen, 0.004, 0.03);
      if (bendLen > 1e-6) _bkPole.multiplyScalar(useBend / bendLen);
      else _bkPole.set(0, 0, 0);
      _bkPole.addScaledVector(_bkRest, 1 - useBend).normalize();
      if (w <= 0) {
        lp.target.copy(_bkContact);
        lp.pole.copy(_bkPole);
        lp.normal.set(0, 1, 0);
      } else {
        lp.target.lerpVectors(_bkContact, lp.target, w);
        lp.pole.lerpVectors(_bkPole, lp.pole, w);
        if (lp.pole.lengthSq() < 1e-8) lp.pole.copy(_bkPole);
        lp.pole.normalize();
      }
      lp.ik = 1;
    }
  };

  const evalGenerator = (index: number, p: number, t: number, out: BodyPose): void => {
    switch (index) {
      case 0:
        genBase(p, t, out);
        return;
      case 1:
        genClimb(climbs[0], p, t, out);
        return;
      case 2:
        genLedge1(p, t, out);
        return;
      case 3:
        genClimb(climbs[1], p, t, out);
        return;
      case 4:
        genLeap2(p, t, out);
        return;
      case 5:
        genClimb(climbs[2], p, t, out);
        return;
      default:
        genSummit(p, t, out);
    }
  };

  /** [start of crossfade into generator i, end of it] for i = 1..6. */
  const XFADE: ReadonlyArray<readonly [number, number]> = [
    [SEG.climb1[0], SEG.baseEnd],
    [SEG.ledge1[0], SEG.climb1[1]],
    [SEG.climb2[0], SEG.ledge1[1]],
    [SEG.leap2[0], SEG.climb2[1]],
    [SEG.scramble[0], SEG.leap2[1]],
    [SEG.summit, SEG.scramble[1]],
  ];

  /** Builds the target pose for progress p. */
  const evalTarget = (p: number, t: number): void => {
    // Generator index: the last one whose crossfade has started.
    let g = 0;
    for (let i = 0; i < XFADE.length; i += 1) if (p >= XFADE[i][0]) g = i + 1;
    if (g > 0 && p < XFADE[g - 1][1]) {
      const a = XFADE[g - 1][0];
      const b = XFADE[g - 1][1];
      evalGenerator(g - 1, p, t, poseA);
      bakeLimbs(poseA);
      evalGenerator(g, p, t, poseB);
      bakeLimbs(poseB);
      blendBodyPose(poseA, poseB, smootherstep(a, b, p), target);
    } else {
      evalGenerator(g, p, t, target);
      bakeLimbs(target);
    }
  };

  /* ------------------------------------------------------------------
   * Target post-process: reach constraints and the gaze
   * ------------------------------------------------------------------ */

  const fkTarget = createTorsoFK();
  const _wrist = new THREE.Vector3();
  const _jointToGoal = new THREE.Vector3();
  const _shift = new THREE.Vector3();

  /** Moves the pelvis so planted IK goals stay within reach and never fold a limb flat (three passes). */
  const MAX_REACH_SHIFT = 0.3;
  /** Closest a planted wrist / ankle goal may come to its shoulder / hip. */
  const MIN_FOLD_ARM = 0.17;
  const MIN_FOLD_LEG = 0.2;
  const _away = new THREE.Vector3();
  const enforceReach = (pose: BodyPose): void => {
    let reachInto = 0;
    let reachTotal = 0;
    for (let pass = 0; pass < 3; pass += 1) {
      torsoFK(pose, fkTarget);
      _shift.set(0, 0, 0);
      for (let li = 0; li < 4; li += 1) {
        const limb = LIMB_INDICES[li];
        const lp = pose.limbs[limb];
        const w = lp.reach;
        if (w <= 0) continue;
        const arm = isArm(limb);
        const side = limbSide(limb);
        const joint = arm ? fkTarget.shoulder[side > 0 ? 0 : 1] : fkTarget.hip[side > 0 ? 0 : 1];
        if (arm) {
          _wrist.copy(lp.effector).applyQuaternion(lp.hand);
          _wrist.subVectors(lp.target, _wrist);
        } else {
          // Ankle ≈ contact lifted by the foot height (and pulled back off the surface).
          _wrist.copy(lp.target).addScaledVector(lp.normal, info.footHeight * 0.8);
        }
        _jointToGoal.subVectors(_wrist, joint);
        const dist = _jointToGoal.length();
        const reach = (arm ? info.armReach : info.legReach) * (arm ? 0.975 : 0.985);
        const fold = arm ? MIN_FOLD_ARM : MIN_FOLD_LEG;
        if (dist > reach) _shift.addScaledVector(_jointToGoal, ((dist - reach) / dist) * w);
        else if (dist < fold) {
          // Folded flat (a shoulder over its own wrist — the elbow would spin): the body moves off the goal,
          // biased back from the chest so the direction stays defined even at zero distance.
          _away.set(0, 0, -1).applyQuaternion(fkTarget.qChest).multiplyScalar(fold * 0.5).sub(_jointToGoal).normalize();
          _shift.addScaledVector(_away, (fold - dist) * w);
        }
      }
      if (_shift.lengthSq() < 1e-10) return;
      // Never toward the rock beyond the room the pose allows.
      const into = -_shift.dot(pose.wallNormal);
      if (into > 0) {
        const allowed = Math.max(0, pose.wallRoom - reachInto);
        if (into > allowed) _shift.addScaledVector(pose.wallNormal, into - allowed);
        reachInto += Math.min(into, allowed);
      }
      // Cap the total correction: the poses are designed to be reachable, this only absorbs small misses.
      const room = MAX_REACH_SHIFT - reachTotal;
      if (room <= 0) return;
      const len = _shift.length();
      if (len > room) _shift.multiplyScalar(room / len);
      reachTotal += Math.min(len, room);
      pose.pelvisPos.add(_shift);
      // Free limbs travel with the body (their goals are FK poses relative to it); planted ones stay put.
      for (let li = 0; li < 4; li += 1) {
        const lp = pose.limbs[LIMB_INDICES[li]];
        lp.target.addScaledVector(_shift, 1 - clamp01(lp.reach));
      }
    }
  };

  const _gazeDir = new THREE.Vector3();
  const _qInv = new THREE.Quaternion();
  const _neckGaze = new THREE.Quaternion();
  const _headGaze = new THREE.Quaternion();

  /** Turns the neck and head toward pose.gaze (relative to the chest), blended by gazeWeight. */
  const resolveGaze = (pose: BodyPose): void => {
    if (pose.gazeWeight <= 0) return;
    torsoFK(pose, fkTarget);
    _gazeDir.subVectors(pose.gaze, fkTarget.pHead);
    if (_gazeDir.lengthSq() < 1e-6) return;
    _qInv.copy(fkTarget.qChest).invert();
    _gazeDir.applyQuaternion(_qInv).normalize();
    // Yaw is undefined when looking straight up or down: fade it out there so it never wraps. A target behind
    // the chest turns the head toward its side, easing back to centre as it crosses straight behind (atan2
    // would jump from +π to −π there).
    const horizontal = Math.hypot(_gazeDir.x, _gazeDir.z);
    const behind = _gazeDir.z >= 0 ? 1 : THREE.MathUtils.smoothstep(Math.abs(_gazeDir.x) / Math.max(horizontal, 1e-6), 0, 0.5);
    const yaw =
      THREE.MathUtils.clamp(Math.atan2(_gazeDir.x, _gazeDir.z), -1.2, 1.2) * THREE.MathUtils.smoothstep(horizontal, 0.12, 0.4) * behind;
    const pitch = THREE.MathUtils.clamp(Math.atan2(_gazeDir.y, Math.hypot(_gazeDir.x, _gazeDir.z)), -0.8, 0.65);
    torsoRotation(-pitch * 0.4, 0, yaw * 0.45, _neckGaze);
    torsoRotation(-pitch * 0.6, 0, yaw * 0.55, _headGaze);
    _neckGaze.multiply(pose.neck);
    _headGaze.multiply(pose.head);
    pose.neck.slerp(_neckGaze, pose.gazeWeight);
    pose.head.slerp(_headGaze, pose.gazeWeight);
  };

  /* ------------------------------------------------------------------
   * Damped current pose and the solver
   * ------------------------------------------------------------------ */

  const current = createBodyPose();
  let snapNext = true;

  const LAMBDA = {
    yaw: 12,
    pelvisPos: 18,
    pelvisRot: 16,
    torso: 16,
    neck: 11,
    fk: 18,
    target: 30,
    pole: 14,
    effector: 30,
    hand: 22,
    ik: 24,
  } as const;

  const dampPose = (dt: number): void => {
    if (snapNext) {
      copyBodyPose(target, current);
      snapNext = false;
      return;
    }
    current.yaw = THREE.MathUtils.damp(current.yaw, target.yaw, LAMBDA.yaw, dt);
    dampVector3(current.pelvisPos, target.pelvisPos, LAMBDA.pelvisPos, dt);
    dampQuaternion(current.pelvisRot, target.pelvisRot, LAMBDA.pelvisRot, dt);
    dampQuaternion(current.spine, target.spine, LAMBDA.torso, dt);
    dampQuaternion(current.chest, target.chest, LAMBDA.torso, dt);
    dampQuaternion(current.neck, target.neck, LAMBDA.neck, dt);
    dampQuaternion(current.head, target.head, LAMBDA.neck, dt);
    current.gaze.copy(target.gaze);
    current.gazeWeight = target.gazeWeight;
    for (let i = 0; i < 4; i += 1) {
      const c = current.limbs[i];
      const g = target.limbs[i];
      c.ik = THREE.MathUtils.damp(c.ik, g.ik, LAMBDA.ik, dt);
      if (Math.abs(c.ik - g.ik) < 1e-6) c.ik = g.ik;
      dampVector3(c.target, g.target, LAMBDA.target, dt);
      dampVector3(c.pole, g.pole, LAMBDA.pole, dt);
      if (c.pole.lengthSq() < 1e-8) c.pole.copy(g.pole);
      c.pole.normalize();
      dampVector3(c.effector, g.effector, LAMBDA.effector, dt);
      dampQuaternion(c.hand, g.hand, LAMBDA.hand, dt);
      dampQuaternion(c.fkUpper, g.fkUpper, LAMBDA.fk, dt);
      dampQuaternion(c.fkLower, g.fkLower, LAMBDA.fk, dt);
      dampQuaternion(c.fkEnd, g.fkEnd, LAMBDA.fk, dt);
      c.plant = THREE.MathUtils.damp(c.plant, g.plant, LAMBDA.ik, dt);
      c.reach = THREE.MathUtils.damp(c.reach, g.reach, LAMBDA.ik, dt);
      dampVector3(c.normal, g.normal, LAMBDA.target, dt);
      c.normal.normalize();
    }
  };

  const bones = rig.bones;
  const fkSolve = createTorsoFK();
  const ikResult = createTwoBoneResult();
  const _rootPos = new THREE.Vector3();
  const _rootQ = new THREE.Quaternion();
  const _parentInv = new THREE.Matrix4();
  const _parentQInv = new THREE.Quaternion();
  const _localPos = new THREE.Vector3();
  const _lowerW = new THREE.Quaternion();
  const _endW = new THREE.Quaternion();
  const _goal = new THREE.Vector3();
  const _armFallback = new THREE.Vector3();
  const _legFallback = new THREE.Vector3();
  const _contactPos = new THREE.Vector3();
  const _decompS = new THREE.Vector3();
  const _decompP = new THREE.Vector3();

  const UPPER_BONES: readonly [BoneName, BoneName, BoneName, BoneName] = ['LeftArm', 'RightArm', 'LeftUpLeg', 'RightUpLeg'];
  const LOWER_BONES: readonly [BoneName, BoneName, BoneName, BoneName] = ['LeftForeArm', 'RightForeArm', 'LeftLeg', 'RightLeg'];
  const HAND_BONES: readonly [BoneName, BoneName] = ['LeftHand', 'RightHand'];

  interface MutableContact {
    planted: number;
    readonly position: THREE.Vector3;
    readonly target: THREE.Vector3;
    readonly normal: THREE.Vector3;
  }
  const contactState = (): MutableContact => ({
    planted: 0,
    position: new THREE.Vector3(),
    target: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
  });
  const contactList = [contactState(), contactState(), contactState(), contactState()] as const;
  const contacts: CharacterContacts = {
    leftHand: contactList[0],
    rightHand: contactList[1],
    leftFoot: contactList[2],
    rightFoot: contactList[3],
  };

  const solve = (p: number): void => {
    protagonistPositionAt(p, _rootPos);
    yawRotation(current.yaw, _rootQ);
    // Root (world placement; supports a transformed parent).
    const parent = rig.root.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      _parentInv.copy(parent.matrixWorld).invert();
      _parentInv.decompose(_decompP, _parentQInv, _decompS);
      rig.root.position.copy(_rootPos).applyMatrix4(_parentInv);
      rig.root.quaternion.multiplyQuaternions(_parentQInv, _rootQ);
    } else {
      rig.root.position.copy(_rootPos);
      rig.root.quaternion.copy(_rootQ);
    }
    if (bones.Root !== rig.root) bones.Root.quaternion.identity();

    // Torso.
    _localPos.subVectors(current.pelvisPos, _rootPos).applyQuaternion(_qInv.copy(_rootQ).invert());
    bones.Pelvis.position.copy(_localPos);
    bones.Pelvis.quaternion.copy(current.pelvisRot);
    bones.Spine.quaternion.copy(current.spine);
    bones.Chest.quaternion.copy(current.chest);
    bones.Neck.quaternion.copy(current.neck);
    bones.Head.quaternion.copy(current.head);
    torsoFK(current, fkSolve);

    // Limbs: plain two-bone IK toward the baked goals (FK poses were turned into goals by bakeLimbs).
    _armFallback.set(0, -0.35, -1).applyQuaternion(fkSolve.qChest).normalize();
    _legFallback.set(0, 0, 1).applyQuaternion(fkSolve.qPelvis);
    for (let li = 0; li < 4; li += 1) {
      const limb = LIMB_INDICES[li];
      const lp = current.limbs[limb];
      const arm = isArm(limb);
      const sideIndex = limbSide(limb) > 0 ? 0 : 1;
      const parentQ = arm ? fkSolve.qChest : fkSolve.qPelvis;
      const joint = arm ? fkSolve.shoulder[sideIndex] : fkSolve.hip[sideIndex];
      const rest = arm ? info.armRest[sideIndex] : info.legRest[sideIndex];
      const upperBone = bones[UPPER_BONES[limb]];
      const lowerBone = bones[LOWER_BONES[limb]];
      if (arm) {
        // Wrist goal = contact − hand rotation × contact offset.
        _goal.copy(lp.effector).applyQuaternion(lp.hand);
        _goal.subVectors(lp.target, _goal);
        solveTwoBone(rest, joint, _goal, lp.pole, ikResult, _armFallback);
        upperBone.quaternion.copy(parentQ).invert().multiply(ikResult.upper);
        lowerBone.quaternion.copy(ikResult.upper).invert().multiply(ikResult.lower);
        bones[HAND_BONES[sideIndex]].quaternion.copy(ikResult.lower).invert().multiply(lp.hand);
        _endW.copy(lp.hand);
      } else {
        // Ankle goal: contact − shin rotation × contact offset (fixed-point iterations on the shin rotation).
        _lowerW.copy(fkSolve.qPelvis);
        for (let it = 0; it < legIterations; it += 1) {
          _goal.copy(lp.effector).applyQuaternion(_lowerW);
          _goal.subVectors(lp.target, _goal);
          solveTwoBone(rest, joint, _goal, lp.pole, ikResult, _legFallback);
          _lowerW.copy(ikResult.lower);
        }
        upperBone.quaternion.copy(parentQ).invert().multiply(ikResult.upper);
        lowerBone.quaternion.copy(ikResult.upper).invert().multiply(ikResult.lower);
        _endW.copy(ikResult.lower);
      }
      // Report where the contact point actually is.
      _contactPos.copy(lp.effector).applyQuaternion(_endW).add(ikResult.end);
      const cs = contactList[limb];
      cs.position.copy(_contactPos);
      cs.target.copy(lp.target);
      cs.normal.copy(lp.normal);
      cs.planted = lp.plant;
    }
  };

  /* ------------------------------------------------------------------
   * Wind
   * ------------------------------------------------------------------ */

  // Matches the model's default: from the next mountain (−z) toward the camera (+z), slightly from the left.
  const windDirection = new THREE.Vector3(0.25, 0.05, 1).normalize();
  let wind = 0.1;

  const windTarget = (p: number, t: number): number => {
    const altitude = clamp01(protagonistPositionAt(p, _tmpV).y / WAYPOINTS.summit[1]);
    let w = 0.1 + 0.3 * altitude;
    w += 0.1 * smoothstep(0.78, 0.86, p);
    const gustRise = smoothstep(ENDING.paperGustStart, ENDING.paperGustStart + 0.005, p);
    const gustFall = smoothstep(ENDING.paperStick, 0.975, p);
    w = lerp(w, 1, gustRise);
    w = lerp(w, 0.62, gustFall);
    if (secondary) w += (0.05 + 0.08 * gustRise) * (0.6 * Math.sin(t * 1.7) + 0.4 * Math.sin(t * 3.9 + 0.7));
    return clamp01(w);
  };

  /* ------------------------------------------------------------------
   * Public object
   * ------------------------------------------------------------------ */

  const diag = { beforeReach: new THREE.Vector3(), afterReach: new THREE.Vector3() };
  let state: AnimationState = 'HERO_IDLE';
  let stateBlend = 1;
  let visible = true;

  /**
   * Makes sure the tables progress `p` needs exist. Climb, jump and summit states need everything up to their stage;
   * base camp only its ground patch (built first). Returns false while they are still being built (non-blocking mode).
   */
  const ensureTablesFor = (p: number): boolean => {
    if (ready) return true;
    const needsAll = p >= SEG.climb1[0] - 0.004;
    if (blockingPrepare) {
      if (needsAll) prepare();
      else stepBuild(budgetMs);
      return true;
    }
    const usable = !needsAll && spots.base.ready;
    if (!usable) stepBuild(urgentBudgetMs);
    else if (budgetMs > 0) stepBuild(budgetMs);
    return needsAll ? ready : spots.base.ready;
  };

  const animator: CharacterAnimator = {
    update(progress: number, delta: number, elapsed: number): void {
      const p = clamp01(Number.isFinite(progress) ? progress : 0);
      const dt = Math.min(Math.max(Number.isFinite(delta) ? delta : 0, 0), 0.1);
      const usable = ensureTablesFor(p);
      const si = animationStateIndexAt(p);
      const range = ANIMATION_STATE_RANGES[si];
      state = range.state;
      stateBlend = si === 0 ? 1 : smoothstep(range.start, range.start + 0.006, p);
      if (!usable) {
        // Still building what this progress needs: stay hidden, then land exactly on the pose once ready.
        snapNext = true;
        wind = windTarget(p, elapsed);
        visible = false;
        rig.root.visible = false;
        return;
      }
      const snapping = snapNext;
      evalTarget(p, elapsed);
      diag.beforeReach.copy(target.pelvisPos);
      enforceReach(target);
      diag.afterReach.copy(target.pelvisPos);
      resolveGaze(target);
      dampPose(dt);
      solve(p);
      const wt = windTarget(p, elapsed);
      wind = snapping ? wt : THREE.MathUtils.damp(wind, wt, wt > wind ? 7 : 2, dt);
      visible = p >= hiddenBefore;
      rig.root.visible = visible;
    },
    get state() {
      return state;
    },
    get stateBlend() {
      return stateBlend;
    },
    get wind() {
      return wind;
    },
    windDirection,
    contacts,
    get visible() {
      return visible;
    },
    get ready() {
      return ready;
    },
    prepare,
    prepareStep(ms: number): boolean {
      stepBuild(ms);
      return ready;
    },
    debugHolds(index: number, limb: number): Float32Array {
      return climbs[index].holds[limb as LimbIndex];
    },
    debugPelvis(): { beforeReach: THREE.Vector3; afterReach: THREE.Vector3 } {
      return diag;
    },
    snap(): void {
      snapNext = true;
    },
    dispose(): void {
      builder = null;
    },
  };
  return animator;
}

export default createCharacterAnimator;
