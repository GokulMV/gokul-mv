import { useEffect, useRef } from 'react';
import { SCENES, scrollStore } from '../store/scrollStore';
import { pageScroll } from '../store/pageScroll';
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

  // Frame loop: FPS, scroll and scene telemetry. Every field caches the last
  // value it wrote, so an idle frame formats no strings and touches no DOM.
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let windowStart = performance.now();
    let last = windowStart;
    let worstFrame = 0;
    let lastFps = -1;
    let lastWorst = -1;
    let lastDamped = -1;
    let lastRaw = -1;
    let lastVelocity = Number.NaN;
    let lastScene = -1;
    let lastGear = -1;
    let lastAudio = -1;
    let lastLevel = '';
    let lastDensity = -1;
    let lastEma = -1;
    let lastFade = -1;
    let lastOpen = -1;

    // Narrow screens: the audit panel also steps aside for the footer.
    const narrowQuery = window.matchMedia('(max-width: 639px)');
    let narrow = narrowQuery.matches;
    const onNarrow = (event: MediaQueryListEvent) => {
      narrow = event.matches;
    };
    narrowQuery.addEventListener('change', onNarrow);

    const loop = (now: number) => {
      frames += 1;
      worstFrame = Math.max(worstFrame, now - last);
      last = now;
      const open = scrollStore.auditMode;

      if (now - windowStart >= 500) {
        const fps = Math.round((frames * 1000) / (now - windowStart));
        if (fps !== lastFps) {
          lastFps = fps;
          write('fps', String(fps));
        }
        const worst = Math.round(worstFrame * 10);
        if (open && worst !== lastWorst) {
          lastWorst = worst;
          write('frame', `${(worst / 10).toFixed(1)} ms`);
        }
        frames = 0;
        worstFrame = 0;
        windowStart = now;
      }

      const damped = Math.round(scrollStore.dampedProgress * 10000);
      if (damped !== lastDamped) {
        lastDamped = damped;
        write('damped', (damped / 10000).toFixed(4));
      }
      const sceneIndex = scrollStore.activeSceneIndex;
      if (sceneIndex !== lastScene) {
        lastScene = sceneIndex;
        const scene = SCENES[sceneIndex];
        write('scene', `${scene.index + 1}/10 ${scene.title}`);
      }
      const gear = scrollStore.activeGearCount;
      if (gear !== lastGear) {
        lastGear = gear;
        write('gear', `${gear}/4`);
      }

      if (details.current && (open ? 1 : 0) !== lastOpen) {
        lastOpen = open ? 1 : 0;
        details.current.dataset.open = String(open);
        details.current.style.display = open ? 'grid' : 'none';
        // Re-fill the details on open (they are not updated while closed).
        lastRaw = -1;
        lastVelocity = Number.NaN;
        lastAudio = -1;
        lastLevel = '';
        lastDensity = -1;
        lastEma = -1;
        lastWorst = -1;
      }
      if (open) {
        const raw = Math.round(scrollStore.rawProgress * 10000);
        if (raw !== lastRaw) {
          lastRaw = raw;
          write('raw', (raw / 10000).toFixed(4));
        }
        const velocity = Math.round(scrollStore.velocity * 1000);
        if (velocity !== lastVelocity) {
          lastVelocity = velocity;
          write('velocity', (velocity / 1000).toFixed(3));
        }
        const audio = scrollStore.audioEnabled ? 1 : 0;
        if (audio !== lastAudio) {
          lastAudio = audio;
          write('audio', audio ? 'on' : 'muted');
        }
        const density = Math.round(adaptiveQuality.particleDensity * 100);
        if (adaptiveQuality.level !== lastLevel || density !== lastDensity) {
          lastLevel = adaptiveQuality.level;
          lastDensity = density;
          write('quality', `${lastLevel} ${density}%`);
        }
        const ema = Math.round(adaptiveQuality.frameMsEma * 10);
        if (ema !== lastEma) {
          lastEma = ema;
          write('frameEma', `${(ema / 10).toFixed(1)} ms`);
        }
      }

      // Step aside for the contact sheet on the lens and for the credits /
      // footer. In audit mode the panel stays, except over the footer on
      // narrow screens, where it would cover the footer's links.
      if (panel.current) {
        const fade = open
          ? narrow
            ? 1 - pageScroll.footerReveal
            : 1
          : 1 - Math.max(pageScroll.footerReveal, pageScroll.paperCover);
        const hidden = fade <= 0.001;
        if (Math.abs(fade - lastFade) > 0.004 || hidden !== lastFade <= 0.001 || (fade >= 1) !== (lastFade >= 1)) {
          lastFade = fade;
          const el = panel.current;
          el.style.opacity = hidden ? '0' : fade.toFixed(3);
          el.style.visibility = hidden ? 'hidden' : 'visible';
          el.style.pointerEvents = fade < 0.5 ? 'none' : '';
          el.setAttribute('aria-hidden', hidden ? 'true' : 'false');
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      narrowQuery.removeEventListener('change', onNarrow);
    };
  }, []);

  // Railway health poller.
  useEffect(() => {
    let cancelled = false;
    const setDot = (color: string) => {
      if (dot.current) dot.current.style.background = color;
    };
    /** One /healthz round trip; resolves true when the server answered healthy. */
    const poll = async (): Promise<boolean> => {
      const started = performance.now();
      try {
        const res = await fetch('/healthz', { cache: 'no-store', headers: { Accept: 'application/json' } });
        const latency = performance.now() - started;
        if (cancelled) return false;
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
        return ok;
      } catch {
        if (cancelled) return false;
        write('health', 'unreachable');
        write('latency', '—');
        setDot('#F87171');
        return false;
      }
    };
    // Only while the tab is visible; failures back off (x2 per failure, up to 60 s).
    let timer = 0;
    let failures = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      if (cancelled || document.hidden) return;
      timer = window.setTimeout(tick, Math.min(60_000, HEALTH_INTERVAL_MS * 2 ** failures));
    };
    const tick = () => {
      void poll().then((ok) => {
        failures = ok ? 0 : Math.min(failures + 1, 4);
        schedule();
      });
    };
    const onVisibility = () => {
      if (document.hidden) window.clearTimeout(timer);
      else tick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const shortSha = __BUILD_SHA__.length > 7 ? __BUILD_SHA__.slice(0, 7) : __BUILD_SHA__;

  // Below sm the panel sits under the sound / audit buttons instead of beside
  // them: side by side they do not fit, and the panel would cover the Audit button.
  return (
    <div
      ref={panel}
      className="interactive hud-glass fixed left-4 top-16 z-20 w-[min(60vw,280px)] !bg-ink/70 p-3 font-mono text-[10.5px] leading-relaxed text-white/70 sm:top-4"
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
