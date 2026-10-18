import * as THREE from 'three';

/* ==========================================================================
 * Shared 3D noise texture for the alpine rock material.
 *
 * A 32³ RGBA8 Data3DTexture holding four decorrelated, seamlessly tiling 3D
 * value noises (one per channel, lattice period 8, so 4 texels per lattice
 * cell; cubic-smoothstep interpolation baked in, hardware trilinear between
 * texels). One filtered, mip-mapped fetch replaces four ALU value noises, and
 * the mip chain fades a layer to its mean before it can alias.
 *
 * `rockTex( p )` has one lattice cell per unit of p, like rockValue3( p ), and
 * the same value distribution (in [0, 1], centred on 0.5), so thresholds tuned
 * for rockValue3 carry over.
 *
 * The texture is a lazily created module singleton shared by every tier and
 * material; it is never disposed per material (GPU memory: 128 KiB + mips).
 * Its texels are filled in slices of a few z-layers off the critical path
 * (warm ~0.5 ms in total, but a cold, un-optimised first run can take
 * 10+ ms); the massif it shades is still building, hidden, while it fills.
 * ========================================================================== */

/** Texels per side. */
export const ROCK_NOISE_SIZE = 32;
/** Lattice cells per tile. */
export const ROCK_NOISE_PERIOD = 8;
/** z-layers filled per slice. */
const LAYERS_PER_SLICE = 4;

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

export interface RockNoiseBuilder {
  /** RGBA8 texels, size³ × 4 ([z][y][x][channel]); complete once `done`. */
  readonly data: Uint8Array;
  readonly done: boolean;
  /** Fills the next few z-layers; returns true once every texel is filled. */
  step(): boolean;
}

/** Incremental builder of the four tileable value noises. Pure, Node-safe. */
export function createRockNoiseBuilder(size = ROCK_NOISE_SIZE, period = ROCK_NOISE_PERIOD, seed = 0x2f6b51a3): RockNoiseBuilder {
  const data = new Uint8Array(size * size * size * 4);
  const P = period;
  const slab = size * size * 4;
  // Per-axis lattice index pair and smoothstep weight for every texel coordinate.
  const i0 = new Int32Array(size);
  const i1 = new Int32Array(size);
  const w = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    const u = ((i + 0.5) / size) * period;
    const c = Math.floor(u);
    const f = u - c;
    i0[i] = c % period;
    i1[i] = (c + 1) % period;
    w[i] = f * f * (3 - 2 * f);
  }
  let ax: Float32Array | null = null; // [lz][ly][x][ch], interpolated along x
  let ay: Float32Array | null = null; // [lz][y][x][ch], interpolated along x and y
  let z = 0;
  let done = false;

  const interpolateX = (): Float32Array => {
    // Lattice values pre-scaled to 0..255 (+0.5): the Uint8Array store truncates, which rounds.
    const lattice = new Float32Array(P * P * P * 4); // [lz][ly][lx][ch]
    const rand = mulberry32(seed);
    for (let i = 0; i < lattice.length; i += 1) lattice[i] = rand() * 255 + 0.5;
    // Separable interpolation: along x, then y, then z (per slice).
    const out = new Float32Array(P * P * size * 4);
    for (let row = 0; row < P * P; row += 1) {
      for (let x = 0; x < size; x += 1) {
        const a = (row * P + i0[x]) * 4;
        const b = (row * P + i1[x]) * 4;
        const wx = w[x];
        const o = (row * size + x) * 4;
        for (let ch = 0; ch < 4; ch += 1) out[o + ch] = lattice[a + ch] + (lattice[b + ch] - lattice[a + ch]) * wx;
      }
    }
    return out;
  };

  /** Interpolates one lattice z-layer along y. */
  const interpolateY = (src: Float32Array, out: Float32Array, lz: number): void => {
    for (let y = 0; y < size; y += 1) {
      const r0 = (lz * P + i0[y]) * size * 4;
      const r1 = (lz * P + i1[y]) * size * 4;
      const wy = w[y];
      const o = (lz * size + y) * size * 4;
      for (let k = 0; k < size * 4; k += 1) out[o + k] = src[r0 + k] + (src[r1 + k] - src[r0 + k]) * wy;
    }
  };
  let lzDone = 0;

  return {
    data,
    get done() {
      return done;
    },
    step(): boolean {
      if (done) return true;
      if (!ax) {
        ax = interpolateX();
        return false;
      }
      if (lzDone < P) {
        if (!ay) ay = new Float32Array(P * slab);
        interpolateY(ax, ay, lzDone);
        lzDone += 1;
        return false;
      }
      const end = Math.min(size, z + LAYERS_PER_SLICE);
      const src = ay as Float32Array;
      for (; z < end; z += 1) {
        const r0 = i0[z] * slab;
        const r1 = i1[z] * slab;
        const wz = w[z];
        const o = z * slab;
        for (let k = 0; k < slab; k += 1) data[o + k] = src[r0 + k] + (src[r1 + k] - src[r0 + k]) * wz;
      }
      if (z >= size) {
        done = true;
        ax = null;
        ay = null;
      }
      return done;
    },
  };
}

/** Builds the whole texel array synchronously (tests, Node measurements). */
export function buildRockNoiseData(size = ROCK_NOISE_SIZE, period = ROCK_NOISE_PERIOD, seed?: number): Uint8Array {
  const b = createRockNoiseBuilder(size, period, seed);
  while (!b.step());
  return b.data;
}

let texture: THREE.Data3DTexture | null = null;

/**
 * The shared rock noise texture (created on first use; never disposed per material). Its texels fill in
 * slices, one per macrotask, then it uploads once (until then nothing is uploaded and it samples as black).
 */
export function getRockNoiseTexture(): THREE.Data3DTexture {
  if (texture) return texture;
  const builder = createRockNoiseBuilder();
  const t = new THREE.Data3DTexture(builder.data, ROCK_NOISE_SIZE, ROCK_NOISE_SIZE, ROCK_NOISE_SIZE);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.wrapR = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.unpackAlignment = 1;
  t.colorSpace = THREE.NoColorSpace;
  t.name = 'RockNoise3D';
  texture = t;
  const pump = (): void => {
    if (builder.step()) t.needsUpdate = true;
    else setTimeout(pump, 0);
  };
  setTimeout(pump, 0);
  return t;
}

/**
 * GLSL helper (fragment stage). One lattice cell per unit of p; .x/.y/.z/.w are four independent noises.
 */
export const ROCK_NOISE_GLSL = /* glsl */ `
uniform highp sampler3D uRockNoise;
vec4 rockTex( vec3 p ) {
	return texture( uRockNoise, p * ${(1 / ROCK_NOISE_PERIOD).toFixed(4)} );
}
`;
