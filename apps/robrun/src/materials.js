import { syncNativeMaterial } from './native-materials.js';
import { createTextureDecoder } from './textures.js';

const CONCURRENCY = 6,
  MUL = 0.6,
  FLAT_MAX = 1.2,
  FLAT_UNTEX = 0.7,
  TINT_MAX = 1.5;
const DEFAULT = [0.32, 0.32, 0.32],
  PROXY = [0.15, 0.15, 0.16];
const GLASS = [0.03, 0.045, 0.05];
const lin = (e) => (e <= 0.04045 ? e / 12.92 : ((e + 0.055) / 1.055) ** 2.4);
const lum = (c) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
const gray = (c) => [lum(c), lum(c), lum(c)];

export function createMaterials(
  scene,
  texIndex,
  texBase,
  { normals = true, onChange = () => {} } = {},
) {
  const defs = scene.materials,
    hashes = scene.textures;
  const decoder = createTextureDecoder();
  const entries = new Map(),
    texCache = new Map(),
    queue = [];
  let active = 0,
    loaded = 0;

  const mean = (t) => {
    const l = texIndex[hashes[t]];
    return l ? [lin(l[2] / 255), lin(l[3] / 255), lin(l[4] / 255)] : null;
  };

  function factor(d) {
    const l = d.base >= 0 ? mean(d.base) : null;
    if (!d.flat || !l || d.paint) {
      return d.tintMul && d.tint
        ? d.tint.map((k) => Math.min(TINT_MAX, Math.max(0.1, k * 2)))
        : [1, 1, 1];
    }
    return (d.desaturate ? gray(l) : l).map((k, i) =>
      Math.min(FLAT_MAX, Math.max(0.3, Math.max(d.flat[i], 0) / Math.max(k, 0.01))),
    );
  }

  function surface(d) {
    const k = d.base >= 0 ? mean(d.base) : null;
    if (k) {
      const f = factor(d);
      return (d.desaturate ? gray(k) : k).map((v, i) => v * f[i]);
    }
    return d.flat
      ? d.flat.map((t) => Math.max(t, 0) * FLAT_UNTEX)
      : d.tint
        ? d.tint
        : d.proxy
          ? PROXY
          : DEFAULT;
  }
  const color = (d, hasMap) => (hasMap ? factor(d) : surface(d)).map((v) => v * MUL);

  function initialMaterial(d, transparent) {
    return {
      userData: {},
      visible: true,
      alphaTest: 0,
      map: null,
      normalMap: null,
      normalScale: [1, -1],
      emissive: [0, 0, 0],
      color: d.glass ? GLASS : color(d, false),
      roughness: d.glass ? 0.08 : 0.85,
      metalness: 0,
      side: d.twoSided || d.foliage || d.glass ? 2 : 0,
      transparent,
      depthWrite: !transparent,
      opacity: d.glass ? 0.35 : transparent ? 0.6 : 1,
      polygonOffset: transparent,
      polygonOffsetFactor: transparent ? -2 : 0,
      polygonOffsetUnits: transparent ? -2 : 0,
    };
  }

  function create(id) {
    const d = defs[id] ?? { base: -1, normal: -1, blend: 'opaque' };
    const meanAlpha = d.base >= 0 ? (texIndex[hashes[d.base]]?.[5] ?? 255) : 255;
    const masked = d.blend === 'masked' && (d.alpha === 'o' || (!d.alpha && meanAlpha < 250));
    const transparent =
      !!d.glass || d.blend === 'translucent' || d.blend === 'additive' || d.blend === 'modulate';
    const material = initialMaterial(d, transparent);
    if (d.emissive && d.emissive[0] + d.emissive[1] + d.emissive[2] > 0) {
      material.emissive = d.emissive.map((v) => Math.min(v, 4));
    }
    const dead = d.blend === 'hidden' || (d.blend === 'masked' && d.base < 0 && !d.glass);
    if (dead || masked) material.visible = false;
    const flags = { roughnessInAlpha: d.alpha === 'r', masked, desaturate: !!d.desaturate };
    const e = { def: d, material, flags, dead, transparent, tier: 0, wanted: 0, loading: false };
    syncNativeMaterial(e);
    entries.set(id, e);
    return e;
  }
  const entry = (id) => entries.get(id) ?? create(id);

  function texture(hash, small) {
    const url = `${texBase}/${hash}${small ? '-s' : ''}.ktx2`;
    let p = texCache.get(url);
    if (!p) {
      p = fetch(url).then(async (response) => {
        if (!response.ok) throw new Error(`Texture request failed: ${response.status} ${url}`);
        const decoded = await decoder.decode(new Uint8Array(await response.arrayBuffer()));
        loaded++;
        return decoded;
      });
      texCache.set(url, p);
    }
    return p;
  }

  function want(id, tier) {
    const e = entry(id);
    if (e.dead || e.def.base < 0 || e.wanted >= tier) return;
    e.wanted = tier;
    if (!e.loading) queue.push(id);
    pump();
  }
  function pump() {
    while (active < CONCURRENCY && queue.length) {
      const id = queue.shift(),
        e = entries.get(id);
      if (e.loading || e.tier >= e.wanted) continue;
      e.loading = true;
      active++;
      const tier = e.wanted,
        m = e.material;
      const jobs = [
        texture(hashes[e.def.base], tier === 1).then((t) => {
          if (!t) return;
          m.map = t;
          m.color = color(e.def, true);
          if (e.flags.masked) {
            m.alphaTest = e.def.clip ?? 0.33;
            m.visible = true;
          }
        }),
      ];
      if (tier === 2 && normals && e.def.normal >= 0) {
        jobs.push(
          texture(hashes[e.def.normal], false).then((t) => {
            if (t) {
              m.normalMap = t;
              m.normalScale = [1, -1];
            }
          }),
        );
      }
      Promise.all(jobs).finally(() => {
        e.tier = tier;
        e.loading = false;
        m.needsUpdate = true;
        active--;
        if (e.wanted > e.tier) queue.push(id);
        syncNativeMaterial(e);
        onChange();
        pump();
      });
    }
  }

  return {
    entry,
    want,
    get: (id) => entry(id).material,
    pending: () => queue.length + active,
    loaded: () => loaded,
  };
}
