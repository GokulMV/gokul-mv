import { Suspense, useEffect, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { AdaptiveDpr, Preload } from '@react-three/drei';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import { scrollStore, smoothstep } from '../store/scrollStore';
import { Phase0World } from './Phase0World';

function Effects() {
  if (scrollStore.gpuTier < 2) return null;
  return (
    <EffectComposer multisampling={scrollStore.gpuTier >= 3 ? 4 : 0} enableNormalPass={false}>
      <Bloom mipmapBlur intensity={0.55} luminanceThreshold={0.82} luminanceSmoothing={0.2} />
      <Vignette eskil={false} offset={0.22} darkness={0.78} />
    </EffectComposer>
  );
}

/**
 * Scene 10 end state: whatever remains of the world dissolves into the
 * minimal #040508 canvas. Driven from rAF, never from React state.
 */
function VoidFade() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    let opacity = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const delta = Math.min(0.1, (now - last) / 1000);
      last = now;
      opacity = THREE.MathUtils.damp(opacity, smoothstep(0.984, 0.999, scrollStore.dampedProgress), 6, delta);
      if (ref.current) {
        ref.current.style.opacity = opacity.toFixed(3);
        ref.current.style.visibility = opacity > 0.002 ? 'visible' : 'hidden';
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <div ref={ref} className="absolute inset-0 bg-void" style={{ opacity: 0, visibility: 'hidden' }} />;
}

/** Fixed full-screen WebGL layer. Mounted once; never re-renders on scroll. */
export function Experience() {
  const tier = scrollStore.gpuTier;
  const dpr: [number, number] = tier >= 3 ? [1, 2] : tier === 2 ? [1, 1.5] : [0.75, 1];

  return (
    <div className="webgl-layer" aria-hidden="true">
      <Canvas
        dpr={dpr}
        shadows={tier >= 2}
        camera={{ fov: 42, near: 0.1, far: 800, position: [0, 7, 24] }}
        gl={{
          antialias: tier >= 2,
          alpha: false,
          powerPreference: 'high-performance',
          stencil: false,
          depth: true,
        }}
        onCreated={({ gl }) => {
          gl.setClearColor('#040508');
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.05;
          gl.outputColorSpace = THREE.SRGBColorSpace;
        }}
      >
        <Suspense fallback={null}>
          <Phase0World />
          <Effects />
          <Preload all />
        </Suspense>
        <AdaptiveDpr pixelated={false} />
      </Canvas>
      <VoidFade />
    </div>
  );
}

export default Experience;
