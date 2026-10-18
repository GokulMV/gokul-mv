import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { scrollStore, smoothstep } from '../../store/scrollStore';
import { sceneFx } from '../fx/sceneFx';
import { createTileableNoiseTexture } from '../shaders/HorizonPeakShader';
import { createSkyMaterial, skyQualityFor } from '../shaders/SkyShader';
import { SKY_DOME_RADIUS } from './worldLayout';

/* ==========================================================================
 * Procedural twilight sky dome (no network assets).
 *
 * A BackSide sphere of radius SKY_DOME_RADIUS re-centred on the camera every
 * frame; it renders first (renderOrder -1), writes no depth and ignores fog.
 * Warmth and star visibility follow the journey: the low sun's glow deepens
 * toward the summit and the first stars come out as the story ends. Every
 * value is damped in useFrame — nothing here touches React state.
 * ========================================================================== */

const { damp } = THREE.MathUtils;

/** Sky warmth: golden hour deepens as the climb nears the summit. */
function warmthAt(progress: number): number {
  return 0.82 + 0.18 * smoothstep(0.6, 0.88, progress);
}

/** Star visibility: faint all along, brighter for the ending. */
function starsAt(progress: number): number {
  return 0.55 + 0.45 * smoothstep(0.86, 0.96, progress);
}

export function SkyDome(): JSX.Element {
  const tier = scrollStore.gpuTier;
  const quality = skyQualityFor(tier);
  const mesh = useRef<THREE.Mesh>(null);

  const resources = useMemo(() => {
    const widthSegments = tier >= 2 ? 64 : 40;
    const heightSegments = tier >= 2 ? 32 : 20;
    const geometry = new THREE.SphereGeometry(SKY_DOME_RADIUS, widthSegments, heightSegments);
    const noise = createTileableNoiseTexture(128, 8, 0x5a17c0de);
    const material = createSkyMaterial(noise, quality);
    return { geometry, noise, material };
  }, [tier, quality]);

  useLayoutEffect(
    () => () => {
      resources.geometry.dispose();
      resources.material.dispose();
      resources.noise.dispose();
    },
    [resources],
  );

  const state = useRef({ initialised: false });

  useFrame(({ camera, scene }, delta) => {
    const m = mesh.current;
    if (!m) return;
    // Re-centred on the camera; the renderer's matrix update picks this up before drawing.
    m.position.copy(camera.position);

    const u = resources.material.uniforms;
    // Below the horizon the dome meets fully fogged terrain: follow the scene fog colour.
    const fog = scene.fog;
    if (fog instanceof THREE.Fog || fog instanceof THREE.FogExp2) u.uFog.value.copy(fog.color);
    const p = scrollStore.dampedProgress;
    const s = state.current;
    if (!s.initialised) {
      u.uWarmth.value = warmthAt(p);
      u.uStars.value = starsAt(p);
      s.initialised = true;
    }
    u.uTime.value = scrollStore.elapsed;
    u.uWarmth.value = damp(u.uWarmth.value, warmthAt(p), 1.5, delta);
    u.uStars.value = damp(u.uStars.value, starsAt(p), 1.5, delta);
    // Scene 10 void: nothing left to draw.
    m.visible = sceneFx.exposure > 0.002;
  });

  return (
    <mesh
      ref={mesh}
      name="sky-dome"
      geometry={resources.geometry}
      material={resources.material}
      renderOrder={-1}
      frustumCulled={false}
    />
  );
}

export default SkyDome;
