import { h, render } from 'preact';
import { Component, CONTROLS, renderTree, type ShelfProps } from './shelf/shelf.generated.js';
import './shelf/shelf.generated.css';
import './page.css';

/**
 * The site is one room: the bookshelf, 1400 × 1000, scaled to fit the window.
 * Time of day, season and weather follow the visitor's clock. Add ?debug to get a bar
 * that sets them by hand (and the other tweaks: plants, time away, wind, boards),
 * e.g. /?debug&mood=night&season=winter&weather=snow.
 */
const ROOM_W = 1400;
const ROOM_H = 1000;

const params = new URLSearchParams(location.search);
const props: ShelfProps = {};
for (const [key, spec] of Object.entries(CONTROLS)) props[key] = params.get(key) ?? spec.default;

const stage = document.getElementById('stage');
const room = document.getElementById('room');
if (!stage || !room) throw new Error('index.html needs #stage and #room');

const logic = new Component({ ...props });
let queued = false;
function draw(): void {
  queued = false;
  render(h('div', { style: `width:${ROOM_W}px;height:${ROOM_H}px` }, ...renderTree(logic.renderVals())), room as HTMLElement);
}
logic.onChange = () => {
  if (queued) return;
  queued = true;
  queueMicrotask(draw);
};
draw();
logic.componentDidMount?.();

function fit(): void {
  const bar = document.getElementById('debug-bar');
  const free = window.innerHeight - (bar ? bar.offsetHeight : 0);
  const scale = Math.min(window.innerWidth / ROOM_W, free / ROOM_H);
  (room as HTMLElement).style.transform = `scale(${scale})`;
  (stage as HTMLElement).style.width = `${ROOM_W * scale}px`;
  (stage as HTMLElement).style.height = `${ROOM_H * scale}px`;
}

if (params.has('debug')) {
  buildDebugBar();
  // A handle for poking at the room from the console (and for the browser tests).
  (window as unknown as { shelf: typeof logic }).shelf = logic;
}
window.addEventListener('resize', fit);
fit();

function buildDebugBar(): void {
  const bar = document.createElement('div');
  bar.id = 'debug-bar';
  for (const [key, spec] of Object.entries(CONTROLS)) {
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
      const prev = { ...logic.props };
      props[key] = select.value;
      logic.props = { ...props };
      const q = new URLSearchParams({ debug: '', ...props });
      history.replaceState(null, '', `?${q.toString()}`);
      logic.componentDidUpdate?.(prev);
      logic.onChange?.();
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
