import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { type AssetError, ok, type Result } from '@forgeax/engine-types';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { formatFailure } from './errors.js';
import { exportObject, type MeshExportItem } from './geometry.js';

export type MeshExportFormat = 'gltf' | 'glb' | 'obj' | 'stl';

/** Export caller-owned static placements without touching World, Catalog or GPU state. */
export async function exportMeshes(
  items: readonly MeshExportItem[],
  format: MeshExportFormat,
): Promise<Result<Uint8Array, AssetError>> {
  if ((format === 'obj' || format === 'stl') && items.some((item) => item.materials !== undefined))
    return formatFailure(
      'materials',
      `${format.toUpperCase()} byte export is geometry-only; use glTF/GLB to retain materials`,
    );
  const object = exportObject(items, format === 'obj' || format === 'stl');
  if (!object.ok) return object;
  try {
    if (format === 'obj')
      return ok(new TextEncoder().encode(new OBJExporter().parse(object.value)));
    if (format === 'stl') {
      const output = new STLExporter().parse(object.value, { binary: true });
      return ok(new Uint8Array(output.buffer, output.byteOffset, output.byteLength));
    }
    if (format !== 'gltf' && format !== 'glb')
      return formatFailure('format', `unsupported format ${format}`);
    const require = createRequire(import.meta.url);
    const source = `
      const { workerData, parentPort } = require('node:worker_threads');
      (async () => {
        globalThis.FileReader = class {
          readAsArrayBuffer(blob) { blob.arrayBuffer().then(buffer => { this.result = buffer; this.onloadend?.(); }).catch(error => this.onerror?.(error)); }
          readAsDataURL(blob) { blob.arrayBuffer().then(buffer => { this.result = 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + Buffer.from(buffer).toString('base64'); this.onloadend?.(); }).catch(error => this.onerror?.(error)); }
        };
        const { ObjectLoader } = await import(workerData.three);
        const { GLTFExporter } = await import(workerData.exporter);
        const object = new ObjectLoader().parse(workerData.object);
        const output = await new GLTFExporter().parseAsync(object, { binary: workerData.binary, onlyVisible: false });
        const bytes = output instanceof ArrayBuffer ? new Uint8Array(output) : new TextEncoder().encode(JSON.stringify(output));
        parentPort.postMessage({ bytes }, [bytes.buffer]);
      })().catch(error => parentPort.postMessage({ error: error.message }));
    `;
    return await new Promise((resolve) => {
      const worker = new Worker(source, {
        eval: true,
        workerData: {
          object: object.value.toJSON(),
          binary: format === 'glb',
          three: pathToFileURL(require.resolve('three')).href,
          exporter: pathToFileURL(require.resolve('three/addons/exporters/GLTFExporter.js')).href,
        },
      });
      const timer = setTimeout(() => {
        void worker.terminate();
        resolve(formatFailure('export', 'export exceeded thirty seconds'));
      }, 30_000);
      worker.once('error', (error) => {
        clearTimeout(timer);
        resolve(formatFailure('export', error.message));
      });
      worker.once('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) resolve(formatFailure('export', `worker exited with ${code}`));
      });
      worker.once('message', (result: { bytes?: Uint8Array; error?: string }) => {
        clearTimeout(timer);
        void worker.terminate();
        resolve(
          result.bytes === undefined
            ? formatFailure('export', result.error ?? 'worker produced no bytes')
            : ok(result.bytes),
        );
      });
    });
  } catch (cause) {
    return formatFailure('export', cause instanceof Error ? cause.message : String(cause));
  } finally {
    object.value.traverse((child) => {
      const mesh = child as {
        geometry?: { dispose(): void };
        material?: { dispose(): void } | { dispose(): void }[];
      };
      mesh.geometry?.dispose();
      for (const material of Array.isArray(mesh.material)
        ? mesh.material
        : mesh.material === undefined
          ? []
          : [mesh.material])
        material.dispose();
    });
  }
}
