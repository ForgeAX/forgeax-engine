import { describe, expect, it } from 'vitest';
import { createPreparedGraphicsStore } from '../features/prepared-graphics-store';

describe('prepared graphics operation snapshots', () => {
  it('retains normalized descriptors and upload bytes after producer mutation', () => {
    const store = createPreparedGraphicsStore();
    const transaction = store.beginFrame('snapshot.feature', 3);
    const pipeline: {
      shader: string;
      vertexLayout: string;
      colorFormats: GPUTextureFormat[];
      depthFormat: GPUTextureFormat;
      topology: 'triangle-strip';
      indexFormat: 'uint32';
      renderState: {
        depthWriteEnabled: boolean;
        blend: GPUBlendState;
      };
    } = {
      shader: 'synthetic::forward',
      vertexLayout: 'position',
      colorFormats: ['rgba8unorm'],
      depthFormat: 'depth24plus-stencil8',
      topology: 'triangle-strip',
      indexFormat: 'uint32',
      renderState: {
        depthWriteEnabled: false,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        },
      },
    };
    const vertexData = new Float32Array([0, 1, 2, 3, 4, 5]);
    const indexData = new Uint16Array([0, 1, 2]);

    const pipelineRef = transaction.prepare('pipeline', 'forward', pipeline);
    const bindingsRef = transaction.prepare('bindings', 'forward', {
      pipeline: pipelineRef.unwrap(),
      values: { tint: [1, 0, 0, 1] },
    });
    const vertexRef = transaction.prepare('vertex-data', 'triangle', {
      layout: 'position',
      data: vertexData,
    });
    const indexRef = transaction.prepare('index-data', 'triangle', {
      format: 'uint16',
      data: indexData,
    });

    expect(pipelineRef.ok).toBe(true);
    expect(bindingsRef.ok).toBe(true);
    expect(vertexRef.ok).toBe(true);
    expect(indexRef.ok).toBe(true);
    if (!pipelineRef.ok || !bindingsRef.ok || !vertexRef.ok || !indexRef.ok) return;

    pipeline.colorFormats[0] = 'bgra8unorm';
    pipeline.renderState.depthWriteEnabled = true;
    pipeline.renderState.blend.color.dstFactor = 'zero';
    vertexData[0] = 99;
    indexData[0] = 99;

    expect(transaction.commit().ok).toBe(true);
    const snapshot = store.snapshot('snapshot.feature');
    const pipelineItem = snapshot.items.find((item) => item.kind === 'pipeline');
    const bindingsItem = snapshot.items.find((item) => item.kind === 'bindings');
    const vertexItem = snapshot.items.find((item) => item.kind === 'vertex-data');
    const indexItem = snapshot.items.find((item) => item.kind === 'index-data');

    expect(pipelineItem?.descriptor).toMatchObject({
      shader: 'synthetic::forward',
      vertexLayout: 'position',
      colorFormats: ['rgba8unorm'],
      depthFormat: 'depth24plus-stencil8',
      topology: 'triangle-strip',
      indexFormat: 'uint32',
      renderState: {
        depthWriteEnabled: false,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        },
      },
    });
    expect(bindingsItem?.descriptor).toMatchObject({
      pipeline: pipelineRef.value,
      values: { tint: [1, 0, 0, 1] },
    });
    expect(vertexItem?.descriptor).toMatchObject({
      layout: 'position',
      data: [0, 1, 2, 3, 4, 5],
    });
    expect(indexItem?.descriptor).toMatchObject({ format: 'uint16', data: [0, 1, 2] });
    expect(vertexItem?.uploadBytes).toEqual(
      Array.from(new Uint8Array(new Float32Array([0, 1, 2, 3, 4, 5]).buffer)),
    );
    expect(indexItem?.uploadBytes).toEqual(
      Array.from(new Uint8Array(new Uint16Array([0, 1, 2]).buffer)),
    );

    for (const item of snapshot.items) {
      expect(Object.keys(item.reference).sort()).toEqual(['generation', 'kind']);
    }
  });
});
