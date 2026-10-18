import * as THREE from 'three';
import type { GearId } from '../../store/scrollStore';
import { mountainSdf } from '../world/terrainGeometry';
import {
  BACKPACK_FLAP_OPENING_LOCAL,
  BACKPACK_LID_HINGE_LOCAL,
  disposeGearGeometry,
  iceAxeHolsterMatrix,
  iceAxeHolsterPivot,
  type GearGeometrySet,
  type GearMaterialKey,
  type GearMesh,
} from './gearGeometry';
import { createGearMaterial, setGearGlint, type GearMaterial, type GearTextures } from './gearMaterials';
import {
  BACKPACK_FLAP,
  GEAR_APPROACH,
  GEAR_FALL,
  backpackFlapAngle,
  backpackGustAt,
  createFallTrajectory,
  fallBodySpecs,
  gearDetachWeight,
  gearFallOpacity,
  gearFallSeconds,
  gearLockOnAt,
  iceAxeHandBlend,
  type FallBodyId,
  type FallTrajectory,
  type LockOnState,
  type SdfFunction,
} from './gearTimeline';
import { BONE_NAMES, type BoneName, type CharacterRigHandle } from './rigTypes';

/* ==========================================================================
 * GearAssembly — the scene graph and per-frame logic of the four expedition
 * tools on a rig (no React, no DOM: Node tests drive it directly).
 *
 * GearSheddingSystem builds the geometry, creates one assembly per rig, adds
 * `assembly.world` (the parent of falling items) to the scene and calls
 * `update(progress, delta, elapsed, wind, windDir)` every frame AFTER the
 * CharacterAnimator has posed the rig.
 * ========================================================================== */

/** World position of the backpack's collar mouth (where the contact paper escapes) for a rig. Allocation free. */
export function backpackFlapOpeningWorld(rig: CharacterRigHandle, target: THREE.Vector3): THREE.Vector3 {
  const socket = rig.sockets.backpack;
  socket.updateWorldMatrix(true, false);
  return target.set(BACKPACK_FLAP_OPENING_LOCAL[0], BACKPACK_FLAP_OPENING_LOCAL[1], BACKPACK_FLAP_OPENING_LOCAL[2]).applyMatrix4(socket.matrixWorld);
}

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

/** A hanging thing (rack piece / racked axe) swinging about its pivot: a damped spherical pendulum. */
interface Pendulum {
  /** Group whose quaternion is the swing (child of the pivot frame). */
  swing: THREE.Group;
  /** The pivot frame (its world orientation defines "rest down" = its −Y). */
  frame: THREE.Object3D;
  dir: THREE.Vector3;
  vel: THREE.Vector3;
  /** How much of the gravity direction the piece follows (vs. its rest frame). */
  compliance: number;
  maxAngle: number;
  /** Lowest allowed z of the hang direction in the frame (keeps pieces off the body). */
  minZ: number;
}

interface Droppable {
  gear: GearId;
  body: FallBodyId;
  /** Item root (item frame = its socket frame). */
  root: THREE.Group;
  /** Where it lives while attached. */
  home: THREE.Object3D;
  materials: GearMaterial[];
}

interface AxeRig {
  side: 1 | -1;
  body: FallBodyId;
  root: THREE.Group;
  mount: THREE.Group;
  pendulum: Pendulum;
  hand: THREE.Object3D;
  /** Decomposed local transform of the axe inside the swing group (racked). */
  rackPos: THREE.Vector3;
  rackQuat: THREE.Quaternion;
}

function boneSet(rig: CharacterRigHandle): Map<THREE.Object3D, BoneName> {
  const map = new Map<THREE.Object3D, BoneName>();
  for (const name of BONE_NAMES) map.set(rig.bones[name], name);
  return map;
}

/** Rest-pose transform of a rig node relative to Root (bones at their rest positions with identity rotations). */
function restMatrixToRoot(rig: CharacterRigHandle, node: THREE.Object3D, bones: Map<THREE.Object3D, BoneName>): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  let cur: THREE.Object3D | null = node;
  while (cur && cur !== rig.root) {
    const bone = bones.get(cur);
    if (bone) local.makeTranslation(rig.restPositions[bone].x, rig.restPositions[bone].y, rig.restPositions[bone].z);
    else local.compose(cur.position, cur.quaternion, cur.scale);
    m.premultiply(local);
    cur = cur.parent;
  }
  return m;
}

