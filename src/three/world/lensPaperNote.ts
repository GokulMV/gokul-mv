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
  /**
   * The second line of a link that breaks over two lines: drawn and clickable
   * like the link, but not focusable and hidden from assistive tech (the
   * first line carries the whole link's label).
   */
  continuation: boolean;
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
  /** How far the minimum sizes of each family were squeezed to fit the sheet (1 = not at all). */
  fit: Record<NoteFamily, number>;
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
  /** Smallest size (paper units) `maxWidth` may shrink the line to. */
  minSize?: number;
  /** Right-align against x instead of left-aligning. */
  alignRight?: boolean;
  rotation?: number;
  color?: string;
  opacity?: number;
  href?: string | null;
  external?: boolean;
  ariaLabel?: string | null;
  underline?: boolean;
  continuation?: boolean;
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

const isItalic = (fonts: ResolvedNoteFonts, family: NoteFamily): boolean => family === 'hand' && fonts.handItalic;

function makeLine(ctx: CanvasRenderingContext2D | null, fonts: ResolvedNoteFonts, spec: LineSpec): LensNoteLine {
  const weight = spec.weight ?? 400;
  const italic = isItalic(fonts, spec.family);
  let size = spec.size;
  let metrics = measure(ctx, fonts, spec.family, weight, italic, size, spec.text);
  if (spec.maxWidth && metrics.width > spec.maxWidth) {
    size = Math.max(spec.minSize ?? 9, (size * spec.maxWidth) / metrics.width);
    metrics = measure(ctx, fonts, spec.family, weight, italic, size, spec.text);
    // Content too long to fit even at its smallest size (an unusually long
    // value) still never leaves the writing area: the margins win.
    for (let i = 0; i < 3 && metrics.width > spec.maxWidth + 0.25; i += 1) {
      size *= spec.maxWidth / metrics.width;
      metrics = measure(ctx, fonts, spec.family, weight, italic, size, spec.text);
    }
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
    continuation: spec.continuation ?? false,
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
  const italic = isItalic(fonts, family);
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

/** Separators that may end a line only by being dropped ("Engineer ·" / "Full-Stack"). */
const SEPARATOR = /^[·|•—–/-]$/;

/**
 * Splits `text` into at most two lines of near-equal width (no orphaned last
 * word), breaking at a separator when that is just as balanced.
 */
function balance2(
  ctx: CanvasRenderingContext2D | null,
  fonts: ResolvedNoteFonts,
  family: NoteFamily,
  weight: number,
  size: number,
  text: string,
  maxWidth: number,
): string[] {
  const italic = isItalic(fonts, family);
  const width = (t: string) => measure(ctx, fonts, family, weight, italic, size, t).width;
  const trimmed = text.trim();
  if (width(trimmed) <= maxWidth) return [trimmed];
  const words = trimmed.split(/\s+/).filter(Boolean);
  let best: string[] = [trimmed];
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 1; i < words.length; i += 1) {
    const head = words.slice(0, i);
    const tail = words.slice(i);
    const separatorBreak = SEPARATOR.test(head[head.length - 1]) || SEPARATOR.test(tail[0]);
    while (head.length > 1 && SEPARATOR.test(head[head.length - 1])) head.pop();
    while (tail.length > 1 && SEPARATOR.test(tail[0])) tail.shift();
    const a = head.join(' ');
    const b = tail.join(' ');
    const wide = Math.max(width(a), width(b));
    // Over-wide splits only as a last resort; separator breaks win near-ties.
    const score = wide + (wide > maxWidth ? 1e5 : 0) - (separatorBreak ? 0.06 * maxWidth : 0);
    if (score < bestScore) {
      bestScore = score;
      best = [a, b];
    }
  }
  return best;
}

const ruleY = (k: number): number => PAPER_RULES.first + PAPER_RULES.spacing * k;
/** Ink sits a hair above the printed rule. */
const onRule = (k: number): number => ruleY(k) - 4;

const LEFT = 112;
const RIGHT = 704;
/**
 * The top-right kicker stops short of the sheet's corner: that corner lifts
 * off the glass in the wind (LensPaperShader CORNER_REACH), and flat DOM text
 * must never sit on paper that is moving under it.
 */
const KICKER_RIGHT = 662;
/** Gap between the label column and the values (paper units). */
const LABEL_GAP = 26;
/** Left edge of the doodle; the last availability line stops short of it. */
const DOODLE_LEFT = 440;
/** Last rule the details and the availability may use (the signature sits on rule 15). */
const LAST_BODY_RULE = 13;

/**
 * Smallest rendered CSS sizes (px) for each kind of line. On a phone the
 * sheet is only ~330 px wide, so the paper-unit sizes grow to keep every line
 * at least this large; on big screens the designed sizes are already larger.
 */
export const NOTE_MIN_PX = {
  kicker: 11.5,
  label: 12,
  headline: 12,
  name: 15.5,
  value: 14,
  hand: 14.5,
  heading: 20,
  signature: 17,
} as const;

/**
 * Gentle floors (px) for the shortest sheets (landscape phones), where the
 * minimum sizes cannot share the ruled lines without rows overlapping: the
 * minimums are squeezed step by step (FIT_STEPS) only until the note fits,
 * and never below these.
 */
export const NOTE_FLOOR_PX = {
  kicker: 10,
  label: 10,
  headline: 10.5,
  name: 12.5,
  value: 11,
  hand: 11.5,
  heading: 15,
  signature: 13,
} as const;

type NoteRole = keyof typeof NOTE_MIN_PX;

/** The family each role is set in: the two families are squeezed independently. */
const ROLE_FAMILY: Record<NoteRole, NoteFamily> = {
  kicker: 'type',
  label: 'type',
  headline: 'type',
  name: 'type',
  value: 'type',
  hand: 'hand',
  heading: 'hand',
  signature: 'hand',
};

/** Successive squeezes of NOTE_MIN_PX, tried in order (per family) until every line fits the sheet. */
const FIT_STEPS = [1, 0.96, 0.92, 0.88, 0.84, 0.8, 0.76, 0.72, 0.68] as const;

/** Lines may shrink below their size by this factor before they wrap or stack instead. */
const SQUEEZE = 0.94;

/** Hand-drawn doodle: the climbed peak (flag planted) and the far bigger next mountain. */
const DOODLE: LensNoteStroke[] = [
  { d: 'M440 937 C 490 934, 580 939, 676 934', width: 2.4, dash: null, opacity: 0.85 },
  { d: 'M446 936 L 479 905 L 489 912 L 505 891 L 528 923 L 541 936', width: 2.6, dash: null, opacity: 0.9 },
  { d: 'M505 891 L 505 871 M505 872 L 520 877 L 505 883', width: 2.2, dash: null, opacity: 0.9 },
  { d: 'M531 936 L 567 891 L 579 900 L 615 845 L 630 862 L 643 853 L 675 936', width: 2.8, dash: null, opacity: 0.92 },
  { d: 'M602 865 L 610 860 L 617 869 L 625 861 L 634 864', width: 2, dash: null, opacity: 0.75 },
  { d: 'M511 888 C 536 864, 574 860, 610 850', width: 2, dash: [5, 7], opacity: 0.8 },
];

/**
 * Quantised CSS px per paper unit for laying out the note. Rounded down, so
 * the type never renders below its target size, and in 0.01 steps, so resizing
 * only rebuilds the layout (and the ink texture) every ~2% of sheet size.
 */
export function noteScaleKey(unitPx: number): number {
  return Math.max(0.1, Math.floor(unitPx * 100) / 100);
}

interface NoteDetail {
  key: string;
  label: string;
  value: string;
  href: string | null;
  external: boolean;
  ariaLabel: string | null;
}

function noteDetails(contact: ContactDetails): NoteDetail[] {
  const details: NoteDetail[] = [];
  details.push({ key: 'email', label: 'EMAIL', value: contact.email, href: `mailto:${contact.email}`, external: false, ariaLabel: `Email ${contact.email}` });
  if (contact.phone) {
    details.push({
      key: 'phone',
      label: 'PHONE',
      value: contact.phone,
      href: `tel:${contact.phone.replace(/[^\d+]/g, '')}`,
      external: false,
      ariaLabel: `Call ${contact.phone}`,
    });
  }
  if (contact.location) details.push({ key: 'base', label: 'BASE', value: contact.location, href: null, external: false, ariaLabel: null });
  const maxLinks = contact.resumeUrl ? 3 : 4;
  for (const link of contact.links.slice(0, maxLinks)) {
    details.push({
      key: `link-${link.id}`,
      label: link.label.toUpperCase().slice(0, 8),
      value: `${link.handle || link.href.replace(/^https?:\/\//, '')} ↗`,
      href: link.href,
      external: true,
      ariaLabel: `${link.label} ${link.handle} (opens in a new tab)`,
    });
  }
  if (contact.resumeUrl) {
    details.push({ key: 'resume', label: 'RÉSUMÉ', value: 'Download ↗', href: contact.resumeUrl, external: true, ariaLabel: 'Download résumé (opens in a new tab)' });
  }
  return details;
}

/**
 * Splits a value that cannot fit on one line at its most natural break: an
 * email before the "@", otherwise the space or "/" nearest the middle, or
 * (a single long token) the middle itself.
 */
function splitValue(value: string): [string, string] | null {
  if (value.length < 6) return null;
  const at = value.indexOf('@');
  if (at > 0 && at < value.length - 1) return [value.slice(0, at), value.slice(at)];
  const mid = value.length / 2;
  let best = -1;
  for (let i = 1; i < value.length - 1; i += 1) {
    const c = value[i];
    if ((c === ' ' || c === '/') && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  const cut = best > 0 ? best : Math.round(mid);
  const head = value.slice(0, cut).trimEnd();
  const tail = value.slice(cut).trimStart();
  return head && tail ? [head, tail] : null;
}

/** Vertical extent (paper units) of a line's font box (ascent to descent), including its tilt and underline. */
function lineTop(line: LensNoteLine): number {
  const rise = line.rotation < 0 ? Math.sin(-line.rotation) * line.width : 0;
  return line.baseline - line.ascent - rise;
}
function lineBottom(line: LensNoteLine): number {
  const drop = line.rotation > 0 ? Math.sin(line.rotation) * line.width : 0;
  const underline = line.underline ? line.size * 0.225 : 0;
  return line.baseline + Math.max(line.descent, underline) + drop;
}

/**
 * Clear space (CSS px) kept between the font boxes of neighbouring rows. It
 * also absorbs the browser rounding font ascent / descent to whole pixels,
 * which makes the DOM's line boxes up to ~0.5 px taller on each side.
 */
const ROW_CLEARANCE_PX = 1;
const TYPE_MISFIT = 1;
const HAND_MISFIT = 2;
const misfitBit = (line: LensNoteLine): number => (line.family === 'type' ? TYPE_MISFIT : HAND_MISFIT);

/**
 * Which families (TYPE_MISFIT | HAND_MISFIT) have a line outside the writing
 * area (right of RIGHT, the kicker right of KICKER_RIGHT) or whose font box
 * (ascent to descent, underline and tilt included) overlaps another row's.
 * 0 means the note fits: inside the margins, no two rows touching.
 */
function misfits(lines: readonly LensNoteLine[], key: number): number {
  const clearance = ROW_CLEARANCE_PX / key;
  let bad = 0;
  for (const line of lines) {
    const limit = line.key === 'kicker-right' ? KICKER_RIGHT : RIGHT;
    if (line.x + line.width > limit + 0.5 || line.x < LEFT - 8) bad |= misfitBit(line);
  }
  for (let i = 0; i < lines.length; i += 1) {
    const a = lines[i];
    for (let j = i + 1; j < lines.length; j += 1) {
      const b = lines[j];
      if (Math.abs(a.baseline - b.baseline) < 1) continue;
      if (Math.min(a.x + a.width, b.x + b.width) <= Math.max(a.x, b.x)) continue;
      const upper = a.baseline < b.baseline ? a : b;
      const lower = upper === a ? b : a;
      if (lineBottom(upper) + clearance > lineTop(lower)) bad |= misfitBit(a) | misfitBit(b);
    }
  }
  return bad;
}

let cache: { contact: ContactDetails; profile: Profile; layouts: Map<number, LensNoteLayout> } | null = null;

/**
 * Lays out the contact sheet for the given content at `scaleKey` CSS px per
 * paper unit (see noteScaleKey). Deterministic and memoised; the WebGL ink
 * and the DOM overlay must use the same key so the two inks register.
 *
 * The minimum CSS sizes keep phone type legible; on the shortest sheets
 * (landscape phones) they are squeezed — each family only as far as its own
 * lines need (FIT_STEPS, never below NOTE_FLOOR_PX) — until every line fits
 * inside the margins with no rows overlapping. Long values stack under their
 * label, and a value that still cannot fit (a long email) breaks over two lines.
 */
export function buildLensNote(contact: ContactDetails, profile: Profile, scaleKey: number): LensNoteLayout {
  const key = noteScaleKey(scaleKey);
  if (!cache || cache.contact !== contact || cache.profile !== profile) cache = { contact, profile, layouts: new Map() };
  const hit = cache.layouts.get(key);
  if (hit) return hit;

  const ctx = measurer();
  const fonts = resolveNoteFonts();
  let lines: LensNoteLine[] = [];
  let typeStep = 0;
  let handStep = 0;
  const last = FIT_STEPS.length - 1;
  for (;;) {
    const fit = { type: FIT_STEPS[typeStep], hand: FIT_STEPS[handStep] };
    const attempt = layoutNote(ctx, fonts, contact, profile, key, fit);
    lines = attempt.lines;
    const bad = misfits(lines, key) | attempt.cramped;
    const nextType = bad & TYPE_MISFIT && typeStep < last ? typeStep + 1 : typeStep;
    const nextHand = bad & HAND_MISFIT && handStep < last ? handStep + 1 : handStep;
    // Fits — or nothing left to squeeze: keep the most compact attempt (all at the floors).
    if (!bad || (nextType === typeStep && nextHand === handStep)) break;
    typeStep = nextType;
    handStep = nextHand;
  }

  const layout: LensNoteLayout = { fonts, lines, doodle: DOODLE, fit: { type: FIT_STEPS[typeStep], hand: FIT_STEPS[handStep] } };
  if (cache.layouts.size > 12) cache.layouts.clear();
  cache.layouts.set(key, layout);
  return layout;
}

/**
 * One layout attempt with each family's minimum sizes squeezed by `fit`.
 * `cramped` flags the families (TYPE_MISFIT | HAND_MISFIT) with a line that
 * had to shrink below its minimum to stay in the margins while that minimum
 * was still above the role's floor — a tighter fit would serve it better.
 */
function layoutNote(
  ctx: CanvasRenderingContext2D | null,
  fonts: ResolvedNoteFonts,
  contact: ContactDetails,
  profile: Profile,
  key: number,
  fit: Readonly<Record<NoteFamily, number>>,
): { lines: LensNoteLine[]; cramped: number } {
  const lines: LensNoteLine[] = [];
  let cramped = 0;
  const add = (spec: LineSpec, role?: NoteRole) => {
    const line = makeLine(ctx, fonts, spec);
    lines.push(line);
    const min = spec.minSize ?? 0;
    if (role && line.size < min - 1e-6 && min > floor(role) + 1e-6) cramped |= misfitBit(line);
  };
  /** Smallest size (paper units) a line of this role may ever render at. */
  const floor = (role: NoteRole): number => NOTE_FLOOR_PX[role] / key;
  /** Designed size (paper units), raised so it renders at >= the role's (squeezed) minimum. */
  const sized = (design: number, role: NoteRole): number =>
    Math.max(design, (NOTE_MIN_PX[role] * fit[ROLE_FAMILY[role]]) / key, floor(role));
  /** How far `maxWidth` may shrink a line of this role. */
  const shrinkTo = (size: number, role: NoteRole): number => Math.min(size, Math.max(size * SQUEEZE, floor(role)));
  const widthOf = (family: NoteFamily, weight: number, size: number, text: string): number =>
    measure(ctx, fonts, family, weight, isItalic(fonts, family), size, text).width;

  // ---- Kicker row: "FIELD NOTE · Nº 02" … "NEXT ASCENT →" (dropped if it cannot fit).
  const kickerLeft = 'FIELD NOTE · Nº 02';
  const kickerRight = 'NEXT ASCENT →';
  let kicker = sized(17, 'kicker');
  const kickerSpace = KICKER_RIGHT - LEFT - 28;
  const kickerWidth = widthOf('type', 400, kicker, `${kickerLeft}${kickerRight}`);
  if (kickerWidth > kickerSpace) kicker = Math.max(kicker * SQUEEZE, floor('kicker'), (kicker * kickerSpace) / kickerWidth);
  const showKickerRight = widthOf('type', 400, kicker, `${kickerLeft}${kickerRight}`) <= kickerSpace + 0.5;
  add({ key: 'kicker', text: kickerLeft, family: 'type', size: kicker, x: LEFT, baseline: 104, color: NOTE_INK.faded, opacity: 0.82 });
  if (showKickerRight) {
    add({
      key: 'kicker-right',
      text: kickerRight,
      family: 'type',
      size: kicker,
      x: KICKER_RIGHT,
      baseline: 104,
      alignRight: true,
      color: NOTE_INK.faded,
      opacity: 0.82,
    });
  }

  const handSize = sized(31, 'hand');
  add({
    key: 'heading',
    text: 'If found — let’s talk.',
    family: 'hand',
    size: sized(54, 'heading'),
    x: LEFT - 4,
    baseline: onRule(1),
    maxWidth: RIGHT - LEFT,
    minSize: handSize,
    rotation: -0.022,
  }, 'hand');
  const nameSize = sized(34, 'name');
  add({
    key: 'name',
    text: profile.name.toUpperCase(),
    family: 'type',
    size: nameSize,
    weight: 700,
    x: LEFT,
    baseline: onRule(3),
    maxWidth: RIGHT - LEFT,
    minSize: shrinkTo(nameSize, 'name'),
  }, 'name');

  // ---- Headline: one line, or two balanced lines on narrow sheets.
  const headlineSize = sized(20, 'headline');
  const headline = balance2(ctx, fonts, 'type', 400, headlineSize, profile.headline, RIGHT - LEFT);
  headline.forEach((text, i) => {
    add({
      key: `headline-${i}`,
      text,
      family: 'type',
      size: headlineSize,
      x: LEFT,
      baseline: onRule(4 + i),
      maxWidth: RIGHT - LEFT,
      minSize: shrinkTo(headlineSize, 'headline'),
      opacity: 0.8,
    }, 'headline');
  });

  // ---- Details: a label column sized to its longest label and the values
  // beside it; a value that cannot fit beside its label goes under it
  // (indented), and one that cannot fit there either breaks over two lines.
  const details = noteDetails(contact);
  const labelSize = sized(15.5, 'label');
  const valueSize = sized(26, 'value');
  const valueMin = shrinkTo(valueSize, 'value');
  const labelColumn = details.reduce((widest, d) => Math.max(widest, widthOf('type', 400, labelSize, d.label)), 0);
  const valueX = Math.round(LEFT + labelColumn + LABEL_GAP);
  const stackX = LEFT + LABEL_GAP;
  const firstRow = headline.length > 1 ? 7 : 6;

  type Placement = 'beside' | 'stacked' | 'split' | 'squeezed';
  const valueWidth = (d: NoteDetail, size: number): number => widthOf('type', 400, size, d.value);
  const plan: Placement[] = details.map((d) => {
    if (valueWidth(d, valueMin) <= RIGHT - valueX) return 'beside';
    if (valueWidth(d, valueMin) <= RIGHT - stackX) return 'stacked';
    return splitValue(d.value) ? 'split' : 'stacked';
  });
  const rowsOf = (p: Placement): number => (p === 'split' ? 3 : p === 'stacked' ? 2 : 1);
  const budget = LAST_BODY_RULE - firstRow + 1;
  let rowsNeeded = plan.reduce((sum, p) => sum + rowsOf(p), 0);
  // Out of rules: squeeze values back beside their labels where they fit there at the floor...
  for (let i = plan.length - 1; i >= 0 && rowsNeeded > budget; i -= 1) {
    if (plan[i] === 'beside' || valueWidth(details[i], floor('value')) > RIGHT - valueX) continue;
    rowsNeeded -= rowsOf(plan[i]) - 1;
    plan[i] = 'squeezed';
  }
  // ...then leave out the lowest-priority details (the credits footer lists them all).
  while (rowsNeeded > budget && details.length > 1) {
    details.pop();
    rowsNeeded -= rowsOf(plan.pop() ?? 'beside');
  }

  let row = firstRow;
  details.forEach((d, i) => {
    const placement = plan[i];
    const link = {
      href: d.href,
      external: d.external,
      ariaLabel: d.ariaLabel,
      color: d.href ? NOTE_INK.link : NOTE_INK.ribbon,
      underline: d.href !== null,
    };
    add({ key: `${d.key}-label`, text: d.label, family: 'type', size: labelSize, x: LEFT, baseline: onRule(row), color: NOTE_INK.faded, opacity: 0.8 });
    if (placement === 'beside' || placement === 'squeezed') {
      add({
        key: d.key,
        text: d.value,
        family: 'type',
        size: valueSize,
        x: valueX,
        baseline: onRule(row),
        maxWidth: RIGHT - valueX,
        minSize: placement === 'beside' ? valueMin : floor('value'),
        ...link,
      }, 'value');
    } else if (placement === 'stacked') {
      row += 1;
      add({ key: d.key, text: d.value, family: 'type', size: valueSize, x: stackX, baseline: onRule(row), maxWidth: RIGHT - stackX, minSize: valueMin, ...link }, 'value');
    } else {
      // Two lines of one link at one size: the first is the focusable link, the second its continuation.
      const [head, tail] = splitValue(d.value) ?? [d.value, ''];
      const widest = Math.max(widthOf('type', 400, valueSize, head), widthOf('type', 400, valueSize, tail));
      // Both halves at one size (below the floor only if even the halves cannot fit at it).
      const size = Math.min(valueSize, (valueSize * (RIGHT - stackX)) / widest);
      add({ key: d.key, text: head, family: 'type', size, x: stackX, baseline: onRule(row + 1), maxWidth: RIGHT - stackX, minSize: floor('value'), ...link });
      add({
        key: `${d.key}-cont`,
        text: tail,
        family: 'type',
        size,
        x: stackX,
        baseline: onRule(row + 2),
        maxWidth: RIGHT - stackX,
        minSize: floor('value'),
        ...link,
        continuation: true,
      });
      row += 2;
    }
    row += 1;
  });

  // ---- Availability (hand-written, at most two lines, clear of the doodle and the signature).
  if (contact.availability) {
    const availabilityRow = row + 1;
    const rowsLeft = LAST_BODY_RULE + 1 - availabilityRow;
    if (rowsLeft >= 1) {
      const widths = rowsLeft >= 2 ? [RIGHT - LEFT, DOODLE_LEFT - 18 - LEFT] : [DOODLE_LEFT - 18 - LEFT];
      const wrapped = wrap(ctx, fonts, 'hand', handSize, contact.availability, widths);
      wrapped.forEach((text, i) => {
        add({
          key: `availability-${i}`,
          text,
          family: 'hand',
          size: handSize,
          x: LEFT,
          baseline: onRule(availabilityRow + i),
          maxWidth: widths[Math.min(i, widths.length - 1)],
          minSize: shrinkTo(handSize, 'hand'),
          rotation: -0.012,
        }, 'hand');
      });
    }
  }

  const firstName = profile.name.trim().split(/\s+/)[0] || profile.name;
  add({
    key: 'signature',
    text: `— ${firstName}`,
    family: 'hand',
    size: sized(40, 'signature'),
    x: LEFT + 6,
    baseline: onRule(15) - 2,
    maxWidth: DOODLE_LEFT - 24 - LEFT,
    minSize: handSize,
    rotation: -0.035,
  }, 'hand');

  return { lines, cramped };
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
