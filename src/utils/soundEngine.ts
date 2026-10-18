/* ==========================================================================
 * Procedural sound engine — zero dependencies, Web Audio API only.
 *
 *  • Mountain wind: looping pink noise → band-pass → low-pass, with a slow
 *    LFO for gusts. Altitude (0 → 1) opens the filter and raises the level.
 *  • Gear lock: bright inharmonic metallic partials plus a short click.
 *  • Gear drop: lower, detuned partials with a falling pitch.
 *  • Paper flutter: band-passed noise with a fast amplitude flutter and a
 *    filter sweep, used for the throw and the final wind gust.
 *
 * Muted by default. The AudioContext is only created on the first user
 * gesture (browser autoplay policy), from `setEnabled(true)` / `toggle()`.
 * ========================================================================== */

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

const MASTER_LEVEL = 0.55;
const WIND_BASE_GAIN = 0.12;
const WIND_PEAK_GAIN = 0.42;

function createPinkNoiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    // Paul Kellet's refined pink-noise filter.
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
    // Cross-fade the loop seam to avoid a click.
    const fade = Math.min(2048, Math.floor(length / 8));
    for (let i = 0; i < fade; i += 1) {
      const t = i / fade;
      const tail = length - fade + i;
      data[tail] = data[tail] * (1 - t) + data[i] * t;
    }
  }
  return buffer;
}

function createWhiteNoiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

