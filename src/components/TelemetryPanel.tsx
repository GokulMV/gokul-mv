import { useEffect, useRef } from 'react';
import { SCENES, scrollStore } from '../store/scrollStore';
import { adaptiveQuality } from '../three/perf/adaptiveQuality';
import type { GpuInfo } from '../utils/gpuTier';

/* ==========================================================================
 * Live deployment + runtime telemetry. Values are written straight into
 * DOM text nodes from a rAF loop and a /healthz poller — no React state.
 * ========================================================================== */

const HEALTH_INTERVAL_MS = 10_000;

type FieldKey =
  | 'health'
  | 'latency'
  | 'port'
  | 'serverTime'
  | 'fps'
  | 'frame'
  | 'raw'
  | 'damped'
  | 'velocity'
  | 'scene'
  | 'gear'
  | 'audio'
  | 'quality'
  | 'frameEma';

interface HealthPayload {
  status?: string;
  port?: string;
  time?: string;
}

export function TelemetryPanel({ gpu }: { gpu: GpuInfo }) {
  const panel = useRef<HTMLDivElement>(null);
  const details = useRef<HTMLDivElement>(null);
  const dot = useRef<HTMLSpanElement>(null);
  const fields = useRef<Partial<Record<FieldKey, HTMLElement | null>>>({});

  const bind = (key: FieldKey) => (el: HTMLElement | null) => {
    fields.current[key] = el;
  };
  const write = (key: FieldKey, value: string) => {
    const el = fields.current[key];
    if (el && el.textContent !== value) el.textContent = value;
  };

  // Frame loop: FPS, scroll and scene telemetry.
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let windowStart = performance.now();
    let last = windowStart;
    let worstFrame = 0;
    const loop = (now: number) => {
      frames += 1;
      worstFrame = Math.max(worstFrame, now - last);
      last = now;
      if (now - windowStart >= 500) {
        const fps = (frames * 1000) / (now - windowStart);
        write('fps', fps.toFixed(0));
        write('frame', `${worstFrame.toFixed(1)} ms`);
        frames = 0;
        worstFrame = 0;
        windowStart = now;
      }
      write('raw', scrollStore.rawProgress.toFixed(4));
      write('damped', scrollStore.dampedProgress.toFixed(4));
      write('velocity', scrollStore.velocity.toFixed(3));
      const scene = SCENES[scrollStore.activeSceneIndex];
      write('scene', `${scene.index + 1}/10 ${scene.title}`);
      write('gear', `${scrollStore.activeGearCount}/4`);
      write('audio', scrollStore.audioEnabled ? 'on' : 'muted');
      write('quality', `${adaptiveQuality.level} ${(adaptiveQuality.particleDensity * 100).toFixed(0)}%`);
      write('frameEma', `${adaptiveQuality.frameMsEma.toFixed(1)} ms`);
      if (details.current) {
        const show = scrollStore.auditMode;
        if (details.current.dataset.open !== String(show)) {
          details.current.dataset.open = String(show);
          details.current.style.display = show ? 'grid' : 'none';
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Railway health poller.
  useEffect(() => {
    let cancelled = false;
    const setDot = (color: string) => {
      if (dot.current) dot.current.style.background = color;
    };
    const poll = async () => {
      const started = performance.now();
      try {
        const res = await fetch('/healthz', { cache: 'no-store', headers: { Accept: 'application/json' } });
        const latency = performance.now() - started;
        if (cancelled) return;
        let payload: HealthPayload = {};
        if ((res.headers.get('content-type') ?? '').includes('json')) {
          payload = (await res.json()) as HealthPayload;
        }
        const ok = res.ok && payload.status === 'ok';
        write('health', ok ? 'healthy' : `HTTP ${res.status}`);
        write('latency', `${latency.toFixed(0)} ms`);
        write('port', payload.port ?? '—');
        write('serverTime', payload.time ? new Date(payload.time).toLocaleTimeString() : '—');
        setDot(ok ? '#34D399' : '#FBBF24');
      } catch {
        if (cancelled) return;
        write('health', 'unreachable');
        write('latency', '—');
        setDot('#F87171');
      }
    };
    void poll();
    const id = window.setInterval(() => void poll(), HEALTH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const shortSha = __BUILD_SHA__.length > 7 ? __BUILD_SHA__.slice(0, 7) : __BUILD_SHA__;

  return (
    <div
      ref={panel}
      className="interactive hud-glass fixed left-4 top-4 z-20 w-[min(60vw,280px)] !bg-ink/70 p-3 font-mono text-[10.5px] leading-relaxed text-white/70"
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 uppercase tracking-[0.2em] text-glacier/70">
          <span ref={dot} className="h-2 w-2 rounded-full" style={{ background: '#94A3B8' }} />
          Railway
        </span>
        <span ref={bind('health')} className="text-white/85">
          checking…
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-x-3">
        <span className="text-white/40">fps</span>
        <span ref={bind('fps')} className="text-right text-white/85">
          —
        </span>
        <span className="text-white/40">scene</span>
        <span ref={bind('scene')} className="truncate text-right text-white/85">
          —
        </span>
        <span className="text-white/40">progress</span>
        <span ref={bind('damped')} className="text-right text-white/85">
          —
        </span>
        <span className="text-white/40">gear</span>
        <span ref={bind('gear')} className="text-right text-white/85">
          —
        </span>
      </div>
      <div ref={details} data-open="false" className="mt-2 grid-cols-2 gap-x-3 border-t border-white/10 pt-2" style={{ display: 'none' }}>
        <span className="text-white/40">healthz rtt</span>
        <span ref={bind('latency')} className="text-right">—</span>
        <span className="text-white/40">port</span>
        <span ref={bind('port')} className="text-right">—</span>
        <span className="text-white/40">server time</span>
        <span ref={bind('serverTime')} className="text-right">—</span>
        <span className="text-white/40">quality</span>
        <span ref={bind('quality')} className="text-right">—</span>
        <span className="text-white/40">frame ema</span>
        <span ref={bind('frameEma')} className="text-right">—</span>
        <span className="text-white/40">worst frame</span>
        <span ref={bind('frame')} className="text-right">—</span>
        <span className="text-white/40">raw</span>
        <span ref={bind('raw')} className="text-right">—</span>
        <span className="text-white/40">velocity</span>
        <span ref={bind('velocity')} className="text-right">—</span>
        <span className="text-white/40">audio</span>
        <span ref={bind('audio')} className="text-right">—</span>
        <span className="text-white/40">gpu tier</span>
        <span className="text-right">
          {gpu.tier} {gpu.webgl2 ? 'webgl2' : 'webgl1'}
        </span>
        <span className="col-span-2 truncate text-white/40" title={gpu.renderer}>
          {gpu.renderer}
        </span>
        <span className="text-white/40">build</span>
        <span className="text-right">{shortSha}</span>
        <span className="text-white/40">env</span>
        <span className="text-right">{__BUILD_ENV__}</span>
        <span className="col-span-2 text-white/40">built {new Date(__BUILD_TIME__).toLocaleString()}</span>
      </div>
      <p className="mt-2 text-[9.5px] text-white/35">Press ` to toggle audit mode</p>
    </div>
  );
}

export default TelemetryPanel;
