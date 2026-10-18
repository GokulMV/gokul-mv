import { GEAR_DROP_AT, GEAR_EQUIP_AT, clamp01, smoothstep, type GearId } from '../store/scrollStore';
import { PATH_PHASES, altitudeAt } from '../three/protagonistPath';
import { ENDING } from '../three/world/worldLayout';

/* ==========================================================================
 * Procedural sound engine — Web Audio API only, zero samples, zero deps.
 *
 * Signal flow
 *   sources ─► master (mute ramp) ─► compressor (-18 dB, 3:1, knee 12)
 *                                     ├─► dry (72 %) ──────────────┐
 *                                     └─► convolver ─► wet (28 %) ─┴─► output ─► speakers
 *   The convolver holds a procedural 3 s stereo canyon impulse response
 *   (25 ms pre-delay, sparse early reflections as smooth 6 ms noise bursts,
 *   pink noise decaying 60 dB over 3 s with air absorption), so the beds sit
 *   in one space. Foley takes its own bus (see below).
 *   `output` follows the mute ramp too, so reverb tails fade instead of
 *   being cut when the context suspends.
 *
 * Beds (always running while enabled, driven by `updateOnFrame`)
 *   • Wind: a 5 s looping stereo Brownian (1/f²) buffer — never white
 *     noise — split into a low-pass "canyon rumble" (110–220 Hz, Q 1.2) and
 *     a per-channel band-pass "howl" (260–780 Hz, Q 3.5) whose left and right
 *     centres are swept by 0.14 Hz and 0.19 Hz sine LFOs in opposite phase,
 *     on top of a centre set by altitude and scroll speed. Level ≤ 0.14,
 *     swelling with fast scrolling, the two chasm jumps and the paper gust,
 *     and silent from progress 0.99 (Scene 10 void).
 *   • Pad: D2 / A2 / E3 (root–fifth–ninth) through a 340 Hz low-pass at
 *     0.035. Over the summit (0.78 → 0.92) the filter opens to 950 Hz and a
 *     soft F#4 shimmer fades in.
 *
 * Foley — the gear and the climbing contacts are pre-computed mono PCM
 * buffers (4 variants each): low-passed noise and a sub thump, shaped by
 * smooth raised-cosine envelopes, with zero DC and exactly 64 zero samples at
 * both ends, played from sample 0, so a start or a stop can never click.
 * They run on a separate foley bus — warm 1.1 kHz low-pass, its own
 * compressor, only 4 % canyon reverb — so no transient reaches the 3 s canyon
 * and comes back as slap-back. One-shots fire on forward threshold crossings,
 * with hysteresis, per-cue cooldowns and seek detection so a scrubbed or
 * jumped threshold never machine-guns a sound, and a gear one-shot never
 * plays twice within 80 ms (a direct call and a cue on the same threshold):
 *   • playGearEquip       — cloth and leather brush (GEAR_EQUIP_AT)
 *   • playGearDrop        — low air-and-cloth release (GEAR_DROP_AT)
 *   • playChasmJumpWhoosh — deep, wide air rush (both chasm take-offs)
 *   • playPaperThrowAndFlutter — soft warm paper flutter on the foley bus (the
 *     gust that tears the note out of the backpack, and a lighter one when it
 *     peels off the lens)
 * plus soft boot contacts while scrolling through the three climbs, at
 * least 380 ms apart (updateClimbingFoley).
 *
 * Muted by default. The AudioContext is created on the first user gesture
 * (browser autoplay policy) from `setEnabled(true)` / `toggle()`, and is
 * resumed on later interactions if the browser suspends it.
 *
 * `SoundGraph` takes any BaseAudioContext, so the whole mix can also be
 * rendered with an OfflineAudioContext for level checks.
 * ========================================================================== */

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

/** Master level when enabled. Wind and pad sit far below it; foley peaks are tamed by the compressor. */
const MASTER_LEVEL = 0.9;
/** setTargetAtTime reaches ~95 % after 3τ, so the mute crossfade completes in 0.35 s. */
const MUTE_TIME_CONSTANT = 0.35 / 3;

const REVERB_WET = 0.28;
const IR_SECONDS = 3;
const IR_PREDELAY = 0.025;

const BROWN_SECONDS = 5;
const BROWN_LEAK = 0.998;

/** Foley bus: warm low-pass, and the canyon-reverb share it keeps (wet, of the total). */
const FOLEY_LOWPASS_HZ = 1100;
const FOLEY_WET = 0.04;
/** Pre-computed foley: samples held at exactly 0 at both ends, and variants per sound. */
const FOLEY_EDGE = 64;
const FOLEY_VARIANTS = 4;
/** Playback gains of the normalised foley buffers. */
const BOOT_STEP_GAIN = 0.055;
const GEAR_EQUIP_GAIN = 0.075;
const GEAR_DROP_GAIN = 0.07;
/** A gear one-shot never plays twice within this window (s). */
const GEAR_ONE_SHOT_GUARD = 0.08;

const WIND_MAX = 0.14;
const RUMBLE_MIN_HZ = 110;
const RUMBLE_MAX_HZ = 220;
const HOWL_MIN_HZ = 260;
const HOWL_MAX_HZ = 780;
const HOWL_Q = 3.5;
const HOWL_LFO_HZ_LEFT = 0.14;
const HOWL_LFO_HZ_RIGHT = 0.19;
const HOWL_LFO_DEPTH_HZ = 55;
/** Make-up gain: a Q 3.5 band of 1/f² noise is ~20 dB quieter than its low end. */
const HOWL_MAKEUP = 7.5;

const PAD_LEVEL = 0.035;
const PAD_CLOSED_HZ = 340;
const PAD_OPEN_HZ = 950;
/**
 * D2, A2, E3 — an open root–fifth–ninth voicing, spread across the stereo
 * field. [frequency, detune cents, level, waveform, pan]. Levels keep the pad
 * a few dB under the wind bed.
 */
