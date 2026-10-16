import {
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';

/** Fresh-device raw readbacks of cloud transport and composition, before output mapping. */
export async function replayAtmosphereIntermediates(bytes: Uint8Array) {
  const tape = decodeTape(bytes).unwrap();
  const model = buildFrameModel(tape);
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
  ).unwrap();
  const replay = (await openReplay(tape, { device, createShaderModule })).unwrap();
  const rows = [];
  try {
    const cloud = model.works.find(
      (work) =>
        work.pipeline.status === 'available' &&
        work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_transport'),
    );
    if (cloud === undefined)
      throw new Error('Cloud transport missing from captured production frame');
    for (const work of model.works.filter((work) => work.workIndex >= cloud.workIndex)) {
      for (const handle of work.attachments?.colorViewHandleIds ?? []) {
        const result = (await replay.readResourceAtWork(handle, work.workIndex)).unwrap();
        rows.push({
          workIndex: work.workIndex,
          handle,
          width: result.width,
          height: result.height,
          format: result.format,
          bytes: Array.from(result.bytes),
        });
      }
    }
    return rows;
  } finally {
    (await replay.dispose()).unwrap();
  }
}
