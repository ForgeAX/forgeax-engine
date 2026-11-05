import { createBakeCooker, hash2, mipChain, valueNoise, type BakeMapKind } from '@forgeax/engine/modeling';
import type { TextureAsset } from '@forgeax/engine/types';
import { type ConvoyFinish, convoyFinishKey, readConvoyFinish, writeConvoyFinish } from './convoy-finish-cache.ts';

export const CONVOY_FINISH_KIND = 'game-3d-convoy-finish';
export const CONVOY_FINISH_VERSION = 'convoy-surface/6';
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const byte = (n: number) => Math.round(clamp(n) * 255);


function packedTexture(texture: TextureAsset, options: Parameters<typeof mipChain>[1]): TextureAsset {
  const chain = mipChain(texture, options);
  if (!chain.ok) throw chain.error;
  const data = new Uint8Array(chain.value.levels.reduce((sum, level) => sum + level.length, 0));
  let offset = 0;
  for (const level of chain.value.levels) { data.set(level, offset); offset += level.length; }
  return { ...texture, data, mips: { kind: 'packed', levelCount: chain.value.levels.length } };
}

/** Repeating hardware shares microfinish; it does not consume the armor's unique bake atlas. */
export function convoyHardwareTextures(): Record<string, TextureAsset> {
  const size = 256, brushed = new Uint8Array(size * size * 4), rubber = brushed.slice(), ormh = brushed.slice();
  const putNormal = (data: Uint8Array, i: number, x: number, y: number) => {
    data.set([byte(x * 0.5 + 0.5), byte(y * 0.5 + 0.5), byte(Math.sqrt(1 - x * x - y * y) * 0.5 + 0.5), 255], i);
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, grain = hash2(x, y, 83) - 0.5;
    putNormal(brushed, i, (hash2(0, y, 31) - 0.5) * 0.14, grain * 0.018);
    putNormal(rubber, i, grain * 0.2, (hash2(x, y, 91) - 0.5) * 0.2);
    ormh.set([255, byte(0.9 + grain * 0.18), 255, 128], i);
  }
  const texture = (data: Uint8Array): TextureAsset => ({ kind: 'texture', format: 'rgba8unorm', colorSpace: 'linear', shape: { viewDimension: '2d', extent: { width: size, height: size } }, data, mips: { kind: 'none' } });
  return {
    'texture/convoy-brushed-normal': packedTexture(texture(brushed), { layout: 'normal' }),
    'texture/convoy-rubber-normal': packedTexture(texture(rubber), { layout: 'normal' }),
    'texture/convoy-hardware-ormh': packedTexture(texture(ormh), { layout: 'ormh', roughnessFromNormal: texture(brushed) }),
  };
}

function finishSurface(color: Uint8Array, ormh: Uint8Array, emission: Uint8Array, i: number) {
  const [r, g, b] = [color[i]! / 255, color[i + 1]! / 255, color[i + 2]! / 255];
  const glowing = emission[i]! + emission[i + 1]! + emission[i + 2]! > 0;
  const painted = !glowing && ((r > g * 1.7 && r > b * 1.5) || (b > r * 1.7 && b > g * 1.6));
  const metal = ormh[i + 2]! > 140;
  const glass = !painted && !metal && b > r * 1.6 && g > r * 1.5 && !glowing;
  const rubber = !metal && !painted && !glass && Math.max(r, g, b) < 0.12;
  return { painted, metal, glass, rubber };
}

function blendMicroNormal(normal: Uint8Array, i: number, dx: number, dy: number) {
  // Reoriented normal mapping layers microfinish over the actual baked high surface.
  const nx = normal[i]! / 127.5 - 1, ny = normal[i + 1]! / 127.5 - 1, nz = normal[i + 2]! / 127.5 - 1;
  const dz = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));
  const dot = -nx * dx - ny * dy + (nz + 1) * dz;
  const rx = nz > -0.99999 ? nx * dot / (nz + 1) + dx : dx, ry = nz > -0.99999 ? ny * dot / (nz + 1) + dy : -dy, rz = nz > -0.99999 ? dot - dz : -dz;
  const length = Math.hypot(rx, ry, rz);
  normal[i] = byte(rx / length * 0.5 + 0.5); normal[i + 1] = byte(ry / length * 0.5 + 0.5); normal[i + 2] = byte(rz / length * 0.5 + 0.5);
}

function finishWeathering(position: Uint8Array, wear: Uint8Array, cavity: Uint8Array, i: number, painted: boolean) {
  const x = position[i]! / 255, y = position[i + 1]! / 255, z = position[i + 2]! / 255;
  // Object-space patches remain attached to each rigid part when it folds.
  const patch = valueNoise(x + z * 0.73, y, 16, 71);
  const grain = valueNoise(x - z * 0.41, y * 0.7, 48, 19);
  const streak = valueNoise(x + z * 0.29, y * 0.15, 24, 31);
  const edge = wear[i]! / 255;
  const chip = painted ? clamp((edge - 0.7) * 4) * clamp((patch - 0.67) * 7) : 0;
  const scratch = painted && grain > 0.66 && streak > 0.59 ? (grain - 0.66) * 1.4 : 0;
  const exposed = clamp(chip * 0.32 + scratch * 0.5);
  const dirt = clamp(cavity[i]! / 255 * 0.48 + (streak - 0.36) * 0.22);
  return { patch, exposed, dirt };
}

function deliveryMips(raw: Readonly<Record<string, TextureAsset>>) {
  const out: Record<string, TextureAsset> = {};
  for (const name of ['normal', 'ormh', 'baseColor', 'emissive', 'coat']) {
    const texture = raw[name]!;
    out[name] = packedTexture(texture, { layout: name === 'normal' ? 'normal' : name === 'ormh' ? 'ormh' : 'color', ...(name === 'ormh' ? { roughnessFromNormal: raw.normal } : {}) });
  }
  return out;
}