const iceAxePivots: readonly THREE.Vector3[] = [iceAxeHolsterPivot(1), iceAxeHolsterPivot(-1)];

/** Per-frame integration budget (ms) for a fall reached before its precompute finished. */
const FALL_CATCH_UP_MS = 2;

export class GearAssembly {
  readonly world = new THREE.Group();
  private readonly materials: Record<GearId, Partial<Record<GearMaterialKey, GearMaterial>>> = {
    backpack: {},
    rope: {},
    iceAxes: {},
    harness: {},
  };
  private readonly itemMaterials: Record<GearId, GearMaterial[]> = { backpack: [], rope: [], iceAxes: [], harness: [] };
  private readonly itemMeshes: Record<GearId, THREE.Mesh[]> = { backpack: [], rope: [], iceAxes: [], harness: [] };
  private readonly itemCast: Record<GearId, boolean> = { backpack: true, rope: true, iceAxes: true, harness: true };
  private readonly attached: { child: THREE.Object3D; parent: THREE.Object3D }[] = [];

  private readonly packRoot = new THREE.Group();
  private readonly lidPivot = new THREE.Group();
  private readonly rope: Droppable;
  private readonly harness: Droppable;
  private readonly legLoops: { root: THREE.Group; bone: THREE.Object3D; rel: THREE.Matrix4 }[] = [];
  private readonly pendulums: Pendulum[] = [];
  private readonly rackPendulums: Pendulum[] = [];
  private readonly axes: AxeRig[] = [];
  private readonly trajectories = new Map<FallBodyId, FallTrajectory>();
  private readonly specs = fallBodySpecs();

  // Per-frame scratch (no allocation in update).
  private readonly lock: LockOnState = { visible: false, scale: 0, approach: 1, glint: 0 };
  private readonly v0 = new THREE.Vector3();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly q0 = new THREE.Quaternion();
  private readonly q1 = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();
  private readonly m0 = new THREE.Matrix4();
  private readonly m1 = new THREE.Matrix4();
  private readonly s0 = new THREE.Vector3();
  private readonly pelvisPos = new THREE.Vector3();
  private readonly pelvisVel = new THREE.Vector3();
  private readonly pelvisAcc = new THREE.Vector3();
  private readonly gEff = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private hasPelvis = false;
  private lastProgress = Number.NaN;
  private lidFlutter = 0;
  private lidFlutterVel = 0;

