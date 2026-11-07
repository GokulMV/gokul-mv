import { h, render } from 'preact';
import { Component, CONTROLS, renderTree, type ShelfProps } from './shelf/shelf.generated.js';
import './shelf/shelf.generated.css';
import './page.css';

/**
 * The site is one room: the bookshelf, 1400 × 1000, seen through a camera that fits the screen.
 * - A wide screen sees the whole room; the wall and its light carry on to the edges.
 * - A narrow (portrait) screen zooms in on the shelf and can be dragged sideways to look around
 *   the room; anything taken off the shelf comes up in a one-column shape, and the camera
 *   moves in on it.
 * Time of day, season and weather follow the visitor's clock. Add ?debug to get a bar
 * that sets them by hand (and the other tweaks: plants, time away, wind, boards),
 * e.g. /?debug&mood=night&season=winter&weather=snow.
 */
const ROOM_W = 1400;
const ROOM_H = 1000;
/** The shelf column (room x 360…1040) that a narrow screen keeps in view. */
const FOCUS_W = 680;
const FOCUS_X = 700;

const params = new URLSearchParams(location.search);
const props: ShelfProps = {};
for (const [key, spec] of Object.entries(CONTROLS)) props[key] = params.get(key) ?? spec.default;
// On the site the wall and its light carry on past the room to the edges of the screen.
props.bleed = 'yes';

const stageEl = document.getElementById('stage');
const roomEl = document.getElementById('room');
if (!stageEl || !roomEl) throw new Error('index.html needs #stage and #room');
const stage: HTMLElement = stageEl;
const room: HTMLElement = roomEl;

const logic = new Component({ ...props });

/**
 * How far past each edge of the room the wall and its light are drawn. The design draws them
 * 1400px out on every side; only what the screen can actually see is kept (plus a margin), so
 * the browser never has to paint, blend and hold a 4200 × 3000 picture to move or zoom it.
 */
const BLEED_X = 1400;
const BLEED_Y = 1000;
const bleed = { l: BLEED_X, r: BLEED_X, t: BLEED_Y, b: BLEED_Y };

let queued = false;
function draw(): void {
  queued = false;
  const { l, r, t, b } = bleed;
  render(
    h('div', { style: `position:absolute;left:${-l}px;top:${-t}px;width:${ROOM_W + l + r}px;height:${ROOM_H + t + b}px;overflow:hidden` },
      h('div', { style: `position:absolute;left:${l}px;top:${t}px;width:${ROOM_W}px;height:${ROOM_H}px` }, ...renderTree(logic.renderVals()))),
    room,
  );
}
logic.onChange = () => {
  if (queued) return;
  queued = true;
  queueMicrotask(draw);
};

function setProp(key: string, value: string): void {
  if (props[key] === value) return;
  const prev = { ...logic.props };
  props[key] = value;
  logic.props = { ...props };
  logic.componentDidUpdate?.(prev);
  logic.onChange?.();
}

// ---------- the camera ----------
/** cx, cy: the room point at the centre of the screen; s: room px → screen px. */
const cam = { cx: ROOM_W / 2, cy: ROOM_H / 2, s: 1 };
let narrow = false;
let base = 1;
let lookX = FOCUS_X;
let focused: Element | null = null;

function screen(): { w: number; h: number } {
  return { w: stage.clientWidth || window.innerWidth, h: stage.clientHeight || window.innerHeight };
}

/** The part of the room (and past it) a camera shows, in room coordinates. */
function seen(c: { cx: number; cy: number; s: number }): { x0: number; y0: number; x1: number; y1: number } {
  const { w, h: hh } = screen();
  return { x0: c.cx - w / (2 * c.s), x1: c.cx + w / (2 * c.s), y0: c.cy - hh / (2 * c.s), y1: c.cy + hh / (2 * c.s) };
}

/** Keep enough wall past the edges for every view in `views`; re-render only when that changes. */
function trimBleed(...views: Array<{ cx: number; cy: number; s: number }>): void {
  const pad = 32;
  const next = { l: 0, r: 0, t: 0, b: 0 };
  for (const c of views) {
    const v = seen(c);
    next.l = Math.max(next.l, -v.x0);
    next.r = Math.max(next.r, v.x1 - ROOM_W);
    next.t = Math.max(next.t, -v.y0);
    next.b = Math.max(next.b, v.y1 - ROOM_H);
  }
  const fitTo = (n: number, max: number): number => Math.min(max, Math.ceil(Math.max(0, n) + pad));
  next.l = fitTo(next.l, BLEED_X);
  next.r = fitTo(next.r, BLEED_X);
  next.t = fitTo(next.t, BLEED_Y);
  next.b = fitTo(next.b, BLEED_Y);
  if (next.l === bleed.l && next.r === bleed.r && next.t === bleed.t && next.b === bleed.b) return;
  Object.assign(bleed, next);
  logic.onChange?.();
}

