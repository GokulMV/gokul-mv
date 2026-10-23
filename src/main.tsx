import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HoldingPage } from './HoldingPage';
import './index.css';

/**
 * While the portfolio is being rebuilt the site serves a plain holding page
 * and never loads the 3D experience (its chunks are only fetched on demand
 * below). Set to false to bring the experience back.
 */
const HOLDING_PAGE = true;

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

if (HOLDING_PAGE) {
  document.title = 'Gokul MV';
  createRoot(container).render(
    <StrictMode>
      <HoldingPage />
    </StrictMode>,
  );
} else {
  void startExperience(container);
}

async function startExperience(root: HTMLElement): Promise<void> {
  const [{ default: App }, { scrollStore }, { detectGpuTier }, { adaptiveQuality }] = await Promise.all([
    import('./App'),
    import('./store/scrollStore'),
    import('./utils/gpuTier'),
    import('./three/perf/adaptiveQuality'),
  ]);
  type GpuTier = typeof scrollStore.gpuTier;

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);

  const params = new URLSearchParams(window.location.search);
  scrollStore.auditAvailable = params.has('audit');
  scrollStore.auditMode = scrollStore.auditAvailable;

  const detected = detectGpuTier();
  // QA override, audit mode only: `?audit&tier=0..3` forces a quality tier so the
  // composer path can be reviewed on machines without a real GPU.
  const forcedTier = scrollStore.auditMode ? Number(params.get('tier')) : Number.NaN;
  const gpu =
    params.has('tier') && Number.isInteger(forcedTier) && forcedTier >= 0 && forcedTier <= 3
      ? { ...detected, tier: forcedTier as GpuTier }
      : detected;
  scrollStore.gpuTier = gpu.tier;
  adaptiveQuality.init(gpu.tier);

  createRoot(root).render(
    <StrictMode>
      <App gpu={gpu} />
    </StrictMode>,
  );
}
