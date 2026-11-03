import { PerspectiveCamera, Scene } from 'three/src/Three.Core.js';
import { expect, it, vi } from 'vitest';
import { renderReference } from './webgpu-reference.fixture';

const state = vi.hoisted(() => ({
  requests: 0,
  instances: [] as Array<{
    options: { device?: GPUDevice };
    backend: { isWebGPUBackend: boolean; device: GPUDevice };
    rendered: number;
    disposed: boolean;
  }>,
}));

vi.mock('three/src/renderers/webgpu/WebGPURenderer.js', () => ({
  default: class {
    readonly shadowMap = {};
    readonly backend = { isWebGPUBackend: true, device: undefined as unknown as GPUDevice };
    rendered = 0;
    disposed = false;
    constructor(readonly options: { device?: GPUDevice } = {}) {
      state.instances.push(this);
    }
    async init() {
      if (this.options.device !== undefined) this.backend.device = this.options.device;
      else {
        state.requests++;
        this.backend.device = {
          pushErrorScope() {},
          popErrorScope: async () => null,
          queue: { onSubmittedWorkDone: async () => {} },
          destroy: vi.fn(),
        } as unknown as GPUDevice;
      }
    }
    setSize() {}
    setOutputRenderTarget() {}
    render() {
      this.rendered++;
    }
    async readRenderTargetPixelsAsync() {
      return new Uint8Array(128 * 128 * 4);
    }
    dispose() {
      this.disposed = true;
      if (this.options.device === undefined) this.backend.device.destroy();
    }
  },
}));

it('shares only the file-owned upstream device while every oracle gets fresh renderer state', async () => {
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const first = await renderReference(scene, camera);
  const second = await renderReference(scene, camera);
  expect(state.requests).toBe(1);
  const rendered = state.instances.filter((instance) => instance.rendered > 0);
  expect(rendered).toHaveLength(2);
  expect(rendered[0]).not.toBe(rendered[1]);
  for (const renderer of rendered) {
    expect(renderer.options.device).toBe(renderer.backend.device);
    expect(renderer.disposed).toBe(true);
    expect(renderer.backend.device.destroy).not.toHaveBeenCalled();
  }
  expect(first).not.toBe(second);
  expect(first).toEqual(second);
});
