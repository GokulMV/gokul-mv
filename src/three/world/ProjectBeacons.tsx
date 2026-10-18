import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { SCENES, scrollStore, smoothstep, type GpuTier } from '../../store/scrollStore';
import { sceneFx } from '../fx/sceneFx';
import { adaptiveQuality } from '../perf/adaptiveQuality';
import {
  createBeaconBeamGeometry,
  createBeaconBeamMaterial,
  createBeaconCrystalMaterial,
  createBeaconGroundMaterial,
  createBeaconHaloMaterial,
  createBeaconSparkleGeometry,
  createBeaconSparkleMaterial,
  createCrystalClusterGeometry,
  crystalQualityFor,
  fitBeaconToTerrain,
  type BeaconBeamMaterial,
  type BeaconCrystalMaterial,
  type BeaconGroundMaterial,
  type BeaconHaloMaterial,
  type BeaconSparkleMaterial,
} from '../shaders/BeaconCrystalShader';
import { mountainSdf } from './terrainGeometry';
import { BEACONS, FOG, type BeaconSpec } from './worldLayout';

/* ==========================================================================
 * Project beacons — three rotating crystal clusters hugging the climbing
 * route at BEACONS[i].position (Scenes 4 / 5 / 6 → activeSceneIndex 3 / 4 / 5).
 *
 * Each beacon: a faceted crystal cluster (BeaconCrystal shader), an additive
 * light shaft, a camera-facing halo, a ground glow pool (shock rings on the
 * activation flare), orbiting sparkles and a distance-limited point light
 * tinting the rock.
 *
 * The beacons hover right in front of the climbing face, so at mount each one
 * is fitted to the terrain's signed distance field (mountainSdf): the cluster
 * takes the largest scale (capped per beacon, so the crystals grow along the
 * journey) at which it can spin, hover and flare without touching rock; the
 * ground glow is laid onto the rock straight below, along its normal; the
 * point light and sparkles are nudged out of the face.
 *
 * States (all damped, never snapped):
 *   dormant  before its scene  — dim, slow; stirs as its scene approaches
 *   active   during its scene  — flare on arrival, fast spin, full beam
 *   claimed  after its scene   — steady medium glow + a shorter beam, so lit
 *                                beacons trace the conquered route
 *
 * Zero React state: everything is read from the singletons in useFrame and
 * written to refs / uniforms. GPU resources are created once per GPU tier and
 * disposed on unmount. The point lights are never toggled `visible` (that
 * would change the scene's light count and recompile every lit material);
 * they are parked at intensity 0 instead.
 * ========================================================================== */

const { damp } = THREE.MathUtils;

/** Mutable per-beacon state for the HUD (never React state). */
export interface BeaconRuntimeState {
  /** 0 → 1 while this beacon's scene is the active one (damped). */
  activation: number;
  /** 0 → 1 once its scene has been passed (damped). */
  claimed: number;
  /** Glow level driving the crystal: dormant ≈ 0.08, claimed ≈ 0.42, active 1. */
  energy: number;
}

export const beaconState: BeaconRuntimeState[] = BEACONS.map(() => ({ activation: 0, claimed: 0, energy: 0 }));

/* ---------------------------------------------------------------------------
 * Tuning
 * ------------------------------------------------------------------------- */

/** Height of the light shaft geometry (world units). */
const BEAM_HEIGHT = 30;
/** Point light range: only the rock right around the beacon is tinted. */
const LIGHT_RANGE = 11;
/** Largest crystal scale per beacon: the clusters grow along the journey. */
const MAX_CLUSTER_SCALE: readonly number[] = [0.85, 0.95, 1.05];
/** How far the point light sits out of the rock face (world units). */
const LIGHT_STANDOFF = 0.6;
/**
 * Distance fades [start, end] per layer: each layer fades out smoothly with
 * camera distance and is skipped once fully faded. The whole beacon is only
 * hidden beyond the fog's far plane, where it is fully fogged anyway.
 */
