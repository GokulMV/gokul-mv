import { Suspense, useEffect, useLayoutEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { AdaptiveDpr, Preload } from '@react-three/drei';
import { Bloom, EffectComposer, Noise, ToneMapping, Vignette } from '@react-three/postprocessing';
import { BlendFunction, ToneMappingMode } from 'postprocessing';
import * as THREE from 'three';
import { scrollStore, smoothstep } from '../store/scrollStore';
import { soundEngine } from '../utils/soundEngine';
import { CameraRig } from './camera/CameraRig';
import { Protagonist } from './character/Protagonist';
import { ExposureFade } from './fx/ExposureFade';
import { sceneFx } from './fx/sceneFx';
import { CloudCurtain } from './world/CloudCurtain';
import { LensPaper } from './world/LensPaper';
import { MountainEnvironment } from './world/MountainEnvironment';
import { ProjectBeacons } from './world/ProjectBeacons';
import { SkyDome } from './world/SkyDome';
import { WorldLighting } from './world/WorldLighting';
import { CAMERA_CLIP, ENDING, FOG, PALETTE } from './world/worldLayout';

/* ==========================================================================
 * Experience — the fixed full-screen WebGL layer (Phase 1 world).
 *
 * Mounted once; nothing here re-renders on scroll. Every system reads the
 * mutable singletons (scrollStore, sceneFx, adaptiveQuality) in useFrame.
 *
 * Exposure / Scene 10 dissolve:
 *  - tier >= 2 (composer): postprocessing forces renderer tone mapping off,
 *    so ACES runs as a ToneMapping effect and ExposureFade (LAST in the
 *    chain) mixes the display image to #040508 by sceneFx.exposure.
 *  - tier < 2 (no composer): the renderer's ACES tone mapping is scaled by
 *    sceneFx.exposure here.
 *  - VoidFade is a DOM safety net for fogged materials on the no-composer
 *    path; it only starts after the lens paper has finished peeling.
 * ========================================================================== */

const BASE_EXPOSURE = 1.0;

/** Final-void background + linear fog shared by every fogged material. */
function SceneAtmosphere() {
  const scene = useThree((state) => state.scene);
  useLayoutEffect(() => {
    const background = new THREE.Color(PALETTE.void);
    const fog = new THREE.Fog(PALETTE.fog, FOG.near, FOG.far);
    scene.background = background;
    scene.fog = fog;
    return () => {
      if (scene.background === background) scene.background = null;
      if (scene.fog === fog) scene.fog = null;
    };
  }, [scene]);
  return null;
}

/** No-composer path: scale the renderer's tone-mapping exposure by sceneFx.exposure. */
function RendererExposure() {
  const gl = useThree((state) => state.gl);
  useFrame(() => {
    gl.toneMappingExposure = BASE_EXPOSURE * sceneFx.exposure;
  });
  return null;
}

/** Drives the sound engine from the render loop: beds, pad warmth and scroll-threshold foley. */
function SoundDriver() {
  useFrame((_state, delta) => {
    soundEngine.updateOnFrame(scrollStore.dampedProgress, scrollStore.velocity, delta);
  });
  return null;
}

function Effects() {
  const tier = scrollStore.gpuTier;
  return (
    <EffectComposer multisampling={tier >= 3 ? 4 : 0} enableNormalPass={false}>
      <Bloom mipmapBlur intensity={0.55} luminanceThreshold={0.82} luminanceSmoothing={0.2} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={0.12} />
      <Vignette eskil={false} offset={0.22} darkness={0.72} />
      <ExposureFade />
    </EffectComposer>
  );
}

/**
 * DOM safety net for the end state: once the paper has peeled away, anything
 * left of the world settles into the minimal #040508 canvas. rAF-driven.
 */
function VoidFade() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    let opacity = 0;
    let written = -1;
    let last = performance.now();
    const loop = (now: number) => {
      const delta = Math.min(0.1, (now - last) / 1000);
      last = now;
      const target = smoothstep(ENDING.paperPeelEnd, ENDING.footerAfter, scrollStore.dampedProgress);
      opacity = THREE.MathUtils.damp(opacity, target, 6, delta);
      const el = ref.current;
      if (el && Math.abs(opacity - written) > 0.002) {
        written = opacity;
        el.style.opacity = opacity.toFixed(3);
        el.style.visibility = opacity > 0.002 ? 'visible' : 'hidden';
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
  const composer = tier >= 2;
  const dpr: [number, number] = tier >= 3 ? [1, 2] : tier === 2 ? [1, 1.5] : [0.75, 1];

  return (
    <div className="webgl-layer" aria-hidden="true">
      <Canvas
        dpr={dpr}
        flat={composer}
        shadows={tier >= 2}
        camera={{ fov: CAMERA_CLIP.fov, near: CAMERA_CLIP.near, far: CAMERA_CLIP.far, position: [0, 3, 24] }}
        gl={{
          antialias: tier >= 2 && !composer,
          alpha: false,
          powerPreference: 'high-performance',
          stencil: false,
          depth: true,
        }}
        onCreated={({ gl }) => {
          gl.setClearColor(PALETTE.void);
          gl.outputColorSpace = THREE.SRGBColorSpace;
          if (!composer) {
            gl.toneMapping = THREE.ACESFilmicToneMapping;
            gl.toneMappingExposure = BASE_EXPOSURE;
          }
        }}
      >
        <SceneAtmosphere />
        <SoundDriver />
        {composer ? null : <RendererExposure />}
        <CameraRig />
        <Suspense fallback={null}>
          <SkyDome />
          <WorldLighting />
          <MountainEnvironment />
          {/* The climber: opaque / alpha-tested meshes drawn with the world, hair's soft pass at renderOrder 1;
              the cloud curtain (900, depthTest off) and the lens paper (999/1000) composite over it. */}
          <Protagonist />
          <ProjectBeacons />
          <CloudCurtain />
          <LensPaper />
          {composer ? <Effects /> : null}
          <Preload all />
        </Suspense>
        <AdaptiveDpr pixelated={false} />
      </Canvas>
      <VoidFade />
    </div>
  );
}

export default Experience;
