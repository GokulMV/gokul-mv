import { useEffect, useMemo } from 'react';
import { SmoothScrollProvider } from './components/SmoothScrollProvider';
import { SceneHud } from './components/SceneHud';
import { HudControls } from './components/HudControls';
import { TelemetryPanel } from './components/TelemetryPanel';
import { LensPaperOverlay } from './components/LensPaperOverlay';
import { CreditsFooter } from './components/CreditsFooter';
import { Experience } from './three/Experience';
import { scrollStore } from './store/scrollStore';
import { soundEngine } from './utils/soundEngine';
import type { GpuInfo } from './utils/gpuTier';

/**
 * Without the WebGL layer there is no render loop to tick the sound engine
 * (Experience's SoundDriver does it otherwise), so drive it from rAF.
 */
function useFallbackSoundDriver(active: boolean) {
  useEffect(() => {
    if (!active) return undefined;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      soundEngine.updateOnFrame(scrollStore.dampedProgress, scrollStore.velocity, (now - last) / 1000);
      last = now;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active]);
}

function WebGLUnavailable() {
  return (
    <div className="fixed inset-0 z-0 flex items-center justify-center bg-void p-6 text-center">
      <div className="hud-glass max-w-md p-8">
        <p className="hud-kicker mb-3">WebGL unavailable</p>
        <p className="text-sm text-white/70">
          This browser or device cannot create a WebGL context, so the 3D journey is disabled. The story cards still
          follow your scroll, and the contact details are in the credits at the end.
        </p>
      </div>
    </div>
  );
}

export default function App({ gpu }: { gpu: GpuInfo }) {
  const canRender3D = useMemo(() => gpu.tier > 0, [gpu.tier]);
  useFallbackSoundDriver(!canRender3D);

  return (
    <SmoothScrollProvider after={<CreditsFooter />}>
      {canRender3D ? <Experience /> : <WebGLUnavailable />}
      <SceneHud />
      {canRender3D ? <LensPaperOverlay /> : null}
      <HudControls />
      <TelemetryPanel gpu={gpu} />
    </SmoothScrollProvider>
  );
}
