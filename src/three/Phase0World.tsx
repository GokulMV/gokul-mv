import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Line, Stars } from '@react-three/drei';
import * as THREE from 'three';
import {
  GEAR_DROP_AT,
  GEAR_EQUIP_AT,
  GEAR_EQUIP_ORDER,
  isGearAttached,
  remap,
  scrollStore,
  smoothstep,
  type GearId,
} from '../store/scrollStore';
import { protagonistPositionAt, samplePath, WAYPOINTS } from './protagonistPath';

const { damp, lerp } = THREE.MathUtils;

/* ==========================================================================
 * Phase-0 verification world. Every animated value is derived from
 * scrollStore.dampedProgress inside useFrame and interpolated with
 * THREE.MathUtils.damp — React never re-renders while scrolling.
 * ========================================================================== */

const SKY = new THREE.Color('#0B1220');
const VOID = new THREE.Color('#040508');

/* ---------------------------------------------------------------------------
 * Deterministic pseudo-random + value noise for rock displacement.
 * ------------------------------------------------------------------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

function rockGeometry(size: THREE.Vector3Tuple, seed: number, roughness: number): THREE.BufferGeometry {
  const [w, h, d] = size;
  const geometry = new THREE.BoxGeometry(w, h, d, Math.ceil(w / 1.5), Math.ceil(h / 1.5), Math.ceil(d / 1.5));
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 1) {
    v.fromBufferAttribute(pos, i);
    const n = hash3(Math.round(v.x * 4) + seed, Math.round(v.y * 4), Math.round(v.z * 4)) - 0.5;
    const topFace = v.y > h / 2 - 0.01;
    v.x += n * roughness;
    v.z += n * roughness;
    v.y += topFace ? n * roughness * 0.3 : n * roughness * 0.6;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  const nonIndexed = geometry.toNonIndexed();
  geometry.dispose();
  nonIndexed.computeVertexNormals();
  return nonIndexed;
}

/* ---------------------------------------------------------------------------
 * Terrain: ground, three cliff massifs and the distant range.
 * ------------------------------------------------------------------------- */

interface CliffSpec {
  position: THREE.Vector3Tuple;
  size: THREE.Vector3Tuple;
  seed: number;
}

const CLIFFS: readonly CliffSpec[] = [
  { position: [0, 9, -13], size: [14, 18, 10], seed: 11 },
  { position: [9, 16, -20], size: [10, 32, 10], seed: 23 },
  { position: [-2, 27.5, -38], size: [14, 55, 22], seed: 37 },
];

