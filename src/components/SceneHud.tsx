import { useEffect, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { SCENES, scrollStore, sceneLocalProgress, TOTAL_GEAR } from '../store/scrollStore';
import { ENDING } from '../three/world/worldLayout';
import {
  displayHex,
  getTechLogo,
  usePortfolioStore,
  type Company,
  type Project,
} from '../store/portfolioStore';

const { damp } = THREE.MathUtils;

/* ==========================================================================
 * Scene HUD. The cards are rendered once (re-rendered only when portfolio
 * content changes). A rAF loop enforces strict decluttering: the shown card
 * fully fades out before the next one is allowed to fade in.
 *
 * Scenes 9–10 belong to the ending: after a short caption during the hero
 * pull, the contact details arrive on the paper stuck to the lens
 * (LensPaperOverlay), so no card is ever shown from ENDING.paperGustStart on.
 * ========================================================================== */

type Placement = 'center' | 'left' | 'right' | 'lower';

const PLACEMENT_CLASS: Record<Placement, string> = {
  center: 'left-1/2 top-1/2 w-[min(92vw,640px)] -translate-x-1/2 -translate-y-1/2 text-center',
  left: 'left-4 top-1/2 w-[min(92vw,420px)] -translate-y-1/2 sm:left-10',
  right: 'right-4 top-1/2 w-[min(92vw,420px)] -translate-y-1/2 sm:right-24',
  lower: 'bottom-[7%] left-1/2 w-[min(92vw,560px)] -translate-x-1/2 text-center',
};

const BASE_TRANSFORM: Record<Placement, string> = {
  center: 'translate(-50%, -50%)',
  left: 'translateY(-50%)',
  right: 'translateY(-50%)',
  lower: 'translateX(-50%)',
};

/** Index of the last scene that has a HUD card (the hero-pull caption). */
const HERO_CAPTION_INDEX = 8;
/** The caption clears out before the gust: the paper owns 0.945 → 1.0. */
const HERO_CAPTION_START = ENDING.heroPullStart + 0.003;
const HERO_CAPTION_END = ENDING.paperGustStart - 0.004;

function Card({
  index,
  placement,
  interactive = false,
  bare = false,
  className = '',
  children,
  register,
}: {
  index: number;
  placement: Placement;
  interactive?: boolean;
  bare?: boolean;
  className?: string;
  children: ReactNode;
  register: (index: number, el: HTMLElement | null) => void;
}) {
  return (
    <section
      ref={(el) => register(index, el)}
      data-scene-card={index}
      data-interactive={interactive ? 'true' : 'false'}
      data-base-transform={BASE_TRANSFORM[placement]}
      aria-hidden="true"
      className={`absolute ${PLACEMENT_CLASS[placement]} ${bare ? '' : 'hud-glass p-6 sm:p-7'} ${className}`}
      style={{ opacity: 0, visibility: 'hidden', willChange: 'opacity, transform' }}
    >
      {children}
    </section>
  );
}

function Kicker({ index }: { index: number }) {
  return (
    <p className="hud-kicker mb-3">
      Scene {String(index + 1).padStart(2, '0')} · {SCENES[index].title}
    </p>
  );
}

function TechChips({ slugs }: { slugs: string[] }) {
  return (
    <ul className="mt-4 flex flex-wrap gap-2">
      {slugs.map((slug) => {
        const logo = getTechLogo(slug);
        if (!logo) return null;
        const color = displayHex(logo.hex);
        return (
          <li
            key={slug}
            className="flex items-center gap-1.5 rounded-full border border-white/10 bg-black/30 px-2.5 py-1 text-[11px] text-white/80"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden="true">
              <path d={logo.path} fill={color} />
            </svg>
            {logo.name}
          </li>
        );
      })}
    </ul>
  );
}

function CompanyCard({ company, project }: { company: Company | undefined; project: Project | undefined }) {
  if (!company) return <p className="text-sm text-white/60">No company configured for this stage.</p>;
  const period = `${company.startDate} — ${company.endDate ?? 'Present'}`;
  return (
    <>
      <h2 className="text-2xl font-semibold text-white">{company.name}</h2>
      <p className="mt-1 text-sm text-glacier/80">
        {company.role} · {company.location}
      </p>
      <p className="mt-1 font-mono text-[11px] text-white/45">{period}</p>
      <p className="mt-4 text-sm leading-relaxed text-white/75">{company.summary}</p>
      <ul className="mt-3 space-y-1.5 text-sm text-white/70">
        {company.achievements.map((a) => (
          <li key={a} className="flex gap-2">
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-beacon" />
            {a}
          </li>
        ))}
      </ul>
      {project ? (
        <div className="mt-5 rounded-xl border border-beacon/25 bg-beacon/[0.06] p-4">
          <p className="hud-kicker !text-beacon/80">Project beacon</p>
          <h3 className="mt-1 text-base font-semibold text-white">
            {project.title} <span className="font-normal text-white/50">— {project.tagline}</span>
          </h3>
          <p className="mt-1.5 text-[13px] leading-relaxed text-white/70">{project.description}</p>
        </div>
      ) : null}
      <TechChips slugs={company.techSlugs} />
    </>
  );
}

function GearPips() {
  const pips = useRef<Array<HTMLSpanElement | null>>([]);
  const label = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let last = -1;
    const loop = () => {
      const count = scrollStore.activeGearCount;
      if (count !== last) {
        last = count;
        pips.current.forEach((pip, i) => {
          if (pip) pip.style.background = i < count ? 'var(--summit)' : 'rgba(255,255,255,0.12)';
        });
        if (label.current) label.current.textContent = `${count}/${TOTAL_GEAR}`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="flex items-center gap-2">
      <span className="hud-kicker">Gear</span>
      {Array.from({ length: TOTAL_GEAR }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            pips.current[i] = el;
          }}
          className="h-2 w-5 rounded-full transition-colors duration-300"
          style={{ background: 'rgba(255,255,255,0.12)' }}
        />
      ))}
      <span ref={label} className="font-mono text-[11px] text-summit">
        0/{TOTAL_GEAR}
      </span>
    </div>
  );
}

