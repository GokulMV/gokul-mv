import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { usePortfolioStore } from '../store/portfolioStore';
import { lensNoteKeyFor, lensPaperState, subscribeLensPaper } from '../three/world/LensPaper';
import { buildLensNote, NOTE_INK, PAPER_UNITS, type LensNoteLine } from '../three/world/lensPaperNote';

/* ==========================================================================
 * Lens paper overlay — the contact details as real DOM on the sheet that the
 * wind slapped onto the lens.
 *
 * The text is laid out in paper units (shared with the WebGL ink texture) and
 * mapped onto the projected sheet with a CSS matrix3d homography written
 * straight to style.transform — from LensPaper's frame callback (same frame,
 * no lag) and from a rAF fallback. No React re-renders on scroll.
 * Links are focusable, clickable and exposed to assistive tech only while the
 * sheet is on the lens and interactive; the rest of the time — fading in, the
 * hand-back to the ink, flight and peel — the sheet is inert and aria-hidden.
 *
 * The type scale depends on the viewport (minimum CSS sizes on phones), so
 * the overlay renders the layout for the key LensPaper painted into its ink
 * texture (lensPaperState.noteKey) and stays hidden while the two differ —
 * a React re-render only when a resize crosses a layout step, never on scroll.
 * ========================================================================== */

const W = PAPER_UNITS.width;
const H = PAPER_UNITS.height;

/** Writes the column-major CSS matrix3d that maps the [0,bw]×[0,bh] box onto `quad` (TL, TR, BR, BL). */
function homography(quad: Float64Array, bw: number, bh: number, out: Float64Array): boolean {
  const x0 = quad[0];
  const y0 = quad[1];
  const x1 = quad[2];
  const y1 = quad[3];
  const x2 = quad[4];
  const y2 = quad[5];
  const x3 = quad[6];
  const y3 = quad[7];
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  let g = 0;
  let hh = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) < 1e-9) return false;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    hh = (dx1 * dy3 - dx3 * dy1) / den;
  }
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + hh * x3;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + hh * y3;
  out[0] = a / bw;
  out[1] = d / bw;
  out[2] = 0;
  out[3] = g / bw;
  out[4] = b / bh;
  out[5] = e / bh;
  out[6] = 0;
  out[7] = hh / bh;
  out[8] = 0;
  out[9] = 0;
  out[10] = 1;
  out[11] = 0;
  out[12] = x0;
  out[13] = y0;
  out[14] = 0;
  out[15] = 1;
  return true;
}

const unit = (value: number): string => `calc(${value.toFixed(2)}px * var(--u, 0.5))`;

function lineStyle(line: LensNoteLine, family: string): CSSProperties {
  // CSS puts the baseline (size + ascent − descent) / 2 below the top of a
  // line box whose height equals the font size.
  const top = line.baseline - (line.size + line.ascent - line.descent) / 2;
  return {
    left: unit(line.x),
    top: unit(top),
    fontFamily: family,
    fontSize: unit(line.size),
    fontWeight: line.weight,
    fontStyle: line.italic ? 'italic' : 'normal',
    lineHeight: 1,
    color: line.color,
    opacity: line.opacity,
    transform: line.rotation !== 0 ? `rotate(${line.rotation.toFixed(4)}rad)` : undefined,
    transformOrigin: line.rotation !== 0 ? `0 ${unit((line.size + line.ascent - line.descent) / 2)}` : undefined,
  };
}

