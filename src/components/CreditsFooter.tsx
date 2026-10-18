import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { displayHex, getTechLogo, usePortfolioStore } from '../store/portfolioStore';
import { scrollStore } from '../store/scrollStore';

/* ==========================================================================
 * Credits / footer — the page after the 3D track. Progress is pinned at 1.0
 * here (the world has dissolved to the #040508 void), and the end credits
 * roll in as normal page content.
 * ========================================================================== */

/** Technologies this site is actually built and deployed with (logos from Simple Icons). */
const BUILT_WITH = ['react', 'threedotjs', 'typescript', 'vite', 'tailwindcss', 'railway'] as const;

/** Libraries credited by name (no official marks in the logo set). */
const ALSO_BUILT_WITH = ['React Three Fiber', 'drei', 'postprocessing', 'GSAP', 'Lenis', 'Zustand'] as const;

const BUILD_SHA = __BUILD_SHA__.length > 7 ? __BUILD_SHA__.slice(0, 7) : __BUILD_SHA__;
const BUILD_YEAR = (() => {
  const year = new Date(__BUILD_TIME__).getFullYear();
  return Number.isFinite(year) ? year : new Date().getFullYear();
})();

/** Stagger for the reveal transition (read by .credits-reveal in index.css). */
const delay = (ms: number): CSSProperties => ({ '--d': `${ms}ms` }) as CSSProperties;

function CreditRow({ role, children, delayMs }: { role: string; children: ReactNode; delayMs: number }) {
  return (
    <div className="credits-reveal grid grid-cols-1 gap-1 sm:grid-cols-2 sm:items-baseline sm:gap-8" style={delay(delayMs)}>
      <dt className="font-mono text-[10px] uppercase tracking-[0.3em] text-glacier/50 sm:text-right">{role}</dt>
      <dd className="text-[15px] text-white/85 sm:text-left">{children}</dd>
    </div>
  );
}

