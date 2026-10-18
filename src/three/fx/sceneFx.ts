/* ==========================================================================
 * Scene FX channel — a mutable singleton shared between world systems.
 *
 * CloudCurtain writes the curtain state and the Scene 10 exposure dissolve;
 * Experience applies `exposure` to the renderer (no-composer path) and to the
 * composer's exposure pass. Any material with `toneMapped: false` must
 * multiply its output by `exposure` itself so the void stays truly empty.
 * Never stored in React state.
 * ========================================================================== */

export interface SceneFxState {
  /** 1 = normal exposure, 0 = black (#040508 void). */
  exposure: number;
  /** Current cloud curtain opacity (0 → 1). */
  curtainOpacity: number;
  /** Current curtain parting (0 = closed across the viewport, 1 = fully parted). */
  curtainPart: number;
}

export const sceneFx: SceneFxState = {
  exposure: 1,
  curtainOpacity: 1,
  curtainPart: 0,
};

export default sceneFx;
