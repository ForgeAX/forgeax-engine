import { halfToFloat } from '../../../packages/rhi-debug/dist/index.mjs';

const assert = (value, message) => {
  if (!value) throw new Error(message);
};
assert.equal = (a, b) => assert(a === b, `Expected ${a} to equal ${b}`);

/** Read each raster producer at its selected tape work, on any real replay backend. */
export async function inspectRasterStages(model, replay, save) {
  const entry = (work, name) => work.pipeline.shaders.some((shader) => shader.entryPoint === name);
  const gbuffer = model.works.filter((work) => entry(work, 'fs_gbuffer'));
  const lighting = model.works.filter((work) => entry(work, 'fs_standard_deferred'));
  assert(gbuffer.length > 0, 'Ordinary Standard G-buffer work is required');
  assert(lighting.length > 0, 'Ordinary Standard direct-light work is required');
  const lastGeometry = gbuffer.at(-1),
    lastLighting = lighting.at(-1);
  assert(lastGeometry.workIndex < lighting[0].workIndex);
  assert(
    [5, 6].includes(lastGeometry.attachments.colorViewHandleIds.length),
    'Expected Standard material attachments and an optional visible-surface target',
  );
  const attachmentIds = lastGeometry.attachments.colorViewHandleIds;
  for (const id of attachmentIds.slice(1, 5))
    assert(
      lighting[0].bindings.some((binding) => binding.resourceId === id),
      'Lighting must read geometry-owned material data',
    );
  const records = [];
  const read = async (label, id, workIndex, subresource) => {
    const result = (await replay.readResourceAtWork(id, workIndex, subresource)).unwrap();
    await save(`${label}.bin`, result.bytes);
    records.push({
      label,
      resourceId: id,
      workIndex,
      format: result.format,
      width: result.width,
      height: result.height,
      bytes: result.bytes.length,
    });
    return result;
  };
  const depth = await read(
    'depth',
    lastGeometry.attachments.depthStencilViewHandleId,
    lastGeometry.workIndex,
    { mipLevel: 0, arrayLayer: 0, aspect: 'depth-only' },
  );
  const normal = await read('normal-roughness', attachmentIds[1], lastGeometry.workIndex);
  if (attachmentIds[5]) await read('visible-surface', attachmentIds[5], lastGeometry.workIndex);
  const albedo = await read('albedo-metallic', attachmentIds[3], lastGeometry.workIndex);
  await read('f0-occlusion', attachmentIds[2], lastGeometry.workIndex);
  const emission = await read('emission', attachmentIds[0], lastGeometry.workIndex);
  const direct = await read(
    'direct-hdr',
    lastLighting.attachments.colorViewHandleIds[0],
    lastLighting.workIndex,
  );
  const viewBinding = lastLighting.bindings.find(
    (binding) => binding.groupIndex === 0 && binding.binding === 0,
  );
  assert(viewBinding?.resourceId, 'Captured lighting view uniform is required');
  await read('view', viewBinding.resourceId, lastLighting.workIndex, {
    offset: viewBinding.bufferOffset ?? 0,
    ...(viewBinding.bufferSize === null ? {} : { size: viewBinding.bufferSize }),
  });
  const words = (r) => new Uint32Array(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength / 4);
  const n = words(normal),
    a = words(albedo),
    d = new Float32Array(depth.bytes.buffer, depth.bytes.byteOffset, depth.bytes.byteLength / 4);
  const hdr = Array.from(
    new Uint16Array(direct.bytes.buffer, direct.bytes.byteOffset, direct.bytes.byteLength / 2),
    halfToFloat,
  );
  const emitted = Array.from(
    new Uint16Array(
      emission.bytes.buffer,
      emission.bytes.byteOffset,
      emission.bytes.byteLength / 2,
    ),
    halfToFloat,
  );
  const images = Object.fromEntries(
    ['depth', 'normal', 'albedo', 'direct'].map((key) => [key, new Uint8Array(d.length * 4)]),
  );
  let covered = 0,
    background = 0,
    directEnergy = 0,
    emissionEnergy = 0;
  for (let i = 0; i < d.length; i++) {
    assert(Number.isFinite(d[i]) && d[i] >= 0 && d[i] <= 1, `Invalid depth at ${i}`);
    if (d[i] > 0) covered++;
    else background++;
    let x = (n[i] & 4095) * (2 / 4095) - 1;
    let y = ((n[i] >>> 12) & 4095) * (2 / 4095) - 1;
    const z = 1 - Math.abs(x) - Math.abs(y),
      fold = Math.max(-z, 0);
    x += x >= 0 ? -fold : fold;
    y += y >= 0 ? -fold : fold;
    const length = Math.hypot(x, y, z);
    for (let c = 0; c < 3; c++) {
      const value = hdr[i * 4 + c];
      assert(Number.isFinite(value) && value >= 0, `Invalid direct radiance at ${i}`);
      directEnergy += value;
      emissionEnergy += emitted[i * 4 + c];
      images.normal[i * 4 + c] =
        d[i] > 0 ? Math.round((([x, y, z][c] / length) * 0.5 + 0.5) * 255) : 0;
      images.albedo[i * 4 + c] = d[i] > 0 ? (a[i] >>> (c * 8)) & 255 : 0;
      images.depth[i * 4 + c] = d[i] > 0 ? Math.round(Math.min(1, d[i] ** 0.25) * 255) : 0;
      images.direct[i * 4 + c] = Math.round((value / (1 + value)) ** (1 / 2.2) * 255);
    }
    for (const pixels of Object.values(images)) pixels[i * 4 + 3] = 255;
  }
  assert(covered > d.length / 2, 'Sponza must cover the selected view');
  assert(emissionEnergy === 0, 'Baseline requires non-emissive original Sponza materials');
  for (const [label, pixels] of Object.entries(images)) await save(`${label}.rgba`, pixels);
  return {
    geometryWorks: gbuffer.map((w) => w.workIndex),
    lightingWorks: lighting.map((w) => w.workIndex),
    shadowWorks: model.works.filter((w) => entry(w, 'fs_shadow')).map((w) => w.workIndex),
    temporalWorks: model.works.filter((w) => entry(w, 'fs_temporal')).map((w) => w.workIndex),
    width: depth.width,
    height: depth.height,
    covered,
    background,
    directEnergy,
    emissionEnergy,
    records,
  };
}
