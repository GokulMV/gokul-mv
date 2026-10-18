import { useEffect, useMemo } from 'react';
import { SmoothScrollProvider } from './components/SmoothScrollProvider';
import { SceneHud } from './components/SceneHud';
import { HudControls } from './components/HudControls';
import { TelemetryPanel } from './components/TelemetryPanel';
import { Experience } from './three/Experience';
import { altitudeAt } from './three/protagonistPath';
import { scrollStore } from './store/scrollStore';
import { soundEngine } from './utils/soundEngine';
import type { GpuInfo } from './utils/gpuTier';

function useSoundDirector() {
  useEffect(() => {
    const offGear = scrollStore.onGearChange((next, prev) => {
      if (next > prev) soundEngine.playGearLock(next - 1);
      else soundEngine.playGearDrop();
    });
    const offScene = scrollStore.onSceneChange((next, prev) => {
      if (next === 8 && prev < 8) soundEngine.playPaperFlutter(0.5);
      if (next === 9 && prev < 9) soundEngine.playPaperFlutter(1);
    });
    let raf = 0;
    const loop = () => {
      soundEngine.setAltitude(altitudeAt(scrollStore.dampedProgress));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      offGear();
      offScene();
      cancelAnimationFrame(raf);
    };
  }, []);
}

function WebGLUnavailable() {
  return (
    <div className="fixed inset-0 z-0 flex items-center justify-center bg-void p-6 text-center">
      <div className="hud-glass max-w-md p-8">
        <p className="hud-kicker mb-3">WebGL unavailable</p>
        <p className="text-sm text-white/70">
          This browser or device cannot create a WebGL context, so the 3D journey is disabled. The story cards below
          still follow your scroll.
        </p>
      </div>
    </div>
  );
}

export default function App({ gpu }: { gpu: GpuInfo }) {
  useSoundDirector();
  const canRender3D = useMemo(() => gpu.tier > 0, [gpu.tier]);

  return (
    <SmoothScrollProvider>
      {canRender3D ? <Experience /> : <WebGLUnavailable />}
      <SceneHud />
      <HudControls />
      <TelemetryPanel gpu={gpu} />
    </SmoothScrollProvider>
  );
}
