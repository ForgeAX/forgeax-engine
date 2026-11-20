import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from 'vite';
import type {
  BasisEncoderModule,
  BasisModuleFactory,
} from '../../../codec/src/wasm/basis-types.js';

export const pressureTextureSide = 1024;

export async function encodePressureTexture(repository: string): Promise<Uint8Array> {
  const codec = pathToFileURL(resolve(repository, 'packages/codec/pkg/encode') + '/');
  const { default: factory } = (await import(new URL('basis_encoder.mjs', codec).href)) as {
    default: BasisModuleFactory<BasisEncoderModule>;
  };
  const module = await factory({ locateFile: (file: string) => new URL(file, codec).href, print() {} });
  module.initializeBasis();
  const encoder = new module.BasisEncoder();
  const side = pressureTextureSide;
  const pixels = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const i = (y * side + x) * 4;
      pixels[i] = x & 255;
      pixels[i + 1] = y & 255;
      pixels[i + 2] = (x ^ y) & 255;
      pixels[i + 3] = 255;
    }
  }
  try {
    encoder.setSliceSourceImage(0, pixels, side, side, 0);
    encoder.setCreateKTX2File(true);
    encoder.setKTX2UASTCSupercompression(true);
    encoder.setFormatMode(module.basis_tex_format.cUASTC_LDR_4x4.value);
    encoder.setMipGen(true);
    encoder.controlThreading(false, 0);
    const output = new Uint8Array(pixels.length * 2);
    const size = encoder.encode(output);
    if (size <= 0) throw new Error('The pressure fixture must encode a KTX2 texture');
    return output.subarray(0, size);
  } finally {
    encoder.delete();
  }
}

/** Observe the owning worker transport and the live pool without changing its scheduler. */
export function observeRuntimePackTaskPool(singleWorker = true): Plugin {
  return {
    name: 'fixture-runtime-pack-task-pool',
    enforce: 'pre',
    transform(code, id) {
      if (!id.split('?')[0]?.endsWith('/packages/app/dist/engine-worker-runtime.mjs')) return;
      const anchors = {
        factory: 'workerFactory: taskWorkerFactory,',
        admission: 'return target.taskPool;',
        reply: 'channel.port1.onmessage = (event) => listener.message(event.data);',
        send: 'channel.port1.postMessage(message, transfer ?? []);',
      };
      for (const anchor of Object.values(anchors))
        if (code.split(anchor).length !== 2) throw new Error(`Missing unique task probe anchor: ${anchor}`);
      return `
        const taskPressure = globalThis.runtimePackTaskPressure = { pool: undefined, rows: undefined };
        const pressurePools = new WeakSet();
        function observePressurePool(pool) {
          if (!pressurePools.has(pool)) {
            pressurePools.add(pool);
            const submit = pool.submit.bind(pool);
            pool.submit = (kind, input, options) => {
              taskPressure.rows?.push({
                kind, priority: options?.priority ?? 'normal', submittedMs: performance.now(),
              });
              return submit(kind, input, options);
            };
          }
          taskPressure.pool = pool;
          return pool;
        }
        function observePressureDispatch(worker, message) {
          if (message.t !== 'run') return;
          const row = taskPressure.rows?.find(
            row => row.kind === message.kind && row.dispatchedMs === undefined,
          );
          if (row) Object.assign(row, { worker, id: message.id, dispatchedMs: performance.now() });
        }
        function observePressureReply(worker, message) {
          if (message.t !== 'done' && message.t !== 'fail') return;
          const row = taskPressure.rows?.find(row => row.worker === worker && row.id === message.id);
          if (!row) return;
          Object.assign(row, { finishedMs: performance.now(), status: message.t });
          if (row.kind !== 'runtime-pack.build' || message.t !== 'done') return;
          const backings = new Set(Object.values(message.value?.blobs ?? {}).map(view => view.buffer));
          row.outputBackingBytes = [...backings].reduce((bytes, backing) => bytes + backing.byteLength, 0);
        }
        ${code
          .replace(anchors.factory, singleWorker ? `workers: 1, ${anchors.factory}` : anchors.factory)
          .replace(anchors.admission, 'return observePressurePool(target.taskPool);')
          .replace(anchors.reply, `channel.port1.onmessage = (event) => {
            observePressureReply(workerId, event.data);
            listener.message(event.data);
          };`)
          .replace(anchors.send, `observePressureDispatch(workerId, message); ${anchors.send}`)}
      `;
    },
  };
}
