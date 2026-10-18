import { useEffect, useRef } from 'react';
import { SCENES, scrollStore } from '../store/scrollStore';
import { soundEngine } from '../utils/soundEngine';

/** Progress rail, scene navigation, audio + audit toggles. */
export function HudControls() {
  const fill = useRef<HTMLDivElement>(null);
  const dots = useRef<Array<HTMLButtonElement | null>>([]);
  const audioBtn = useRef<HTMLButtonElement>(null);
  const auditBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let raf = 0;
    let lastScene = -1;
    const loop = () => {
      if (fill.current) fill.current.style.transform = `scaleY(${scrollStore.dampedProgress.toFixed(4)})`;
      const scene = scrollStore.activeSceneIndex;
      if (scene !== lastScene) {
        lastScene = scene;
        dots.current.forEach((dot, i) => {
          if (!dot) return;
          dot.dataset.active = String(i === scene);
          dot.style.background = i === scene ? 'var(--beacon)' : i < scene ? 'rgba(207,232,255,0.55)' : 'rgba(255,255,255,0.15)';
          dot.style.transform = i === scene ? 'scale(1.5)' : 'scale(1)';
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const syncAudio = (enabled: boolean) => {
      scrollStore.audioEnabled = enabled;
      if (audioBtn.current) {
        audioBtn.current.textContent = enabled ? 'Sound · on' : 'Sound · off';
        audioBtn.current.setAttribute('aria-pressed', String(enabled));
      }
    };
    const syncAudit = () => {
      if (auditBtn.current) {
        auditBtn.current.textContent = scrollStore.auditMode ? 'Audit · on' : 'Audit · off';
        auditBtn.current.setAttribute('aria-pressed', String(scrollStore.auditMode));
      }
    };
    syncAudio(soundEngine.isEnabled);
    syncAudit();
    const offAudio = soundEngine.onChange(syncAudio);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '`') {
        scrollStore.auditMode = !scrollStore.auditMode;
        syncAudit();
      }
    };
    const onAuditClick = () => {
      scrollStore.auditMode = !scrollStore.auditMode;
      syncAudit();
    };
    const auditEl = auditBtn.current;
    auditEl?.addEventListener('click', onAuditClick);
    window.addEventListener('keydown', onKey);
    return () => {
      offAudio();
      auditEl?.removeEventListener('click', onAuditClick);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <>
      <nav
        aria-label="Journey scenes"
        className="interactive fixed right-4 top-1/2 z-20 flex -translate-y-1/2 items-center gap-3 sm:right-8"
      >
        <div className="relative h-56 w-px overflow-hidden bg-white/10">
          <div ref={fill} className="absolute inset-0 origin-top bg-gradient-to-b from-glacier to-beacon" style={{ transform: 'scaleY(0)' }} />
        </div>
        <ol className="flex flex-col gap-[14px]">
          {SCENES.map((scene, i) => (
            <li key={scene.id}>
              <button
                type="button"
                ref={(el) => {
                  dots.current[i] = el;
                }}
                title={`${i + 1}. ${scene.title}`}
                aria-label={`Go to scene ${i + 1}: ${scene.title}`}
                onClick={() => scrollStore.scrollToProgress(scene.start + (scene.end - scene.start) * 0.3)}
                className="block h-2 w-2 rounded-full transition-[transform,background] duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-beacon"
                style={{ background: 'rgba(255,255,255,0.15)' }}
              />
            </li>
          ))}
        </ol>
      </nav>

      <div className="interactive fixed right-4 top-4 z-20 flex gap-2 sm:right-8">
        <button ref={auditBtn} type="button" className="hud-btn" aria-pressed="false">
          Audit · off
        </button>
        <button
          ref={audioBtn}
          type="button"
          className="hud-btn"
          aria-pressed="false"
          disabled={!soundEngine.isSupported}
          onClick={() => void soundEngine.toggle()}
        >
          Sound · off
        </button>
      </div>
    </>
  );
}

export default HudControls;
