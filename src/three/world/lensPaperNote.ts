import type { ContactDetails, Profile } from '../../store/portfolioStore';

/* ==========================================================================
 * Lens-paper note — the single layout of the contact sheet.
 *
 * The sheet is drawn twice: as ink in a canvas texture on the WebGL paper
 * (visible while it flies and while it peels away) and as real, crisp,
 * clickable DOM text on top of the paper while it is stuck to the lens.
 * Both read this layout, so the two inks line up while they cross-fade.
 *
 * Coordinates are "paper units": the sheet is 740 × 1000, origin top-left,
 * y down, baselines sitting on the ruled lines.
 * ========================================================================== */

export const PAPER_UNITS = { width: 740, height: 1000 } as const;
export const PAPER_ASPECT = PAPER_UNITS.width / PAPER_UNITS.height;

/** Ruled lines: rule k sits at y = first + spacing · k. */
export const PAPER_RULES = { first: 190, spacing: 50, count: 16 } as const;
/** Red margin line (paper units from the left edge). */
export const PAPER_MARGIN_X = 88;
/** The sheet was folded in quarters in the pack: creases on both centre lines. */
export const PAPER_CREASES = { x: 370, y: 500 } as const;

export type NoteFamily = 'type' | 'hand';

export interface ResolvedNoteFonts {
  /** CSS font-family list for the typewritten lines. */
  type: string;
  /** CSS font-family list for the handwritten lines. */
  hand: string;
  /** A synthetic slant is only used when no handwriting face is installed. */
  handItalic: boolean;
}

export interface LensNoteLine {
  key: string;
  text: string;
  href: string | null;
  external: boolean;
  ariaLabel: string | null;
  family: NoteFamily;
  weight: number;
  italic: boolean;
  /** Left edge of the text (paper units). */
  x: number;
  /** Alphabetic baseline (paper units). */
  baseline: number;
  /** Font size (paper units). */
  size: number;
  /** Rotation in radians about (x, baseline). */
  rotation: number;
  color: string;
  opacity: number;
  /** Measured advance width (paper units). */
  width: number;
  /** Font ascent / descent used by CSS line boxes (paper units). */
  ascent: number;
  descent: number;
  underline: boolean;
}

export interface LensNoteStroke {
  d: string;
  width: number;
  dash: readonly number[] | null;
  opacity: number;
}

export interface LensNoteLayout {
  fonts: ResolvedNoteFonts;
  lines: LensNoteLine[];
  doodle: LensNoteStroke[];
}

/** Ink colours (sRGB). */
export const NOTE_INK = {
  ribbon: '#23252C',
  pen: '#1C2D63',
  link: '#1B3170',
  faded: '#4B4F5C',
} as const;

const TYPE_CANDIDATES = [
  'American Typewriter',
  'Courier Prime',
  'Courier 10 Pitch',
  'Courier New',
  'Courier',
  'Nimbus Mono PS',
  'Liberation Mono',
];
const TYPE_FALLBACK = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

const HAND_CANDIDATES = [
  'Segoe Print',
  'Bradley Hand',
  'Noteworthy',
  'Ink Free',
  'Chalkboard SE',
  'Comic Neue',
  'Patrick Hand',
];
const HAND_SERIF_CANDIDATES = ['Bitstream Charter', 'Charter', 'Georgia', 'Iowan Old Style', 'Palatino', 'Times New Roman'];
const HAND_FALLBACK = 'serif';

let measureCtx: CanvasRenderingContext2D | null = null;

function measurer(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  measureCtx = canvas.getContext('2d');
  return measureCtx;
}

const quote = (family: string): string => `"${family}"`;

/** True when `family` is installed: its glyph advances differ from both generic fallbacks. */
function hasFont(ctx: CanvasRenderingContext2D, family: string): boolean {
  const sample = 'mmmmmmmmmlliWWQqg@1937 — let’s talk';
  const widthWith = (fallback: string): number => {
    ctx.font = `64px ${quote(family)}, ${fallback}`;
    return ctx.measureText(sample).width;
  };
  const widthOf = (fallback: string): number => {
    ctx.font = `64px ${fallback}`;
    return ctx.measureText(sample).width;
  };
  return widthWith('monospace') !== widthOf('monospace') || widthWith('serif') !== widthOf('serif');
}

