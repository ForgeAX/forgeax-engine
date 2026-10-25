// @forgeax/apps-shared/rhi-debug-browser-replay -- diagnostic browser host for
// replaying the exact captured RHI-debug tape on a fresh WebGPU device.

import {
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { selectCaptureWorkIndex } from './capture-work-selection.mjs';

export interface BrowserReplayPixels {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly workIndex: number;
}

/** Replay one exact v7 tape on a fresh browser WebGPU device and read its work attachment. */
export async function replayCapturedFrameInBrowser(
  bytes: Uint8Array,
  workIndex?: number,
): Promise<BrowserReplayPixels> {
  const decoded = decodeTape(bytes);
  if (!decoded.ok) {
    throw new Error(`browser replay tape decode failed: ${decoded.error.code}`);
  }
  const tape = decoded.value;
  const model = buildFrameModel(tape);
  const selectedWorkIndex = selectCaptureWorkIndex(model, 'pixel', workIndex);
  if (selectedWorkIndex === undefined) {
    throw new Error('browser replay tape has no workIndex entries');
  }

  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) {
    throw new Error(`browser replay adapter request failed: ${adapter.error.code}`);
  }
  const device = await adapter.value.requestDevice(
    replayDeviceRequest(tape, adapter.value.features, adapter.value.limits),
  );
  if (!device.ok) {
    throw new Error(`browser replay device request failed: ${device.error.code}`);
  }

  let session: import('@forgeax/engine-rhi-debug').ReplaySession | undefined;
  try {
    const replay = await openReplay(tape, { device: device.value, createShaderModule });
    if (!replay.ok) throw new Error(`browser replay session open failed: ${replay.error.code}`);
    session = replay.value;
    const inspection = await session.inspectWork(selectedWorkIndex, ['pixels']);
    if (!inspection.ok) {
      throw new Error(
        `browser replay inspectWork(${selectedWorkIndex}) failed: ${inspection.error.code}`,
      );
    }
    const attachment = inspection.value.attachment;
    if (
      attachment?.kind !== 'texture' ||
      attachment.width === undefined ||
      attachment.height === undefined ||
      attachment.format === undefined
    ) {
      throw new Error('browser replay work attachment readback is unavailable');
    }
    return {
      pixels: attachment.bytes,
      width: attachment.width,
      height: attachment.height,
      format: attachment.format,
      workIndex: inspection.value.workIndex,
    };
  } finally {
    try {
      if (session !== undefined) await session.dispose();
    } finally {
      const native = device.value.nativeDevice();
      if (native.ok) native.value.destroy();
    }
  }
}