  constructor(
    private readonly rig: CharacterRigHandle,
    private readonly set: GearGeometrySet,
    private readonly textures: GearTextures,
    /** Rock field the falls collide with (defaults to the mountain). */
    private readonly sdf: SdfFunction = mountainSdf,
  ) {
    this.world.name = 'GearShedding.world';
    const bones = boneSet(rig);

    /* ---- Backpack ---- */
    this.packRoot.name = 'ExpeditionBackpack';
    this.addMeshes(this.packRoot, set.backpack.body, 'backpack');
    this.lidPivot.name = 'ExpeditionBackpack.lid';
    this.lidPivot.position.set(BACKPACK_LID_HINGE_LOCAL[0], BACKPACK_LID_HINGE_LOCAL[1], BACKPACK_LID_HINGE_LOCAL[2]);
    this.addMeshes(this.lidPivot, set.backpack.lid, 'backpack');
    this.packRoot.add(this.lidPivot);
    this.attach(this.packRoot, rig.sockets.backpack);

    /* ---- Rope ---- */
    const ropeRoot = new THREE.Group();
    ropeRoot.name = 'ClimbingRopeCoil';
    this.addMeshes(ropeRoot, set.rope.meshes, 'rope');
    this.attach(ropeRoot, rig.sockets.ropeCoil);
    this.rope = { gear: 'rope', body: 'rope', root: ropeRoot, home: rig.sockets.ropeCoil, materials: this.itemMaterials.rope };

    /* ---- Harness: belt + rack on the socket, leg loops on the thighs ---- */
    const beltRoot = new THREE.Group();
    beltRoot.name = 'TacticalHarnessRack';
    this.addMeshes(beltRoot, set.harness.belt, 'harness');
    for (const piece of set.harness.rack) {
      const frame = new THREE.Group();
      frame.position.copy(piece.pivot);
      frame.quaternion.copy(piece.rest);
      const swing = new THREE.Group();
      this.addMeshes(swing, piece.meshes, 'harness');
      frame.add(swing);
      beltRoot.add(frame);
      const p: Pendulum = { swing, frame, dir: DOWN.clone(), vel: new THREE.Vector3(), compliance: 0.9, maxAngle: 1.15, minZ: -0.12 };
      this.pendulums.push(p);
      this.rackPendulums.push(p);
    }
    this.attach(beltRoot, rig.sockets.harness);
    this.harness = { gear: 'harness', body: 'harness', root: beltRoot, home: rig.sockets.harness, materials: this.itemMaterials.harness };
    const harnessRest = restMatrixToRoot(rig, rig.sockets.harness, bones);
    for (const boneName of ['LeftUpLeg', 'RightUpLeg'] as const) {
      const root = new THREE.Group();
      root.name = `TacticalHarnessRack.${boneName}`;
      this.addMeshes(root, set.harness.legLoops[boneName], 'harness');
      const bone = rig.bones[boneName];
      this.attach(root, bone);
      const rel = harnessRest.clone().invert().multiply(restMatrixToRoot(rig, bone, bones));
      this.legLoops.push({ root, bone, rel });
    }

    /* ---- Ice axes ---- */
    for (const side of [1, -1] as const) {
      const root = new THREE.Group();
      root.name = side > 0 ? 'DualCarbonIceAxes.left' : 'DualCarbonIceAxes.right';
      this.addMeshes(root, side > 0 ? set.axes.left.meshes : set.axes.right.meshes, 'iceAxes');
      const holster = side > 0 ? rig.sockets.hipHolsterL : rig.sockets.hipHolsterR;
      const mount = new THREE.Group();
      mount.position.copy(iceAxeHolsterPivot(side));
      const swing = new THREE.Group();
      mount.add(swing);
      this.attach(mount, holster);
      const local = new THREE.Matrix4().makeTranslation(-mount.position.x, -mount.position.y, -mount.position.z).multiply(iceAxeHolsterMatrix(side));
      const rackPos = new THREE.Vector3();
      const rackQuat = new THREE.Quaternion();
      local.decompose(rackPos, rackQuat, new THREE.Vector3());
      swing.add(root);
      root.position.copy(rackPos);
      root.quaternion.copy(rackQuat);
      const pendulum: Pendulum = { swing, frame: mount, dir: DOWN.clone(), vel: new THREE.Vector3(), compliance: 0.7, maxAngle: 0.85, minZ: -0.6 };
      this.pendulums.push(pendulum);
      this.axes.push({ side, body: side > 0 ? 'axeL' : 'axeR', root, mount, pendulum, hand: side > 0 ? rig.sockets.handGripL : rig.sockets.handGripR, rackPos, rackQuat });
    }

    // Everything starts hidden; update() decides.
    this.packRoot.visible = false;
    ropeRoot.visible = false;
    beltRoot.visible = false;
    for (const l of this.legLoops) l.root.visible = false;
    for (const a of this.axes) {
      a.mount.visible = false;
      a.root.visible = false;
    }
  }

  get triangles(): number {
    return this.set.triangles;
  }

  get trajectoriesReady(): boolean {
    if (this.trajectories.size < this.specs.length) return false;
    for (const t of this.trajectories.values()) if (!t.done) return false;
    return true;
  }

  /** Advances the trajectory precomputation within the budget. */
  prepare(budgetMs: number): void {
    const t0 = performance.now();
    for (const spec of this.specs) {
      let tr = this.trajectories.get(spec.id);
      if (!tr) {
        tr = createFallTrajectory(spec, this.sdf);
        this.trajectories.set(spec.id, tr);
      }
      if (!tr.done) tr.step(Math.max(0.5, budgetMs - (performance.now() - t0)));
      if (performance.now() - t0 >= budgetMs) return;
    }
  }

  private trajectory(id: FallBodyId): FallTrajectory {
    let tr = this.trajectories.get(id);
    if (!tr) {
      const spec = this.specs.find((s) => s.id === id);
      if (!spec) throw new Error(`no fall spec ${id}`);
      tr = createFallTrajectory(spec, this.sdf);
      this.trajectories.set(id, tr);
    }
    return tr;
  }

  /** Every material once (for shader warm-up). */
  allMaterials(): GearMaterial[] {
    return [...this.itemMaterials.backpack, ...this.itemMaterials.rope, ...this.itemMaterials.iceAxes, ...this.itemMaterials.harness];
  }