const PAD_VOICES: ReadonlyArray<readonly [number, number, number, OscillatorType, number]> = [
  [73.42, -4, 0.25, 'triangle', 0],
  [110.0, 3, 0.16, 'triangle', -0.35],
  [164.81, 5, 0.12, 'sine', 0.35],
];
const SHIMMER_HZ = 369.99;
const SHIMMER_LEVEL = 0.014;
const SUMMIT_START = PATH_PHASES.scrambleEnd; // 0.78
const SUMMIT_END = ENDING.heroPullStart; // 0.92

/** Bed parameter smoothing (seconds). */
const LEVEL_TIME_CONSTANT = 0.14;
const FILTER_TIME_CONSTANT = 0.22;
/** Bed parameters are re-targeted at most this often (keeps the automation timeline short). */
const PARAM_INTERVAL = 1 / 30;

/** A cue re-arms only after progress falls this far back below its threshold. */
const CUE_HYSTERESIS = 0.004;
/** Minimum time between two firings of the same cue. */
const CUE_COOLDOWN = 0.6;
/** Minimum time between any two one-shots. */
const ONE_SHOT_SPACING = 0.12;

/** Climbing stretches (progress) that get boot / glove contacts: cliff 1, the pillar, the scramble. */
const CLIMB_ZONES: ReadonlyArray<readonly [number, number]> = [
  [PATH_PHASES.ascentStart, PATH_PHASES.ascentEnd],
  [PATH_PHASES.jumpOneEnd, PATH_PHASES.climbOneEnd],
  [PATH_PHASES.leapTwoEnd, PATH_PHASES.scrambleEnd],
];
/** Contacts need the page moving at least this fast (progress / s). */
const CLIMB_MIN_SPEED = 0.0005;
/** Shortest gap between two contacts (s); slower scrolling stretches it to ~0.7 s. */
const CLIMB_STEP_MIN = 0.38;
/** A per-frame progress step this large, or this fast, is a seek (End key, rail click): no one-shots. */
const SEEK_STEP = 0.03;
const SEEK_SPEED = 0.8;
/** One-shots stay suppressed this long after the last seek frame (the damped tail of a jump). */
const SEEK_HOLD = 0.25;

/* -------------------------------------------------------------------------- */
/* Buffers                                                                    */
/* -------------------------------------------------------------------------- */

/** Paul Kellet's refined pink (1/f) filter, one instance per channel. */
class PinkFilter {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private b3 = 0;
  private b4 = 0;
  private b5 = 0;
  private b6 = 0;

  next(white: number): number {
    this.b0 = 0.99886 * this.b0 + white * 0.0555179;
    this.b1 = 0.99332 * this.b1 + white * 0.0750759;
    this.b2 = 0.969 * this.b2 + white * 0.153852;
    this.b3 = 0.8665 * this.b3 + white * 0.3104856;
    this.b4 = 0.55 * this.b4 + white * 0.5329522;
    this.b5 = -0.7616 * this.b5 - white * 0.016898;
    const out = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + white * 0.5362;
    this.b6 = white * 0.115926;
    return out * 0.11;
  }
}

/** Cross-fade the end of a looping buffer into its start so the loop has no seam. */
function crossfadeLoop(data: Float32Array, fade: number): void {
  const length = data.length;
  for (let i = 0; i < fade; i += 1) {
    const t = i / fade;
    const tail = length - fade + i;
    data[tail] = data[tail] * Math.cos(t * Math.PI * 0.5) + data[i] * Math.sin(t * Math.PI * 0.5);
  }
}

function normalizePeak(data: Float32Array, peak: number): void {
  let mean = 0;
  for (let i = 0; i < data.length; i += 1) mean += data[i];
  mean /= data.length;
  let max = 0;
  for (let i = 0; i < data.length; i += 1) {
    data[i] -= mean;
    const a = Math.abs(data[i]);
    if (a > max) max = a;
  }
  if (max > 0) {
    const k = peak / max;
    for (let i = 0; i < data.length; i += 1) data[i] *= k;
  }
}

/**
 * Brownian (1/f²) noise: leaky-integrated white noise, DC removed and
 * peak-normalised, independent per channel (wide, decorrelated stereo). The
 * leak sets the corner below which it flattens: 0.998 (~15 Hz) for the wind
 * bed; the foley uses 0.99 (~75 Hz) so a 45 ms slice taken anywhere in the
 * buffer has a steady level instead of riding the slow random-walk drift.
 */
function createBrownNoiseBuffer(ctx: BaseAudioContext, seconds: number, channels = 2, leak = BROWN_LEAK): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(channels, length, ctx.sampleRate);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel);
    let b = 0;
    for (let i = 0; i < length; i += 1) {
      b = leak * b + (Math.random() * 2 - 1) * 0.02;
      data[i] = b;
    }
    normalizePeak(data, 0.85);
    crossfadeLoop(data, Math.min(8192, Math.floor(length / 6)));
  }
  return buffer;
}

/* --- Pre-computed foley -------------------------------------------------- */

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

/** Two cascaded one-pole low-passes (12 dB / octave); cutoff may change per sample. */
class SoftLowpass {
  private y1 = 0;
  private y2 = 0;

  constructor(private readonly rate: number) {}

  next(x: number, cutoffHz: number): number {
    const a = 1 - Math.exp((-2 * Math.PI * cutoffHz) / this.rate);
    this.y1 += a * (x - this.y1);
    this.y2 += a * (this.y1 - this.y2);
    return this.y2;
  }
}

/** Hann rise over [start, start + rise], hold, Hann fall over [end - fall, end]; 0 outside. */
function hannGate(t: number, start: number, end: number, rise: number, fall: number): number {
  if (t <= start || t >= end) return 0;
  if (t < start + rise) return 0.5 - 0.5 * Math.cos((Math.PI * (t - start)) / rise);
  if (t > end - fall) return 0.5 - 0.5 * Math.cos((Math.PI * (end - t)) / fall);
  return 1;
}

/**
 * Builds one mono foley buffer: `sample(t, rand)` is the raw signal and
 * `envelope(t)` its smooth amplitude. The result has zero DC (the mean is
 * removed in proportion to the envelope, so the ends stay silent), a peak of
 * 1, and exactly FOLEY_EDGE zero samples at both ends.
 */