let resolvedFonts: ResolvedNoteFonts | null = null;

/** Picks the first installed typewriter / handwriting face (system fonts only, no network). */
export function resolveNoteFonts(): ResolvedNoteFonts {
  if (resolvedFonts) return resolvedFonts;
  const ctx = measurer();
  if (!ctx) {
    return {
      type: `${TYPE_CANDIDATES.map(quote).join(', ')}, ${TYPE_FALLBACK}`,
      hand: `${HAND_CANDIDATES.map(quote).join(', ')}, ${HAND_FALLBACK}`,
      handItalic: false,
    };
  }
  const type = TYPE_CANDIDATES.find((family) => hasFont(ctx, family));
  const hand = HAND_CANDIDATES.find((family) => hasFont(ctx, family));
  const serif = HAND_SERIF_CANDIDATES.find((family) => hasFont(ctx, family));
  resolvedFonts = {
    type: type ? `${quote(type)}, ${TYPE_FALLBACK}` : TYPE_FALLBACK,
    hand: hand ? `${quote(hand)}, ${HAND_FALLBACK}` : serif ? `${quote(serif)}, ${HAND_FALLBACK}` : HAND_FALLBACK,
    handItalic: !hand,
  };
  return resolvedFonts;
}

export function noteFontString(fonts: ResolvedNoteFonts, line: Pick<LensNoteLine, 'family' | 'weight' | 'italic' | 'size'>): string {
  const family = line.family === 'type' ? fonts.type : fonts.hand;
  return `${line.italic ? 'italic ' : ''}${line.weight} ${line.size}px ${family}`;
}

interface LineSpec {
  key: string;
  text: string;
  family: NoteFamily;
  size: number;
  weight?: number;
  x: number;
  baseline: number;
  maxWidth?: number;
  /** Right-align against x instead of left-aligning. */
  alignRight?: boolean;
  rotation?: number;
  color?: string;
  opacity?: number;
  href?: string | null;
  external?: boolean;
  ariaLabel?: string | null;
  underline?: boolean;
}

function measure(
  ctx: CanvasRenderingContext2D | null,
  fonts: ResolvedNoteFonts,
  family: NoteFamily,
  weight: number,
  italic: boolean,
  size: number,
  text: string,
): { width: number; ascent: number; descent: number } {
  if (!ctx) return { width: text.length * size * 0.56, ascent: size * 0.8, descent: size * 0.22 };
  ctx.font = noteFontString(fonts, { family, weight, italic, size });
  const m = ctx.measureText(text);
  const ascent = Number.isFinite(m.fontBoundingBoxAscent) ? m.fontBoundingBoxAscent : size * 0.8;
  const descent = Number.isFinite(m.fontBoundingBoxDescent) ? m.fontBoundingBoxDescent : size * 0.22;
  return { width: m.width, ascent, descent };
}

function makeLine(ctx: CanvasRenderingContext2D | null, fonts: ResolvedNoteFonts, spec: LineSpec): LensNoteLine {
  const weight = spec.weight ?? (spec.family === 'type' ? 400 : 400);
  const italic = spec.family === 'hand' && fonts.handItalic;
  let size = spec.size;
  let metrics = measure(ctx, fonts, spec.family, weight, italic, size, spec.text);
  if (spec.maxWidth && metrics.width > spec.maxWidth) {
    size = Math.max(9, (size * spec.maxWidth) / metrics.width);
    metrics = measure(ctx, fonts, spec.family, weight, italic, size, spec.text);
  }
  const x = spec.alignRight ? spec.x - metrics.width : spec.x;
  return {
    key: spec.key,
    text: spec.text,
    href: spec.href ?? null,
    external: spec.external ?? false,
    ariaLabel: spec.ariaLabel ?? null,
    family: spec.family,
    weight,
    italic,
    x,
    baseline: spec.baseline,
    size,
    rotation: spec.rotation ?? 0,
    color: spec.color ?? (spec.family === 'hand' ? NOTE_INK.pen : NOTE_INK.ribbon),
    opacity: spec.opacity ?? 1,
    width: metrics.width,
    ascent: metrics.ascent,
    descent: metrics.descent,
    underline: spec.underline ?? false,
  };
}