export function CreditsFooter(): JSX.Element {
  const profile = usePortfolioStore((s) => s.profile);
  const contact = usePortfolioStore((s) => s.contact);
  const root = useRef<HTMLElement>(null);

  // Reveal each block as it scrolls in (CSS transitions; reduced motion shows everything at once).
  useEffect(() => {
    const el = root.current;
    if (!el) return undefined;
    const targets = Array.from(el.querySelectorAll<HTMLElement>('.credits-reveal'));
    if (typeof IntersectionObserver === 'undefined') {
      targets.forEach((t) => (t.dataset.shown = 'true'));
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            (entry.target as HTMLElement).dataset.shown = 'true';
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.15 },
    );
    targets.forEach((t) => observer.observe(t));
    return () => observer.disconnect();
  }, []);

  const backToBaseCamp = () => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scrollStore.scrollToProgress(0, reduced ? { immediate: true } : { duration: 3.2 });
  };

  const firstName = profile.name.trim().split(/\s+/)[0] || profile.name;

  return (
    <footer
      ref={root}
      id="credits"
      aria-labelledby="credits-title"
      className="relative z-[5] overflow-hidden bg-void text-white"
      data-credits
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-void to-transparent" />

      <div className="relative mx-auto flex min-h-[100svh] w-full max-w-3xl flex-col items-center px-4 pb-14 pt-28 text-center sm:px-8 sm:pt-36">
        <svg
          className="credits-reveal credits-ridge mb-10 h-16 w-full max-w-md text-glacier/40 sm:h-20"
          viewBox="0 0 400 80"
          fill="none"
          aria-hidden="true"
          focusable="false"
        >
          {/* The climbed peak (flag planted) and the bigger, continuous next mountain. */}
          <path
            d="M0 78 L34 70 L62 56 L76 60 L104 40 L118 47 L136 58 L158 54 L186 36 L204 41 L238 10 L252 17 L268 6 L292 24 L314 28 L348 52 L372 60 L400 78"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
            strokeLinecap="round"
            pathLength={1}
          />
          <path d="M104 40 L104 26 M104 27 L113 30 L104 33" stroke="#F4C77B" strokeOpacity="0.8" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
          <path d="M110 38 C 150 20, 200 12, 262 9" stroke="currentColor" strokeOpacity="0.6" strokeWidth="0.9" strokeDasharray="0.012 0.02" pathLength={1} className="credits-trail" />
        </svg>

        <p className="credits-reveal hud-kicker" style={delay(80)}>
          Fin · end of part one
        </p>
        <h2
          id="credits-title"
          className="credits-reveal mt-4 text-balance text-5xl font-extralight uppercase tracking-[0.28em] text-white sm:text-7xl"
          style={delay(160)}
        >
          The Ascent
        </h2>
        <p className="credits-reveal mt-6 text-sm text-white/60 sm:text-base" style={delay(260)}>
          Designed &amp; engineered by <span className="font-medium text-white">{profile.name}</span>
        </p>
        <p className="credits-reveal mt-1 font-mono text-[11px] uppercase tracking-[0.22em] text-glacier/60" style={delay(320)}>
          {profile.headline}
        </p>

        <p
          className="credits-reveal mt-12 max-w-xl text-balance text-xl font-light italic leading-relaxed text-white/80 sm:text-2xl"
          style={delay(120)}
        >
          This summit was only base camp. The next mountain is already in view — bigger, and continuous. Let’s
          climb it together.
        </p>

        <dl className="mt-14 w-full space-y-4 sm:space-y-3">
          <CreditRow role="Story, design & code" delayMs={0}>
            {profile.name}
          </CreditRow>
          <CreditRow role="Rendering" delayMs={60}>
            Three.js · React Three Fiber · drei · postprocessing
          </CreditRow>
          <CreditRow role="Motion" delayMs={120}>
            GSAP · Lenis
          </CreditRow>
          <CreditRow role="State" delayMs={180}>
            Zustand
          </CreditRow>
          <CreditRow role="Hosting" delayMs={240}>
            Railway
          </CreditRow>
        </dl>

        <section aria-labelledby="credits-contact" className="credits-reveal mt-16 w-full">
          <h3 id="credits-contact" className="hud-kicker">
            Say hello to {firstName}
          </h3>
          <ul className="mt-5 flex flex-col items-center gap-3 text-[15px]">
            <li>
              <a
                className="break-all text-beacon underline decoration-beacon/30 underline-offset-4 transition-colors hover:decoration-beacon focus:outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-beacon/70"
                href={`mailto:${contact.email}`}
              >
                {contact.email}
              </a>
            </li>
            {contact.phone ? (
              <li>
                <a
                  className="text-white/80 hover:text-white focus:outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-beacon/70"
                  href={`tel:${contact.phone.replace(/[^\d+]/g, '')}`}
                >
                  {contact.phone}
                </a>
              </li>
            ) : null}
            <li className="text-sm text-white/50">
              {contact.location}
              {contact.availability ? <span className="block text-white/40">{contact.availability}</span> : null}
            </li>
          </ul>
          <ul className="mt-5 flex flex-wrap justify-center gap-2">
            {contact.links.map((link) => (
              <li key={link.id}>
                <a
                  className="hud-btn inline-flex min-h-[40px] items-center"
                  href={link.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={`${link.label} ${link.handle} (opens in a new tab)`}
                >
                  {link.label} · {link.handle}
                </a>
              </li>
            ))}
            {contact.resumeUrl ? (
              <li>
                <a
                  className="hud-btn inline-flex min-h-[40px] items-center"
                  href={contact.resumeUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label="Résumé (opens in a new tab)"
                >
                  Résumé
                </a>
              </li>
            ) : null}
          </ul>
        </section>

        <section aria-labelledby="credits-built" className="credits-reveal mt-16 w-full">
          <h3 id="credits-built" className="hud-kicker">
            Built with
          </h3>
          <ul className="mx-auto mt-6 grid max-w-lg grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-6">
            {BUILT_WITH.map((slug) => {
              const logo = getTechLogo(slug);
              if (!logo) return null;
              const color = displayHex(logo.hex);
              return (
                <li key={slug} className="flex flex-col items-center gap-2">
                  <svg viewBox="0 0 24 24" className="h-7 w-7 opacity-90" role="img" aria-label={logo.name}>
                    <path d={logo.path} fill={color} />
                  </svg>
                  <span className="text-[11px] text-white/55">{logo.name}</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-6 text-[12px] text-white/45">with {ALSO_BUILT_WITH.join(' · ')}</p>
        </section>

        <div className="credits-reveal mt-16">
          <button
            type="button"
            onClick={backToBaseCamp}
            className="group inline-flex min-h-[44px] items-center gap-3 rounded-full border border-white/15 bg-white/[0.04] px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.24em] text-glacier/85 transition-colors hover:border-beacon/60 hover:text-beacon focus:outline-none focus-visible:ring-2 focus-visible:ring-beacon/70"
          >
            <span aria-hidden="true" className="inline-block transition-transform duration-500 group-hover:-translate-y-0.5">
              ↑
            </span>
            Back to base camp
          </button>
        </div>

        <div className="mt-auto w-full pt-16">
          <p className="text-[11px] leading-relaxed text-white/35">
            Brand icons: Simple Icons (CC0). Brand marks are trademarks of their respective owners.
          </p>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/30">
            © {BUILD_YEAR} {profile.name} · build <span className="text-white/45">{BUILD_SHA}</span>
          </p>
        </div>
      </div>
    </footer>
  );
}

export default CreditsFooter;