  private material(item: GearId, key: GearMaterialKey): GearMaterial {
    const existing = this.materials[item][key];
    if (existing) return existing;
    const m = createGearMaterial(key, item, this.textures);
    this.materials[item][key] = m;
    this.itemMaterials[item].push(m);
    return m;
  }

  private addMeshes(parent: THREE.Object3D, meshes: readonly GearMesh[], item: GearId): void {
    for (const gm of meshes) {
      const mesh = new THREE.Mesh(gm.geometry, this.material(item, gm.material));
      mesh.name = gm.geometry.name;
      mesh.castShadow = gm.castShadow;
      mesh.receiveShadow = true;
      mesh.userData.castShadow = gm.castShadow;
      parent.add(mesh);
      this.itemMeshes[item].push(mesh);
    }
  }

  private attach(child: THREE.Object3D, parent: THREE.Object3D): void {
    parent.add(child);
    this.attached.push({ child, parent });
  }

  private setParent(child: THREE.Object3D, parent: THREE.Object3D): void {
    if (child.parent !== parent) parent.add(child);
  }

  private setGlint(item: GearId, glint: number): void {
    const list = this.itemMaterials[item];
    for (let i = 0; i < list.length; i += 1) setGearGlint(list[i], glint);
  }

  /** Dissolve (alphaHash) and drop the shadow while an item fades away. */
  private setOpacity(item: GearId, opacity: number): void {
    const list = this.itemMaterials[item];
    for (let i = 0; i < list.length; i += 1) list[i].opacity = opacity;
    const cast = opacity >= 0.999;
    if (this.itemCast[item] === cast) return;
    this.itemCast[item] = cast;
    const meshes = this.itemMeshes[item];
    for (let i = 0; i < meshes.length; i += 1) meshes[i].castShadow = cast && meshes[i].userData.castShadow === true;
  }

  /* ---------------------------------------------------------------------------
   * Frame update
   * ------------------------------------------------------------------------- */

  update(progress: number, delta: number, elapsed: number, wind: number, windDir: THREE.Vector3): void {
    const dt = THREE.MathUtils.clamp(delta, 0, 0.1);
    const snap = !Number.isFinite(this.lastProgress) || Math.abs(progress - this.lastProgress) > 0.004 || delta > 0.25;
    this.lastProgress = progress;

    this.trackPelvis(dt, snap);
    this.updateBackpack(progress, dt, elapsed, wind, snap);
    this.updateDroppable(this.rope, progress);
    this.updateHarness(progress);
    // Axe clips first (visibility + lock-on), then every pendulum (so the racked tools read this frame's swing),
    // then the tools themselves.
    const axesVisible = this.updateAxeMounts(progress);
    this.updatePendulums(dt, wind, windDir, snap, gearFallSeconds('harness', progress) < 0);
    this.placeAxes(progress, axesVisible);
  }

  private trackPelvis(dt: number, snap: boolean): void {
    const pelvis = this.rig.bones.Pelvis;
    pelvis.updateWorldMatrix(true, false);
    this.v0.setFromMatrixPosition(pelvis.matrixWorld);
    if (!this.hasPelvis || snap || dt <= 0) {
      this.pelvisPos.copy(this.v0);
      this.pelvisVel.set(0, 0, 0);
      this.pelvisAcc.set(0, 0, 0);
      this.hasPelvis = true;
      return;
    }
    this.v1.copy(this.v0).sub(this.pelvisPos).divideScalar(dt);
    this.v2.copy(this.v1).sub(this.pelvisVel).divideScalar(dt);
    if (this.v2.lengthSq() > 900) this.v2.setLength(30);
    const k = 1 - Math.exp(-14 * dt);
    this.pelvisAcc.lerp(this.v2, k);
    this.pelvisVel.copy(this.v1);
    this.pelvisPos.copy(this.v0);
  }

  private applyLockOn(gear: GearId, root: THREE.Object3D, lock: LockOnState): void {
    const a = GEAR_APPROACH[gear];
    root.position.set(a[0] * lock.approach, a[1] * lock.approach, a[2] * lock.approach);
    root.scale.setScalar(Math.max(1e-3, lock.scale));
  }