/** Greedy word wrap with the same font metrics the renderers use. */
function wrap(
  ctx: CanvasRenderingContext2D | null,
  fonts: ResolvedNoteFonts,
  family: NoteFamily,
  size: number,
  text: string,
  widths: readonly number[],
): string[] {
  const italic = family === 'hand' && fonts.handItalic;
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    const limit = widths[Math.min(lines.length, widths.length - 1)];
    if (current && measure(ctx, fonts, family, 400, italic, size, candidate).width > limit) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  if (lines.length > widths.length) {
    const kept = lines.slice(0, widths.length);
    kept[kept.length - 1] = `${kept[kept.length - 1]} ${lines.slice(widths.length).join(' ')}`;
    return kept;
  }
  return lines;
}

const ruleY = (k: number): number => PAPER_RULES.first + PAPER_RULES.spacing * k;
/** Ink sits a hair above the printed rule. */
const onRule = (k: number): number => ruleY(k) - 4;

const LEFT = 112;
const VALUE_X = 236;
const RIGHT = 704;

/** Hand-drawn doodle: the climbed peak (flag planted) and the far bigger next mountain. */
const DOODLE: LensNoteStroke[] = [
  { d: 'M470 945 C 520 942, 610 947, 706 942', width: 2.4, dash: null, opacity: 0.85 },
  { d: 'M476 944 L 509 913 L 519 920 L 535 899 L 558 931 L 571 944', width: 2.6, dash: null, opacity: 0.9 },
  { d: 'M535 899 L 535 879 M535 880 L 550 885 L 535 891', width: 2.2, dash: null, opacity: 0.9 },
  { d: 'M561 944 L 597 899 L 609 908 L 645 853 L 660 870 L 673 861 L 705 944', width: 2.8, dash: null, opacity: 0.92 },
  { d: 'M632 873 L 640 868 L 647 877 L 655 869 L 664 872', width: 2, dash: null, opacity: 0.75 },
  { d: 'M541 896 C 566 872, 604 868, 640 858', width: 2, dash: [5, 7], opacity: 0.8 },
];

let cache: { contact: ContactDetails; profile: Profile; layout: LensNoteLayout } | null = null;

