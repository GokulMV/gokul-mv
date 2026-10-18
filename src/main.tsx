import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { scrollStore, type GpuTier } from './store/scrollStore';
import { detectGpuTier } from './utils/gpuTier';
import { adaptiveQuality } from './three/perf/adaptiveQuality';
import './index.css';

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

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

createRoot(container).render(
  <StrictMode>
    <App gpu={gpu} />
  </StrictMode>,
);
