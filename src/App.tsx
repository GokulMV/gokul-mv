import { useEffect, useMemo } from 'react';
import { SmoothScrollProvider } from './components/SmoothScrollProvider';
import { SceneHud } from './components/SceneHud';
import { HudControls } from './components/HudControls';
import { TelemetryPanel } from './components/TelemetryPanel';
import { LensPaperOverlay } from './components/LensPaperOverlay';
import { CreditsFooter } from './components/CreditsFooter';
import { Experience } from './three/Experience';
import { altitudeAt } from './three/protagonistPath';
import { ENDING } from './three/world/worldLayout';
import { scrollStore } from './store/scrollStore';
import { soundEngine } from './utils/soundEngine';
import type { GpuInfo } from './utils/gpuTier';

function useSoundDirector() {
  useEffect(() => {
    const offGear = scrollStore.onGearChange((next, prev) => {
      if (next > prev) soundEngine.playGearLock(next - 1);
      else soundEngine.playGearDrop();
    });
    // Ending cues fire on forward threshold crossings of the ENDING timeline:
    // the gust tearing the paper out of the pack, and the wind peeling it off
    // the lens. A cue re-arms only after scrolling back past its threshold by
    // HYSTERESIS, so scrubbing around a threshold never spams it.
    const HYSTERESIS = 0.004;
    let gustArmed = scrollStore.dampedProgress < ENDING.paperGustStart;
    let peelArmed = scrollStore.dampedProgress < ENDING.paperHoldEnd;
    let raf = 0;
    const loop = () => {
      const p = scrollStore.dampedProgress;
      soundEngine.setAltitude(altitudeAt(p));
      if (gustArmed && p >= ENDING.paperGustStart) {
        gustArmed = false;
        soundEngine.playPaperFlutter(0.6);
      } else if (!gustArmed && p < ENDING.paperGustStart - HYSTERESIS) {
        gustArmed = true;
      }
      if (peelArmed && p >= ENDING.paperHoldEnd) {
        peelArmed = false;
        soundEngine.playPaperFlutter(1);
      } else if (!peelArmed && p < ENDING.paperHoldEnd - HYSTERESIS) {
        peelArmed = true;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      offGear();
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
          This browser or device cannot create a WebGL context, so the 3D journey is disabled. The story cards still
          follow your scroll, and the contact details are in the credits at the end.
        </p>
      </div>
    </div>
  );
}

export default function App({ gpu }: { gpu: GpuInfo }) {
  useSoundDirector();
  const canRender3D = useMemo(() => gpu.tier > 0, [gpu.tier]);

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