/** Surface paint stays in the baked atlas: no runtime noise or per-part materials. */
export function finishConvoyTextures(maps: Readonly<Record<string, TextureAsset>>) {
  const pixels = (name: string) => maps[name]!.data as Uint8Array;
  const color = pixels('baseColor').slice(), ormh = pixels('ormh').slice();
  const coat = new Uint8Array(color.length), normal = pixels('normal').slice();
  const width = maps.baseColor!.shape.extent.width;
  const emission = pixels('emissive');
  const position = pixels('position'), wear = pixels('edgeWear'), cavity = pixels('cavity');
  for (let i = 0; i < color.length; i += 4) {
    const { painted, metal, glass, rubber } = finishSurface(color, ormh, emission, i);
    const pixel = i / 4, px = pixel % width, py = Math.floor(pixel / width);
    const grit = hash2(px, py, 17);
    const brushed = valueNoise(px * 0.035, py, 1, 31);
    const pore = valueNoise(px, py, 0.35, 49);
    const fine = rubber ? (pore - 0.5) * 0.2 : metal ? (brushed - 0.5) * 0.1 : painted ? (grit - 0.5) * 0.03 : 0;
    const dx = fine, dy = metal ? fine * 0.15 : (hash2(px, py, 73) - 0.5) * (rubber ? 0.16 : painted ? 0.03 : 0);
    blendMicroNormal(normal, i, dx, dy);
    const { patch, exposed, dirt } = finishWeathering(position, wear, cavity, i, painted);
    for (let c = 0; c < 3; c++) {
      const paint = color[i + c]! / 255;
      const steel = [0.46, 0.49, 0.51][c]!;
      const surfaceGrain = rubber ? 0.8 + pore * 0.3 : metal ? 0.94 + brushed * 0.1 : 0.98 + grit * 0.035;
      color[i + c] = byte((paint * (1 - exposed) + steel * exposed) * (1 - dirt) * surfaceGrain);
    }
    const rough = ormh[i + 1]! / 255;
    const micro = (grit - 0.5) * (rubber ? 0.1 : painted ? 0.035 : 0.075) + (metal ? (brushed - 0.5) * 0.12 : 0);
    ormh[i + 1] = byte(rough + (patch - 0.5) * (painted ? 0.08 : 0.04) + micro + dirt * 0.2 + exposed * 0.17);
    ormh[i + 2] = byte(ormh[i + 2]! / 255 * (1 - exposed) + exposed * 0.92);
    // Clearcoat is restricted to intact enamel and glass; rubber and bare steel stay dry.
    coat[i] = byte(painted ? 1 - exposed : glass ? 0.75 : 0);
    coat[i + 1] = byte((glass ? 0.035 : 0.09) + dirt * 0.35 + exposed * 0.25);
    coat[i + 3] = 255;
  }
  const raw: Record<string, TextureAsset> = { ...maps,
    baseColor: { ...maps.baseColor!, data: color },
    normal: { ...maps.normal!, data: normal },
    ormh: { ...maps.ormh!, data: ormh },
    coat: { ...maps.ormh!, data: coat },
  };
  return deliveryMips(raw);
}

/** One Engine bake job, then deterministic paint/roughness/coat and delivery mips. */
export function createConvoyCooker(): ReturnType<typeof createBakeCooker> {
  const baker = createBakeCooker();
  const pending = new Map<string, Promise<ConvoyFinish>>();
  let previous: { signature: string; value: ConvoyFinish } | undefined;
  return {
    key: CONVOY_FINISH_KIND, timeoutMs: 180000,
    cacheIdentity: async () => `${await baker.cacheIdentity?.()}:${CONVOY_FINISH_VERSION}`,
    async cook(input, context) {
      const { finishMap, ...provided } = input.source as Record<string, unknown>;
      const source: Record<string, unknown> = { ...provided, params: structuredClone(provided.params) };
      const signature = convoyFinishKey([await baker.cacheIdentity?.(), CONVOY_FINISH_VERSION, source.base, source.detail, source.params]);
      let job = pending.get(signature);
      if (job === undefined) {
        job = previous?.signature === signature ? Promise.resolve(previous.value) : (async () => {
          const restored = readConvoyFinish(context?.cache, signature);
          if (restored !== undefined) return restored;
          const maps: Record<string, TextureAsset> = {}, facts: ConvoyFinish['facts'] = {};
          for (const map of (source.params as { maps: BakeMapKind[] }).maps) {
            const { payload, guid: _guid, ...fact } = await baker.cook({ ...input, source: { ...source, map, mips: false } }, context);
            maps[map] = payload;
            facts[map] = fact;
          }
          const value = { textures: finishConvoyTextures(maps), facts };
          writeConvoyFinish(context?.cache, signature, value);
          return value;
        })();
        pending.set(signature, job);
      }
      try {
        const value = await job;
        // Retain one completed atlas; in-flight recipes coalesce independently.
        previous = { signature, value };
        const map = typeof finishMap === 'string' ? finishMap : String(source.map);
        if (!Object.hasOwn(value.textures, map)) throw new Error(`Unknown convoy finish map: ${map}`);
        const fact = value.facts[String(source.map)]!;
        return { ...fact, guid: input.guid, payload: value.textures[map]!, inputFingerprint: `${fact.inputFingerprint}:${CONVOY_FINISH_VERSION}:${map}` };
      } finally {
        if (pending.get(signature) === job) pending.delete(signature);
      }
    },
  };
}