function createFoleyBuffer(
  ctx: BaseAudioContext,
  seconds: number,
  seed: number,
  render: (rate: number, rand: () => number) => (t: number) => number,
  envelope: (t: number) => number,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.floor(seconds * rate);
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  const weight = new Float32Array(length);
  const sample = render(rate, mulberry32(seed));
  const usable = (length - 2 * FOLEY_EDGE) / rate;
  let sum = 0;
  let weightSum = 0;
  for (let i = 0; i < length; i += 1) {
    const t = (i - FOLEY_EDGE) / rate;
    const raw = sample(Math.max(0, t));
    const w = i < FOLEY_EDGE || i >= length - FOLEY_EDGE ? 0 : envelope(Math.min(t, usable));
    weight[i] = w;
    data[i] = raw * w;
    sum += data[i];
    weightSum += w;
  }
  const dc = weightSum > 0 ? sum / weightSum : 0;
  let peak = 0;
  for (let i = 0; i < length; i += 1) {
    data[i] -= dc * weight[i];
    peak = Math.max(peak, Math.abs(data[i]));
  }
  const k = peak > 0 ? 1 / peak : 0;
  for (let i = 0; i < length; i += 1) data[i] = i < FOLEY_EDGE || i >= length - FOLEY_EDGE ? 0 : data[i] * k;
  return buffer;
}

/**
 * Rubber boot sole on rock, 110 ms: firm "velvet" pink noise low-passed at
 * 340 Hz (6 ms attack, fast decay) over a light sub body gliding 55 → 32 Hz.
 * No gravel, no high frequencies, no booming heartbeat.
 */
function createBootStepBuffer(ctx: BaseAudioContext, seed: number): AudioBuffer {
  const seconds = 0.11;
  return createFoleyBuffer(
    ctx,
    seconds,
    seed,
    (rate, rand) => {
      const pink = new PinkFilter();
      const lp = new SoftLowpass(rate);
      let phase = rand() * Math.PI * 2;
      let lastT = 0;
      return (t) => {
        const f = 32 + (55 - 32) * Math.exp(-t / 0.03);
        phase += 2 * Math.PI * f * Math.max(0, t - lastT);
        lastT = t;
        const sub = Math.sin(phase) * Math.exp(-t / 0.035);
        const attack = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, t / 0.006));
        const velvet = lp.next(pink.next(rand() * 2 - 1), 340) * 4 * attack * Math.exp(-t / 0.022);
        return 0.28 * sub + 0.85 * velvet;
      };
    },
    (t) => hannGate(t, 0, seconds - (2 * FOLEY_EDGE) / ctx.sampleRate, 0.004, 0.05),
  );
}

/**
 * Gear settling onto the body, 220 ms: a tight, damped pack-settle thump
 * (75 → 42 Hz, decaying in ~18 ms) then a firmer cloth rub — pink noise
 * low-passed at 420 Hz with a 14 ms rise, followed by a 620 Hz layer.
 */
function createGearEquipBuffer(ctx: BaseAudioContext, seed: number): AudioBuffer {
  const seconds = 0.22;
  return createFoleyBuffer(
    ctx,
    seconds,
    seed,
    (rate, rand) => {
      const pinkA = new PinkFilter();
      const pinkB = new PinkFilter();
      const lpA = new SoftLowpass(rate);
      const lpB = new SoftLowpass(rate);
      let phase = 0; // starts on a zero crossing, so the thump never steps
      let lastT = 0;
      return (t) => {
        let thump = 0;
        if (t < 0.06) {
          const f = 42 + (75 - 42) * Math.exp(-t / 0.02);
          phase += 2 * Math.PI * f * Math.max(0, t - lastT);
          thump = Math.sin(phase) * Math.exp(-t / 0.018) * (1 - Math.exp(-t / 0.0015)) * (1 - smoothstep(0.045, 0.06, t));
        }
        lastT = t;
        const rubA = lpA.next(pinkA.next(rand() * 2 - 1), 420) * 3 * hannGate(t, 0.004, 0.14, 0.014, 0.09);
        const rubB = lpB.next(pinkB.next(rand() * 2 - 1), 620) * 2.4 * hannGate(t, 0.05, 0.217, 0.03, 0.1);
        return 0.45 * thump + rubA + 0.75 * rubB;
      };
    },
    () => 1,
  );
}

/** Air-and-cloth release, 360 ms: pink noise through a low-pass gliding 320 → 120 Hz, smooth cosine envelope. */
function createGearDropBuffer(ctx: BaseAudioContext, seed: number): AudioBuffer {
  const seconds = 0.36;
  const usable = seconds - (2 * FOLEY_EDGE) / ctx.sampleRate;
  return createFoleyBuffer(
    ctx,
    seconds,
    seed,
    (rate, rand) => {
      const pink = new PinkFilter();
      const lp = new SoftLowpass(rate);
      return (t) => lp.next(pink.next(rand() * 2 - 1), 320 * Math.pow(120 / 320, Math.min(1, t / usable)));
    },
    (t) => hannGate(t, 0, usable, usable * 0.22, usable * 0.78),
  );
}

function createPinkNoiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const pink = new PinkFilter();
  for (let i = 0; i < length; i += 1) data[i] = pink.next(Math.random() * 2 - 1);
  normalizePeak(data, 0.9);
  return buffer;
}

/**
 * Procedural canyon impulse response: 25 ms of silence, a few sparse early
 * reflections (different per ear, smooth noise bursts), then pink noise decaying by 60 dB over
 * IR_SECONDS through a one-pole low-pass whose cutoff falls from 9 kHz to
 * 1.4 kHz (air absorption: the tail darkens as it dies).
 */
