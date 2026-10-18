import { useEffect, useRef } from 'react';
import { SCENES, scrollStore } from '../store/scrollStore';
import { pageScroll } from '../store/pageScroll';
import { soundEngine } from '../utils/soundEngine';
import { lensPaperState } from '../three/world/LensPaper';

/**
 * True when the convex quad `q` (TL, TR, BR, BL x/y pairs) overlaps the
 * axis-aligned rect [l, r] × [t, b] (separating-axis test, no allocations).
 */
function quadHitsRect(q: Float64Array, l: number, t: number, r: number, b: number): boolean {
  let minX = q[0];
  let maxX = q[0];
  let minY = q[1];
  let maxY = q[1];
  for (let i = 1; i < 4; i += 1) {
    minX = Math.min(minX, q[i * 2]);
    maxX = Math.max(maxX, q[i * 2]);
    minY = Math.min(minY, q[i * 2 + 1]);
    maxY = Math.max(maxY, q[i * 2 + 1]);
  }
  if (maxX < l || minX > r || maxY < t || minY > b) return false;
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4;
    // Outward-agnostic edge normal; the quad's own extent along it vs the rect's.
    const nx = q[j * 2 + 1] - q[i * 2 + 1];
    const ny = q[i * 2] - q[j * 2];
    let qMin = Infinity;
    let qMax = -Infinity;
    for (let k = 0; k < 4; k += 1) {
      const d = q[k * 2] * nx + q[k * 2 + 1] * ny;
      qMin = Math.min(qMin, d);
      qMax = Math.max(qMax, d);
    }
    const r0 = l * nx + t * ny;
    const r1 = r * nx + t * ny;
    const r2 = r * nx + b * ny;
    const r3 = l * nx + b * ny;
    const rMin = Math.min(r0, r1, r2, r3);
    const rMax = Math.max(r0, r1, r2, r3);
    if (rMax < qMin || rMin > qMax) return false;
  }
  return true;
}

/**
 * Progress rail, scene navigation, audio + audit toggles. The scene rail
 * belongs to the 3D journey: it fades out (and leaves the tab order and the
 * accessibility tree) while the contact sheet is on the lens — on a phone it
 * would sit on the sheet — and while the credits / footer scroll in. The
 * sound and audit buttons stay, but tuck away (slide off the top edge)
 * deep in the footer while you scroll down, so they never sit on a footer
 * link, and return on scroll up; and on short landscape screens, where the
 * sheet on the lens reaches up beside them, until it peels away. Tucked
 * buttons stay in the tab order and the accessibility tree: keyboard focus
 * slides them straight back in (CSS :focus-within).
 *
 * The rAF loop only touches the DOM when a value actually changes.
 */
export function HudControls() {
  const nav = useRef<HTMLElement>(null);
  const topControls = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const dots = useRef<Array<HTMLButtonElement | null>>([]);
  const audioBtn = useRef<HTMLButtonElement>(null);
  const auditBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let raf = 0;
    let lastScene = -1;
    let lastFill = -1;
    let lastHide = -1;
    let lastInFooter = false;
    let lastScroll = pageScroll.scroll;
    let tucked = false;
    let lastTucked = false;
    let overSheet = false;
    // The buttons' untransformed layout box (CSS px), measured on resize only
    // (of the window, or of the buttons themselves, e.g. once fonts load).
    const box = { left: 0, top: 0, right: 0, bottom: 0 };
    const measure = () => {
      const el = topControls.current;
      if (!el) return;
      box.left = el.offsetLeft;
      box.top = el.offsetTop;
      box.right = el.offsetLeft + el.offsetWidth;
      box.bottom = el.offsetTop + el.offsetHeight;
    };
    measure();
    window.addEventListener('resize', measure);
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (resizeObserver && topControls.current) resizeObserver.observe(topControls.current);
    const loop = () => {
      const progress = scrollStore.dampedProgress;
      if (fill.current && Math.abs(progress - lastFill) > 0.0002) {
        lastFill = progress;
        fill.current.style.transform = `scaleY(${progress.toFixed(4)})`;
      }
      const hide = Math.max(pageScroll.footerReveal, pageScroll.paperCover);
      const hidden = hide >= 0.999;
      if (nav.current && (Math.abs(hide - lastHide) > 0.004 || hidden !== lastHide >= 0.999 || (hide <= 0) !== (lastHide <= 0))) {
        lastHide = hide;
        const el = nav.current;
        el.style.opacity = hidden ? '0' : (1 - hide).toFixed(3);
        el.style.pointerEvents = hide > 0.35 ? 'none' : '';
        el.style.visibility = hidden ? 'hidden' : 'visible';
        if (hidden && el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      }
      // Over scrolling footer text the buttons get a solid backdrop.
      if (topControls.current && lastInFooter !== pageScroll.inFooter) {
        lastInFooter = pageScroll.inFooter;
        topControls.current.dataset.footer = String(lastInFooter);
      }
      // Headroom: once the footer's top edge has left the viewport, footer
      // content scrolls under the buttons — tuck them away on scroll down,
      // bring them back on scroll up (or while one has keyboard focus).
      const scroll = pageScroll.scroll;
      const delta = scroll - lastScroll;
      lastScroll = scroll;
      const deepInFooter = scroll - pageScroll.trackLimit > window.innerHeight;
      if (!deepInFooter) tucked = false;
      else if (delta > 1) tucked = true;
      else if (delta < -1) tucked = false;
      // The sheet on the lens reaches up beside the buttons (short landscape
      // screens): step aside until it has peeled away. A wider margin to come
      // back than to leave, so the slap's wobble never makes them flicker.
      const paper = lensPaperState;
      if ((paper.phase === 'stuck' || paper.phase === 'peel') && paper.visible) {
        const m = overSheet ? 14 : 8;
        overSheet = quadHitsRect(paper.quad, box.left - m, box.top - m, box.right + m, box.bottom + m);
      } else {
        overSheet = false;
      }
      const controls = topControls.current;
      const focused = controls && (tucked || overSheet) ? document.activeElement : null;
      if (focused && controls?.contains(focused)) {
        // Keyboard focus keeps them out (headroom yields; over the sheet CSS
        // :focus-within shows them while focused); focus left over from a tap
        // must not hold them over the footer or the sheet.
        if (focused.matches(':focus-visible')) tucked = false;
        else (focused as HTMLElement).blur();
      }
      const tuck = tucked || overSheet;
      if (controls && tuck !== lastTucked) {
        lastTucked = tuck;
        controls.dataset.tucked = String(tuck);
      }
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
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      resizeObserver?.disconnect();
    };
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
      if (e.key === '`' && scrollStore.auditAvailable) {
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
        ref={nav}
        aria-label="Journey scenes"
        className="interactive fixed right-4 top-1/2 z-20 flex -translate-y-1/2 items-center gap-3 transition-opacity duration-300 sm:right-8"
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

      <div
        ref={topControls}
        data-footer="false"
        data-tucked="false"
        className="hud-top-controls interactive fixed right-4 top-4 z-20 flex gap-2 sm:right-8"
      >
        {scrollStore.auditAvailable ? (
          <button ref={auditBtn} type="button" className="hud-btn" aria-pressed="false">
            Audit · off
          </button>
        ) : null}
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
