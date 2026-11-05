// Types for the module scripts/build-shelf.mjs generates from Shelf.dc.html.
import type { ComponentChildren } from 'preact';

export type ShelfProps = Record<string, string>;

export interface ShelfLogic {
  props: ShelfProps;
  state: Record<string, unknown>;
  /** Called after every setState; the page uses it to schedule a redraw. */
  onChange: (() => void) | null;
  renderVals(): unknown;
  componentDidMount?(): void;
  componentDidUpdate?(prev: ShelfProps): void;
  componentWillUnmount?(): void;
}

export const Component: new (props: ShelfProps) => ShelfLogic;

export function renderTree(values: unknown): ComponentChildren[];

/** The tweakable props from the design file: time of day, season, weather, plants, time away, wind, boards. */
export const CONTROLS: Record<string, { editor: string; options: string[]; default: string }>;