function createCanyonImpulse(ctx: BaseAudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const pre = Math.floor(IR_PREDELAY * rate);
  const length = pre + Math.floor(IR_SECONDS * rate);
  const buffer = ctx.createBuffer(2, length, rate);
  const decay = Math.log(1000) / IR_SECONDS; // -60 dB at IR_SECONDS
  const fadeIn = Math.floor(0.004 * rate);
  const early: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
    [
      [0.011, 0.5],
      [0.034, 0.32],
      [0.058, 0.22],
    ],
    [
      [0.017, 0.46],
      [0.041, 0.3],
      [0.071, 0.2],
    ],
  ];
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    const pink = new PinkFilter();
    let lp = 0;
    for (let i = pre; i < length; i += 1) {
      const t = (i - pre) / rate;
      const cutoff = 9000 * Math.pow(1400 / 9000, t / IR_SECONDS);
      const a = 1 - Math.exp((-2 * Math.PI * cutoff) / rate);
      lp += a * (pink.next(Math.random() * 2 - 1) - lp);
      const attack = i - pre < fadeIn ? (i - pre) / fadeIn : 1;
      data[i] = lp * Math.exp(-decay * t) * attack;
    }
    // Early reflections as smooth 6 ms Hann-windowed pink-noise bursts (a single-sample spike would
    // turn every transient into a metallic slap-back).
    const burst = Math.floor(0.006 * rate);
    const reflection = new PinkFilter();
    for (const [time, gain] of early[channel]) {
      const at = pre + Math.floor(time * rate);
      for (let k = 0; k < burst && at + k < length; k += 1) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (burst - 1));
        data[at + k] += gain * 0.35 * w * reflection.next(Math.random() * 2 - 1) * 9;
      }
    }
    normalizePeak(data, 0.6);
  }
  return buffer;
}

/* -------------------------------------------------------------------------- */
/* Graph                                                                      */
/* -------------------------------------------------------------------------- */

/** Re-target an AudioParam smoothly from wherever it currently is. */
function glide(param: AudioParam, target: number, at: number, timeConstant: number): void {
  param.cancelScheduledValues(at);
  param.setValueAtTime(param.value, at);
  param.setTargetAtTime(target, at, timeConstant);
}

function bump(p: number, start: number, end: number, ramp: number): number {
  return smoothstep(start, start + ramp, p) * (1 - smoothstep(end - ramp, end, p));
}

/**
 * The full mix. Context-agnostic: an AudioContext in the browser, or an
 * OfflineAudioContext to render it for analysis.
 */
export class SoundGraph {
  readonly master: GainNode;
  private readonly output: GainNode;
  private readonly convolver: ConvolverNode;
  private readonly pinkNoise: AudioBuffer;
  /** Foley bus (bypasses the canyon reverb but for FOLEY_WET); follows the mute ramp like `master`. */
  private readonly foleyBus: GainNode;
  /** Pre-computed foley buffers (FOLEY_VARIANTS each). */
  private readonly bootSteps: AudioBuffer[] = [];
  private readonly gearEquips: AudioBuffer[] = [];
  private readonly gearDrops: AudioBuffer[] = [];

  private readonly windSource: AudioBufferSourceNode;
  private readonly windBus: GainNode;
  private readonly rumble: BiquadFilterNode;
  private readonly howlLeft: BiquadFilterNode;
  private readonly howlRight: BiquadFilterNode;
  private readonly howlGain: GainNode;

  private readonly padFilter: BiquadFilterNode;
  private readonly padGain: GainNode;
  private readonly shimmerGain: GainNode;

  private readonly oscillators: OscillatorNode[] = [];

  constructor(readonly ctx: BaseAudioContext) {
    const now = ctx.currentTime;

    // --- Master bus -------------------------------------------------------
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.ratio.value = 3;
    compressor.knee.value = 12;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.28;
    const dry = ctx.createGain();
    dry.gain.value = 1 - REVERB_WET;
    this.convolver = ctx.createConvolver();
    this.convolver.normalize = true;
    const wet = ctx.createGain();
    wet.gain.value = REVERB_WET;
    this.output = ctx.createGain();
    this.output.gain.value = 0;
    this.master.connect(compressor);
    compressor.connect(dry).connect(this.output);
    compressor.connect(this.convolver).connect(wet).connect(this.output);
    this.output.connect(ctx.destination);

    // Foley bus: warm low-pass -> its own compressor -> straight to the output, with only a FOLEY_WET share
    // through the canyon convolver (the send is scaled so the wet part ends up at FOLEY_WET after `wet`).
    this.foleyBus = ctx.createGain();
    this.foleyBus.gain.value = 0;
    const foleyLowpass = ctx.createBiquadFilter();
    foleyLowpass.type = 'lowpass';
    foleyLowpass.frequency.value = FOLEY_LOWPASS_HZ;
    foleyLowpass.Q.value = 0.5;
    const foleyCompressor = ctx.createDynamicsCompressor();
    foleyCompressor.threshold.value = -18;
    foleyCompressor.ratio.value = 3;
    foleyCompressor.knee.value = 12;
    foleyCompressor.attack.value = 0.006;
    foleyCompressor.release.value = 0.2;
    const foleySend = ctx.createGain();
    foleySend.gain.value = FOLEY_WET / REVERB_WET;
    this.foleyBus.connect(foleyLowpass).connect(foleyCompressor);
    foleyCompressor.connect(this.output);
    foleyCompressor.connect(foleySend).connect(this.convolver);

    this.pinkNoise = createPinkNoiseBuffer(ctx, 2);
    for (let v = 0; v < FOLEY_VARIANTS; v += 1) {
      this.bootSteps.push(createBootStepBuffer(ctx, 101 + v));
      this.gearEquips.push(createGearEquipBuffer(ctx, 211 + v));
      this.gearDrops.push(createGearDropBuffer(ctx, 307 + v));
    }

    // --- Wind -------------------------------------------------------------
    this.windSource = ctx.createBufferSource();
    this.windSource.buffer = createBrownNoiseBuffer(ctx, BROWN_SECONDS);
    this.windSource.loop = true;
    this.windBus = ctx.createGain();
    this.windBus.gain.value = 0;
    this.windBus.connect(this.master);

    this.rumble = ctx.createBiquadFilter();
    this.rumble.type = 'lowpass';
    this.rumble.frequency.value = RUMBLE_MIN_HZ;
    this.rumble.Q.value = 1.2;
    this.windSource.connect(this.rumble).connect(this.windBus);

    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    this.howlLeft = ctx.createBiquadFilter();
    this.howlRight = ctx.createBiquadFilter();
    for (const band of [this.howlLeft, this.howlRight]) {
      band.type = 'bandpass';
      band.Q.value = HOWL_Q;
      band.frequency.value = 380;
    }
    this.windSource.connect(splitter);
    splitter.connect(this.howlLeft, 0);
    splitter.connect(this.howlRight, 1);
    this.howlLeft.connect(merger, 0, 0);
    this.howlRight.connect(merger, 0, 1);
    this.howlGain = ctx.createGain();
    this.howlGain.gain.value = HOWL_MAKEUP * 0.55;
    merger.connect(this.howlGain).connect(this.windBus);

    // Opposite-sign depths start the two sweeps in anti-phase; the different
    // rates then let them drift in and out of phase (a slowly turning gust).
    this.lfo(HOWL_LFO_HZ_LEFT, HOWL_LFO_DEPTH_HZ, this.howlLeft.frequency);
    this.lfo(HOWL_LFO_HZ_RIGHT, -HOWL_LFO_DEPTH_HZ, this.howlRight.frequency);

    // --- Pad --------------------------------------------------------------
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = PAD_CLOSED_HZ;
    this.padFilter.Q.value = 0.7;
    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0;
    this.padFilter.connect(this.padGain).connect(this.master);
    const drift = ctx.createOscillator();
    drift.frequency.value = 0.05;
    const driftDepth = ctx.createGain();
    driftDepth.gain.value = 3; // ± 3 cents of slow, shared pitch drift
    drift.connect(driftDepth);
    this.oscillators.push(drift);
    for (const [frequency, detune, level, type, pan] of PAD_VOICES) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = frequency;
      osc.detune.value = detune;
      driftDepth.connect(osc.detune);
      const voice = ctx.createGain();
      voice.gain.value = level;
      osc.connect(voice).connect(this.panner(pan, now)).connect(this.padFilter);
      this.oscillators.push(osc);
    }

