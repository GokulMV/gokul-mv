import { forwardRef, useImperativeHandle, useLayoutEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { BlendFunction, Effect } from 'postprocessing';
import * as THREE from 'three';
import { PALETTE } from '../world/worldLayout';
import { sceneFx } from './sceneFx';

/* ==========================================================================
 * Exposure fade — the composer-side half of the Scene 10 dissolve.
 *
 * The postprocessing composer disables renderer tone mapping, so
 * `renderer.toneMappingExposure` cannot darken the frame on tier 2+ GPUs.
 * This effect runs LAST in the chain (after tone mapping, grain and
 * vignette) and mixes the display image toward the void colour by
 * `sceneFx.exposure`, so the final frame is exactly #040508.
 * ========================================================================== */

const fragmentShader = /* glsl */ `
uniform float exposure;
uniform vec3 voidColor;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = vec4(mix(voidColor, inputColor.rgb, clamp(exposure, 0.0, 1.0)), inputColor.a);
}
`;

export class ExposureFadeEffect extends Effect {
  constructor() {
    super('ExposureFadeEffect', fragmentShader, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ['exposure', new THREE.Uniform(1)],
        // THREE.Color converts the sRGB hex to linear, matching the effect chain's working space.
        ['voidColor', new THREE.Uniform(new THREE.Color(PALETTE.void))],
      ]),
    });
  }

  set exposure(value: number) {
    (this.uniforms.get('exposure') as THREE.Uniform<number>).value = value;
  }

  get exposure(): number {
    return (this.uniforms.get('exposure') as THREE.Uniform<number>).value;
  }
}

/** Drop-in child of <EffectComposer>; reads sceneFx.exposure every frame. */
export const ExposureFade = forwardRef<ExposureFadeEffect>(function ExposureFade(_, ref) {
  const effect = useMemo(() => new ExposureFadeEffect(), []);
  useImperativeHandle(ref, () => effect, [effect]);
  useLayoutEffect(() => () => effect.dispose(), [effect]);

  useFrame(() => {
    effect.exposure = sceneFx.exposure;
  });

  return <primitive object={effect} dispose={null} />;
});

export default ExposureFade;
