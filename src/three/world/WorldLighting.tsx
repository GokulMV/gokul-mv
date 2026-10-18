import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { scrollStore, smoothstep } from '../../store/scrollStore';
import { protagonistPositionAt } from '../protagonistPath';
import { keyBakeWeightAt, keyDirectionAt, keyLight } from './keyLight';
import { PALETTE, SUN_DIRECTION } from './worldLayout';

/* ==========================================================================
 * World lighting — golden-hour sun, sky/ground hemisphere, a cool low fill
 * and a procedural (PMREM) sky environment for PBR reflections.
 *
 * The sun light is the key light (keyLight.ts): SUN_DIRECTION swung toward
 * the south during the climb so the faces the camera sees are raked by it;
 * keyLight.direction is written here every frame and shared by the rock
 * material. The sky, horizon, clouds and chasm effects keep SUN_DIRECTION.
 *
 * The sun's shadow camera follows the region the camera is looking at: every
 * frame the light and its target are re-centred on a focus point ahead of the
 * camera (distance and box size adapt to how far the camera is from the climb
 * route), and the centre is snapped to the shadow-map texel grid in light
 * space so static geometry never shimmers. Nothing here touches React state.
 * ========================================================================== */

const { damp } = THREE.MathUtils;

/** Distance from the focus point back to the sun light (along the key direction). */
const SUN_DISTANCE = 150;
const SUN_INTENSITY = 5.0;
const HEMI_INTENSITY = 3.2;
const FILL_INTENSITY = 1.1;
const ENV_INTENSITY = 1.0;
/** Key-light colour: a warm golden-hour white (PALETTE.sun stays the sky's sun disc). */
const SUN_COLOR = '#FFE0BE';

/** Cool fill: sky bounce from high on the side opposite the key (reveals form instead of flattening it). */
const FILL_COLOR = '#9FB2D0';
/** Sky half of the hemisphere light: a soft sky blue, so shade is cool but granite stays grey. */
const HEMI_SKY = new THREE.Color('#B4C0D2');
/** Ground half: warm bounce off sunlit rock and snow. */
const HEMI_GROUND = new THREE.Color('#5E5148');
const KEY_START = keyDirectionAt(0, new THREE.Vector3());
/** Fill: a high sky bounce from the side opposite the key (written into `out`, no allocation). */
function fillDirectionFor(key: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.set(-key.x, 0.75, -key.z).normalize();
}
const SUN_START = KEY_START.clone().multiplyScalar(SUN_DISTANCE);
const FILL_START = fillDirectionFor(KEY_START, new THREE.Vector3()).multiplyScalar(SUN_DISTANCE);

/** Route samples used to judge how far the camera is from the action. */
const ROUTE_SAMPLES: readonly THREE.Vector3[] = Array.from({ length: 64 }, (_, i) =>
  protagonistPositionAt(0.26 + (0.54 * i) / 63, new THREE.Vector3()),
);

const UP = new THREE.Vector3(0, 1, 0);