const HIDE_DISTANCE = FOG.far;
const SPARKLE_FADE: readonly [number, number] = [55, 80];
const GROUND_FADE: readonly [number, number] = [95, 120];
const LIGHT_FADE: readonly [number, number] = [110, 150];
/** Seconds the activation flare holds before decaying. */
const FLARE_HOLD = 0.7;

interface TierProfile {
  satellites: number;
  sparkles: number;
  beamSegments: number;
  pointLight: boolean;
  /** Without a bloom pass (tier < 2) the halo stands in for it... */
  haloBoost: number;
  /** ...but its lens streak is toned down so it never dominates. */
  streakScale: number;
}

function tierProfile(tier: GpuTier): TierProfile {
  switch (tier) {
    case 3:
      return { satellites: 4, sparkles: 144, beamSegments: 28, pointLight: true, haloBoost: 1, streakScale: 1 };
    case 2:
      return { satellites: 3, sparkles: 96, beamSegments: 24, pointLight: true, haloBoost: 1, streakScale: 1 };
    case 1:
      return { satellites: 3, sparkles: 56, beamSegments: 18, pointLight: true, haloBoost: 1.35, streakScale: 0.55 };
    default:
      return { satellites: 2, sparkles: 24, beamSegments: 12, pointLight: false, haloBoost: 1.35, streakScale: 0.55 };
  }
}

/* ---------------------------------------------------------------------------
 * State model
 * ------------------------------------------------------------------------- */

interface BeaconTargets {
  activation: number;
  claimed: number;
  energy: number;
  spin: number;
  beam: number;
  beamLength: number;
  halo: number;
  haloScale: number;
  streak: number;
  light: number;
  spread: number;
  sparkle: number;
  sparkleEnergy: number;
  ring: number;
  pulseRate: number;
  flare: number;
}

type BeaconSim = BeaconTargets & {
  initialised: boolean;
  angle: number;
  pulsePhase: number;
  orbit: number;
  rise: number;
  satSpin: number;
  ringPhase: number;
  activeTime: number;
};

function createTargets(): BeaconTargets {
  return {
    activation: 0,
    claimed: 0,
    energy: 0,
    spin: 0,
    beam: 0,
    beamLength: 0,
    halo: 0,
    haloScale: 0,
    streak: 0,
    light: 0,
    spread: 0,
    sparkle: 0,
    sparkleEnergy: 0,
    ring: 0,
    pulseRate: 0,
    flare: 0,
  };
}

function createSim(): BeaconSim {
  return {
    ...createTargets(),
    initialised: false,
    angle: 0,
    pulsePhase: 0,
    orbit: 0,
    rise: 0,
    satSpin: 0,
    ringPhase: 0,
    activeTime: 0,
  };
}

/** Writes the state targets for a beacon at the given progress / scene into `out`. */
function computeTargets(spec: BeaconSpec, progress: number, sceneIndex: number, activeTime: number, out: BeaconTargets): void {
  const own = spec.sceneIndex;
  if (sceneIndex === own) {
    out.activation = 1;
    out.claimed = 0;
    out.energy = 1;
    out.spin = 1.05;
    out.beam = 1;
    out.beamLength = 1;
    out.halo = 0.42;
    out.haloScale = 3.1;
    out.streak = 1;
    out.light = 10;
    out.spread = 1;
    out.sparkle = 1;
    out.sparkleEnergy = 1;
    out.ring = 0.2;
    out.pulseRate = 3.2;
    out.flare = activeTime < FLARE_HOLD ? 1 : 0;
    return;
  }
  if (sceneIndex > own) {
    out.activation = 0;
    out.claimed = 1;
    out.energy = 0.42;
    out.spin = 0.4;
    out.beam = 0.4;
    out.beamLength = 0.55;
    out.halo = 0.24;
    out.haloScale = 2.4;
    out.streak = 0.4;
    out.light = 3.5;
    out.spread = 0.4;
    out.sparkle = 0.55;
    out.sparkleEnergy = 0.3;
    out.ring = 0;
    out.pulseRate = 1.4;
    out.flare = 0;
    return;
  }
  // Dormant; stirs during the last stretch before its scene begins.
  const start = SCENES[own].start;
  const awaken = smoothstep(start - 0.06, start, progress);
  out.activation = 0;
  out.claimed = 0;
  out.energy = 0.08 + 0.17 * awaken;
  out.spin = 0.16 + 0.16 * awaken;
  out.beam = 0.06 * awaken;
  out.beamLength = 0.2;
  out.halo = 0.11 + 0.08 * awaken;
  out.haloScale = 1.7 + 0.4 * awaken;
  out.streak = 0.1 * awaken;
  out.light = 0.7 + 1.6 * awaken;
  out.spread = 0.12 * awaken;
  out.sparkle = 0.32 + 0.3 * awaken;
  out.sparkleEnergy = 0.1 * awaken;
  out.ring = 0;
  out.pulseRate = 0.9 + 0.8 * awaken;
  out.flare = 0;
}