    this.shimmerGain = ctx.createGain();
    this.shimmerGain.gain.value = 0;
    this.shimmerGain.connect(this.master);
    for (const [detune, pan] of [
      [-3, -0.4],
      [4, 0.4],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = SHIMMER_HZ;
      osc.detune.value = detune;
      osc.connect(this.panner(pan, now)).connect(this.shimmerGain);
      this.oscillators.push(osc);
    }

    this.windSource.start(now);
    for (const osc of this.oscillators) osc.start(now);
  }

  /** Set the impulse response (generated lazily so the enabling click stays snappy). */
  loadReverb(): void {
    if (!this.convolver.buffer) this.convolver.buffer = createCanyonImpulse(this.ctx);
  }

  /** Mute / unmute: master and post-reverb output glide together. */
  setLevel(level: number, at: number, timeConstant = MUTE_TIME_CONSTANT): void {
    glide(this.master.gain, level, at, timeConstant);
    glide(this.foleyBus.gain, level, at, timeConstant);
    glide(this.output.gain, level > 0 ? 1 : 0, at, timeConstant);
  }

  /**
   * Re-target the beds for a scroll state. `speed` is 0 → 1 (normalised
   * scroll speed). Allocation-free; call at most ~30 times a second.
   */
  applyScroll(progress: number, altitude: number, speed: number, at: number): void {
    const p = progress;
    const chasm = Math.max(
      bump(p, PATH_PHASES.ascentEnd, PATH_PHASES.jumpOneEnd, 0.015),
      bump(p, PATH_PHASES.climbOneEnd, PATH_PHASES.leapTwoEnd, 0.015),
    );
    const gust = bump(p, ENDING.paperGustStart - 0.006, ENDING.paperStick + 0.01, 0.006);
    const voidFade = 1 - smoothstep(0.975, 0.99, p); // exactly 0 from 0.99

    const windLevel = Math.min(WIND_MAX, 0.065 + 0.04 * altitude + 0.035 * speed + 0.03 * chasm + 0.04 * gust) * voidFade;
    glide(this.windBus.gain, windLevel, at, LEVEL_TIME_CONSTANT);

    const energy = clamp01(0.4 * altitude + 0.6 * speed + 0.5 * chasm + gust);
    glide(this.rumble.frequency, RUMBLE_MIN_HZ + (RUMBLE_MAX_HZ - RUMBLE_MIN_HZ) * energy, at, FILTER_TIME_CONSTANT);

    // Howl centre stays inside [260, 780] including the ± LFO swing.
    const lo = HOWL_MIN_HZ + HOWL_LFO_DEPTH_HZ + 15;
    const hi = HOWL_MAX_HZ - HOWL_LFO_DEPTH_HZ - 15;
    const centre = lo + (hi - lo) * clamp01(0.15 + 0.45 * altitude + 0.35 * speed + 0.2 * chasm + 0.3 * gust);
    glide(this.howlLeft.frequency, centre - 15, at, FILTER_TIME_CONSTANT);
    glide(this.howlRight.frequency, centre + 15, at, FILTER_TIME_CONSTANT);
    glide(this.howlGain.gain, HOWL_MAKEUP * (0.55 + 0.45 * clamp01(0.6 * altitude + speed + chasm + gust)), at, FILTER_TIME_CONSTANT);

    const summit = smoothstep(SUMMIT_START, SUMMIT_END, p);
    const padFade = (0.6 + 0.4 * smoothstep(0, 0.06, p)) * (1 - smoothstep(0.985, 1, p));
    glide(this.padGain.gain, PAD_LEVEL * padFade, at, LEVEL_TIME_CONSTANT * 2);
    glide(this.padFilter.frequency, PAD_CLOSED_HZ + (PAD_OPEN_HZ - PAD_CLOSED_HZ) * summit, at, 0.6);
    glide(this.shimmerGain.gain, SHIMMER_LEVEL * summit * (1 - smoothstep(0.985, 1, p)), at, 0.5);
  }