export function SceneHud() {
  const profile = usePortfolioStore((s) => s.profile);
  const education = usePortfolioStore((s) => s.education);
  const basicSkills = usePortfolioStore((s) => s.basicSkills);
  const companies = usePortfolioStore((s) => s.companies);
  const projects = usePortfolioStore((s) => s.projects);
  const skills = usePortfolioStore((s) => s.skills);

  const cards = useRef<Array<HTMLElement | null>>([]);
  const register = (index: number, el: HTMLElement | null) => {
    cards.current[index] = el;
  };

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let shown = -1;
    let opacity = 0;
    // Last state written to the shown card: idle frames write nothing.
    let writtenEl: HTMLElement | null = null;
    let writtenStep = -1;

    const loop = (now: number) => {
      const delta = Math.min(0.1, (now - last) / 1000);
      last = now;
      const p = scrollStore.dampedProgress;
      const active = scrollStore.activeSceneIndex;
      // Hold a card only while its scene is in its readable window.
      const local = sceneLocalProgress(active, p);
      const wanted = active > HERO_CAPTION_INDEX ? -1 : active;
      const readable =
        active === 0
          ? local < 0.85
          : active === HERO_CAPTION_INDEX
            ? p >= HERO_CAPTION_START && p < HERO_CAPTION_END
            : local > 0.04 && local < 0.96;

      if (p >= ENDING.paperGustStart) {
        // Hard cut: nothing may share the frame with the flying paper.
        const el = shown >= 0 ? cards.current[shown] : null;
        if (el) {
          el.style.opacity = '0';
          el.style.visibility = 'hidden';
          el.style.pointerEvents = 'none';
          el.setAttribute('aria-hidden', 'true');
        }
        opacity = 0;
        shown = -1;
        writtenEl = null;
      } else if (shown !== wanted || !readable) {
        opacity = damp(opacity, 0, 14, delta);
        if (opacity < 0.02) {
          opacity = 0;
          const prev = shown >= 0 ? cards.current[shown] : null;
          if (prev) {
            prev.style.visibility = 'hidden';
            prev.style.pointerEvents = 'none';
            prev.setAttribute('aria-hidden', 'true');
          }
          shown = wanted;
        }
      } else {
        opacity = damp(opacity, 1, 7, delta);
      }

      const el = shown >= 0 ? cards.current[shown] : null;
      const step = Math.round(opacity * 1000);
      if (el && (el !== writtenEl || step !== writtenStep)) {
        writtenEl = el;
        writtenStep = step;
        const visible = opacity > 0.01;
        el.style.visibility = visible ? 'visible' : 'hidden';
        el.style.opacity = opacity.toFixed(3);
        const baseTransform = el.dataset.baseTransform ?? 'translateY(-50%)';
        el.style.transform = `${baseTransform} translateY(${((1 - opacity) * 18).toFixed(2)}px)`;
        const interactive = el.dataset.interactive === 'true' && opacity > 0.6;
        el.style.pointerEvents = interactive ? 'auto' : 'none';
        el.setAttribute('aria-hidden', visible ? 'false' : 'true');
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const stage = (n: 1 | 2 | 3) => ({
    company: companies.find((c) => c.stage === n),
    project: projects.find((p) => p.stage === n),
  });

  return (
    <div className="hud-layer">
      <Card index={0} placement="center" bare className="[text-shadow:0_2px_24px_rgba(4,5,8,0.75)]" register={register}>
        <p className="hud-kicker mb-5">{profile.name}</p>
        <h1 className="text-balance text-3xl font-light leading-tight text-white sm:text-5xl">
          {profile.welcomeMessage}
        </h1>
        <p className="mt-6 animate-pulse font-mono text-[11px] uppercase tracking-hud text-glacier/60">Scroll ↓</p>
      </Card>

      <Card index={1} placement="right" register={register}>
        <Kicker index={1} />
        <h2 className="text-3xl font-semibold text-white">{profile.name}</h2>
        <p className="mt-1 text-sm text-glacier/80">{profile.headline}</p>
        <p className="mt-4 text-sm leading-relaxed text-white/70">{profile.summary}</p>
        <dl className="mt-5 grid grid-cols-2 gap-3">
          {profile.traits.map((trait) => (
            <div key={trait.id} className="rounded-xl border border-white/10 bg-black/25 p-3">
              <dt className="hud-kicker !tracking-[0.18em]">{trait.label}</dt>
              <dd className="mt-1 text-[13px] text-white/85">{trait.value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-5">
          <GearPips />
        </div>
      </Card>

      <Card index={2} placement="left" register={register}>
        <Kicker index={2} />
        <h2 className="text-2xl font-semibold text-white">Education & Basic Skills</h2>
        {education.map((edu) => (
          <div key={edu.id} className="mt-4">
            <p className="text-sm font-medium text-white/90">
              {edu.degree} · {edu.field}
            </p>
            <p className="text-[13px] text-white/55">
              {edu.institution} · {edu.startYear} — {edu.endYear ?? 'Present'}
            </p>
          </div>
        ))}
        <ul className="mt-5 space-y-2.5">
          {basicSkills.map((skill) => (
            <li key={skill.id}>
              <div className="flex justify-between text-[12px] text-white/70">
                <span>{skill.label}</span>
                <span className="font-mono text-white/40">{Math.round(skill.level * 100)}</span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-gradient-to-r from-beacon to-glacier" style={{ width: `${skill.level * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-5">
          <GearPips />
        </div>
      </Card>

      {([1, 2, 3] as const).map((n) => (
        <Card key={n} index={2 + n} placement={n === 2 ? 'left' : 'right'} register={register}>
          <Kicker index={2 + n} />
          <CompanyCard {...stage(n)} />
          <div className="mt-5">
            <GearPips />
          </div>
        </Card>
      ))}

      <Card index={6} placement="right" register={register}>
        <Kicker index={6} />
        <h2 className="text-2xl font-semibold text-white">Skills earned on the way up</h2>
        <p className="mt-1 text-sm text-white/60">Everything but the pack left behind — the rest was skill.</p>
        <ul className="mt-5 grid grid-cols-4 gap-3">
          {skills.map((skill) => {
            const logo = getTechLogo(skill.slug);
            if (!logo) return null;
            const color = displayHex(logo.hex);
            return (
              <li
                key={skill.slug}
                className="flex flex-col items-center gap-1.5 rounded-xl border border-white/10 bg-black/30 p-2.5"
                style={{ boxShadow: `0 0 24px ${color}22` }}
                title={`${logo.name} · ${skill.years} yrs`}
              >
                <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
                  <path d={logo.path} fill={color} />
                </svg>
                <span className="text-center text-[10px] leading-tight text-white/70">{logo.name}</span>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card index={7} placement="center" bare className="[text-shadow:0_2px_24px_rgba(4,5,8,0.85)]" register={register}>
        <p className="text-balance text-2xl font-light italic text-white/90 sm:text-4xl">{profile.horizonMessage}</p>
      </Card>

      <Card
        index={HERO_CAPTION_INDEX}
        placement="lower"
        bare
        className="[text-shadow:0_2px_22px_rgba(4,5,8,0.9)]"
        register={register}
      >
        <p className="hud-kicker mb-2 !text-glacier/70">
          Scene {String(HERO_CAPTION_INDEX + 1).padStart(2, '0')} · {SCENES[HERO_CAPTION_INDEX].title}
        </p>
        <p className="text-balance text-xl font-light italic text-white/90 sm:text-2xl">
          Standing before the next mountain — ready for the next journey.
        </p>
      </Card>
    </div>
  );
}

export default SceneHud;