/* ---------------------------------------------------------------------------
 * Resources
 * ------------------------------------------------------------------------- */

interface BeaconResources {
  crystalGeometry: THREE.BufferGeometry;
  crystalMaterial: BeaconCrystalMaterial;
  beamGeometry: THREE.BufferGeometry;
  beamMaterial: BeaconBeamMaterial;
  haloGeometry: THREE.BufferGeometry;
  haloMaterial: BeaconHaloMaterial;
  groundGeometry: THREE.BufferGeometry;
  groundMaterial: BeaconGroundMaterial;
  sparkleGeometry: THREE.BufferGeometry;
  sparkleMaterial: BeaconSparkleMaterial;
  sparkleMax: number;
  placement: BeaconPlacement;
}

/** Where each part of a beacon sits (from the terrain fit); local to the beacon unless noted. */
interface BeaconPlacement {
  clusterScale: number;
  beamBase: number;
  haloY: number;
  groundPosition: THREE.Vector3;
  groundQuaternion: THREE.Quaternion;
  groundDiameter: number;
  /** Ground glow dims the further the rock lies below the crystal. */
  groundGain: number;
  sparkleOffset: THREE.Vector3;
  /** World-space point light position. */
  lightPosition: [number, number, number];
}

function placeBeacon(spec: BeaconSpec, index: number, cluster: ReturnType<typeof createCrystalClusterGeometry>): BeaconPlacement {
  const fit = fitBeaconToTerrain(spec.position, cluster.geometry, mountainSdf, {
    maxScale: MAX_CLUSTER_SCALE[index] ?? 1,
  });
  const scale = fit.scale;
  const up = new THREE.Vector3(0, 1, 0);
  const groundNormal = fit.ground ? fit.ground.normal.clone() : up.clone();
  const groundDepth = fit.ground ? fit.ground.depth : cluster.bottomDepth * scale + 0.6;
  const groundPosition = fit.ground ? fit.ground.offset.clone() : new THREE.Vector3(0, -groundDepth, 0);
  // Sparkles orbit a little out of the face (horizontal part of the outward direction).
  const outward = new THREE.Vector3(fit.outward.x, 0, fit.outward.z);
  const light = new THREE.Vector3(...spec.position)
    .addScaledVector(fit.outward, LIGHT_STANDOFF)
    .add(new THREE.Vector3(0, 0.3, 0));
  return {
    clusterScale: scale,
    beamBase: (cluster.topTip - 0.25) * scale,
    haloY: 0.32 * scale,
    groundPosition,
    groundQuaternion: new THREE.Quaternion().setFromUnitVectors(up, groundNormal),
    groundDiameter: THREE.MathUtils.clamp(2.4 + 0.55 * groundDepth, 2.4, 4.4),
    groundGain: THREE.MathUtils.clamp(1.5 / (0.6 + groundDepth), 0.45, 1),
    sparkleOffset: outward.lengthSq() > 1e-6 ? outward.normalize().multiplyScalar(0.3) : new THREE.Vector3(),
    lightPosition: [light.x, light.y, light.z],
  };
}

