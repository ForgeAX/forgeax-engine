import type { Plugin } from 'vite';

/** Audit one real Task Worker at the copy and encoding boundaries without sampling its heap. */
export function observeRuntimePackTaskMemory(channel: string): Plugin {
  return {
    name: 'fixture-runtime-pack-task-memory',
    enforce: 'pre',
    transform(code, id) {
      const module = id.split('?', 1)[0];
      if (!module?.endsWith('/packages/import/dist/browser.mjs')) return;
      const capture = /const owned = [^;]*copyPackData\(submitted\);/g;
      const save = /blobs\[path\] = (\w+);/g;
      if ([...code.matchAll(capture)].length !== 1 || [...code.matchAll(save)].length !== 1)
        throw new Error('Expected unique Runtime Pack output capture and artifact write');
      return `
        function observePackBackings(packageId, phase, fields) {
          if (globalThis.name !== 'forgeax-task') return;
          const unique = new Set();
          function backings(value, buffers, visited) {
            if (value === null || typeof value !== 'object' || visited.has(value)) return;
            visited.add(value);
            if (ArrayBuffer.isView(value)) {
              buffers.add(value.buffer);
              return;
            }
            for (const child of Object.values(value)) backings(child, buffers, visited);
          }
          const total = buffers => Array.from(buffers).reduce((sum, buffer) => sum + buffer.byteLength, 0);
          const groups = Object.fromEntries(Object.entries(fields).map(([name, value]) => {
            const buffers = new Set();
            backings(value, buffers, new Set());
            for (const buffer of buffers) unique.add(buffer);
            return [name, total(buffers)];
          }));
          const port = new BroadcastChannel(${JSON.stringify(channel)});
          try { port.postMessage({ packageId, phase, groups, uniqueBytes: total(unique) }); }
          finally { port.close(); }
        }
        ${code
          .replace(capture, (statement) => `${statement}
            observePackBackings(packageId, 'isolate', { submitted, owned });`)
          .replace(save, (_full, body: string) => `blobs[path] = ${body};
            if (asset.kind === 'mesh' && artifact.assetCodec?.name === 'mesh-binary')
              observePackBackings(packageId, 'encode', { owned, encoded: artifact.bytes, publication: blobs });`)}
      `;
    },
  };
}

/** Count native Mesh buffer capacity at every allocation and destruction. */
export function observeRuntimePackGpuBuffers(channel: string): Plugin {
  return {
    name: 'fixture-runtime-pack-gpu-buffers',
    enforce: 'pre',
    transform(code, id) {
      if (!id.split('?', 1)[0]?.endsWith('/packages/app/dist/render-worker-runtime.mjs')) return;
      return `
        const meshBufferPort = new BroadcastChannel(${JSON.stringify(channel)});
        const meshBuffers = new WeakMap();
        let meshBufferSequence = 0;
        let meshGpuBytes = 0;
        function noteMeshBuffer(kind, row) {
          meshGpuBytes += kind === 'allocate' ? row.bytes : -row.bytes;
          meshBufferPort.postMessage({ kind, ...row, liveBytes: meshGpuBytes });
        }
        const createMeshBuffer = GPUDevice.prototype.createBuffer;
        GPUDevice.prototype.createBuffer = function (...args) {
          const buffer = createMeshBuffer.apply(this, args);
          if (/^mesh-.+-(vbo|ibo)$/.test(buffer.label)) {
            const info = { id: ++meshBufferSequence, label: buffer.label, bytes: buffer.size };
            meshBuffers.set(buffer, info);
            noteMeshBuffer('allocate', info);
          }
          return buffer;
        };
        const destroyMeshBuffer = GPUBuffer.prototype.destroy;
        GPUBuffer.prototype.destroy = function (...args) {
          const result = destroyMeshBuffer.apply(this, args);
          const info = meshBuffers.get(this);
          if (info) {
            meshBuffers.delete(this);
            noteMeshBuffer('destroy', info);
          }
          return result;
        };
        ${code}
      `;
    },
  };
}
