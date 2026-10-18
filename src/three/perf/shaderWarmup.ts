import * as THREE from 'three';

/* ==========================================================================
 * Shader warm-up — compiles an object's programs ahead of its first draw so
 * that draw never stalls on shader compilation (a long main-thread task on
 * ANGLE / D3D and on software GL).
 *
 * The programs must be the variants the frame will actually use. Through the
 * post-processing composer (tier >= 2: the renderer's own toneMapping is
 * NoToneMapping) the scene is drawn into a linear render target, so the
 * warm-up compiles against a 1×1 linear target too; without the composer it
 * compiles for the canvas (renderer tone mapping + sRGB output).
 *
 * Shadow casters also need the shadow pass's depth program (a skinned or
 * textured caster gets its own MeshDepthMaterial variant). compileShadowDepth
 * mirrors WebGLShadowMap.getDepthMaterial on a stand-in depth material and
 * compiles it into a render target with the scene's lights, which yields the
 * same program (three shares programs by cache key). The stand-ins stay alive
 * until dispose() so the program is still cached when the first shadow pass
 * asks for it.
 *
 * WebGLRenderer.compile() only hands the shaders to the driver. With
 * KHR_parallel_shader_compile the driver links them in the background;
 * ready() polls that (non-blocking) so a caller can keep an object hidden
 * until its first draw cannot stall. Without the extension nothing can be
 * polled: ready() then waits LINK_GRACE_MS after the last compile, which
 * covers a hardware driver's link; a software rasteriser (SwiftShader) can
 * still take longer, so its first draw may wait for the rest.
 * ========================================================================== */

/** Without KHR_parallel_shader_compile: time given to the driver to link after the last compile (ms). */
export const LINK_GRACE_MS = 400;

export interface ShaderWarmup {
  /** Compiles every material under `object` for drawing it into the warm-up's scene. */
  compile(object: THREE.Object3D): void;
  /** Compiles the shadow-pass depth program of every shadow-casting mesh under `object` (no-op without shadows). */
  compileShadowDepth(object: THREE.Object3D): void;
  /** Every program compiled so far has finished linking (always true without KHR_parallel_shader_compile). */
  ready(): boolean;
  /** Frees the stand-in render target once compiling is done (programs and depth stand-ins stay). */
  releaseTarget(): void;
  /** Frees the render target and the depth stand-ins (safe to call more than once). */
  dispose(): void;
}

interface ProgramLike {
  isReady?: () => boolean;
}

interface MaterialProperties {
  /** Every program variant compiled for the material (by cache key). */
  programs?: Map<string, ProgramLike>;
}

/** WebGLShadowMap's side mapping for PCF / basic shadow maps (front faces cast from their back). */
const SHADOW_SIDE: Record<THREE.Side, THREE.Side> = {
  [THREE.FrontSide]: THREE.BackSide,
  [THREE.BackSide]: THREE.FrontSide,
  [THREE.DoubleSide]: THREE.DoubleSide,
};

/** The depth material WebGLShadowMap would draw `material`'s caster with (directional / spot lights). */
function depthStandIn(gl: THREE.WebGLRenderer, material: THREE.Material): THREE.MeshDepthMaterial {
  const source = material as THREE.Material & {
    map?: THREE.Texture | null;
    alphaMap?: THREE.Texture | null;
    displacementMap?: THREE.Texture | null;
    displacementScale?: number;
    displacementBias?: number;
    wireframe?: boolean;
  };
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.name = 'ShaderWarmup.depth';
  depth.visible = material.visible;
  depth.wireframe = source.wireframe ?? false;
  depth.side = gl.shadowMap.type === THREE.VSMShadowMap ? (material.shadowSide ?? material.side) : (material.shadowSide ?? SHADOW_SIDE[material.side]);
  depth.alphaMap = source.alphaMap ?? null;
  depth.alphaTest = material.alphaTest;
  depth.map = source.map ?? null;
  depth.clipShadows = material.clipShadows;
  depth.clippingPlanes = material.clippingPlanes;
  depth.clipIntersection = material.clipIntersection;
  depth.displacementMap = source.displacementMap ?? null;
  depth.displacementScale = source.displacementScale ?? 1;
  depth.displacementBias = source.displacementBias ?? 0;
  return depth;
}

export function createShaderWarmup(gl: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene): ShaderWarmup {
  let target: THREE.WebGLRenderTarget | null = null;
  const programs: ProgramLike[] = [];
  const depthMaterials: THREE.MeshDepthMaterial[] = [];
  let readyCount = 0;
  const parallel = gl.extensions.has('KHR_parallel_shader_compile');
  let lastCompileAt = -Infinity;
  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const track = (material: THREE.Material): void => {
    const variants = (gl.properties.get(material) as MaterialProperties).programs;
    if (!variants) return;
    for (const program of variants.values()) if (!programs.includes(program)) programs.push(program);
  };

  const compileInto = (object: THREE.Object3D, intoTarget: boolean): void => {
    const previous = gl.getRenderTarget();
    if (intoTarget) {
      target ??= new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
      gl.setRenderTarget(target);
    }
    try {
      gl.compile(object, camera, scene);
    } finally {
      if (intoTarget) gl.setRenderTarget(previous);
      lastCompileAt = now();
    }
  };

  return {
    compile(object: THREE.Object3D): void {
      compileInto(object, gl.toneMapping === THREE.NoToneMapping);
      object.traverse((o) => {
        const material = (o as THREE.Mesh).material;
        if (!material) return;
        if (Array.isArray(material)) material.forEach(track);
        else track(material);
      });
    },
    compileShadowDepth(object: THREE.Object3D): void {
      if (!gl.shadowMap.enabled) return;
      const casters: THREE.Mesh[] = [];
      object.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.castShadow && mesh.material && !Array.isArray(mesh.material)) casters.push(mesh);
      });
      for (const mesh of casters) {
        const material = mesh.material as THREE.Material;
        const custom = mesh.customDepthMaterial;
        const depth = custom ?? depthStandIn(gl, material);
        if (!custom) depthMaterials.push(depth as THREE.MeshDepthMaterial);
        // Swapped for this one synchronous call only (nothing draws in between).
        mesh.material = depth;
        try {
          // The shadow pass draws into the shadow map: a render target (linear output, no tone mapping).
          compileInto(mesh, true);
        } finally {
          mesh.material = material;
        }
        track(depth);
      }
    },
    ready(): boolean {
      if (!parallel) return now() - lastCompileAt >= LINK_GRACE_MS;
      while (readyCount < programs.length) {
        const program = programs[readyCount];
        if (program.isReady && !program.isReady()) return false;
        readyCount += 1;
      }
      return true;
    },
    releaseTarget(): void {
      target?.dispose();
      target = null;
    },
    dispose(): void {
      target?.dispose();
      target = null;
      for (const m of depthMaterials) m.dispose();
      depthMaterials.length = 0;
      programs.length = 0;
      readyCount = 0;
    },
  };
}

export default createShaderWarmup;
