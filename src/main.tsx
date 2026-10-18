import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { scrollStore } from './store/scrollStore';
import { detectGpuTier } from './utils/gpuTier';
import { adaptiveQuality } from './three/perf/adaptiveQuality';
import './index.css';

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
window.scrollTo(0, 0);

const gpu = detectGpuTier();
scrollStore.gpuTier = gpu.tier;
adaptiveQuality.init(gpu.tier);
scrollStore.auditMode = new URLSearchParams(window.location.search).has('audit');

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

createRoot(container).render(
  <StrictMode>
    <App gpu={gpu} />
  </StrictMode>,
);