  private updateBackpack(progress: number, dt: number, elapsed: number, wind: number, snap: boolean): void {
    const lock = gearLockOnAt('backpack', progress, this.lock);
    this.packRoot.visible = lock.visible;
    if (!lock.visible) return;
    this.applyLockOn('backpack', this.packRoot, lock);
    this.setGlint('backpack', lock.glint);
    // Lid: deterministic flip in the gust + wind flutter (secondary).
    const base = backpackFlapAngle(progress);
    const gust = Math.max(backpackGustAt(progress), Math.min(1, wind)) * (base > 0 ? 1 : 0);
    const flutterTarget = gust * (0.11 * Math.sin(elapsed * 9.7) + 0.06 * Math.sin(elapsed * 16.3 + 1.3) + 0.03 * Math.sin(elapsed * 27.1 + 0.4));
    if (snap) {
      this.lidFlutter = flutterTarget;
      this.lidFlutterVel = 0;
    } else {
      // Under-damped spring toward the flutter target (frame-rate independent sub-steps).
      let remaining = dt;
      while (remaining > 1e-6) {
        const h = Math.min(remaining, 1 / 120);
        const acc = 260 * (flutterTarget - this.lidFlutter) - 12 * this.lidFlutterVel;
        this.lidFlutterVel += acc * h;
        this.lidFlutter += this.lidFlutterVel * h;
        remaining -= h;
      }
    }
    const angle = THREE.MathUtils.clamp(base + this.lidFlutter, 0, BACKPACK_FLAP.maxAngle);
    this.lidPivot.rotation.set(0, 0, -angle);
  }

  /** Attached → lock-on; dropped → precomputed fall blended from the live socket, then dissolve. */
  private updateDroppable(item: Droppable, progress: number): void {
    const lock = gearLockOnAt(item.gear, progress, this.lock);
    const t = gearFallSeconds(item.gear, progress);
    if (!lock.visible || t >= GEAR_FALL.fadeEnd) {
      item.root.visible = false;
      // Before the lock-on it waits (hidden) on its socket, so a scrub back never leaves it in world space.
      if (!lock.visible) this.setParent(item.root, item.home);
      return;
    }
    item.root.visible = true;
    if (t < 0) {
      this.setParent(item.root, item.home);
      item.root.quaternion.identity();
      this.applyLockOn(item.gear, item.root, lock);
      this.setGlint(item.gear, lock.glint);
      this.setOpacity(item.gear, 1);
      return;
    }
    this.setGlint(item.gear, 0);
    if (!this.fallReady(item.body, t)) {
      item.root.visible = false;
      return;
    }
    this.fallPose(item.body, t, item.home, null, this.v0, this.q0);
    this.setParent(item.root, this.world);
    item.root.position.copy(this.v0);
    item.root.quaternion.copy(this.q0);
    item.root.scale.copy(ONE);
    this.setOpacity(item.gear, gearFallOpacity(t));
  }

  /**
   * Whether the item's fall is integrated up to `t` seconds. A fall still being precomputed when progress first
   * reaches it (a fling past the drop right after load) catches up FALL_CATCH_UP_MS per frame instead of in one
   * long task; the caller keeps the item hidden until it has. Once precomputed (prepare()), always true.
   */
  private fallReady(id: FallBodyId, t: number): boolean {
    const tr = this.trajectory(id);
    if (tr.done) return true;
    const need = Math.min(t, GEAR_FALL.duration) + 2 * GEAR_FALL.dt;
    if (tr.simulated >= need) return true;
    tr.step(FALL_CATCH_UP_MS);
    return tr.done || tr.simulated >= need;
  }

  /**
   * World pose of a falling item frame at `t` seconds: the trajectory, blended from the live attachment
   * (`home.matrixWorld × local`) over the detach window.
   */
  private fallPose(id: FallBodyId, t: number, home: THREE.Object3D, local: THREE.Matrix4 | null, outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
    this.trajectory(id).sample(t, outPos, outQuat);
    const w = gearDetachWeight(t);
    if (w >= 1) return;
    home.updateWorldMatrix(true, false);
    this.m0.copy(home.matrixWorld);
    if (local) this.m0.multiply(local);
    this.m0.decompose(this.v1, this.q1, this.s0);
    outPos.lerpVectors(this.v1, outPos, w);
    this.q1.slerp(outQuat, w);
    outQuat.copy(this.q1);
  }