interface WindChain {
  source: AudioBufferSourceNode;
  bandpass: BiquadFilterNode;
  lowpass: BiquadFilterNode;
  gain: GainNode;
  gustLfo: OscillatorNode;
  gustDepth: GainNode;
}

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private wind: WindChain | null = null;
  private noise: AudioBuffer | null = null;
  private enabled = false;
  private altitude = 0;
  private readonly listeners = new Set<(enabled: boolean) => void>();

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
    if (enabled) {
      const ctx = this.ensureContext();
      if (!ctx || !this.master) return;
      if (ctx.state === 'suspended') await ctx.resume();
      this.enabled = true;
      const now = ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(this.master.gain.value, now);
      this.master.gain.linearRampToValueAtTime(MASTER_LEVEL, now + 0.8);
      this.applyAltitude(0.6);
    } else {
      this.enabled = false;
      if (this.ctx && this.master) {
        const now = this.ctx.currentTime;
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setValueAtTime(this.master.gain.value, now);
        this.master.gain.linearRampToValueAtTime(0, now + 0.4);
        const ctx = this.ctx;
        window.setTimeout(() => {
          if (!this.enabled && ctx.state === 'running') void ctx.suspend();
        }, 500);
      }
    }
    this.listeners.forEach((listener) => listener(this.enabled));
  }

  toggle(): Promise<void> {
    return this.setEnabled(!this.enabled);
  }

  /** Normalised altitude 0 (base camp) → 1 (summit). Cheap; call every frame. */
  setAltitude(altitude: number): void {
    const next = Math.min(1, Math.max(0, altitude));
    if (Math.abs(next - this.altitude) < 0.002) return;
    this.altitude = next;
    if (this.enabled) this.applyAltitude(0.35);
  }

  /** Metallic lock-on chime used when a piece of gear snaps onto a bone. */
  playGearLock(variant = 0): void {
    const ctx = this.readyContext();
    if (!ctx || !this.compressor) return;
    const now = ctx.currentTime;
    const fundamental = 880 * 2 ** ((variant % 4) * (3 / 12));
    const partials: ReadonlyArray<readonly [number, number, number]> = [
      [1, 0.32, 0.9],
      [2.76, 0.18, 0.6],
      [5.4, 0.1, 0.35],
      [8.93, 0.05, 0.22],
    ];
    const out = ctx.createGain();
    out.gain.value = 0.5;
    out.connect(this.compressor);
    for (const [ratio, level, decay] of partials) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(fundamental * ratio, now);
      env.gain.setValueAtTime(0, now);
      env.gain.linearRampToValueAtTime(level, now + 0.004);
      env.gain.exponentialRampToValueAtTime(0.0001, now + decay);
      osc.connect(env).connect(out);
      osc.start(now);
      osc.stop(now + decay + 0.05);
    }
    this.noiseBurst(ctx, out, now, 0.035, 4200, 'highpass', 0.35);
    window.setTimeout(() => out.disconnect(), 1200);
  }

  /** Duller, falling clank used when gear detaches and drops away. */
  playGearDrop(): void {
    const ctx = this.readyContext();
    if (!ctx || !this.compressor) return;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 0.45;
    out.connect(this.compressor);
    const partials: ReadonlyArray<readonly [number, number]> = [
      [330, 0.28],
      [330 * 2.31, 0.14],
      [330 * 4.12, 0.07],
    ];
    for (const [freq, level] of partials) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.55, now + 0.9);
      env.gain.setValueAtTime(0, now);
      env.gain.linearRampToValueAtTime(level, now + 0.006);
      env.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
      osc.connect(env).connect(out);
      osc.start(now);
      osc.stop(now + 1);
    }
    this.noiseBurst(ctx, out, now, 0.6, 900, 'bandpass', 0.12, 0.25);
    window.setTimeout(() => out.disconnect(), 1600);
  }

  /** Paper flutter whoosh. `intensity` 0 → 1 (1 = final wind gust). */
  playPaperFlutter(intensity = 0.5): void {
    const ctx = this.readyContext();
    if (!ctx || !this.compressor || !this.noise) return;
    const k = Math.min(1, Math.max(0, intensity));
    const now = ctx.currentTime;
    const duration = 0.9 + k * 1.1;

    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.4;
    band.frequency.setValueAtTime(600, now);
    band.frequency.exponentialRampToValueAtTime(2600 + k * 2400, now + duration * 0.35);
    band.frequency.exponentialRampToValueAtTime(500, now + duration);

    const flutter = ctx.createGain();
    flutter.gain.value = 0.5;
    const flutterLfo = ctx.createOscillator();
    flutterLfo.type = 'square';
    flutterLfo.frequency.setValueAtTime(14 + k * 10, now);
    flutterLfo.frequency.linearRampToValueAtTime(7, now + duration);
    const flutterDepth = ctx.createGain();
    flutterDepth.gain.value = 0.45;
    flutterLfo.connect(flutterDepth).connect(flutter.gain);

    const env = ctx.createGain();
    const peak = 0.25 + k * 0.35;
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(peak, now + 0.12);
    env.gain.setTargetAtTime(peak * 0.6, now + 0.2, 0.25);
    env.gain.linearRampToValueAtTime(0, now + duration);

    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(-0.4, now);
    panner.pan.linearRampToValueAtTime(0.6 + k * 0.3, now + duration);

    source.connect(band).connect(flutter).connect(env).connect(panner).connect(this.compressor);
    source.start(now, Math.random() * 2);
    source.stop(now + duration + 0.05);
    flutterLfo.start(now);
    flutterLfo.stop(now + duration + 0.05);
    source.onended = () => {
      panner.disconnect();
      flutterDepth.disconnect();
    };
  }

  dispose(): void {
    this.listeners.clear();
    if (this.wind) {
      this.wind.source.stop();
      this.wind.gustLfo.stop();
      this.wind = null;
    }
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
    this.master = null;
    this.compressor = null;
    this.noise = null;
    this.enabled = false;
  }

  /* ---------------------------------------------------------------------- */

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

    const master = ctx.createGain();
    master.gain.value = 0;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.25;
    compressor.connect(master).connect(ctx.destination);

    this.ctx = ctx;
    this.master = master;
    this.compressor = compressor;
    this.noise = createWhiteNoiseBuffer(ctx, 3);
    this.wind = this.createWind(ctx, compressor);
    return ctx;
  }

  private createWind(ctx: AudioContext, destination: AudioNode): WindChain {
    const source = ctx.createBufferSource();
    source.buffer = createPinkNoiseBuffer(ctx, 6);
    source.loop = true;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = 420;
    bandpass.Q.value = 0.7;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 900;
    lowpass.Q.value = 0.4;

    const gain = ctx.createGain();
    gain.gain.value = WIND_BASE_GAIN;

    // Slow LFO modulating the band-pass centre for organic gusts.
    const gustLfo = ctx.createOscillator();
    gustLfo.type = 'sine';
    gustLfo.frequency.value = 0.09;
    const gustDepth = ctx.createGain();
    gustDepth.gain.value = 160;
    gustLfo.connect(gustDepth).connect(bandpass.frequency);

    source.connect(bandpass).connect(lowpass).connect(gain).connect(destination);
    source.start();
    gustLfo.start();

    return { source, bandpass, lowpass, gain, gustLfo, gustDepth };
  }

  private applyAltitude(timeConstant: number): void {
    if (!this.ctx || !this.wind) return;
    const a = this.altitude;
    const now = this.ctx.currentTime;
    const { bandpass, lowpass, gain, gustLfo, gustDepth } = this.wind;
    bandpass.frequency.setTargetAtTime(380 + a * 520, now, timeConstant);
    lowpass.frequency.setTargetAtTime(800 + a * 2600, now, timeConstant);
    gain.gain.setTargetAtTime(WIND_BASE_GAIN + (WIND_PEAK_GAIN - WIND_BASE_GAIN) * a, now, timeConstant);
    gustLfo.frequency.setTargetAtTime(0.08 + a * 0.22, now, timeConstant);
    gustDepth.gain.setTargetAtTime(140 + a * 420, now, timeConstant);
  }

  private noiseBurst(
    ctx: AudioContext,
    destination: AudioNode,
    when: number,
    duration: number,
    frequency: number,
    type: BiquadFilterType,
    level: number,
    q = 0.8,
  ): void {
    if (!this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(level, when);
    env.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    src.connect(filter).connect(env).connect(destination);
    src.start(when, Math.random() * 2);
    src.stop(when + duration + 0.02);
  }
}

export const soundEngine = new SoundEngine();

export default soundEngine;
