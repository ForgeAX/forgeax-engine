import type { Buffer, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import type { StandardExactDiffuseGi } from '../pipeline/standard-profile';
import type { CameraSnapshot } from '../render-contract';
import type { TemporalResetReason, TemporalView } from '../temporal/view';
import { createDiffuseReconstruction, DIFFUSE_HISTORY_BYTES } from './diffuse-reconstruction';

/** History is owned by the same content preparation and submitted-sample counter as raw GI. */
export function prepareRendererDiffuseReconstruction(
  device: RhiDevice,
  module: ShaderModule,
  pixels: number,
  mode: NonNullable<StandardExactDiffuseGi['reconstruction']>,
  allocate: (label: string, bytes: number, usage: number) => Buffer,
  submittedSamples: () => number,
  /** Resource label prefix; Lite reflections reuse this owner for their signal. */
  label: 'ray-diffuse' | 'ray-reflection' = 'ray-diffuse',
) {
  const histories = [
    allocate(`${label}.history-a`, pixels * DIFFUSE_HISTORY_BYTES, 128 | 12),
    allocate(`${label}.history-b`, pixels * DIFFUSE_HISTORY_BYTES, 128 | 12),
  ] as const;
  const signal = allocate(`${label}.signal`, pixels * 16, 128 | 12);
  const diagnostics = allocate(`${label}.diagnostics`, pixels * 16, 128 | 12);
  const config = allocate(`${label}.reconstruction-config`, 48, 64 | 8);
  const kernel = createDiffuseReconstruction(device, module).unwrap();
  type HistoryCommit = {
    readonly view: TemporalView;
    readonly projection: string;
    readonly resetReason:
      | TemporalResetReason
      | 'content-generation'
      | 'projection-change'
      | 'history-gap'
      | undefined;
    readonly historyUsed: boolean;
  };
  let accepted: HistoryCommit | undefined;
  let pending: HistoryCommit | undefined;
  return {
    mode,
    signal,
    diagnostics,
    config,
    kernel,
    get current() {
      return histories[submittedSamples() % 2 === 0 ? 0 : 1];
    },
    get previous() {
      return histories[submittedSamples() % 2 === 0 ? 1 : 0];
    },
    prepare(view: TemporalView, previousView: TemporalView | undefined, camera: CameraSnapshot) {
      const projection = JSON.stringify([
        camera.worldId,
        camera.entityKey,
        camera.projection,
        camera.near,
        camera.far,
        camera.fov,
        camera.aspect,
        camera.eye?.frustumShift ?? 0,
        camera.orthoLeft,
        camera.orthoRight,
        camera.orthoTop,
        camera.orthoBottom,
        view.input.internalWidth,
        view.input.internalHeight,
      ]);
      const resetReason =
        accepted === undefined
          ? 'content-generation'
          : accepted.view !== previousView
            ? 'history-gap'
            : accepted.projection !== projection
              ? 'projection-change'
              : view.resetReason;
      const historyUsed = mode !== 'spatial' && resetReason === undefined && view.historyValid;
      pending = { view, projection, resetReason, historyUsed };
      const bytes = new ArrayBuffer(48);
      new Uint32Array(bytes).set([Number(historyUsed), 16, Number(mode !== 'spatial'), 2]);
      new Float32Array(bytes).set(
        [
          ...(view.currentJitterUv ?? [0, 0]),
          ...(previousView?.currentJitterUv ?? [0, 0]),
          0.03,
          0.01,
          0.98,
          0.9,
        ],
        4,
      );
      device.queue.writeBuffer(config, 0, new Uint8Array(bytes)).unwrap();
    },
    commit() {
      if (pending !== undefined) {
        accepted = pending;
        pending = undefined;
      }
    },
    inspect() {
      return {
        mode,
        historyUsed: accepted?.historyUsed ?? false,
        resetReason:
          accepted === undefined ? ('content-generation' as const) : accepted.resetReason,
        allocatedBytes: pixels * 224 + 48,
      };
    },
  };
}
export type RendererDiffuseReconstruction = ReturnType<typeof prepareRendererDiffuseReconstruction>;