export function LensPaperOverlay(): JSX.Element {
  const contact = usePortfolioStore((s) => s.contact);
  const profile = usePortfolioStore((s) => s.profile);
  const [noteKey, setNoteKey] = useState(() =>
    lensPaperState.noteKey > 0
      ? lensPaperState.noteKey
      : lensNoteKeyFor(document.documentElement.clientWidth || window.innerWidth, document.documentElement.clientHeight || window.innerHeight),
  );
  const layout = useMemo(() => buildLensNote(contact, profile, noteKey), [contact, profile, noteKey]);
  const sheetRef = useRef<HTMLElement>(null);
  const renderedKey = useRef(noteKey);
  useLayoutEffect(() => {
    renderedKey.current = noteKey;
  }, [noteKey]);

  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return undefined;
    lensPaperState.overlayMounted = true;

    const matrix = new Float64Array(16);
    const applied = new Float64Array(8);
    let lastFrame = -1;
    let lastUnit = -1;
    let transformUnit = -2;
    let lastOpacity = -1;
    let shown = false;
    let exposed = false;
    let requestedKey = -1;

    /** Interactive: clickable, in the tab order and in the accessibility tree — or none of these. */
    const expose = (next: boolean) => {
      if (next === exposed) return;
      exposed = next;
      el.toggleAttribute('inert', !next);
      el.setAttribute('aria-hidden', next ? 'false' : 'true');
      el.style.pointerEvents = next ? 'auto' : 'none';
      if (!next && el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    };
    el.toggleAttribute('inert', true);

    const hide = () => {
      expose(false);
      if (!shown) return;
      shown = false;
      el.style.visibility = 'hidden';
      el.style.opacity = '0';
      lastOpacity = 0;
    };

    const apply = () => {
      const s = lensPaperState;
      if (s.frame === lastFrame) return;
      lastFrame = s.frame;

      const u = s.restHeight / H;
      if (u > 0 && Math.abs(u - lastUnit) > 0.0004) {
        lastUnit = u;
        el.style.setProperty('--u', u.toFixed(5));
      }

      // A different layout is painted on the sheet: hide until it is rendered here too.
      if (s.noteKey > 0 && s.noteKey !== renderedKey.current) {
        hide();
        if (s.noteKey !== requestedKey) {
          requestedKey = s.noteKey;
          setNoteKey(s.noteKey);
        }
        lastFrame = -1;
        return;
      }

      const opacity = s.visible ? s.textOpacity : 0;
      if (opacity <= 0.004 || lastUnit <= 0) {
        hide();
        return;
      }
      if (!shown) {
        shown = true;
        el.style.visibility = 'visible';
      }
      expose(s.interactive);
      if (Math.abs(opacity - lastOpacity) > 0.002) {
        lastOpacity = opacity;
        el.style.opacity = opacity.toFixed(3);
      }

      // The box size depends on the type scale, so a rescale also needs a new matrix.
      let moved = transformUnit !== lastUnit;
      for (let i = 0; i < 8 && !moved; i += 1) {
        if (Math.abs(applied[i] - s.quad[i]) > 0.01) {
          moved = true;
          break;
        }
      }
      if (!moved) return;
      applied.set(s.quad);
      transformUnit = lastUnit;
      if (!homography(s.quad, W * lastUnit, H * lastUnit, matrix)) return;
      const m = matrix;
      el.style.transform = `matrix3d(${m[0]},${m[1]},0,${m[3]},${m[4]},${m[5]},0,${m[7]},0,0,1,0,${m[12]},${m[13]},0,1)`;
    };

    const off = subscribeLensPaper(apply);
    let raf = 0;
    const loop = () => {
      apply();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      off();
      cancelAnimationFrame(raf);
      lensPaperState.overlayMounted = false;
    };
  }, []);

  const typeFamily = layout.fonts.type;
  const handFamily = layout.fonts.hand;

  return (
    <div className="lens-paper-layer">
      <section
        ref={sheetRef}
        aria-label="Contact details — a note stuck to the lens"
        aria-hidden="true"
        data-fit={`${layout.fit.type}/${layout.fit.hand}`}
        className="lens-paper-sheet"
        style={{ visibility: 'hidden', opacity: 0, pointerEvents: 'none' }}
      >
        <svg className="lens-paper-doodle" viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
          {layout.doodle.map((stroke, i) => (
            <path
              key={i}
              d={stroke.d}
              fill="none"
              stroke={NOTE_INK.pen}
              strokeWidth={stroke.width}
              strokeOpacity={stroke.opacity}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={stroke.dash ? stroke.dash.join(' ') : undefined}
            />
          ))}
        </svg>
        {layout.lines.map((line) => {
          const style = lineStyle(line, line.family === 'type' ? typeFamily : handFamily);
          if (line.href) {
            // A link's second line (a long email broken at the "@") is the same
            // link for the pointer, but neither a second tab stop nor read twice.
            const continuation = line.continuation ? ({ tabIndex: -1, 'aria-hidden': true } as const) : {};
            return (
              <a
                key={line.key}
                className="lens-paper-line lens-paper-link"
                style={style}
                href={line.href}
                aria-label={line.continuation ? undefined : (line.ariaLabel ?? undefined)}
                {...continuation}
                {...(line.external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
              >
                {line.text}
              </a>
            );
          }
          return (
            <span key={line.key} className="lens-paper-line" style={style}>
              {line.text}
            </span>
          );
        })}
      </section>
    </div>
  );
}

export default LensPaperOverlay;
