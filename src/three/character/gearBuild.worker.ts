import { buildGearGeometry, packGearGeometry, ropeCoilCentreline, type GearDetail, type PackedGearSet } from './gearGeometry';
import { ROPE_FALL_PROXY_SAMPLES } from './gearTimeline';

/* ==========================================================================
 * Gear build worker: builds the four expedition tools' geometry off the main
 * thread and transfers the typed arrays back (zero-copy). Spawned by
 * GearSheddingSystem; the main thread falls back to its time-sliced builder
 * if this worker cannot start or reports an error.
 * ========================================================================== */

export interface GearBuildRequest {
  detail: GearDetail;
}

export type GearBuildResponse =
  | {
      ok: true;
      detail: GearDetail;
      set: PackedGearSet;
      /** ropeCoilCentreline(ROPE_FALL_PROXY_SAMPLES) flattened (the rope's fall proxies; see primeRopeFallProxies). */
      ropeProxies: number[];
    }
  | { ok: false; detail: GearDetail; error: string };

interface WorkerScope {
  onmessage: ((event: MessageEvent<GearBuildRequest>) => void) | null;
  postMessage(message: GearBuildResponse, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { detail } = event.data;
  try {
    const { packed, transfer } = packGearGeometry(buildGearGeometry(detail));
    const ropeProxies = ropeCoilCentreline(ROPE_FALL_PROXY_SAMPLES).points.flatMap((p) => [p.x, p.y, p.z]);
    scope.postMessage({ ok: true, detail, set: packed, ropeProxies }, transfer);
  } catch (error) {
    scope.postMessage({ ok: false, detail, error: error instanceof Error ? error.message : String(error) }, []);
  }
};