function createResources(spec: BeaconSpec, index: number, tier: GpuTier): BeaconResources {
  const profile = tierProfile(tier);
  const cluster = createCrystalClusterGeometry({ seed: 0x51ab + index * 7919, satellites: profile.satellites });

  const haloGeometry = new THREE.PlaneGeometry(1, 1);
  // The halo is billboarded in the vertex stage and scaled by uScale (≤ ~5).
  haloGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3.4);

  const groundGeometry = new THREE.PlaneGeometry(1, 1);
  groundGeometry.rotateX(-Math.PI / 2);

  return {
    crystalGeometry: cluster.geometry,
    crystalMaterial: createBeaconCrystalMaterial(spec.color, crystalQualityFor(tier)),
    beamGeometry: createBeaconBeamGeometry({
      height: BEAM_HEIGHT,
      coreRadius: 0.075,
      hazeRadius: 0.62,
      radialSegments: profile.beamSegments,
    }),
    beamMaterial: createBeaconBeamMaterial(spec.color, BEAM_HEIGHT),
    haloGeometry,
    haloMaterial: createBeaconHaloMaterial(spec.color),
    groundGeometry,
    groundMaterial: createBeaconGroundMaterial(spec.color),
    sparkleGeometry: createBeaconSparkleGeometry(profile.sparkles, 0x9e37 + index * 104729),
    sparkleMaterial: createBeaconSparkleMaterial(spec.color),
    sparkleMax: profile.sparkles,
    placement: placeBeacon(spec, index, cluster),
  };
}

function disposeResources(r: BeaconResources): void {
  r.crystalGeometry.dispose();
  r.crystalMaterial.dispose();
  r.beamGeometry.dispose();
  r.beamMaterial.dispose();
  r.haloGeometry.dispose();
  r.haloMaterial.dispose();
  r.groundGeometry.dispose();
  r.groundMaterial.dispose();
  r.sparkleGeometry.dispose();
  r.sparkleMaterial.dispose();
}

/* ---------------------------------------------------------------------------
 * One beacon
 * ------------------------------------------------------------------------- */

interface BeaconProps {
  spec: BeaconSpec;
  index: number;
  tier: GpuTier;
}

const _cameraWorld = new THREE.Vector3();
const _cameraLocal = new THREE.Vector3();
const _beaconWorld = new THREE.Vector3();

