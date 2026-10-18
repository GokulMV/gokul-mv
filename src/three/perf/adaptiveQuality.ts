import type { GpuTier } from '../../store/scrollStore';

/* ==========================================================================
 * Adaptive quality — a mutable singleton like scrollStore.
 *
 * The frame-time monitor in CameraRig lowers `particleDensity` when frame
 * deltas exceed the 18ms budget and raises it again when there is headroom.
 * Particle systems allocate their maximum instance count once and read
 * `particleDensity` (0 → 1) every frame to set how many instances to draw.
 * Never stored in React state.
 * ========================================================================== */

export type QualityLevel = 'ultra' | 'high' | 'medium' | 'low';

export type QualityListener = (density: number, level: QualityLevel) => void;

export interface AdaptiveQualityState {
  /** Fraction (0 → 1) of each particle system's maximum to draw. */
  particleDensity: number;
  /** Lowest density the monitor may fall to. */
  minDensity: number;
  /** Highest density allowed for this device (set from the GPU tier). */
  maxDensity: number;
  level: QualityLevel;
  /** Frame budget in ms (≈55fps); sustained frames above this degrade quality. */
  readonly budgetMs: number;
  /** Exponential moving average of frame time in ms (written by the monitor). */
  frameMsEma: number;
  /** Number of downgrade steps taken since boot. */
  downgrades: number;
  /** Number of upgrade steps taken since boot. */
  upgrades: number;
  init: (tier: GpuTier) => void;
  setDensity: (density: number) => void;
  /** Scales a system's maximum count by the current density (at least `floor`). */
  countFor: (maxCount: number, floor?: number) => number;
  onChange: (listener: QualityListener) => () => void;
}

const listeners = new Set<QualityListener>();

const TIER_MAX_DENSITY: Readonly<Record<GpuTier, number>> = {
  0: 0.2,
  1: 0.45,
  2: 0.8,
  3: 1,
};

function levelFor(density: number): QualityLevel {
  if (density >= 0.9) return 'ultra';
  if (density >= 0.65) return 'high';
  if (density >= 0.4) return 'medium';
  return 'low';
}

export const adaptiveQuality: AdaptiveQualityState = {
  particleDensity: 0.8,
  minDensity: 0.15,
  maxDensity: 0.8,
  level: 'high',
  budgetMs: 18,
  frameMsEma: 16.7,
  downgrades: 0,
  upgrades: 0,

  init(tier: GpuTier): void {
    adaptiveQuality.maxDensity = TIER_MAX_DENSITY[tier];
    adaptiveQuality.setDensity(TIER_MAX_DENSITY[tier]);
  },

  setDensity(density: number): void {
    const next = Math.min(adaptiveQuality.maxDensity, Math.max(adaptiveQuality.minDensity, density));
    if (Math.abs(next - adaptiveQuality.particleDensity) < 1e-4) return;
    adaptiveQuality.particleDensity = next;
    adaptiveQuality.level = levelFor(next);
    listeners.forEach((listener) => listener(next, adaptiveQuality.level));
  },

  countFor(maxCount: number, floor = 0): number {
    return Math.max(floor, Math.min(maxCount, Math.round(maxCount * adaptiveQuality.particleDensity)));
  },

  onChange(listener: QualityListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export default adaptiveQuality;