  /* --- Foley ------------------------------------------------------------ */

  /*
   * Gear and climbing foley: pre-computed PCM buffers on the foley bus. A
   * buffer starts and ends on exact zeros and plays from sample 0, so no
   * start or stop can click; every hit picks one of FOLEY_VARIANTS and a
   * slight rate / level / pan variation, so no two sound identical.
   */

  /** Cloth and leather brush as a piece of gear locks on. */
  gearEquip(itemIndex: number, when: number): void {
    this.playFoley(this.gearEquips, when, GEAR_EQUIP_GAIN * (0.9 + 0.2 * Math.random()), ((itemIndex % 4) - 1.5) * 0.12, 0.97 + 0.06 * Math.random());
  }

  /** Low air-and-cloth release as a piece of gear falls away. */
  gearDrop(shedStage: number, when: number): void {
    const side = shedStage % 2 === 0 ? -0.15 : 0.15;
    this.playFoley(this.gearDrops, when, GEAR_DROP_GAIN * (0.9 + 0.2 * Math.random()), side, 0.96 + 0.08 * Math.random());
  }

  /** One soft boot contact on granite (subtle level, varied rate and pan). */
  climbStep(when: number, intensity: number): void {
    const level = BOOT_STEP_GAIN * (0.75 + 0.25 * clamp01(intensity)) * (0.85 + 0.3 * Math.random());
    this.playFoley(this.bootSteps, when, level, (Math.random() * 2 - 1) * 0.2, 0.94 + 0.12 * Math.random());
  }

  /** A deep chest-air rush for a leap: wide bands swept 130 → 380 → 140 Hz over 650 ms, panning across. */
  chasmWhoosh(intensity: number, when: number): void {
    const ctx = this.ctx;
    const k = clamp01(intensity);
    const duration = 0.65;
    const pan = this.panner(-0.5, when);
    pan.pan.linearRampToValueAtTime(0.5, when + duration);
    pan.connect(this.master);

    const src = this.noiseSource(when, duration + 0.15);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(0.11 + 0.06 * k, when + duration * 0.42);
    env.gain.exponentialRampToValueAtTime(0.0005, when + duration + 0.1);
    env.connect(pan);
    // Two wide, non-whistling air bands: one carrying the sweep, a broader one below it for body.
    for (const [q, scale, level] of [
      [1.2, 1, 0.7],
      [0.7, 0.45, 0.6],
    ] as const) {
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.Q.value = q;
      band.frequency.setValueAtTime(130 * scale, when);
      band.frequency.exponentialRampToValueAtTime(380 * scale, when + duration * 0.45);
      band.frequency.exponentialRampToValueAtTime(140 * scale, when + duration);
      const tap = ctx.createGain();
      tap.gain.value = level;
      src.connect(band).connect(tap).connect(env);
    }
    src.onended = () => {
      env.disconnect();
      pan.disconnect();
    };
  }

  /**
   * Soft cotton paper fluttering in the breeze: a few 40–90 ms bursts of
   * pink noise, high-passed at 280 Hz, through wide bands between 420 and
   * 950 Hz with smooth 18 ms attacks and a small flicker, on the warm foley
   * bus, swelling then thinning out as the sheet flies off.
   */
  paperFlutter(intensity: number, when: number): void {
    const ctx = this.ctx;
    const k = clamp01(intensity);
    const bursts = 5 + Math.round(4 * k);
    const pan = this.panner(-0.15, when);
    pan.pan.linearRampToValueAtTime(0.55, when + 1.6);
    pan.connect(this.foleyBus);
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 280;
    highpass.Q.value = 0.6;
    highpass.connect(pan);

    let t = when;
    let last: AudioBufferSourceNode | null = null;
    for (let i = 0; i < bursts; i += 1) {
      const shape = Math.sin(((i + 0.5) / bursts) * Math.PI); // swell, then thin out
      const duration = 0.04 + Math.random() * 0.05;
      const src = this.noiseSource(t, duration + 0.01);
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 420 + Math.random() * 530;
      band.Q.value = 1;
      const env = ctx.createGain();
      const peak = (0.045 + 0.055 * k) * (0.35 + 0.65 * shape) * (0.6 + 0.4 * Math.random());
      const attack = 0.018;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(peak, t + attack);
      // A gentle flicker after the attack (the sheet flexing), then a smooth fade.
      env.gain.linearRampToValueAtTime(peak * 0.55, t + attack + (duration - attack) * 0.35);
      env.gain.linearRampToValueAtTime(peak * 0.8, t + attack + (duration - attack) * 0.55);
      env.gain.exponentialRampToValueAtTime(0.0005, t + duration);
      src.connect(band).connect(env).connect(highpass);
      src.onended = () => env.disconnect();
      last = src;
      t += duration * (0.55 + Math.random() * 0.9) + (i > bursts * 0.6 ? 0.04 + Math.random() * 0.08 : 0.01);
    }
    if (last) {
      last.addEventListener('ended', () => {
        highpass.disconnect();
        pan.disconnect();
      });
    }
  }

  stop(): void {
    try {
      this.windSource.stop();
    } catch {
      /* already stopped */
    }
    for (const osc of this.oscillators) {
      try {
        osc.stop();
      } catch {
        /* already stopped */
      }
    }
  }

  /* --- helpers ----------------------------------------------------------- */

