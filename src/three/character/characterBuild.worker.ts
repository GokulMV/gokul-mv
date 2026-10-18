import { buildCharacterMeshes, type CharacterDetailLevel, type CharacterMeshes } from './characterGeometry';
import { buildHairGeometry, type HairGeometryData } from './characterHair';

/* ==========================================================================
 * Protagonist build worker: polygonises the garments and grows the hair off
 * the main thread, then transfers the typed arrays back (zero-copy).
 * Spawned by characterAssembly; the main thread falls back to a time-sliced
 * build if this worker cannot start or reports an error.
 * ========================================================================== */

export interface CharacterBuildRequest {
  detail: CharacterDetailLevel;
}

export type CharacterBuildResponse =
  | { ok: true; detail: CharacterDetailLevel; meshes: CharacterMeshes; hair: HairGeometryData }
  | { ok: false; detail: CharacterDetailLevel; error: string };

interface WorkerScope {
  onmessage: ((event: MessageEvent<CharacterBuildRequest>) => void) | null;
  postMessage(message: CharacterBuildResponse, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

function transferables(meshes: CharacterMeshes, hair: HairGeometryData): Transferable[] {
  const list: Transferable[] = [];
  for (const m of Object.values(meshes.meshes)) {
    list.push(
      m.positions.buffer,
      m.normals.buffer,
      m.indices.buffer,
      m.skinIndex.buffer,
      m.skinWeight.buffer,
      m.rest.buffer,
      m.restNormal.buffer,
      m.occlusion.buffer,
      m.mask.buffer,
    );
  }
  list.push(hair.positions.buffer, hair.normals.buffer, hair.tangents.buffer, hair.strand.buffer, hair.lengths.buffer, hair.indices.buffer);
  // Never list a buffer twice (postMessage throws on duplicates).
  return Array.from(new Set(list));
}

scope.onmessage = (event) => {
  const { detail } = event.data;
  try {
    const meshes = buildCharacterMeshes(detail);
    const hair = buildHairGeometry(detail);
    scope.postMessage({ ok: true, detail, meshes, hair }, transferables(meshes, hair));
  } catch (error) {
    scope.postMessage({ ok: false, detail, error: error instanceof Error ? error.message : String(error) }, []);
  }
};