  private updateHarness(progress: number): void {
    this.updateDroppable(this.harness, progress);
    const lock = this.lock; // written by updateDroppable for 'harness'
    const t = gearFallSeconds('harness', progress);
    const visible = this.harness.root.visible;
    for (const leg of this.legLoops) {
      leg.root.visible = visible;
      if (!visible) {
        if (t < 0) this.setParent(leg.root, leg.bone);
        continue;
      }
      if (t < 0) {
        this.setParent(leg.root, leg.bone);
        leg.root.quaternion.identity();
        this.applyLockOn('harness', leg.root, lock);
        continue;
      }
      // Falling with the belt: belt pose × rest-relative leg-loop transform, blended from the live thigh.
      this.m1.compose(this.harness.root.position, this.harness.root.quaternion, ONE).multiply(leg.rel);
      this.m1.decompose(this.v0, this.q0, this.s0);
      const w = gearDetachWeight(t);
      if (w < 1) {
        leg.bone.updateWorldMatrix(true, false);
        leg.bone.matrixWorld.decompose(this.v1, this.q1, this.s0);
        this.v0.lerpVectors(this.v1, this.v0, w);
        this.q1.slerp(this.q0, w);
        this.q0.copy(this.q1);
      }
      this.setParent(leg.root, this.world);
      leg.root.position.copy(this.v0);
      leg.root.quaternion.copy(this.q0);
      leg.root.scale.copy(ONE);
    }
  }

  /** Visibility, glint / dissolve and the lock-on slide of the axe clips on the hip holsters. Returns visibility. */
  private updateAxeMounts(progress: number): boolean {
    const lock = gearLockOnAt('iceAxes', progress, this.lock);
    const t = gearFallSeconds('iceAxes', progress);
    const visible = lock.visible && t < GEAR_FALL.fadeEnd;
    this.setGlint('iceAxes', t < 0 ? lock.glint : 0);
    this.setOpacity('iceAxes', t < 0 ? 1 : gearFallOpacity(t));
    for (const axe of this.axes) {
      axe.mount.visible = visible;
      if (!visible) continue;
      const pivot = iceAxePivots[axe.side > 0 ? 0 : 1];
      if (t < 0) {
        // Lock-on acts on the racked mount (the tools slide down into their clips).
        const a = GEAR_APPROACH.iceAxes;
        axe.mount.position.set(pivot.x + a[0] * lock.approach, pivot.y + a[1] * lock.approach, pivot.z + a[2] * lock.approach);
        axe.mount.scale.setScalar(Math.max(1e-3, lock.scale));
      } else {
        axe.mount.position.copy(pivot);
        axe.mount.scale.copy(ONE);
      }
    }
    return visible;
  }

  /** Places each tool: racked in its swinging clip, in the hand, in a handoff between the two, or falling. */
  private placeAxes(progress: number, visible: boolean): void {
    const t = gearFallSeconds('iceAxes', progress);
    const hand = iceAxeHandBlend(progress);
    const ease = hand * hand * (3 - 2 * hand);
    for (const axe of this.axes) {
      axe.root.visible = visible;
      if (!visible) {
        if (t < 0) {
          this.setParent(axe.root, axe.pendulum.swing);
          axe.root.position.copy(axe.rackPos);
          axe.root.quaternion.copy(axe.rackQuat);
        }
        continue;
      }
      if (t >= 0) {
        if (!this.fallReady(axe.body, t)) {
          axe.root.visible = false;
          continue;
        }
        // Falling from the rack (racked at the drop): live racked pose → trajectory.
        this.rackLocal(axe, this.m1);
        this.fallPose(axe.body, t, axe.pendulum.swing, this.m1, this.v0, this.q0);
        this.setParent(axe.root, this.world);
        axe.root.position.copy(this.v0);
        axe.root.quaternion.copy(this.q0);
        axe.root.scale.copy(ONE);
        continue;
      }
      if (ease <= 0) {
        this.setParent(axe.root, axe.pendulum.swing);
        axe.root.position.copy(axe.rackPos);
        axe.root.quaternion.copy(axe.rackQuat);
        axe.root.scale.copy(ONE);
      } else if (ease >= 1) {
        this.setParent(axe.root, axe.hand);
        axe.root.position.set(0, 0, 0);
        axe.root.quaternion.identity();
        axe.root.scale.copy(ONE);
      } else {
        // Handoff: interpolate the world pose between the rack and the grip.
        axe.pendulum.swing.updateWorldMatrix(true, false);
        this.rackLocal(axe, this.m1);
        this.m0.copy(axe.pendulum.swing.matrixWorld).multiply(this.m1);
        this.m0.decompose(this.v0, this.q0, this.s0);
        axe.hand.updateWorldMatrix(true, false);
        axe.hand.matrixWorld.decompose(this.v1, this.q1, this.s0);
        // A small lift arc so the tool clears the hip as it comes out of / goes into the clip.
        this.v2.lerpVectors(this.v0, this.v1, ease).addScaledVector(UP, 0.06 * Math.sin(Math.PI * ease));
        this.q2.copy(this.q0).slerp(this.q1, ease);
        this.setParent(axe.root, this.world);
        axe.root.position.copy(this.v2);
        axe.root.quaternion.copy(this.q2);
        axe.root.scale.copy(ONE);
      }
    }
  }

