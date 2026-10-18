import * as THREE from 'three';
import type { GearId } from '../../store/scrollStore';
import type { GearMaterialKey } from './gearGeometry';

/* ==========================================================================
 * Gear materials — physically based, tone mapped normally (sceneFx.exposure
 * reaches them through the renderer like the rest of the world).
 *
 * Procedural data textures (no DOM, no network):
 *   ripstop   nylon plain weave with the ripstop grid (normal map);
 *   webbing   tubular nylon ribs + twill (normal map);
 *   rope      kernmantle 2-over-2 braid: colour (gold sheath, navy tracer
 *             carriers, pale flecks) + normal;
 *   carbon    2/2 twill tows: colour (warp / weft sheen contrast) + normal.
 *
 * Every item gets its own material instances so a falling item can dissolve
 * (alphaHash: no transparency sorting, no program switch at fade time) and
 * flash a lock-on glint (emissive intensity) independently.
 * ========================================================================== */

export interface GearTextures {
  ripstop: THREE.DataTexture;
  webbing: THREE.DataTexture;
  ropeColor: THREE.DataTexture;
  ropeNormal: THREE.DataTexture;
  carbonColor: THREE.DataTexture;
  carbonNormal: THREE.DataTexture;
  dispose: () => void;
}

const frac = (x: number): number => x - Math.floor(x);

function dataTexture(data: Uint8Array, w: number, h: number, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Normal map (tangent space, +Z up) from a tiling height function sampled on a w × h grid. */
function normalFromHeight(w: number, h: number, height: (x: number, y: number) => number, strength: number): THREE.DataTexture {
  const hf = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) hf[y * w + x] = height(x, y);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const l = hf[y * w + ((x - 1 + w) % w)];
      const r = hf[y * w + ((x + 1) % w)];
      const d = hf[((y - 1 + h) % h) * w + x];
      const u = hf[((y + 1) % h) * w + x];
      let nx = (l - r) * strength;
      let ny = (d - u) * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * w + x) * 4;
      data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  return dataTexture(data, w, h, false);
}

