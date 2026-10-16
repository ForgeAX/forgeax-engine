import { disposeInstanceBufferChunks } from '../src/instance-buffer-cache';
import { cleanPerFrameCaches } from '../src/record/fold-buckets';
import { resolveStorageInstanceChunks } from '../src/record/main-pass-geometry';
import type { _InternalRenderPipelineContext } from '../src/record/render-context';
import type { RenderableSnapshot } from '../src/render-system-extract';

export const modes = ['small-stable', 'stable', 'dirty', 'resize', 'replacement'] as const;
export function createCase(mode: (typeof modes)[number]) {
  const count = mode === 'small-stable' ? 1 : 256;
  const work = { buffers: 0, destroys: 0, writes: 0, bytes: 0, bindings: 0, draws: 0 };
  const device = {
    caps: { storageBuffer: true },
    createBuffer: (desc: { size: number }) => {
      work.buffers++;
      return { ok: true, value: { size: desc.size } };
    },
    destroyBuffer: () => {
      work.destroys++;
      return { ok: true, value: undefined };
    },
    createBindGroup: () => {
      work.bindings++;
      return { ok: true, value: {} };
    },
    queue: {
      writeBuffer: (_buffer: unknown, _offset: number, data: Uint8Array) => {
        work.writes++;
        work.bytes += data.byteLength;
        return { ok: true, value: undefined };
      },
    },
  };
  const context = {
    runtime: {
      device,
      errorRegistry: {
        fire: (e: unknown) => {
          throw e;
        },
      },
    },
    pipelineState: { instancesBindGroupLayout: {} },
    bindGroupCounts: { createBindGroup: 0, keys: [] },
    frameState: {
      instanceBufferChunks: new Map(),
      instancesBgShared: new WeakMap(),
      instanceBuffers: new Map(),
      materialBgPerEntity: new Map(),
      instancesBgPerEntity: new Map(),
      transientInstanceBuffers: [],
    },
  } as unknown as _InternalRenderPipelineContext;
  const rows = Array.from({ length: count }, (_, i) => ({
    source: {
      worldId: i % 3,
      entityKey: i + 1,
      instances: {
        cacheKey: i + 1,
        archVersion: 1,
        revision: 1,
        instanceCount: 32,
        transforms: new Float32Array(32 * 16),
      },
    } as unknown as RenderableSnapshot,
  }));
  let step = 0;
  const run = (iterations: number) => {
    let checksum = 0;
    for (let f = 0; f < iterations; f++) {
      step++;
      context.bindGroupCounts.keys.length = 0;
      for (const row of rows) {
        const inst = row.source.instances;
        if (inst === undefined) throw Error('missing instances');
        if (mode === 'dirty' || mode === 'resize') Reflect.set(inst, 'revision', step + 1);
        if (mode === 'resize') Reflect.set(inst, 'instanceCount', step % 2 ? 24 : 32);
        if (mode === 'replacement')
          Reflect.set(inst, 'cacheKey', row.source.entityKey + (step % 2 ? count : 0));
        const draws = resolveStorageInstanceChunks(
          context,
          row as never,
          inst,
          8 * 128,
          undefined,
          -1,
        );
        if (draws === null) throw Error('chunk admission failed');
        for (const draw of draws) checksum += draw.instanceCount + (draw.firstInstanceOrdinal ?? 0);
        work.draws += draws.length;
      }
      cleanPerFrameCaches(context.runtime as never, context.frameState, rows as never);
    }
    return checksum;
  };
  run(1);
  return {
    run,
    inspect: () => ({ ...work }),
    dispose: () => disposeInstanceBufferChunks(context.frameState.instanceBufferChunks!),
  };
}