  private rackLocal(axe: AxeRig, out: THREE.Matrix4): THREE.Matrix4 {
    return out.compose(axe.rackPos, axe.rackQuat, ONE);
  }

  /** Damped spherical pendulums: hang along gravity minus the climber's acceleration (plus wind). */
  private updatePendulums(dt: number, wind: number, windDir: THREE.Vector3, snap: boolean, rackAttached: boolean): void {
    // Effective gravity in the world: g − a_pelvis + wind push.
    this.gEff.set(0, -9.81, 0).sub(this.pelvisAcc).addScaledVector(windDir, 2.2 * Math.min(1.5, wind));
    const strength = this.gEff.length();
    for (let i = 0; i < this.pendulums.length; i += 1) {
      const p = this.pendulums[i];
      const isRack = i < this.rackPendulums.length;
      if (isRack) {
        if (!this.harness.root.visible) continue;
        if (!rackAttached) {
          // Falling with the belt: free fall has no effective gravity in the belt's frame, so a piece keeps its
          // last swing; a scrub jump into the fall settles it on its rest hang (deterministic).
          if (snap) {
            p.dir.copy(DOWN);
            p.vel.set(0, 0, 0);
            p.swing.quaternion.identity();
          }
          continue;
        }
      } else if (!p.frame.visible) {
        // The clips keep swinging on the hips (empty once the tools are gone) while they are shown, so a racked or
        // detaching tool always reads this frame's swing.
        continue;
      }
      p.frame.updateWorldMatrix(true, false);
      this.q0.setFromRotationMatrix(this.m0.extractRotation(p.frame.matrixWorld)).invert();
      // Target hang direction in the pivot frame.
      if (strength > 2) this.target.copy(this.gEff).multiplyScalar(1 / strength).applyQuaternion(this.q0);
      else this.target.copy(p.dir);
      this.target.lerp(DOWN, 1 - p.compliance);
      if (this.target.z < p.minZ) this.target.z = p.minZ;
      this.target.normalize();
      const cos = -this.target.y;
      if (cos < Math.cos(p.maxAngle)) {
        // Clamp the cone around the rest-down axis.
        const h = Math.hypot(this.target.x, this.target.z) || 1;
        const s = Math.sin(p.maxAngle);
        this.target.set((this.target.x / h) * s, -Math.cos(p.maxAngle), (this.target.z / h) * s);
      }
      if (snap) {
        p.dir.copy(this.target);
        p.vel.set(0, 0, 0);
      } else {
        let remaining = dt;
        while (remaining > 1e-6) {
          const h = Math.min(remaining, 1 / 120);
          // a = k (target − dir) − c v
          this.v1.copy(this.target).sub(p.dir).multiplyScalar(70).addScaledVector(p.vel, -4.2);
          p.vel.addScaledVector(this.v1, h);
          p.dir.addScaledVector(p.vel, h).normalize();
          p.vel.addScaledVector(p.dir, -p.vel.dot(p.dir));
          remaining -= h;
        }
      }
      p.swing.quaternion.setFromUnitVectors(DOWN, p.dir);
    }
  }

  dispose(): void {
    for (const { child } of this.attached) child.parent?.remove(child);
    for (const a of this.axes) a.root.parent?.remove(a.root);
    this.rope.root.parent?.remove(this.rope.root);
    this.harness.root.parent?.remove(this.harness.root);
    for (const l of this.legLoops) l.root.parent?.remove(l.root);
    this.world.parent?.remove(this.world);
    for (const m of this.allMaterials()) m.dispose();
    disposeGearGeometry(this.set);
    this.textures.dispose();
  }
}

