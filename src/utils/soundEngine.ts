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
 *   (25 ms pre-delay, sparse early reflections, pink noise decaying 60 dB
 *   over 3 s with air absorption), so every sound sits in the same space.
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
 * Foley one-shots (fire on forward threshold crossings, with hysteresis,
 * per-cue cooldowns and seek detection so a scrubbed or jumped threshold
 * never machine-guns a sound):
 *   • playGearEquip       — fabric/strap thud + carabiner click (GEAR_EQUIP_AT)
 *   • playGearDrop        — buckle release thump + falling air (GEAR_DROP_AT)
 *   • playChasmJumpWhoosh — resonant swept air (both chasm take-offs)
 *   • playPaperThrowAndFlutter — paper rustle bursts (the gust that tears the
 *     note out of the backpack, and a lighter one when it peels off the lens)
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
 * peak-normalised, independent per channel (wide, decorrelated stereo).
 */
function createBrownNoiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    let b = 0;
    for (let i = 0; i < length; i += 1) {
      b = BROWN_LEAK * b + (Math.random() * 2 - 1) * 0.02;
      data[i] = b;
    }
    normalizePeak(data, 0.85);
    crossfadeLoop(data, Math.min(8192, Math.floor(length / 6)));
  }
  return buffer;
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
 * reflections (different per ear), then pink noise decaying by 60 dB over
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
    for (const [time, gain] of early[channel]) {
      const at = pre + Math.floor(time * rate);
      if (at < length) data[at] += gain * (channel === 0 ? 1 : -1);
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

    this.pinkNoise = createPinkNoiseBuffer(ctx, 2);

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

  /** Strap/fabric thud, then 35 ms later a damped carabiner click (2.4 + 3.85 kHz). */
  gearEquip(itemIndex: number, when: number): void {
    const ctx = this.ctx;
    const pan = this.panner(((itemIndex % 4) - 1.5) * 0.18, when);
    pan.connect(this.master);

    this.noiseHit(when, 0.018, 'bandpass', 1800, 1.4, 0.42, pan);

    const clickAt = when + 0.035;
    const tune = 1 + (itemIndex % 4) * 0.025;
    const click = ctx.createGain();
    click.gain.setValueAtTime(0, clickAt);
    click.gain.linearRampToValueAtTime(0.16, clickAt + 0.0015);
    click.gain.exponentialRampToValueAtTime(0.0005, clickAt + 0.065);
    click.connect(pan);
    for (const [hz, level] of [
      [2400, 1],
      [3850, 0.62],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = hz * tune;
      const partial = ctx.createGain();
      partial.gain.value = level;
      osc.connect(partial).connect(click);
      osc.start(clickAt);
      osc.stop(clickAt + 0.08);
      osc.onended = () => {
        partial.disconnect();
        click.disconnect();
        pan.disconnect();
      };
    }
    this.noiseHit(clickAt, 0.006, 'highpass', 5200, 0.7, 0.12, pan);
  }

  /** Buckle release: a short tick, a 140 → 55 Hz thump, then air falling away into the chasm. */
  gearDrop(shedStage: number, when: number): void {
    const ctx = this.ctx;
    const side = shedStage % 2 === 0 ? -0.2 : 0.2;
    const pan = this.panner(side, when);
    pan.pan.linearRampToValueAtTime(side * 2.2, when + 1.4);
    pan.connect(this.master);

    this.noiseHit(when, 0.012, 'bandpass', 1300, 2, 0.18, pan);

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(140, when);
    thump.frequency.exponentialRampToValueAtTime(55, when + 0.18);
    const body = ctx.createGain();
    body.gain.setValueAtTime(0, when);
    body.gain.linearRampToValueAtTime(0.42, when + 0.005);
    body.gain.exponentialRampToValueAtTime(0.0005, when + 0.2);
    thump.connect(body).connect(pan);
    thump.start(when);
    thump.stop(when + 0.22);
    thump.onended = () => body.disconnect();

    const air = this.noiseSource(when, 1.6);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.6;
    band.frequency.setValueAtTime(760, when + 0.05);
    band.frequency.exponentialRampToValueAtTime(240, when + 1.5);
    const fall = ctx.createGain();
    fall.gain.setValueAtTime(0, when);
    fall.gain.linearRampToValueAtTime(0.07 + 0.015 * (shedStage % 3), when + 0.25);
    fall.gain.exponentialRampToValueAtTime(0.0005, when + 1.55);
    air.connect(band).connect(fall).connect(pan);
    air.onended = () => {
      fall.disconnect();
      pan.disconnect();
    };
  }

  /** Resonant swept air for a leap: 180 → 900 → 220 Hz over 650 ms, panning across. */
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
    env.gain.linearRampToValueAtTime(0.62 + 0.5 * k, when + duration * 0.42);
    env.gain.exponentialRampToValueAtTime(0.0005, when + duration + 0.1);
    env.connect(pan);
    // Two bands: a resonant one carrying the sweep, and a broad one an octave
    // below for body.
    for (const [q, scale, level] of [
      [5, 1, 1],
      [1.1, 0.5, 0.55],
    ] as const) {
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.Q.value = q;
      band.frequency.setValueAtTime(180 * scale, when);
      band.frequency.exponentialRampToValueAtTime(900 * scale, when + duration * 0.45);
      band.frequency.exponentialRampToValueAtTime(220 * scale, when + duration);
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
   * Cotton-paper rustle: a cluster of 40–90 ms bursts of high-passed pink
   * noise through narrow-ish bands between 1.2 and 3.2 kHz, each with its own
   * amplitude flicker, swelling then thinning out as the sheet flies off.
   */
  paperFlutter(intensity: number, when: number): void {
    const ctx = this.ctx;
    const k = clamp01(intensity);
    const bursts = 9 + Math.round(9 * k);
    const pan = this.panner(-0.15, when);
    pan.pan.linearRampToValueAtTime(0.55, when + 1.6);
    pan.connect(this.master);
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 950;
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
      band.frequency.value = 1200 + Math.random() * 2000;
      band.Q.value = 1.8 + Math.random() * 1.6;
      const env = ctx.createGain();
      const peak = (0.2 + 0.5 * k) * (0.35 + 0.65 * shape) * (0.6 + 0.4 * Math.random());
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(peak, t + 0.004);
      // Flicker: a quick dip and recovery inside the burst (the sheet snapping).
      env.gain.linearRampToValueAtTime(peak * 0.35, t + duration * 0.45);
      env.gain.linearRampToValueAtTime(peak * 0.8, t + duration * 0.6);
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

  private noiseSource(when: number, duration: number): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.pinkNoise;
    src.loop = true;
    src.start(when, Math.random() * (this.pinkNoise.duration - 0.2));
    src.stop(when + duration);
    return src;
  }

  private noiseHit(
    when: number,
    duration: number,
    type: BiquadFilterType,
    frequency: number,
    q: number,
    level: number,
    destination: AudioNode,
  ): void {
    const src = this.noiseSource(when, duration + 0.01);
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(level, when + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0005, when + duration);
    src.connect(filter).connect(env).connect(destination);
    src.onended = () => env.disconnect();
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
   * the wind and pad beds; fires foley on forward threshold crossings.
   * Allocation-free.
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
            this.lastOneShot = this.clock;
            this.fire(cue.kind, cue.arg);
          }
        }
      }
    }

    if (live && ctx && this.clock >= this.nextParamAt) {
      this.nextParamAt = this.clock + PARAM_INTERVAL;
      this.applyBeds(p, velocity, ctx.currentTime);
    }
  }

  /* --- one-shots (also fired automatically by updateOnFrame) -------------- */

  playGearEquip(itemIndex = 0): void {
    const ctx = this.readyContext();
    if (ctx && this.graph) this.graph.gearEquip(itemIndex, ctx.currentTime + 0.005);
  }

  playGearDrop(shedStage = 0): void {
    const ctx = this.readyContext();
    if (ctx && this.graph) this.graph.gearDrop(shedStage, ctx.currentTime + 0.005);
  }

  playChasmJumpWhoosh(intensity = 1): void {
    const ctx = this.readyContext();
    if (ctx && this.graph) this.graph.chasmWhoosh(intensity, ctx.currentTime + 0.005);
  }

  playPaperThrowAndFlutter(intensity = 1): void {
    const ctx = this.readyContext();
    if (ctx && this.graph) this.graph.paperFlutter(intensity, ctx.currentTime + 0.005);
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