const ENV_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize( position );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const ENV_FRAGMENT = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uSun;
uniform vec3 uGround;
uniform vec3 uSunDir;
varying vec3 vDir;
void main() {
  vec3 d = normalize( vDir );
  float e = d.y;
  vec3 sky = mix( uHorizon, uMid, smoothstep( 0.0, 0.32, e ) );
  sky = mix( sky, uZenith, smoothstep( 0.3, 0.95, e ) );
  float s = max( dot( d, uSunDir ), 0.0 );
  // Warm horizon glow concentrated around the sun's azimuth.
  float az = max( dot( normalize( vec3( d.x, 0.0, d.z ) + 1e-5 ), normalize( vec3( uSunDir.x, 0.0, uSunDir.z ) ) ), 0.0 );
  sky += uGlow * ( pow( az, 6.0 ) * ( 1.0 - smoothstep( 0.0, 0.5, abs( e - 0.05 ) ) ) * 0.9 + pow( s, 12.0 ) * 1.4 );
  sky += uSun * pow( s, 900.0 ) * 40.0;
  vec3 ground = mix( uGround, uHorizon * 0.55, smoothstep( -0.35, 0.0, e ) );
  vec3 col = e >= 0.0 ? sky : ground;
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Builds a prefiltered environment texture from a procedural golden-hour sky. */
function createSkyEnvironment(gl: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const pmrem = new THREE.PMREMGenerator(gl);
  const envScene = new THREE.Scene();
  const geometry = new THREE.SphereGeometry(10, 64, 32);
  const material = new THREE.ShaderMaterial({
    vertexShader: ENV_VERTEX,
    fragmentShader: ENV_FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      uZenith: { value: new THREE.Color(PALETTE.skyZenith) },
      uMid: { value: new THREE.Color(PALETTE.skyMid) },
      uHorizon: { value: new THREE.Color(PALETTE.skyHorizon) },
      uGlow: { value: new THREE.Color(PALETTE.skySunGlow) },
      uSun: { value: new THREE.Color(PALETTE.sun) },
      uGround: { value: new THREE.Color(PALETTE.hemisphereGround) },
      uSunDir: { value: SUN_DIRECTION.clone().normalize() },
    },
  });
  envScene.add(new THREE.Mesh(geometry, material));
  const target = pmrem.fromScene(envScene, 0, 0.1, 50);
  geometry.dispose();
  material.dispose();
  pmrem.dispose();
  return target;
}