  private lfo(frequency: number, depth: number, target: AudioParam): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    const gain = this.ctx.createGain();
    gain.gain.value = depth;
    osc.connect(gain).connect(target);
    this.oscillators.push(osc);
  }

  private panner(pan: number, when: number): StereoPannerNode {
    const node = this.ctx.createStereoPanner();
    node.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), when);
    return node;
  }

  private noiseSource(when: number, duration: number, buffer: AudioBuffer = this.pinkNoise): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.start(when, Math.random() * (buffer.duration - 0.2));
    src.stop(when + duration);
    return src;
  }

  /** Plays one of `buffers` from sample 0 on the foley bus. */
  private playFoley(buffers: readonly AudioBuffer[], when: number, gain: number, pan: number, rate: number): void {
    const src = this.ctx.createBufferSource();
    src.buffer = buffers[Math.floor(Math.random() * buffers.length) % buffers.length];
    src.playbackRate.value = rate;
    const level = this.ctx.createGain();
    level.gain.value = gain;
    const panner = this.panner(pan, when);
    src.connect(level).connect(panner).connect(this.foleyBus);
    src.start(when);
    src.onended = () => {
      level.disconnect();
      panner.disconnect();
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Scroll cues                                                                */
/* -------------------------------------------------------------------------- */

const enum CueKind {
  GearEquip,
  GearDrop,
  ChasmJump,
  Paper,
}

interface CueSpec {
  at: number;
  kind: CueKind;
  arg: number;
}

function buildCues(): CueSpec[] {
  const ids = Object.keys(GEAR_EQUIP_AT) as GearId[];
  const equips = ids
    .map((id) => GEAR_EQUIP_AT[id])
    .sort((a, b) => a - b)
    .map((at, i): CueSpec => ({ at, kind: CueKind.GearEquip, arg: i }));
  const drops = ids
    .map((id) => GEAR_DROP_AT[id])
    .filter((at) => Number.isFinite(at))
    .sort((a, b) => a - b)
    .map((at, i): CueSpec => ({ at, kind: CueKind.GearDrop, arg: i }));
  return [
    ...equips,
    ...drops,
    { at: PATH_PHASES.ascentEnd, kind: CueKind.ChasmJump, arg: 0.7 },
    { at: PATH_PHASES.leapTwoTakeoff, kind: CueKind.ChasmJump, arg: 1 },
    { at: ENDING.paperGustStart, kind: CueKind.Paper, arg: 1 },
    { at: ENDING.paperHoldEnd, kind: CueKind.Paper, arg: 0.45 },
  ].sort((a, b) => a.at - b.at);
}

const CUES = buildCues();
const CUE_COUNT = CUES.length;

/* -------------------------------------------------------------------------- */
/* Engine                                                                     */
/* -------------------------------------------------------------------------- */

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private graph: SoundGraph | null = null;
  private enabled = false;
  private readonly listeners = new Set<(enabled: boolean) => void>();

  // Scroll-cue state (preallocated; updateOnFrame never allocates).
  private readonly armed = new Uint8Array(CUE_COUNT);
  private readonly lastFired = new Float64Array(CUE_COUNT).fill(-Infinity);
  private lastOneShot = -Infinity;
  private lastSeek = -Infinity;
  private nextClimbStep = 0;
  private lastProgress = Number.NaN;
  private clock = 0;
  private nextParamAt = 0;

  get isEnabled(): boolean {
    return this.enabled;
  }

  get isSupported(): boolean {
    if (typeof window === 'undefined') return false;
    return Boolean(window.AudioContext ?? (window as WebkitWindow).webkitAudioContext);
  }

  get state(): AudioContextState | 'uninitialised' {
    return this.ctx ? this.ctx.state : 'uninitialised';
  }

  onChange(listener: (enabled: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Must be called from a user gesture the first time. */
  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      const ctx = this.ensureContext();
      if (!ctx || !this.graph) {
        this.enabled = false;
        return;
      }
      if (ctx.state !== 'running') await ctx.resume().catch(() => undefined);
      // Snap the beds to the current scroll state before fading in.
      this.nextParamAt = 0;
      this.applyBeds(Number.isNaN(this.lastProgress) ? 0 : this.lastProgress, 0, ctx.currentTime);
      this.graph.setLevel(MASTER_LEVEL, ctx.currentTime);
      // Build the reverb after the click handler returns.
      window.setTimeout(() => this.graph?.loadReverb(), 0);
    } else if (this.ctx && this.graph) {
      const ctx = this.ctx;
      this.graph.setLevel(0, ctx.currentTime);
      window.setTimeout(() => {
        if (!this.enabled && ctx.state === 'running') void ctx.suspend();
      }, 600);
    }
    this.listeners.forEach((listener) => listener(this.enabled));
  }

  toggle(): Promise<void> {
    return this.setEnabled(!this.enabled);
  }

  /**
   * Per-frame tick (from the render loop). Tracks every scroll cue even while
   * muted, so enabling sound mid-journey never fires stale one-shots; drives
   * the wind and pad beds; fires foley on forward threshold crossings and
   * climbing contacts. Allocation-free except for the audio nodes of a sound
   * that actually fires.
   */
  updateOnFrame(dampedProgress: number, velocity: number, delta: number): void {
    const p = clamp01(dampedProgress);
    this.clock += Math.max(0, Math.min(delta, 0.1));
    const previous = this.lastProgress;
    this.lastProgress = p;

    const ctx = this.ctx;
    const live = this.enabled && ctx !== null && this.graph !== null && ctx.state === 'running';

    if (Number.isNaN(previous)) {
      for (let i = 0; i < CUE_COUNT; i += 1) this.armed[i] = p < CUES[i].at ? 1 : 0;
    } else {
      if (Math.abs(p - previous) > SEEK_STEP || Math.abs(velocity) > SEEK_SPEED) this.lastSeek = this.clock;
      const seeking = this.clock - this.lastSeek < SEEK_HOLD;
      for (let i = 0; i < CUE_COUNT; i += 1) {
        const cue = CUES[i];
        if (p < cue.at - CUE_HYSTERESIS) {
          this.armed[i] = 1;
        } else if (this.armed[i] === 1 && p >= cue.at) {
          this.armed[i] = 0;
          if (
            live &&
            !seeking &&
            this.clock - this.lastFired[i] >= CUE_COOLDOWN &&
            this.clock - this.lastOneShot >= ONE_SHOT_SPACING
          ) {
            this.lastFired[i] = this.clock;
            this.fire(cue.kind, cue.arg); // the play method claims the one-shot slot
          }
        }
      }
    }

    if (live && ctx && this.clock >= this.nextParamAt) {
      this.nextParamAt = this.clock + PARAM_INTERVAL;
      this.applyBeds(p, velocity, ctx.currentTime);
    }
    if (live) this.updateClimbingFoley(p, velocity, this.clock - this.lastSeek < SEEK_HOLD);
  }

  /**
   * Boot / glove contacts while the climber is on rock: only inside
   * CLIMB_ZONES, only while scrolling, never during a seek, and at least
   * CLIMB_STEP_MIN apart (the gap grows as scrolling slows).
   */
  private updateClimbingFoley(p: number, velocity: number, seeking: boolean): void {
    const speed = Math.abs(velocity);
    if (seeking || speed <= CLIMB_MIN_SPEED || this.clock < this.nextClimbStep) return;
    // A gear sound just played: leave it room.
    if (this.clock - this.lastOneShot < 0.15) return;
    let climbing = false;
    for (let i = 0; i < CLIMB_ZONES.length; i += 1) {
      if (p >= CLIMB_ZONES[i][0] && p <= CLIMB_ZONES[i][1]) climbing = true;
    }
    if (!climbing) return;
    const brisk = smoothstep(0.002, 0.04, speed);
    this.nextClimbStep = this.clock + CLIMB_STEP_MIN + 0.3 * (1 - brisk) + Math.random() * 0.06;
    this.playClimbStep(0.5 + 0.5 * brisk);
  }

  /* --- one-shots (also fired automatically by updateOnFrame) -------------- */

  /** Gear locking on. Never plays twice within GEAR_ONE_SHOT_GUARD (a direct call and a cue on one threshold). */
  playGearEquip(itemIndex = 0): void {
    const ctx = this.readyContext();
    if (!ctx || !this.graph || !this.claimOneShot(GEAR_ONE_SHOT_GUARD)) return;
    this.graph.gearEquip(itemIndex, ctx.currentTime + 0.005);
  }

  /** Gear falling away. Never plays twice within GEAR_ONE_SHOT_GUARD. */
  playGearDrop(shedStage = 0): void {
    const ctx = this.readyContext();
    if (!ctx || !this.graph || !this.claimOneShot(GEAR_ONE_SHOT_GUARD)) return;
    this.graph.gearDrop(shedStage, ctx.currentTime + 0.005);
  }

  playChasmJumpWhoosh(intensity = 1): void {
    const ctx = this.readyContext();
    if (!ctx || !this.graph || !this.claimOneShot(0)) return;
    this.graph.chasmWhoosh(intensity, ctx.currentTime + 0.005);
  }

  /** One boot / glove contact on granite (fired automatically while climbing). */
  playClimbStep(intensity = 1): void {
    const ctx = this.readyContext();
    if (ctx && this.graph) this.graph.climbStep(ctx.currentTime + 0.005, intensity);
  }

  playPaperThrowAndFlutter(intensity = 1): void {
    const ctx = this.readyContext();
    if (!ctx || !this.graph || !this.claimOneShot(0)) return;
    this.graph.paperFlutter(intensity, ctx.currentTime + 0.005);
  }

  dispose(): void {
    this.listeners.clear();
    this.removeResumeListeners();
    this.graph?.stop();
    this.graph = null;
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
    this.enabled = false;
  }

  /* ---------------------------------------------------------------------- */

  /** Takes the one-shot slot unless another one-shot played less than `minGap` ago (frame clock). */
  private claimOneShot(minGap: number): boolean {
    if (this.clock - this.lastOneShot < minGap) return false;
    this.lastOneShot = this.clock;
    return true;
  }

  private fire(kind: CueKind, arg: number): void {
    switch (kind) {
      case CueKind.GearEquip:
        this.playGearEquip(arg);
        break;
      case CueKind.GearDrop:
        this.playGearDrop(arg);
        break;
      case CueKind.ChasmJump:
        this.playChasmJumpWhoosh(arg);
        break;
      case CueKind.Paper:
        this.playPaperThrowAndFlutter(arg);
        break;
    }
  }

  private applyBeds(p: number, velocity: number, at: number): void {
    if (!this.graph) return;
    const speed = smoothstep(0.015, 0.2, Math.abs(velocity));
    this.graph.applyScroll(p, altitudeAt(p), speed, at);
  }

  private readyContext(): AudioContext | null {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return null;
    return this.ctx;
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (!this.isSupported) return null;
    const Ctor = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.graph = new SoundGraph(ctx);
    this.addResumeListeners();
    return ctx;
  }

  /** Browsers (iOS especially) suspend or interrupt audio; resume on the next interaction. */
  private readonly resumeOnInteraction = (): void => {
    const ctx = this.ctx;
    if (!this.enabled || !ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    void ctx.resume().catch(() => undefined);
  };

  private readonly onVisibility = (): void => {
    const ctx = this.ctx;
    if (!ctx || !this.graph || !this.enabled) return;
    if (document.hidden) {
      this.graph.setLevel(0, ctx.currentTime);
      window.setTimeout(() => {
        if (document.hidden && ctx.state === 'running') void ctx.suspend();
      }, 600);
    } else {
      void ctx
        .resume()
        .then(() => {
          if (this.enabled && this.graph) this.graph.setLevel(MASTER_LEVEL, ctx.currentTime);
        })
        .catch(() => undefined);
    }
  };

  private addResumeListeners(): void {
    window.addEventListener('pointerdown', this.resumeOnInteraction, { capture: true, passive: true });
    window.addEventListener('keydown', this.resumeOnInteraction, { capture: true, passive: true });
    window.addEventListener('touchend', this.resumeOnInteraction, { capture: true, passive: true });
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private removeResumeListeners(): void {
    window.removeEventListener('pointerdown', this.resumeOnInteraction, { capture: true });
    window.removeEventListener('keydown', this.resumeOnInteraction, { capture: true });
    window.removeEventListener('touchend', this.resumeOnInteraction, { capture: true });
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}

export const soundEngine = new SoundEngine();

export default soundEngine;