function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function createGearTextures(): GearTextures {
  // Ripstop: plain weave (4 px threads) with a raised grid every 32 px.
  const ripstop = normalFromHeight(
    128,
    128,
    (x, y) => {
      const weave = Math.cos((Math.PI * x) / 2) * Math.cos((Math.PI * y) / 2) * 0.35;
      const gx = Math.min(x % 32, 32 - (x % 32));
      const gy = Math.min(y % 32, 32 - (y % 32));
      const grid = Math.max(Math.exp(-gx * gx * 0.35), Math.exp(-gy * gy * 0.35));
      return weave + grid * 0.55 + (hash2(x, y) - 0.5) * 0.12;
    },
    1.3,
  );

  // Webbing: fine ribs across the strap (v) with a slight twill along it (u).
  const webbing = normalFromHeight(
    64,
    64,
    (x, y) => {
      const rib = Math.sin((Math.PI * 2 * y) / 4);
      const twill = Math.sin((Math.PI * 2 * (x + y)) / 8) * 0.35;
      return rib * 0.8 + twill + (hash2(x + 7, y) - 0.5) * 0.1;
    },
    1.4,
  );

  // Rope sheath: 2-over-2 braid of two helical carrier families (tile: 256 along the rope × 64 around).
  const RW = 256;
  const RH = 64;
  const ropeHeight = new Float32Array(RW * RH);
  const ropeData = new Uint8Array(RW * RH * 4);
  const gold = new THREE.Color('#d9a22b');
  const goldDeep = new THREE.Color('#a66f14');
  const navy = new THREE.Color('#1d2c4d');
  const fleck = new THREE.Color('#efe6cf');
  const c = new THREE.Color();
  for (let y = 0; y < RH; y += 1) {
    for (let x = 0; x < RW; x += 1) {
      const s = x / RW;
      const t = y / RH;
      const p1 = (24 * s + 8 * t) * 2;
      const p2 = (24 * s - 8 * t) * 2;
      const c1 = Math.floor(p1);
      const c2 = Math.floor(p2);
      const over = ((c1 + c2) & 1) === 0;
      const f = over ? frac(p1) : frac(p2);
      const carrier = over ? c1 : c2;
      const bump = Math.sin(Math.PI * f);
      ropeHeight[y * RW + x] = bump * (0.75 + 0.25 * Math.sin(Math.PI * (over ? frac(p2) : frac(p1))));
      const m = ((carrier % 16) + 16) % 16;
      if (over && (m === 0 || m === 1)) c.copy(navy);
      else if (!over && m === 5) c.copy(fleck);
      else c.copy(gold).lerp(goldDeep, 0.15 + 0.35 * (1 - bump) + 0.1 * hash2(carrier, over ? 1 : 2));
      c.multiplyScalar(0.72 + 0.28 * bump);
      const i = (y * RW + x) * 4;
      // Store sRGB bytes (the texture is flagged SRGBColorSpace).
      const sr = c.clone().convertLinearToSRGB();
      ropeData[i] = Math.round(THREE.MathUtils.clamp(sr.r, 0, 1) * 255);
      ropeData[i + 1] = Math.round(THREE.MathUtils.clamp(sr.g, 0, 1) * 255);
      ropeData[i + 2] = Math.round(THREE.MathUtils.clamp(sr.b, 0, 1) * 255);
      ropeData[i + 3] = 255;
    }
  }
  const ropeColor = dataTexture(ropeData, RW, RH, true);
  const ropeNormal = normalFromHeight(RW, RH, (x, y) => ropeHeight[y * RW + x], 2.2);

  // Carbon 2/2 twill: 8 tows per 64 px tile.
  const CW = 64;
  const carbonHeight = new Float32Array(CW * CW);
  const carbonData = new Uint8Array(CW * CW * 4);
  for (let y = 0; y < CW; y += 1) {
    for (let x = 0; x < CW; x += 1) {
      const i0 = Math.floor(x / 8);
      const j0 = Math.floor(y / 8);
      const warpOver = ((i0 + j0) & 3) < 2;
      const fx = ((x % 8) + 0.5) / 8;
      const fy = ((y % 8) + 0.5) / 8;
      const bump = warpOver ? Math.sin(Math.PI * fx) : Math.sin(Math.PI * fy);
      carbonHeight[y * CW + x] = bump;
      const base = warpOver ? 0.07 + 0.05 * bump : 0.035 + 0.025 * bump;
      const k = (y * CW + x) * 4;
      const sr = Math.pow(base, 1 / 2.2);
      carbonData[k] = Math.round(sr * 255 * 0.96);
      carbonData[k + 1] = Math.round(sr * 255 * 0.98);
      carbonData[k + 2] = Math.round(sr * 255);
      carbonData[k + 3] = 255;
    }
  }
  const carbonColor = dataTexture(carbonData, CW, CW, true);
  const carbonNormal = normalFromHeight(CW, CW, (x, y) => carbonHeight[y * CW + x], 0.9);

  const all = [ripstop, webbing, ropeColor, ropeNormal, carbonColor, carbonNormal];
  return {
    ripstop,
    webbing,
    ropeColor,
    ropeNormal,
    carbonColor,
    carbonNormal,
    dispose: () => {
      for (const t of all) t.dispose();
    },
  };
}

export type GearMaterial = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;

/** Warm lock-on glint colour (linear). */
export const GEAR_GLINT_COLOR = new THREE.Color('#ffd9a8');

const GLINT_UNIFORMS = new WeakMap<THREE.Material, { value: number }>();

/**
 * Lock-on glint: a warm Fresnel rim (bright at the silhouette, a faint fill face-on) added to the emissive
 * radiance, so the snap reads as a highlight sweeping the tool while its shading and detail stay intact.
 * One shared program for every gear material (same onBeforeCompile source); the strength is a per-material
 * uniform, so changing it never recompiles.
 */