let settle = 0;
function apply(glide: boolean): void {
  const { w, h: hh } = screen();
  room.classList.toggle('glide', glide);
  // While the camera eases in or out the room moves as one finished picture; it is redrawn
  // sharp at the new size once it lands.
  clearTimeout(settle);
  if (glide) {
    room.classList.add('moving');
    settle = window.setTimeout(() => room.classList.remove('moving'), 600);
  } else if (!drag) {
    room.classList.remove('moving');
  }
  room.style.transform = `translate(${(w / 2 - cam.cx * cam.s).toFixed(2)}px, ${(hh / 2 - cam.cy * cam.s).toFixed(2)}px) scale(${cam.s.toFixed(4)})`;
}

function clampLook(x: number): number {
  const half = screen().w / (2 * base);
  return half >= ROOM_W / 2 ? ROOM_W / 2 : Math.min(ROOM_W - half, Math.max(half, x));
}

/** Where a dialog sits in room coordinates, untouched by its own entrance animation. */
function boxOf(el: HTMLElement): { x: number; y: number; w: number; h: number } {
  let x = 0;
  let y = 0;
  let n: HTMLElement | null = el;
  while (n && n !== room) {
    x += n.offsetLeft;
    y += n.offsetTop;
    n = n.offsetParent as HTMLElement | null;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

function fit(glide = false): void {
  const bar = document.getElementById('debug-bar');
  document.documentElement.style.setProperty('--bar', `${bar ? bar.offsetHeight : 0}px`);
  const { w, h: hh } = screen();
  const whole = Math.min(w / ROOM_W, hh / ROOM_H);
  const wasNarrow = narrow;
  narrow = w / hh < 1.2;
  // A small landscape phone keeps the whole room but still gets the one-column dialogs.
  setProp('compact', narrow || hh < 520 ? 'yes' : 'no');
  base = narrow ? Math.max(whole, Math.min(hh / ROOM_H, w / FOCUS_W)) : whole;
  if (narrow && !wasNarrow) lookX = FOCUS_X;
  lookX = clampLook(lookX);
  document.documentElement.dataset.view = narrow ? 'narrow' : 'wide';

  const from = { ...cam };
  const dialog = room.querySelector<HTMLElement>('[role="dialog"]');
  focused = dialog;
  if (dialog && (narrow || hh < 520)) {
    // Move in on what was taken down, with room for the "put it back" scribble above it.
    const b = boxOf(dialog);
    const top = b.y - 60;
    const bh = b.h + 70;
    cam.s = Math.max(whole, Math.min(1.6, (w * 0.94) / b.w, (hh * 0.94) / bh));
    cam.cx = b.x + b.w / 2;
    cam.cy = top + bh / 2;
  } else {
    cam.s = base;
    cam.cx = narrow ? lookX : ROOM_W / 2;
    // A tall screen sees more height than the room has: keep the ceiling at the top and let the
    // floor take the rest, so the lamp stands on something.
    cam.cy = Math.max(ROOM_H / 2, hh / (2 * cam.s));
  }
  // During a glide both ends of it are on screen at some point.
  if (glide) trimBleed(from, cam); else trimBleed(cam);
  apply(glide);
}

// Focusing something near an edge can scroll even a clipped box; the camera does the moving here.
stage.addEventListener('scroll', () => { stage.scrollTop = 0; stage.scrollLeft = 0; });

// Follow dialogs as they open and close.
let refit = 0;
new MutationObserver(() => {
  if (refit) return;
  refit = requestAnimationFrame(() => {
    refit = 0;
    const dialog = room.querySelector('[role="dialog"]');
    if (dialog !== focused) fit(true);
  });
}).observe(room, { childList: true, subtree: true });

// ---------- looking around on a narrow screen: drag the wall, or scroll sideways ----------
let drag: { id: number; x: number; from: number; moved: boolean } | null = null;
function canLook(): boolean {
  if (!narrow || focused) return false;
  const st = (logic as unknown as { state?: Record<string, unknown> }).state || {};
  // Holding the watering can or a lit match: the finger is busy.
  return (st.canMode ?? 'home') === 'home' && st.fire !== 'held';
}
stage.addEventListener('pointerdown', (e) => {
  if (!canLook() || drag) return;
  const t = e.target as Element | null;
  if (t && t.closest('button, a, input, textarea, select, label, [role="dialog"]')) return;
  drag = { id: e.pointerId, x: e.clientX, from: lookX, moved: false };
});
window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x;
  if (!drag.moved && Math.abs(dx) < 6) return;
  if (!drag.moved) { hideHint(); room.classList.add('moving'); }
  drag.moved = true;
  lookX = clampLook(drag.from - dx / base);
  cam.cx = lookX;
  frame();
});
const endDrag = (e: PointerEvent): void => {
  if (!drag || e.pointerId !== drag.id) return;
  drag = null;
  room.classList.remove('moving');
};
// One transform per frame however fast the finger moves.
let framed = 0;
function frame(): void {
  if (framed) return;
  framed = requestAnimationFrame(() => { framed = 0; apply(false); });
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);
stage.addEventListener('wheel', (e) => {
  // ctrl + wheel is the browser's own zoom (and a trackpad pinch): leave it alone.
  if (!canLook() || e.ctrlKey) return;
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (!d) return;
  e.preventDefault();
  hideHint();
  lookX = clampLook(lookX + d / base);
  cam.cx = lookX;
  frame();
}, { passive: false });

