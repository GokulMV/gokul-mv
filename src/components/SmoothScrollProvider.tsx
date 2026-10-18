import { useEffect, useRef, type ReactNode } from 'react';
import Lenis from '@studio-freight/lenis';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { clamp01, SCROLL_TRACK_VH, scrollStore } from '../store/scrollStore';
import { pageScroll } from '../store/pageScroll';

gsap.registerPlugin(ScrollTrigger);

interface SmoothScrollProviderProps {
  children: ReactNode;
  /** Height of the scroll track in viewport heights. */
  trackVh?: number;
  /** Normal page content rendered after the track (the credits / footer). */
  after?: ReactNode;
}

declare global {
  interface Window {
    /** Debug handle, only present in audit mode (?audit). */
    __ascent?: { scrollStore: typeof scrollStore; pageScroll: typeof pageScroll };
  }
}

/**
 * Owns Lenis and drives it from GSAP's ticker so Lenis, ScrollTrigger and the
 * scroll store share one clock. Progress is written to the mutable
 * `scrollStore` — never to React state.
 *
 * Progress is TRACK-relative: it reaches exactly 1.0 when the bottom of the
 * 1400vh track meets the bottom of the viewport (scroll = trackEnd −
 * innerHeight) and stays 1.0 while the `after` content (the footer) scrolls
 * in. The driver registered with the store uses the same track limit, so
 * scrollToProgress(p) always targets the track — also from the footer.
 */
export function SmoothScrollProvider({ children, trackVh = SCROLL_TRACK_VH, after }: SmoothScrollProviderProps) {
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const lenis = new Lenis({
      duration: reducedMotion ? 0.01 : 1.15,
      easing: (t: number) => Math.min(1, 1.001 - 2 ** (-10 * t)),
      smoothWheel: !reducedMotion,
      wheelMultiplier: 0.9,
      touchMultiplier: 1.4,
      syncTouch: false,
    });

    let trackLimit = 1;
    const measureTrack = () => {
      const track = trackRef.current;
      if (!track) return;
      const top = track.getBoundingClientRect().top + window.scrollY;
      // Integer, so Lenis' rounded scroll targets land exactly on progress 1.
      trackLimit = Math.max(1, Math.floor(top + track.offsetHeight - window.innerHeight));
      pageScroll.trackLimit = trackLimit;
    };
    measureTrack();

    const readProgress = (): number => clamp01((lenis.scroll as number) / trackLimit);

    const updatePage = () => {
      const scroll = lenis.scroll as number;
      const beyond = scroll - trackLimit;
      pageScroll.scroll = scroll;
      pageScroll.inFooter = beyond > 0.5;
      pageScroll.footerReveal = clamp01(beyond / Math.max(1, window.innerHeight * 0.5));
    };

    const onScroll = () => {
      scrollStore.setRawProgress(readProgress());
      updatePage();
      ScrollTrigger.update();
    };
    lenis.on('scroll', onScroll);

    scrollStore.registerDriver({
      get limit() {
        return trackLimit;
      },
      scrollTo: (target, options) => lenis.scrollTo(target, options),
    });

    let last = performance.now();
    const update = (time: number) => {
      lenis.raf(time * 1000);
      const now = performance.now();
      scrollStore.tick((now - last) / 1000);
      last = now;
    };
    gsap.ticker.add(update);
    gsap.ticker.lagSmoothing(0);

    // Resume where the browser restored the scroll position.
    scrollStore.setRawProgress(readProgress());
    scrollStore.dampedProgress = scrollStore.rawProgress;
    updatePage();

    const remeasure = () => {
      lenis.resize();
      measureTrack();
      ScrollTrigger.refresh();
      scrollStore.setRawProgress(readProgress());
      updatePage();
    };
    window.addEventListener('resize', remeasure);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(remeasure) : null;
    if (observer && trackRef.current) observer.observe(trackRef.current);

    if (scrollStore.auditMode) window.__ascent = { scrollStore, pageScroll };

    return () => {
      window.removeEventListener('resize', remeasure);
      observer?.disconnect();
      gsap.ticker.remove(update);
      lenis.off('scroll', onScroll);
      scrollStore.registerDriver(null);
      lenis.destroy();
      if (window.__ascent) delete window.__ascent;
    };
  }, []);

  return (
    <>
      {children}
      <div
        ref={trackRef}
        aria-hidden="true"
        data-scroll-track
        style={{ height: `${trackVh}vh`, width: '100%', position: 'relative', pointerEvents: 'none' }}
      />
      {after}
    </>
  );
}

export default SmoothScrollProvider;
