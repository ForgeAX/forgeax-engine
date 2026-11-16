import { Materials } from '@forgeax/engine/render';
import { nativeRuntime } from './native-renderer.js';

const converted = new WeakMap();
const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const srgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
function textureHandle(texture, mode) {
  let variants = converted.get(texture);
  if (!variants) {
    variants = new Map();
    converted.set(texture, variants);
  }
  if (variants.has(mode)) return variants.get(mode);
  const mips = texture.mipmaps.length ? texture.mipmaps : [texture];
  const chunks = mips.map((mip) => {
    const out = new Uint8Array(mip.data);
    if (out.length !== mip.width * mip.height * 4)
      throw new Error('Expected RGBA8 KTX2 transcode for RobRun surface conversion');
    for (let i = 0; i < out.length; i += 4) {
      if (mode === 'normal') {
        const x = out[i] / 127.5 - 1,
          y = out[i + 1] / 127.5 - 1;
        out[i + 2] = Math.round((Math.sqrt(Math.max(0, 1 - x * x - y * y)) + 1) * 127.5);
      } else if (mode === 'gray') {
        const l =
          linear(out[i] / 255) * 0.2126 +
          linear(out[i + 1] / 255) * 0.7152 +
          linear(out[i + 2] / 255) * 0.0722;
        out[i] = out[i + 1] = out[i + 2] = Math.round(srgb(l) * 255);
      }
    }
    return out;
  });
  const data = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  const color = mode !== 'normal';
  const handle = nativeRuntime()
    .assets.create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: texture.width, height: texture.height } },
      format: color ? 'rgba8unorm-srgb' : 'rgba8unorm',
      colorSpace: color ? 'srgb' : 'linear',
      mips: { kind: 'packed', levelCount: chunks.length },
      data,
    })
    .unwrap();
  variants.set(mode, handle);
  return handle;
}
export function syncNativeMaterial(entry) {
  const { material: m, flags } = entry;
  const assets = nativeRuntime().assets;
  const base = m.map ? textureHandle(m.map, flags.desaturate ? 'gray' : 'color') : undefined;
  const normal = m.normalMap ? textureHandle(m.normalMap, 'normal') : undefined;
  const payload = Materials.standard({
    baseColor: [...m.color, m.opacity],
    metallic: 0,
    roughness: flags.roughnessInAlpha && base ? 1 : m.roughness,
    emissive: m.emissive,
    normalScale: [1, -1],
    alphaMode: m.transparent || flags.masked ? 'preserve' : 'opaque',
    alphaCutoff: flags.masked ? m.alphaTest : 0,
    ...(base ? { baseColorTexture: base } : {}),
    ...(normal ? { normalTexture: normal } : {}),
    ...(flags.roughnessInAlpha && base ? { roughnessTexture: base, roughnessChannel: 3 } : {}),
    queue: m.transparent ? 3000 : 2000,
    renderState: {
      cullMode: m.side === 2 ? 'none' : 'back',
      depthWriteEnabled: m.depthWrite,
      ...(m.transparent
        ? {
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          }
        : {}),
      ...(m.polygonOffset
        ? {
            depthBias: Math.trunc(m.polygonOffsetUnits),
            depthBiasSlopeScale: m.polygonOffsetFactor,
          }
        : {}),
    },
  });
  if (!m.userData.nativeHandle) m.userData.nativeHandle = assets.create(payload).unwrap();
  else {
    const { kind, ...patch } = payload;
    assets.update(m.userData.nativeHandle, patch).unwrap();
  }
}