// A one-time nudge that the room carries on past the edges.
let hint: HTMLElement | null = null;
function showHint(): void {
  if (!narrow || hint) return;
  hint = document.createElement('div');
  hint.id = 'look-hint';
  hint.setAttribute('aria-hidden', 'true');
  hint.textContent = '← drag to look around the room →';
  document.body.appendChild(hint);
  setTimeout(hideHint, 6500);
}
function hideHint(): void {
  if (!hint) return;
  const el = hint;
  el.classList.add('gone');
  setTimeout(() => el.remove(), 600);
}

// Focus rings are for the keyboard: hide them after a click or tap, show them again on Tab.
document.addEventListener('pointerdown', () => { document.documentElement.dataset.input = 'pointer'; }, true);
document.addEventListener('keydown', () => { document.documentElement.dataset.input = 'keyboard'; }, true);

if (params.has('debug')) {
  buildDebugBar();
  // A handle for poking at the room from the console (and for the browser tests).
  (window as unknown as { shelf: typeof logic }).shelf = logic;
}

// Size the camera before the first frame so the room never flashes at the wrong scale.
const w0 = screen();
narrow = w0.w / w0.h < 1.2;
props.compact = narrow || w0.h < 520 ? 'yes' : 'no';
logic.props = { ...props };
draw();
logic.componentDidMount?.();
narrow = false;
fit();
showHint();

// Refit in the same frame as the resize (the browser zooming the page is a resize too), so no
// frame is ever drawn with the old size. A pinch-zoom only moves the visual viewport over the
// page and needs nothing.
window.addEventListener('resize', () => fit());

function buildDebugBar(): void {
  const bar = document.createElement('div');
  bar.id = 'debug-bar';
  for (const [key, spec] of Object.entries(CONTROLS)) {
    if (key === 'bleed' || key === 'compact') continue;
    const label = document.createElement('label');
    label.textContent = `${key} `;
    const select = document.createElement('select');
    for (const option of spec.options) {
      const el = document.createElement('option');
      el.value = option;
      el.textContent = option;
      el.selected = option === props[key];
      select.appendChild(el);
    }
    select.onchange = () => {
      setProp(key, select.value);
      const q = new URLSearchParams({ debug: '', ...props });
      q.delete('bleed');
      q.delete('compact');
      history.replaceState(null, '', `?${q.toString()}`);
    };
    label.appendChild(select);
    bar.appendChild(label);
  }
  const reset = document.createElement('button');
  reset.textContent = 'Forget my visit (plants, cobwebs, notes)';
  reset.onclick = () => {
    for (const k of ['gmv-shelf-plants-v1', 'gmv-shelf-visit-v1', 'gmv-shelf-notes-v1']) {
      try { localStorage.removeItem(k); } catch { /* storage unavailable */ }
    }
    location.reload();
  };
  bar.appendChild(reset);
  document.body.prepend(bar);
}