function addRimGlint(m: GearMaterial): void {
  const glint = { value: 0 };
  const color = { value: GEAR_GLINT_COLOR };
  GLINT_UNIFORMS.set(m, glint);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uGearGlint = glint;
    shader.uniforms.uGearGlintColor = color;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGearGlint;\nuniform vec3 uGearGlintColor;')
      .replace(
        '#include <emissivemap_fragment>',
        [
          '#include <emissivemap_fragment>',
          'if ( uGearGlint > 0.0 ) {',
          '  float gearRim = 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) );',
          '  totalEmissiveRadiance += uGearGlintColor * uGearGlint * ( 0.06 + 1.6 * gearRim * gearRim * gearRim );',
          '}',
        ].join('\n'),
      );
  };
}

/** Sets the lock-on glint strength (0..1) of a gear material. */
export function setGearGlint(m: GearMaterial, strength: number): void {
  const u = GLINT_UNIFORMS.get(m);
  if (u) u.value = strength;
}

/** Creates the material for one slot of one item. Falling items (everything but the backpack) dissolve with alphaHash. */
export function createGearMaterial(key: GearMaterialKey, item: GearId, textures: GearTextures): GearMaterial {
  const fades = item !== 'backpack';
  const common = { vertexColors: true, alphaHash: fades } as const;
  let m: GearMaterial;
  switch (key) {
    case 'packFabric':
      m = new THREE.MeshPhysicalMaterial({
        ...common,
        roughness: 0.8,
        metalness: 0,
        sheen: 0.4,
        sheenRoughness: 0.55,
        sheenColor: new THREE.Color('#e7b0a2'),
        normalMap: textures.ripstop,
        normalScale: new THREE.Vector2(0.32, 0.32),
        specularIntensity: 0.5,
      });
      break;
    case 'packDark':
      m = new THREE.MeshPhysicalMaterial({
        ...common,
        roughness: 0.86,
        metalness: 0,
        sheen: 0.35,
        sheenRoughness: 0.6,
        sheenColor: new THREE.Color('#8d96a6'),
        normalMap: textures.ripstop,
        normalScale: new THREE.Vector2(0.4, 0.4),
        specularIntensity: 0.45,
      });
      break;
    case 'webbing':
      m = new THREE.MeshStandardMaterial({ ...common, roughness: 0.84, metalness: 0, normalMap: textures.webbing, normalScale: new THREE.Vector2(0.75, 0.75) });
      break;
    case 'sling':
      m = new THREE.MeshStandardMaterial({ ...common, roughness: 0.78, metalness: 0, normalMap: textures.webbing, normalScale: new THREE.Vector2(0.6, 0.6) });
      break;
    case 'plastic':
      m = new THREE.MeshStandardMaterial({ ...common, roughness: 0.42, metalness: 0 });
      break;
    case 'metal':
      m = new THREE.MeshStandardMaterial({ ...common, roughness: 0.3, metalness: 1 });
      break;
    case 'anodized':
      m = new THREE.MeshStandardMaterial({ ...common, roughness: 0.34, metalness: 0.88 });
      break;
    case 'steel':
      m = new THREE.MeshStandardMaterial({ ...common, color: new THREE.Color('#d6dae0'), roughness: 0.24, metalness: 1 });
      break;
    case 'rubber':
      m = new THREE.MeshStandardMaterial({ ...common, roughness: 0.9, metalness: 0 });
      break;
    case 'rope':
      m = new THREE.MeshStandardMaterial({
        ...common,
        map: textures.ropeColor,
        normalMap: textures.ropeNormal,
        normalScale: new THREE.Vector2(0.9, 0.9),
        roughness: 0.82,
        metalness: 0,
      });
      break;
    case 'carbon':
      m = new THREE.MeshPhysicalMaterial({
        ...common,
        map: textures.carbonColor,
        normalMap: textures.carbonNormal,
        normalScale: new THREE.Vector2(0.3, 0.3),
        roughness: 0.4,
        metalness: 0.1,
        clearcoat: 1,
        clearcoatRoughness: 0.1,
      });
      break;
    default: {
      const never: never = key;
      throw new Error(`unknown gear material ${String(never)}`);
    }
  }
  m.name = `Gear.${item}.${key}`;
  addRimGlint(m);
  return m;
}