/** Lays out the contact sheet for the given content. Deterministic and memoised. */
export function buildLensNote(contact: ContactDetails, profile: Profile): LensNoteLayout {
  if (cache && cache.contact === contact && cache.profile === profile) return cache.layout;
  const ctx = measurer();
  const fonts = resolveNoteFonts();
  const lines: LensNoteLine[] = [];
  const add = (spec: LineSpec) => lines.push(makeLine(ctx, fonts, spec));

  add({ key: 'kicker', text: 'FIELD NOTE · Nº 02', family: 'type', size: 17, x: LEFT, baseline: 104, color: NOTE_INK.faded, opacity: 0.82 });
  add({
    key: 'kicker-right',
    text: 'NEXT ASCENT →',
    family: 'type',
    size: 17,
    x: RIGHT,
    baseline: 104,
    alignRight: true,
    color: NOTE_INK.faded,
    opacity: 0.82,
  });
  add({ key: 'heading', text: 'If found — let’s talk.', family: 'hand', size: 54, x: LEFT - 4, baseline: onRule(1), maxWidth: RIGHT - LEFT, rotation: -0.022 });
  add({ key: 'name', text: profile.name.toUpperCase(), family: 'type', size: 34, weight: 700, x: LEFT, baseline: onRule(3), maxWidth: RIGHT - LEFT });
  add({ key: 'headline', text: profile.headline, family: 'type', size: 19, x: LEFT, baseline: onRule(4), maxWidth: RIGHT - LEFT, opacity: 0.78 });

  let row = 6;
  const detail = (key: string, label: string, value: string, href: string | null, external: boolean, ariaLabel: string | null) => {
    add({ key: `${key}-label`, text: label, family: 'type', size: 14.5, x: LEFT, baseline: onRule(row), color: NOTE_INK.faded, opacity: 0.8 });
    add({
      key,
      text: value,
      family: 'type',
      size: 23,
      x: VALUE_X,
      baseline: onRule(row),
      maxWidth: RIGHT - VALUE_X,
      href,
      external,
      ariaLabel,
      color: href ? NOTE_INK.link : NOTE_INK.ribbon,
      underline: href !== null,
    });
    row += 1;
  };

  detail('email', 'EMAIL', contact.email, `mailto:${contact.email}`, false, `Email ${contact.email}`);
  if (contact.phone) detail('phone', 'PHONE', contact.phone, `tel:${contact.phone.replace(/[^\d+]/g, '')}`, false, `Call ${contact.phone}`);
  if (contact.location) detail('base', 'BASE', contact.location, null, false, null);
  const maxLinks = contact.resumeUrl ? 3 : 4;
  contact.links.slice(0, maxLinks).forEach((link) => {
    const label = link.label.toUpperCase().slice(0, 8);
    detail(
      `link-${link.id}`,
      label,
      `${link.handle || link.href.replace(/^https?:\/\//, '')} ↗`,
      link.href,
      true,
      `${link.label} ${link.handle} (opens in a new tab)`,
    );
  });
  if (contact.resumeUrl) detail('resume', 'RÉSUMÉ', 'Download ↗', contact.resumeUrl, true, 'Download résumé (opens in a new tab)');

  if (contact.availability) {
    const firstRow = Math.min(row + 1, 13);
    const rowsLeft = Math.max(1, 14 - firstRow);
    const wrapped = wrap(ctx, fonts, 'hand', 31, contact.availability, rowsLeft >= 2 ? [RIGHT - LEFT, 470 - LEFT] : [RIGHT - LEFT]);
    wrapped.forEach((text, i) => {
      add({
        key: `availability-${i}`,
        text,
        family: 'hand',
        size: 31,
        x: LEFT,
        baseline: onRule(firstRow + i),
        maxWidth: i === 0 ? RIGHT - LEFT : 470 - LEFT,
        rotation: -0.012,
      });
    });
  }

  const firstName = profile.name.trim().split(/\s+/)[0] || profile.name;
  add({ key: 'signature', text: `— ${firstName}`, family: 'hand', size: 40, x: LEFT + 6, baseline: onRule(15) - 2, maxWidth: 340, rotation: -0.035 });

  const layout: LensNoteLayout = { fonts, lines, doodle: DOODLE };
  cache = { contact, profile, layout };
  return layout;
}

/**
 * Paints the note's ink into a 2D canvas whose size is `scale` × paper units.
 * Ink only: the paper itself (fibres, rules, creases) is procedural in the shader.
 */
export function paintLensNote(ctx: CanvasRenderingContext2D, layout: LensNoteLayout, scale: number): void {
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, PAPER_UNITS.width, PAPER_UNITS.height);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  for (const line of layout.lines) {
    ctx.save();
    ctx.translate(line.x, line.baseline);
    if (line.rotation !== 0) ctx.rotate(line.rotation);
    ctx.globalAlpha = line.opacity;
    ctx.fillStyle = line.color;
    ctx.font = noteFontString(layout.fonts, line);
    ctx.fillText(line.text, 0, 0);
    if (line.underline) {
      ctx.globalAlpha = line.opacity * 0.4;
      ctx.fillRect(0, line.size * 0.17, line.width, Math.max(1, line.size * 0.055));
    }
    ctx.restore();
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = NOTE_INK.pen;
  for (const stroke of layout.doodle) {
    ctx.globalAlpha = stroke.opacity;
    ctx.lineWidth = stroke.width;
    ctx.setLineDash(stroke.dash ? [...stroke.dash] : []);
    ctx.stroke(new Path2D(stroke.d));
  }
  ctx.restore();
}
