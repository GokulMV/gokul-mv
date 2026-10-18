import { Component, Suspense, useEffect, useLayoutEffect, useMemo, useRef, type ErrorInfo, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import type * as THREE from 'three';
import { scrollStore } from '../../store/scrollStore';
import type { CharacterRigHandle } from './rigTypes';
import { createProceduralCharacter, DEFAULT_WIND_DIRECTION } from './characterAssembly';
import { createRigFromGltf } from './characterGlb';

/* ==========================================================================
 * ProtagonistModel — the 1.75 m climber (procedural by default, zero network).
 *
 * Renders the character's Root group and hands the CharacterRigHandle to the
 * parent ONCE per rig instance through `onRig` (on mount; the bones and gear
 * sockets exist immediately, the garment meshes stream in over a few frames
 * of time-sliced building and attach themselves to the same rig).
 *
 * Never re-renders on scroll: per-frame work (time-sliced build, hair wind,
 * cloth flutter) happens in useFrame from mutable refs/singletons.
 *
 * `glbUrl` (optional) loads a humanoid glTF with drei's useGLTF (no Draco /
 * Meshopt decoders, so nothing is fetched from a CDN) and re-skins it onto the
 * contract skeleton. ANY failure — network, parse, missing bones — falls back
 * to the procedural rig through an error boundary. While the GLB loads nothing
 * is shown and onRig has not been called yet.
 * ========================================================================== */

export { SKIN_TONE } from './characterMaterials';
export { DEFAULT_WIND_DIRECTION } from './characterAssembly';

export interface ProtagonistModelProps {
  /** Optional humanoid glTF override (bones mapped by name). Defaults to the procedural rig. */
  glbUrl?: string;
  /** Receives the rig once it exists (once per rig instance). */
  onRig: (rig: CharacterRigHandle) => void;
  /** Extra wind strength (0 calm → 1 gust; above 1 allowed) for hair and cloth, written by the animator. */
  wind?: { current: number };
  /** World-space wind direction (defaults to DEFAULT_WIND_DIRECTION). */
  windDirection?: { current: THREE.Vector3 };
}

/** Time-slicing of the procedural mesh build. Harnesses may set frameBudgetMs = Infinity. */
export const protagonistBuildSettings = {
  frameBudgetMs: 6,
};

type RigCallback = (rig: CharacterRigHandle) => void;

/** Keeps the latest callback without re-running effects when the parent passes a new function identity. */
function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

function ProceduralProtagonist({ onRig, wind, windDirection }: Omit<ProtagonistModelProps, 'glbUrl'>): JSX.Element {
  // Tier is read once at mount (like the rest of the world); a tier change remounts the Canvas.
  const character = useMemo(() => createProceduralCharacter({ tier: scrollStore.gpuTier }), []);
  const onRigRef = useLatest<RigCallback>(onRig);
  const windRef = useLatest(wind);
  const windDirRef = useLatest(windDirection);

  useLayoutEffect(() => {
    // Build what fits in this frame right away; the rest is time-sliced in useFrame.
    character.build(protagonistBuildSettings.frameBudgetMs);
    onRigRef.current(character.rig);
  }, [character, onRigRef]);

  useEffect(() => () => character.dispose(), [character]);

  useFrame((_, delta) => {
    if (!character.ready) character.build(protagonistBuildSettings.frameBudgetMs);
    character.update(delta, scrollStore.elapsed, windRef.current?.current ?? 0, windDirRef.current?.current ?? DEFAULT_WIND_DIRECTION);
  });

  return <primitive object={character.rig.root} />;
}

function GlbProtagonist({ url, onRig }: { url: string; onRig: RigCallback }): JSX.Element {
  const gltf = useGLTF(url, false, false);
  // Throws on an unusable rig → caught by the boundary → procedural fallback.
  const result = useMemo(() => createRigFromGltf(gltf.scene), [gltf]);
  const onRigRef = useLatest(onRig);
  useLayoutEffect(() => {
    onRigRef.current(result.rig);
  }, [result, onRigRef]);
  useEffect(() => () => result.dispose(), [result]);
  return <primitive object={result.rig.root} />;
}

interface FallbackProps {
  fallback: ReactNode;
  resetKey: string;
  children: ReactNode;
}

class GlbFallbackBoundary extends Component<FallbackProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn('[ProtagonistModel] glbUrl override failed; using the procedural rig.', error.message, info.componentStack ?? '');
  }

  override componentDidUpdate(prev: FallbackProps): void {
    if (prev.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function ProtagonistModel({ glbUrl, onRig, wind, windDirection }: ProtagonistModelProps): JSX.Element {
  const procedural = <ProceduralProtagonist onRig={onRig} wind={wind} windDirection={windDirection} />;
  if (!glbUrl) return procedural;
  return (
    <GlbFallbackBoundary fallback={procedural} resetKey={glbUrl}>
      <Suspense fallback={null}>
        <GlbProtagonist url={glbUrl} onRig={onRig} />
      </Suspense>
    </GlbFallbackBoundary>
  );
}

export default ProtagonistModel;
