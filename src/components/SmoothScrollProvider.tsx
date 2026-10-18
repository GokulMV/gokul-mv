import { useEffect, useRef, type ReactNode } from 'react';
import Lenis from '@studio-freight/lenis';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SCROLL_TRACK_VH, scrollStore } from '../store/scrollStore';

gsap.registerPlugin(ScrollTrigger);

interface SmoothScrollProviderProps {
  children: ReactNode;
  /** Height of the scroll track in viewport heights. */
  trackVh?: number;
}

/**
 * Owns Lenis and drives it from GSAP's ticker so Lenis, ScrollTrigger and the
 * scroll store share one clock. Progress is written to the mutable
 * `scrollStore` — never to React state.
 */
export function SmoothScrollProvider({ children, trackVh = SCROLL_TRACK_VH }: SmoothScrollProviderProps) {
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

    const readProgress = (): number => {
      const limit = lenis.limit as number;
      return limit > 0 ? (lenis.scroll as number) / limit : 0;
    };

    const onScroll = () => {
      scrollStore.setRawProgress(readProgress());
      ScrollTrigger.update();
    };
    lenis.on('scroll', onScroll);

    scrollStore.registerDriver({
      get limit() {
        return lenis.limit as number;
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

    const onResize = () => {
      lenis.resize();
      ScrollTrigger.refresh();
      scrollStore.setRawProgress(readProgress());
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      gsap.ticker.remove(update);
      lenis.off('scroll', onScroll);
      scrollStore.registerDriver(null);
      lenis.destroy();
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
    </>
  );
}

export default SmoothScrollProvider;