function Beacon({ spec, index, tier }: BeaconProps): JSX.Element {
  const profile = useMemo(() => tierProfile(tier), [tier]);
  const resources = useMemo(() => createResources(spec, index, tier), [spec, index, tier]);
  useLayoutEffect(() => () => disposeResources(resources), [resources]);

  const root = useRef<THREE.Group>(null);
  const cluster = useRef<THREE.Group>(null);
  const crystal = useRef<THREE.Mesh>(null);
  const beam = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const ground = useRef<THREE.Mesh>(null);
  const sparkles = useRef<THREE.Points>(null);
  const light = useRef<THREE.PointLight>(null);

  const sim = useRef<BeaconSim>(createSim());
  const targets = useRef<BeaconTargets>(createTargets());

  const phaseOffset = index * 2.17;
  const place = resources.placement;

  useFrame(({ camera, gl, size }, rawDelta) => {
    const r = root.current;
    const c = cluster.current;
    const m = crystal.current;
    if (!r || !c || !m) return;

    const dt = Math.min(Math.max(rawDelta, 0), 0.1);
    const s = sim.current;
    const tg = targets.current;
    const t = scrollStore.elapsed;
    const progress = scrollStore.dampedProgress;
    const sceneIndex = scrollStore.activeSceneIndex;
    const isActive = sceneIndex === spec.sceneIndex;

    // ---- State machine → damped channels.
    if (!s.initialised) {
      // First frame: start where the story is (no flare on a mid-journey reload).
      s.activeTime = isActive ? FLARE_HOLD + 1 : 0;
      computeTargets(spec, progress, sceneIndex, s.activeTime, tg);
      Object.assign(s, tg);
      s.initialised = true;
    } else {
      s.activeTime = isActive ? s.activeTime + dt : 0;
      computeTargets(spec, progress, sceneIndex, s.activeTime, tg);
    }

    s.activation = damp(s.activation, tg.activation, 2.4, dt);
    s.claimed = damp(s.claimed, tg.claimed, 1.6, dt);
    s.energy = damp(s.energy, tg.energy, 2.2, dt);
    s.spin = damp(s.spin, tg.spin, 1.4, dt);
    s.beam = damp(s.beam, tg.beam, 1.8, dt);
    s.beamLength = damp(s.beamLength, tg.beamLength, 1.2, dt);
    s.halo = damp(s.halo, tg.halo, 2.4, dt);
    s.haloScale = damp(s.haloScale, tg.haloScale, 2, dt);
    s.streak = damp(s.streak, tg.streak, 2, dt);
    s.light = damp(s.light, tg.light, 2.6, dt);
    s.spread = damp(s.spread, tg.spread, 1.6, dt);
    s.sparkle = damp(s.sparkle, tg.sparkle, 2, dt);
    s.sparkleEnergy = damp(s.sparkleEnergy, tg.sparkleEnergy, 1.2, dt);
    s.ring = damp(s.ring, tg.ring, 2, dt);
    s.pulseRate = damp(s.pulseRate, tg.pulseRate, 1.5, dt);
    s.flare = damp(s.flare, tg.flare, tg.flare > s.flare ? 6 : 1.6, dt);

    // Phase accumulators integrate damped rates, so speed changes never jump.
    s.angle += s.spin * dt;
    s.pulsePhase += s.pulseRate * dt;
    s.orbit += (0.25 + 0.95 * s.sparkleEnergy) * dt;
    s.rise += (0.05 + 0.28 * s.sparkleEnergy) * dt;
    s.satSpin += (0.2 + 0.7 * s.energy) * dt;
    s.ringPhase += (0.35 + 0.3 * s.flare) * dt;

    const hud = beaconState[index];
    hud.activation = s.activation;
    hud.claimed = s.claimed;
    hud.energy = s.energy;

    // ---- Visibility / distance culling.
    const exposure = sceneFx.exposure;
    camera.getWorldPosition(_cameraWorld);
    _beaconWorld.set(spec.position[0], spec.position[1], spec.position[2]);
    const distance = _cameraWorld.distanceTo(_beaconWorld);
    const shown = exposure > 0.002 && distance < HIDE_DISTANCE;
    r.visible = shown;

    const l = light.current;
    if (l) {
      const reach = shown ? 1 - smoothstep(LIGHT_FADE[0], LIGHT_FADE[1], distance) : 0;
      const flicker = 0.94 + 0.06 * Math.sin(s.pulsePhase * Math.PI * 2);
      l.intensity = (s.light + 8 * s.flare) * flicker * exposure * reach;
    }
    if (!shown) return;

    // ---- Cluster motion: spin, gentle precession and hover.
    c.rotation.set(0.05 * Math.sin(t * 0.37 + phaseOffset), s.angle, 0.06 * Math.sin(t * 0.41 + phaseOffset * 1.3));
    // Hover amplitude matches the terrain fit's `hover` allowance (0.08).
    c.position.y = 0.075 * Math.sin(t * 0.8 + phaseOffset);
    m.updateWorldMatrix(true, false);
    _cameraLocal.copy(_cameraWorld);
    m.worldToLocal(_cameraLocal);

    const pulse = 0.5 + 0.5 * Math.sin(s.pulsePhase * Math.PI * 2);

    const cu = resources.crystalMaterial.uniforms;
    cu.uTime.value = t;
    cu.uEnergy.value = s.energy;
    cu.uFlare.value = s.flare;
    cu.uPulse.value = pulse;
    cu.uSpread.value = s.spread + 0.35 * s.flare;
    cu.uSatSpin.value = s.satSpin;
    cu.uCamLocal.value.copy(_cameraLocal);
    cu.uExposure.value = exposure;

    // ---- Light shaft.
    const b = beam.current;
    if (b) {
      const bu = resources.beamMaterial.uniforms;
      bu.uTime.value = t;
      bu.uIntensity.value = s.beam * (0.85 + 0.15 * pulse) + 0.6 * s.flare;
      bu.uLength.value = s.beamLength;
      bu.uExposure.value = exposure;
      b.visible = bu.uIntensity.value > 0.004;
    }

    // ---- Halo.
    const h = halo.current;
    if (h) {
      const hu = resources.haloMaterial.uniforms;
      hu.uScale.value = s.haloScale * (1 + 0.04 * pulse) + 1.6 * s.flare;
      hu.uIntensity.value = (s.halo * (0.9 + 0.1 * pulse) + 0.45 * s.flare) * profile.haloBoost;
      hu.uStreak.value = (s.streak + s.flare) * profile.streakScale;
      hu.uRotation.value = s.angle * 0.35;
      hu.uExposure.value = exposure;
      h.visible = hu.uIntensity.value > 0.003;
    }

    // ---- Ground glow pool.
    const g = ground.current;
    if (g) {
      const gu = resources.groundMaterial.uniforms;
      gu.uTime.value = t;
      const fade = 1 - smoothstep(GROUND_FADE[0], GROUND_FADE[1], distance);
      gu.uIntensity.value = (0.08 + 0.42 * s.energy + 0.35 * s.flare) * place.groundGain * fade;
      gu.uRing.value = s.ring + 1.2 * s.flare;
      gu.uRingPhase.value = s.ringPhase;
      gu.uExposure.value = exposure;
      g.visible = fade > 0.001;
    }

    // ---- Sparkles: allocate max once, draw what the frame budget allows.
    const p = sparkles.current;
    if (p) {
      const su = resources.sparkleMaterial.uniforms;
      const fade = 1 - smoothstep(SPARKLE_FADE[0], SPARKLE_FADE[1], distance);
      const visible = fade > 0.001 && s.sparkle > 0.01;
      p.visible = visible;
      if (visible) {
        const count = adaptiveQuality.countFor(resources.sparkleMax, Math.ceil(resources.sparkleMax * 0.2));
        resources.sparkleGeometry.setDrawRange(0, count);
        const perspective = camera as THREE.PerspectiveCamera;
        const fov = perspective.isPerspectiveCamera ? perspective.fov : 42;
        su.uPointScale.value = (size.height * gl.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(fov) * 0.5));
        su.uTime.value = t;
        su.uOrbit.value = s.orbit;
        su.uRise.value = s.rise;
        su.uEnergy.value = s.sparkleEnergy;
        su.uIntensity.value = (s.sparkle * (0.7 + 1.1 * s.energy) + 0.8 * s.flare) * fade;
        su.uExposure.value = exposure;
      }
    }
  });

  return (
    <>
      <group ref={root} name={`beacon-${spec.id}`} position={spec.position}>
        <group ref={cluster} scale={place.clusterScale}>
          <mesh ref={crystal} geometry={resources.crystalGeometry} material={resources.crystalMaterial} dispose={null} />
        </group>
        <mesh
          ref={beam}
          geometry={resources.beamGeometry}
          material={resources.beamMaterial}
          position={[0, place.beamBase, 0]}
          renderOrder={2}
          dispose={null}
        />
        <mesh
          ref={halo}
          geometry={resources.haloGeometry}
          material={resources.haloMaterial}
          position={[0, place.haloY, 0]}
          renderOrder={3}
          dispose={null}
        />
        <mesh
          ref={ground}
          geometry={resources.groundGeometry}
          material={resources.groundMaterial}
          position={place.groundPosition}
          quaternion={place.groundQuaternion}
          scale={place.groundDiameter}
          renderOrder={1}
          dispose={null}
        />
        <points
          ref={sparkles}
          geometry={resources.sparkleGeometry}
          material={resources.sparkleMaterial}
          position={place.sparkleOffset}
          scale={0.6 + 0.4 * place.clusterScale}
          renderOrder={4}
          dispose={null}
        />
      </group>
      {profile.pointLight ? (
        <pointLight
          ref={light}
          position={place.lightPosition}
          color={spec.color}
          intensity={0}
          distance={LIGHT_RANGE}
          decay={2}
        />
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------------------------
 * All beacons
 * ------------------------------------------------------------------------- */

export function ProjectBeacons(): JSX.Element {
  const tier = scrollStore.gpuTier;
  return (
    <group name="project-beacons">
      {BEACONS.map((spec, index) => (
        <Beacon key={`${spec.id}-${tier}`} spec={spec} index={index} tier={tier} />
      ))}
    </group>
  );
}

export default ProjectBeacons;
