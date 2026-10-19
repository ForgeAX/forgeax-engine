import { encodeBase64 } from '@forgeax/engine/types';
import { buildFrameModel, decodeTape, imageStats, openReplay, readbackImage, replayDeviceRequest, tapeDigest, toRgba8 } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { VFX_PARTICLE_CORE_LAYOUT, vfxParticleCoreField } from '@forgeax/engine-vfx';

/** Diagnostic carrier only: call after disposing the original App. */
export async function replaySdfEvidence(bytes: Uint8Array, collision: boolean) {
  const tape = decodeTape(bytes).unwrap();
  const model = buildFrameModel(tape);
  const update = model.works.find(work => work.pipeline?.shaders?.some(shader =>
    shader.entryPoint === 'forgeax_vfx_update_main'));
  if (update === undefined) throw new Error('Captured ordinary VFX update missing');
  const particle = update.bindings.find(binding => binding.binding === 0)?.resourceId;
  const sdf = update.bindings.find(binding => binding.binding === 15)?.resourceId;
  if (particle == null || (sdf != null) !== collision) throw new Error('Captured binding contract mismatch');
  const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))).unwrap();
  const replay = (await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })).unwrap();
  try {
    const read = (await replay.readResourceAtWork(particle, update.workIndex)).unwrap();
    const { stride, fingerprint } = VFX_PARTICLE_CORE_LAYOUT;
    if (read.bytes.byteLength !== 1024 * stride) throw new Error('Unexpected particle buffer extent');
    const data = new DataView(read.bytes.buffer, read.bytes.byteOffset, read.bytes.byteLength);
    const vector = (index: number, name: 'position' | 'velocity' | 'color', lanes: number) =>
      Array.from({ length: lanes }, (_, lane) => data.getFloat32(index * stride +
        vfxParticleCoreField(name).offset + lane * 4, true));
    const records = Array.from({ length: 1024 }, (_, index) => ({
      position: vector(index, 'position', 3), velocity: vector(index, 'velocity', 3),
      color: vector(index, 'color', 4),
      alive: data.getUint32(index * stride + vfxParticleCoreField('alive').offset, true),
    }));
    const raster = [...model.works].reverse().find(work => work.kind.startsWith('draw'));
    if (raster === undefined) throw new Error('Captured raster output missing');
    const pixels = (await replay.inspectWork(raster.workIndex, ['pixels'])).unwrap().attachment;
    if (pixels === undefined) throw new Error('Fresh replay has no pixels');
    const image = readbackImage(pixels).unwrap();
    if (imageStats(image).nonFinite !== 0) throw new Error('Fresh replay has non-finite pixels');
    const rgba = toRgba8(image);
    return { tapeDigest: tapeDigest(bytes), bindings: update.bindings, updateWorkIndex: update.workIndex,
      particle, sdf, coreLayout: { stride, fingerprint }, originalDisposedBeforeReplay: true,
      records, green: records.filter(record => (record.color[1] ?? 0) > 0.9 && (record.color[0] ?? 0) < 0.3).length,
      red: records.filter(record => (record.color[0] ?? 0) > 0.9).length,
      pixels: { bytes: encodeBase64(rgba), width: image.width, height: image.height, encoding: 'rgba8',
        format: pixels.format, resourceId: pixels.resourceId, provenance: { ...pixels.provenance,
          subresource: pixels.provenance.subresource === null ? null : { ...pixels.provenance.subresource } },
        display: { exposure: 1, range: [0, 1], tonemap: 'clamp' } } };
  } finally {
    (await replay.dispose()).unwrap();
    webgpu._internal_getRawDevice(device)?.destroy();
  }
}
