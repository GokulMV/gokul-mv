/* ==========================================================================
 * Page scroll — a mutable singleton for the page *around* the 3D track.
 *
 * scrollStore.rawProgress is track-relative (0 → 1 over the 1400vh track)
 * and stays at 1 while the credits / footer section scrolls in after it.
 * This holds the extra page state SmoothScrollProvider measures, so the HUD
 * can step aside for the footer, and how much of the frame the lens paper
 * owns (written by LensPaper), so it can step aside for the contact sheet.
 * Never stored in React state.
 * ========================================================================== */

export interface PageScrollState {
  /** Scroll offset (px) at which the track ends: progress === 1 from here on. */
  trackLimit: number;
  /** Current (smoothed) scroll offset in px. */
  scroll: number;
  /** 0 at the end of the track → 1 once the footer covers half the viewport. */
  footerReveal: number;
  /** True once any part of the footer has scrolled into view. */
  inFooter: boolean;
  /**
   * 0 → 1 as the lens paper arrives on the lens; stays 1 while it is on the
   * lens and after it peels away (until progress drops back before it).
   */
  paperCover: number;
}

export const pageScroll: PageScrollState = {
  trackLimit: 1,
  scroll: 0,
  footerReveal: 0,
  inFooter: false,
  paperCover: 0,
};

export default pageScroll;