export function WorldLighting(): JSX.Element {
  const tier = scrollStore.gpuTier;
  const shadows = tier >= 2;
  const mapSize = tier >= 3 ? 2048 : 1024;
  const { gl, scene } = useThree();

  const sun = useRef<THREE.DirectionalLight>(null);
  const fill = useRef<THREE.DirectionalLight>(null);
  const sunTarget = useMemo(() => new THREE.Object3D(), []);
  const fillTarget = useMemo(() => new THREE.Object3D(), []);

  const scratch = useMemo(
    () => ({
      forward: new THREE.Vector3(),
      desired: new THREE.Vector3(),
      focus: new THREE.Vector3(),
      snapped: new THREE.Vector3(),
      /* Light-space basis matching three's DirectionalLightShadow lookAt (up = +Y), rebuilt from the key each frame. */
      lightX: new THREE.Vector3(),
      lightY: new THREE.Vector3(),
      fillDir: new THREE.Vector3(),
      sunColor: new THREE.Color(SUN_COLOR),
      warm: new THREE.Color('#FFC890'),
      tmpColor: new THREE.Color(),
    }),
    [],
  );
  const state = useRef({ initialised: false, size: 30, appliedSize: 0, intensity: SUN_INTENSITY });

  // Procedural environment for PBR reflections (rendered once, no network).
  useEffect(() => {
    const target = createSkyEnvironment(gl);
    const previous = scene.environment;
    const previousIntensity = scene.environmentIntensity;
    scene.environment = target.texture;
    scene.environmentIntensity = ENV_INTENSITY;
    return () => {
      if (scene.environment === target.texture) {
        scene.environment = previous;
        scene.environmentIntensity = previousIntensity;
      }
      target.dispose();
    };
  }, [gl, scene]);

  // Shadow camera setup (once per tier).
  useLayoutEffect(() => {
    const light = sun.current;
    if (!light) return;
    light.target = sunTarget;
    light.castShadow = shadows;
    light.shadow.mapSize.set(mapSize, mapSize);
    light.shadow.bias = -0.00025;
    light.shadow.normalBias = tier >= 3 ? 0.035 : 0.05;
    light.shadow.camera.near = 1;
    light.shadow.camera.far = SUN_DISTANCE * 2;
    light.shadow.needsUpdate = true;
    if (light.shadow.map) {
      light.shadow.map.dispose();
      light.shadow.map = null;
    }
    const fillLight = fill.current;
    if (fillLight) fillLight.target = fillTarget;
  }, [shadows, mapSize, tier, sunTarget, fillTarget]);

  useFrame(({ camera }, delta) => {
    const light = sun.current;
    if (!light) return;
    const s = state.current;
    const { forward, desired, focus, snapped, lightX, lightY } = scratch;
    const p = scrollStore.dampedProgress;
    const key = keyLight.direction;
    keyDirectionAt(p, key);
    keyLight.bakeWeight.value = keyBakeWeightAt(p);
    lightX.crossVectors(UP, key).normalize();
    lightY.crossVectors(key, lightX);

    // How far the camera is from the climb decides focus distance and box size.
    let nearest = Infinity;
    for (let i = 0; i < ROUTE_SAMPLES.length; i += 1) {
      const d = camera.position.distanceToSquared(ROUTE_SAMPLES[i]);
      if (d < nearest) nearest = d;
    }
    nearest = Math.sqrt(nearest);
    const focusDistance = THREE.MathUtils.clamp(nearest * 0.85, 7, 60);
    // Close to the route (base camp: cameras 9-14 out) the box may shrink to 16 for finer shadow texels.
    const sizeFloor = 16 + 8 * smoothstep(8, 12, nearest);
    const sizeTarget = THREE.MathUtils.clamp(16 + nearest * 0.6, sizeFloor, 64);

    camera.getWorldDirection(forward);
    desired.copy(camera.position).addScaledVector(forward, focusDistance);

    if (!s.initialised) {
      focus.copy(desired);
      s.size = sizeTarget;
      s.initialised = true;
    }
    const lambda = 3.5;
    focus.x = damp(focus.x, desired.x, lambda, delta);
    focus.y = damp(focus.y, desired.y, lambda, delta);
    focus.z = damp(focus.z, desired.z, lambda, delta);
    s.size = damp(s.size, sizeTarget, 2.5, delta);

    // Quantise the box size so the texel size only changes in rare, small steps.
    const applied = Math.ceil(s.size / 4) * 4;
    const cam = light.shadow.camera;
    if (applied !== s.appliedSize) {
      s.appliedSize = applied;
      cam.left = -applied;
      cam.right = applied;
      cam.top = applied;
      cam.bottom = -applied;
      cam.updateProjectionMatrix();
    }

    // Snap the centre to whole shadow texels in light space.
    const texel = (applied * 2) / light.shadow.mapSize.x;
    const u = Math.round(focus.dot(lightX) / texel) * texel;
    const v = Math.round(focus.dot(lightY) / texel) * texel;
    const w = Math.round(focus.dot(key) / texel) * texel;
    snapped.set(0, 0, 0).addScaledVector(lightX, u).addScaledVector(lightY, v).addScaledVector(key, w);

    sunTarget.position.copy(snapped);
    sunTarget.updateMatrixWorld();
    light.position.copy(snapped).addScaledVector(key, SUN_DISTANCE);

    // Golden hour deepens slightly as the climb nears the summit.
    const summitGlow = smoothstep(0.62, 0.86, p);
    s.intensity = damp(s.intensity, SUN_INTENSITY * (1 + 0.12 * summitGlow), 2, delta);
    light.intensity = s.intensity;
    scratch.tmpColor.copy(scratch.sunColor).lerp(scratch.warm, summitGlow * 0.35);
    light.color.r = damp(light.color.r, scratch.tmpColor.r, 2, delta);
    light.color.g = damp(light.color.g, scratch.tmpColor.g, 2, delta);
    light.color.b = damp(light.color.b, scratch.tmpColor.b, 2, delta);

    const fillLight = fill.current;
    if (fillLight) {
      fillTarget.position.copy(snapped);
      fillTarget.updateMatrixWorld();
      fillLight.position.copy(snapped).addScaledVector(fillDirectionFor(key, scratch.fillDir), SUN_DISTANCE);
    }
  });

  return (
    <>
      <primitive object={sunTarget} />
      <primitive object={fillTarget} />
      <directionalLight
        ref={sun}
        color={SUN_COLOR}
        intensity={SUN_INTENSITY}
        position={SUN_START}
        castShadow={shadows}
      />
      <directionalLight ref={fill} color={FILL_COLOR} intensity={FILL_INTENSITY} position={FILL_START} />
      <hemisphereLight args={[HEMI_SKY, HEMI_GROUND, HEMI_INTENSITY]} />
    </>
  );
}

export default WorldLighting;
