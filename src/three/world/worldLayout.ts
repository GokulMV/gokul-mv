import * as THREE from 'three';
import type { Vec3Tuple } from '../../store/scrollStore';
import { WAYPOINTS } from '../protagonistPath';

/* ==========================================================================
 * World layout — the single source of truth for where everything lives.
 * Terrain, beacons, effects and the camera rig all read these constants so
 * the climb route, the rock and the framing can never drift apart.
 * ========================================================================== */

export { WAYPOINTS };

/** The six mountain zones of the climb. */
export const ZONES = {
  baseCamp: {
    /** Flat outcrop the journey starts on. */
    center: WAYPOINTS.baseCamp,
    radius: 7,
  },
  cliffOne: {
    /** Steep granite wall climbed in Scene 4 (Company 1). */
    from: WAYPOINTS.baseCamp,
    to: WAYPOINTS.firstLedge,
  },
  chasmOne: {
    /** Medium canyon gap jumped in Scene 5 (Company 2). */
    takeoff: WAYPOINTS.firstLedge,
    landing: WAYPOINTS.chasmOneLanding,
    top: WAYPOINTS.chasmOneTop,
    gap: 6,
  },
  chasmTwo: {
    /** High-difficulty abyss leapt in Scene 6 (Company 3). */
    takeoff: WAYPOINTS.chasmOneTop,
    catch: WAYPOINTS.chasmTwoCatch,
    horizontalGap: 12,
    verticalGap: 8,
  },
  summit: {
    /** Sharp peak the protagonist stands on in Scenes 7–10. */
    peak: WAYPOINTS.summit,
  },
  horizon: {
    /** Massive snow-capped range revealed in Scene 8. */
    peakCount: 9,
    zNear: -180,
    zFar: -260,
  },
} as const;

export interface BeaconSpec {
  id: 'project-1' | 'project-2' | 'project-3';
  /** Matches Project.stage in the portfolio store. */
  stage: 1 | 2 | 3;
  /** scrollStore.activeSceneIndex during which this beacon is the focus. */
  sceneIndex: 3 | 4 | 5;
  position: Vec3Tuple;
  color: string;
}

export const BEACONS: readonly BeaconSpec[] = [
  { id: 'project-1', stage: 1, sceneIndex: 3, position: [0.8, 10, -4.5], color: '#5EEAD4' },
  { id: 'project-2', stage: 2, sceneIndex: 4, position: [5.8, 27, -15], color: '#A78BFA' },
  { id: 'project-3', stage: 3, sceneIndex: 5, position: [-2.2, 48, -30.5], color: '#F4C77B' },
] as const;

/** Volumetric cloud curtain configuration (Scenes 1, 9 and 10). */
export const CLOUD_CURTAIN = {
  /** World-space depth span of the cloud layers for the opening shot. */
  zNear: 6,
  zFar: 26,
  /** How far each half travels laterally when fully parted. */
  partX: 28,
  timeline: {
    openStart: 0.0,
    openEnd: 0.08,
    /* The return waits until the paper is on the lens so the "last pull" hero
     * shot (standing before the next mountain) stays clear. See ENDING. */
    returnStart: 0.955,
    returnEnd: 0.985,
    dissolveStart: 0.985,
    dissolveEnd: 1.0,
  },
} as const;

/**
 * Story ending (Scenes 8–10). The protagonist stands before the next big,
 * continuous mountain — ready for the next journey. A gust tears a paper
 * loose; it flies at the camera and sticks to the lens showing the contact
 * details; scrolling on peels it away, the world dissolves to the void and
 * the credits / footer section scrolls in after progress 1.0.
 */
export const ENDING = {
  /** Over-the-shoulder reveal of the next mountain (Scene 8). */
  revealStart: 0.86,
  revealEnd: 0.92,
  /** Camera pulls back: the protagonist standing before the next mountain. */
  heroPullStart: 0.92,
  heroPullEnd: 0.945,
  /** The gust lifts the paper and carries it to the lens. */
  paperGustStart: 0.945,
  paperStick: 0.955,
  /** Paper on the lens with the contact details (interactive). */
  paperHoldEnd: 0.985,
  /** Scrolling on peels the paper off and the wind takes it out of frame. */
  paperPeelEnd: 0.995,
  /** Progress 1.0 = the end of the 3D track; the footer section follows it. */
  footerAfter: 1.0,
  /**
   * Where the paper leaves the backpack: the protagonist stands on the summit
   * [0,55,-35] facing the next mountain (-z), so the pack on their back faces
   * the camera; its top flap is ~1.25 up and ~0.3 toward +z.
   */
  paperOrigin: [0, 56.25, -34.7] as Vec3Tuple,
} as const;

/**
 * The next journey: one huge, continuous mountain dead ahead on the horizon,
 * clearly bigger than the climbed one (summit 55), flanked by the rest of the
 * range. Sized so that from the Scene 8 camera [-1.2,56.7,-32.2] aiming at
 * HORIZON_AIM, and from the final pull-back camera [0,56.5,-27], its summit
 * sits in the upper third of a 42° (vertical fov) frame.
 */
export const NEXT_MOUNTAIN = {
  summit: [0, 118, -235] as Vec3Tuple,
  /** Approximate footprint half-extents of the massif's base (x, z). */
  baseHalfWidth: 130,
  baseHalfDepth: 70,
  /** Valley floor the massif rises from (hidden in valley mist). */
  baseY: -40,
} as const;

/** Where the Scene 8 over-the-shoulder shot aims (from the scene spec). */
export const HORIZON_AIM: Vec3Tuple = [0, 68, -190];

/** Direction *towards* the sun: low golden-hour sun to the right, slightly ahead. */
export const SUN_DIRECTION = new THREE.Vector3(0.7, 0.45, -0.25).normalize();

export const PALETTE = {
  /** Final Scene 10 canvas colour. */
  void: '#040508',
  skyZenith: '#070D1C',
  skyMid: '#1B2A4A',
  /** Horizon colour away from the sun. */
  skyHorizon: '#3A4E72',
  /** Warm horizon glow towards the sun. */
  skySunGlow: '#F0A868',
  sun: '#FFD9A8',
  fog: '#2B3A58',
  granite: '#4A4F57',
  graniteDark: '#2E3239',
  snow: '#DDE7F2',
  snowShadow: '#8EA3C2',
  cloudLit: '#E8EEF8',
  cloudShadow: '#7E8BA3',
  cloudLining: '#FFD2A1',
  hemisphereSky: '#9DB4D8',
  hemisphereGround: '#1A1F2B',
} as const;

/** Linear scene fog: distant peaks (≈150–260 units away) stay visible but hazy. */
export const FOG = {
  near: 45,
  far: 380,
} as const;

/** Camera clip planes. Sky dome radius must stay below `far`. */
export const CAMERA_CLIP = {
  near: 0.1,
  far: 1200,
  fov: 42,
} as const;

export const SKY_DOME_RADIUS = 1000;
