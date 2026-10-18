import type { GpuTier } from '../store/scrollStore';

export interface GpuInfo {
  tier: GpuTier;
  renderer: string;
  vendor: string;
  webgl2: boolean;
  maxTextureSize: number;
  isMobile: boolean;
}

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen/i;
const LOW_END = /mali-[2-4]\d\d|mali-t[6-7]\d\d|adreno \(tm\) [2-5]\d\d|powervr|sgx|intel\(r\) hd graphics [2-5]\d{2,3}|intel hd graphics [2-5]\d{2,3}|gma/i;
const HIGH_END = /rtx|gtx 1[06-9]\d0|gtx 16\d0|radeon rx [5-7]\d{3}|radeon pro|apple m[1-9]|apple gpu|adreno \(tm\) (7[3-9]\d|8\d\d)|mali-g7[1-9]|mali-g[89]\d|immortalis|arc a\d/i;

/**
 * Heuristic GPU tiering without third-party benchmarks:
 *   0 — no WebGL; 1 — software / low-end; 2 — mainstream; 3 — high-end.
 */
export function detectGpuTier(): GpuInfo {
  const fallback: GpuInfo = {
    tier: 0,
    renderer: 'unavailable',
    vendor: 'unavailable',
    webgl2: false,
    maxTextureSize: 0,
    isMobile: false,
  };
  if (typeof document === 'undefined') return fallback;

  const isMobile =
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

  const canvas = document.createElement('canvas');
  const gl2 = canvas.getContext('webgl2', { powerPreference: 'high-performance' });
  const gl = (gl2 ?? canvas.getContext('webgl')) as WebGLRenderingContext | WebGL2RenderingContext | null;
  if (!gl) return { ...fallback, isMobile };

  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  const vendor = String(debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
  const maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0;
  gl.getExtension('WEBGL_lose_context')?.loseContext();

  const cores = navigator.hardwareConcurrency || 4;
  let tier: GpuTier = 2;
  if (SOFTWARE.test(renderer)) tier = 1;
  else if (LOW_END.test(renderer) || maxTextureSize < 4096) tier = 1;
  else if (HIGH_END.test(renderer) && cores >= 6) tier = 3;
  else if (isMobile && cores < 6) tier = 1;
  if (!gl2 && tier > 1) tier = 1;

  return { tier, renderer, vendor, webgl2: Boolean(gl2), maxTextureSize, isMobile };
}