function Terrain() {
  const geometries = useMemo(() => CLIFFS.map((c) => rockGeometry(c.size, c.seed, 0.9)), []);
  const rockMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#2A3140', roughness: 0.95, metalness: 0.02, flatShading: true }),
    [],
  );
  const snowMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#DCE8F5', roughness: 0.8, flatShading: true }),
    [],
  );

  useLayoutEffect(
    () => () => {
      geometries.forEach((g) => g.dispose());
      rockMaterial.dispose();
      snowMaterial.dispose();
    },
    [geometries, rockMaterial, snowMaterial],
  );

  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.01, 0]} receiveShadow>
        <circleGeometry args={[220, 64]} />
        <meshStandardMaterial color="#141A24" roughness={1} />
      </mesh>
      {CLIFFS.map((cliff, i) => (
        <group key={cliff.seed} position={cliff.position}>
          <mesh geometry={geometries[i]} material={rockMaterial} castShadow receiveShadow />
          <mesh position={[0, cliff.size[1] / 2 + 0.02, 0]} material={snowMaterial} receiveShadow>
            <boxGeometry args={[cliff.size[0] * 0.92, 0.35, cliff.size[2] * 0.92]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function HorizonRange() {
  const peaks = useMemo(() => {
    const rand = mulberry32(2024);
    return Array.from({ length: 26 }, (_, i) => {
      const spread = (i / 25 - 0.5) * 520;
      const height = 70 + rand() * 120;
      return {
        key: i,
        position: [spread + (rand() - 0.5) * 30, height / 2 - 4, -170 - rand() * 160] as THREE.Vector3Tuple,
        radius: 40 + rand() * 50,
        height,
        segments: 5 + Math.floor(rand() * 4),
        rotation: rand() * Math.PI,
      };
    });
  }, []);

  return (
    <group>
      {peaks.map((p) => (
        <group key={p.key} position={p.position} rotation-y={p.rotation}>
          <mesh>
            <coneGeometry args={[p.radius, p.height, p.segments, 1]} />
            <meshStandardMaterial color="#1B2333" roughness={1} flatShading />
          </mesh>
          <mesh position={[0, p.height * 0.32, 0]}>
            {/* Slightly wider than the parent slope so the cap never z-fights. */}
            <coneGeometry args={[p.radius * 0.38, p.height * 0.36, p.segments, 1]} />
            <meshStandardMaterial color="#C9D6E8" roughness={0.9} flatShading />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/* ---------------------------------------------------------------------------
 * Protagonist stand-in + gear.
 * ------------------------------------------------------------------------- */

interface GearSpec {
  id: GearId;
  color: string;
  /** Local attach offset on the body. */
  attach: THREE.Vector3Tuple;
  /** Where the gear rests at base camp before equipping. */
  rest: THREE.Vector3Tuple;
}

const GEAR: Readonly<Record<GearId, GearSpec>> = {
  backpack: { id: 'backpack', color: '#F97316', attach: [0, 1.25, 0.32], rest: [-1.6, 0.25, 1.2] },
  rope: { id: 'rope', color: '#FACC15', attach: [0.32, 1.45, 0.05], rest: [1.5, 0.15, 1.1] },
  iceAxes: { id: 'iceAxes', color: '#38BDF8', attach: [-0.42, 0.95, 0.08], rest: [-1.2, 0.3, -0.9] },
  harness: { id: 'harness', color: '#A3E635', attach: [0, 0.9, 0], rest: [1.3, 0.1, -1.0] },
};

function GearMesh({ id }: { id: GearId }) {
  switch (id) {
    case 'backpack':
      return <boxGeometry args={[0.46, 0.6, 0.26]} />;
    case 'rope':
      return <torusGeometry args={[0.2, 0.06, 10, 24]} />;
    case 'iceAxes':
      return <boxGeometry args={[0.06, 0.7, 0.18]} />;
    case 'harness':
      return <torusGeometry args={[0.3, 0.045, 8, 28]} />;
    default:
      return null;
  }
}

function GearPiece({ spec, body }: { spec: GearSpec; body: RefObject<THREE.Group> }) {
  const ref = useRef<THREE.Mesh>(null);
  const local = useMemo(() => new THREE.Vector3(), []);
  const world = useMemo(() => new THREE.Vector3(), []);
  const restVec = useMemo(() => new THREE.Vector3(...spec.rest), [spec.rest]);
  const attachVec = useMemo(() => new THREE.Vector3(...spec.attach), [spec.attach]);

  useFrame((_, delta) => {
    const mesh = ref.current;
    const group = body.current;
    if (!mesh || !group) return;
    const p = scrollStore.dampedProgress;
    const equipAt = GEAR_EQUIP_AT[spec.id];
    const dropAt = GEAR_DROP_AT[spec.id];

    let targetScale = 1;
    if (p < equipAt) {
      // Resting at base camp, hovering into view during Scene 2/3.
      world.copy(restVec);
      world.y += Math.sin(scrollStore.elapsed * 2 + equipAt * 40) * 0.05;
      targetScale = smoothstep(0.1, 0.17, p);
      mesh.position.x = damp(mesh.position.x, world.x, 8, delta);
      mesh.position.y = damp(mesh.position.y, world.y, 8, delta);
      mesh.position.z = damp(mesh.position.z, world.z, 8, delta);
    } else if (isGearAttached(spec.id, p)) {
      // Locked to the body: follow the body's world transform.
      local.copy(attachVec);
      group.localToWorld(world.copy(local));
      mesh.parent?.worldToLocal(world);
      mesh.position.x = damp(mesh.position.x, world.x, 14, delta);
      mesh.position.y = damp(mesh.position.y, world.y, 14, delta);
      mesh.position.z = damp(mesh.position.z, world.z, 14, delta);
    } else {
      // Detached: ballistic fall derived from progress so reversing scroll rewinds it.
      const fall = remap(p, dropAt, dropAt + 0.035);
      protagonistPositionAt(dropAt, world).add(attachVec);
      world.x += fall * (spec.id === 'iceAxes' ? -3 : 2.5);
      world.z += fall * 3;
      world.y -= fall * fall * 30;
      targetScale = 1 - smoothstep(0.75, 1, fall);
      mesh.position.x = damp(mesh.position.x, world.x, 10, delta);
      mesh.position.y = damp(mesh.position.y, world.y, 10, delta);
      mesh.position.z = damp(mesh.position.z, world.z, 10, delta);
      mesh.rotation.x += delta * 6 * fall;
      mesh.rotation.z += delta * 4 * fall;
    }
    const s = damp(mesh.scale.x, targetScale, 8, delta);
    mesh.scale.setScalar(Math.max(0.0001, s));
    mesh.visible = s > 0.01;
  });

  return (
    <mesh ref={ref} position={spec.rest} castShadow>
      <GearMesh id={spec.id} />
      <meshStandardMaterial color={spec.color} emissive={spec.color} emissiveIntensity={0.35} roughness={0.45} metalness={0.4} />
    </mesh>
  );
}

function Protagonist({ bodyRef }: { bodyRef: RefObject<THREE.Group> }) {
  const target = useMemo(() => new THREE.Vector3(), []);
  const ahead = useMemo(() => new THREE.Vector3(), []);
  const reveal = useRef(0);

  useFrame((_, delta) => {
    const body = bodyRef.current;
    if (!body) return;
    const p = scrollStore.dampedProgress;
    protagonistPositionAt(p, target);
    body.position.x = damp(body.position.x, target.x, 10, delta);
    body.position.y = damp(body.position.y, target.y, 10, delta);
    body.position.z = damp(body.position.z, target.z, 10, delta);

    // Face along the direction of travel while climbing; face the range at the summit.
    protagonistPositionAt(Math.min(1, p + 0.01), ahead).sub(target);
    const heading = ahead.lengthSq() > 1e-6 && p < 0.78 ? Math.atan2(ahead.x, ahead.z) : Math.PI;
    body.rotation.y = damp(body.rotation.y, heading, 4, delta);

    // Revealed in Scene 2, gone with the wind in Scene 10.
    const visibility = smoothstep(0.075, 0.11, p) * (1 - smoothstep(0.985, 1, p));
    reveal.current = damp(reveal.current, visibility, 6, delta);
    body.scale.setScalar(Math.max(0.0001, reveal.current));
    body.visible = reveal.current > 0.01;
  });

  return (
    <group ref={bodyRef}>
      <mesh position={[0, 0.95, 0]} castShadow>
        <capsuleGeometry args={[0.28, 1.1, 8, 16]} />
        <meshStandardMaterial color="#C7D2E0" roughness={0.6} metalness={0.1} />
      </mesh>
      <mesh position={[0, 1.88, 0]} castShadow>
        <sphereGeometry args={[0.2, 24, 24]} />
        <meshStandardMaterial color="#E8C9A8" roughness={0.7} />
      </mesh>
      <mesh position={[0, 1.98, 0.02]} castShadow>
        <sphereGeometry args={[0.205, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color="#0A0A0C" roughness={0.35} metalness={0.2} />
      </mesh>
    </group>
  );
}

/* ---------------------------------------------------------------------------
 * Project beacons (Scenes 4–6).
 * ------------------------------------------------------------------------- */

const BEACONS: ReadonlyArray<{ scene: number; position: THREE.Vector3Tuple; color: string }> = [
  { scene: 3, position: [-4, 18, -10], color: '#5EEAD4' },
  { scene: 4, position: [9, 32, -18], color: '#A78BFA' },
  { scene: 5, position: [-6, 55, -36], color: '#F4C77B' },
];

function Beacon({ scene, position, color }: { scene: number; position: THREE.Vector3Tuple; color: string }) {
  const pillar = useRef<THREE.Mesh>(null);
  const material = useRef<THREE.MeshBasicMaterial>(null);
  const light = useRef<THREE.PointLight>(null);

  useFrame((_, delta) => {
    const active = scrollStore.activeSceneIndex === scene ? 1 : 0;
    if (material.current) {
      material.current.opacity = damp(material.current.opacity, active * 0.55, 4, delta);
    }
    if (light.current) light.current.intensity = damp(light.current.intensity, active * 40, 4, delta);
    if (pillar.current) {
      pillar.current.visible = (material.current?.opacity ?? 0) > 0.005;
      pillar.current.rotation.y += delta * 0.6;
    }
  });

  return (
    <group position={position}>
      <mesh ref={pillar} position={[0, 6, 0]}>
        <cylinderGeometry args={[0.18, 0.5, 12, 16, 1, true]} />
        <meshBasicMaterial
          ref={material}
          color={color}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
      <pointLight ref={light} color={color} intensity={0} distance={16} decay={2} position={[0, 1.5, 0]} />
    </group>
  );
}

/* ---------------------------------------------------------------------------
 * Cloud curtain — camera-locked sprites that part laterally (Scene 1),
 * rush back (Scene 9) and dissolve into the void (Scene 10).
 * ------------------------------------------------------------------------- */

function useCloudTexture(): THREE.CanvasTexture {
  const texture = useMemo(() => {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const rand = mulberry32(7);
      for (let i = 0; i < 14; i += 1) {
        const x = size * (0.3 + rand() * 0.4);
        const y = size * (0.3 + rand() * 0.4);
        const r = size * (0.18 + rand() * 0.2);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(255,255,255,0.55)');
        g.addColorStop(0.6, 'rgba(235,242,250,0.18)');
        g.addColorStop(1, 'rgba(235,242,250,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);
  useLayoutEffect(() => () => texture.dispose(), [texture]);
  return texture;
}

interface CloudPuff {
  side: -1 | 1;
  base: THREE.Vector3;
  scale: number;
  speed: number;
  phase: number;
}

function CloudCurtain() {
  const group = useRef<THREE.Group>(null);
  const sprites = useRef<Array<THREE.Sprite | null>>([]);
  const texture = useCloudTexture();
  const { camera } = useThree();
  const state = useRef({ open: 0, opacity: 1 });

  const puffs = useMemo<CloudPuff[]>(() => {
    const rand = mulberry32(99);
    return Array.from({ length: 64 }, (_, i) => {
      const side: -1 | 1 = i % 2 === 0 ? -1 : 1;
      return {
        side,
        base: new THREE.Vector3(side * (0.5 + rand() * 7), (rand() - 0.5) * 9, -6 - rand() * 6),
        scale: 5 + rand() * 6,
        speed: 0.05 + rand() * 0.15,
        phase: rand() * Math.PI * 2,
      };
    });
  }, []);

  // One material per puff so each can rotate independently.
  const materials = useMemo(
    () =>
      puffs.map(
        () =>
          new THREE.SpriteMaterial({
            map: texture,
            color: '#DDE6F2',
            transparent: true,
            opacity: 0.85,
            depthWrite: false,
            depthTest: false,
            fog: false,
          }),
      ),
    [puffs, texture],
  );
  useLayoutEffect(() => () => materials.forEach((m) => m.dispose()), [materials]);

  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;
    const p = scrollStore.dampedProgress;
    const openTarget = smoothstep(0.012, 0.075, p) * (1 - smoothstep(0.915, 0.965, p));
    const fade = 1 - smoothstep(0.98, 0.996, p);
    const opacityTarget = fade * fade;
    state.current.open = damp(state.current.open, openTarget, 5, delta);
    state.current.opacity = damp(state.current.opacity, opacityTarget, 5, delta);

    g.position.copy(camera.position);
    g.quaternion.copy(camera.quaternion);

    const open = state.current.open;
    g.visible = open < 0.995 && state.current.opacity > 0.01;
    if (!g.visible) return;

    const opacity = state.current.opacity * (0.85 - open * 0.35);
    const t = scrollStore.elapsed;
    puffs.forEach((puff, i) => {
      const sprite = sprites.current[i];
      if (!sprite) return;
      const drift = Math.sin(t * puff.speed + puff.phase) * 0.6;
      sprite.position.set(
        puff.base.x + puff.side * open * 22 + drift,
        puff.base.y + Math.cos(t * puff.speed * 0.7 + puff.phase) * 0.3,
        puff.base.z,
      );
      const material = materials[i];
      material.opacity = opacity;
      material.rotation = puff.phase + t * puff.speed * 0.2;
    });
  });

  return (
    <group ref={group} renderOrder={10}>
      {puffs.map((puff, i) => (
        <sprite
          key={i}
          ref={(el) => {
            sprites.current[i] = el;
          }}
          material={materials[i]}
          scale={[puff.scale, puff.scale, 1]}
          position={puff.base}
          renderOrder={10}
        />
      ))}
    </group>
  );
}

/* ---------------------------------------------------------------------------
 * Camera rig — per-scene framing blended by smoothstep, damped every frame.
 * ------------------------------------------------------------------------- */

const OFFSET_INTRO = new THREE.Vector3(0, 7, 24);
const OFFSET_CAMP = new THREE.Vector3(3.5, 2.2, 8.5);
const OFFSET_CLIMB = new THREE.Vector3(7, 4, 15);
const OFFSET_SUMMIT = new THREE.Vector3(5, 2.6, 9);
const OFFSET_SHOULDER = new THREE.Vector3(0.9, 2.0, 3.4);
const OFFSET_PAPER = new THREE.Vector3(0.4, 2.1, 3.2);

const LOOK_RANGE = new THREE.Vector3(0, 60, -260);

function CameraRig({ bodyRef }: { bodyRef: RefObject<THREE.Group> }) {
  const { camera, scene } = useThree();
  const desired = useMemo(() => new THREE.Vector3(), []);
  const offset = useMemo(() => new THREE.Vector3(), []);
  const look = useMemo(() => new THREE.Vector3(), []);
  const lookTarget = useMemo(() => new THREE.Vector3(), []);
  const focus = useMemo(() => new THREE.Vector3(), []);
  const background = useMemo(() => new THREE.Color(), []);
  const initialised = useRef(false);

  useFrame((_, delta) => {
    const body = bodyRef.current;
    if (!body) return;
    const p = scrollStore.dampedProgress;
    focus.copy(body.position);

    offset.copy(OFFSET_INTRO);
    offset.lerp(OFFSET_CAMP, smoothstep(0.06, 0.12, p));
    offset.lerp(OFFSET_CLIMB, smoothstep(0.27, 0.33, p));
    offset.lerp(OFFSET_SUMMIT, smoothstep(0.77, 0.81, p));
    offset.lerp(OFFSET_SHOULDER, smoothstep(0.86, 0.9, p));
    offset.lerp(OFFSET_PAPER, smoothstep(0.92, 0.95, p));
    desired.copy(focus).add(offset);

    lookTarget.copy(focus);
    lookTarget.y += lerp(4, 1.4, smoothstep(0.05, 0.12, p));
    lookTarget.lerp(LOOK_RANGE, smoothstep(0.86, 0.9, p) * 0.85);

    if (!initialised.current) {
      camera.position.copy(desired);
      look.copy(lookTarget);
      initialised.current = true;
    }

    const lambda = 3.2;
    camera.position.x = damp(camera.position.x, desired.x, lambda, delta);
    camera.position.y = damp(camera.position.y, desired.y, lambda, delta);
    camera.position.z = damp(camera.position.z, desired.z, lambda, delta);
    look.x = damp(look.x, lookTarget.x, lambda * 1.3, delta);
    look.y = damp(look.y, lookTarget.y, lambda * 1.3, delta);
    look.z = damp(look.z, lookTarget.z, lambda * 1.3, delta);
    camera.lookAt(look);

    background.copy(SKY).lerp(VOID, smoothstep(0.975, 1, p));
    if (scene.background instanceof THREE.Color) scene.background.copy(background);
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.color.copy(background);
      const dissolve = smoothstep(0.975, 1, p);
      scene.fog.near = lerp(40, 0.5, dissolve);
      scene.fog.far = lerp(320, 6, dissolve);
    }
  });

  return null;
}

/* ---------------------------------------------------------------------------
 * Audit overlay — protagonist path and waypoints (toggle with `).
 * ------------------------------------------------------------------------- */

function AuditPath() {
  const group = useRef<THREE.Group>(null);
  const points = useMemo(() => samplePath(240), []);

  useFrame(() => {
    if (group.current) group.current.visible = scrollStore.auditMode;
  });

  return (
    <group ref={group} visible={false}>
      <Line points={points} color="#5EEAD4" lineWidth={1.5} dashed dashSize={0.6} gapSize={0.4} />
      {Object.entries(WAYPOINTS).map(([key, position]) => (
        <mesh key={key} position={position}>
          <octahedronGeometry args={[0.35, 0]} />
          <meshBasicMaterial color="#FB7185" wireframe />
        </mesh>
      ))}
    </group>
  );
}

/* ---------------------------------------------------------------------------
 * Composition
 * ------------------------------------------------------------------------- */

export function Phase0World() {
  const bodyRef = useRef<THREE.Group>(null);
  const tier = scrollStore.gpuTier;

  return (
    <>
      <color attach="background" args={['#0B1220']} />
      <fog attach="fog" args={['#0B1220', 40, 320]} />

      <hemisphereLight args={['#BFD7FF', '#1A1F2B', 0.55]} />
      <directionalLight
        position={[30, 80, 40]}
        intensity={2.2}
        color="#FFE8C8"
        castShadow={tier >= 2}
        shadow-mapSize-width={tier >= 3 ? 2048 : 1024}
        shadow-mapSize-height={tier >= 3 ? 2048 : 1024}
        shadow-camera-left={-40}
        shadow-camera-right={40}
        shadow-camera-top={70}
        shadow-camera-bottom={-10}
        shadow-camera-near={1}
        shadow-camera-far={200}
      />
      <ambientLight intensity={0.15} />

      <Stars radius={260} depth={60} count={tier >= 2 ? 4000 : 1500} factor={5} saturation={0} fade speed={0.4} />

      <Terrain />
      <HorizonRange />

      <Protagonist bodyRef={bodyRef} />
      {GEAR_EQUIP_ORDER.map((id) => (
        <GearPiece key={id} spec={GEAR[id]} body={bodyRef} />
      ))}

      {BEACONS.map((beacon) => (
        <Beacon key={beacon.scene} {...beacon} />
      ))}

      <CloudCurtain />
      <AuditPath />
      <CameraRig bodyRef={bodyRef} />
    </>
  );
}

export default Phase0World;
