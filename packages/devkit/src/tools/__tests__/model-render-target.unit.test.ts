import { afterEach, expect, it, vi } from 'vitest';
import { offscreenTarget } from '../model-render-target.js';

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  vi.stubGlobal('GPUTextureUsage', { RENDER_ATTACHMENT: 16, COPY_SRC: 1 });
  const listeners = new Set<(event: GPUUncapturedErrorEvent) => void>();
  const textures: { destroy: ReturnType<typeof vi.fn>; format: string }[] = [];
  const device = {
    addEventListener: vi.fn((_type, listener) => listeners.add(listener)),
    removeEventListener: vi.fn((_type, listener) => listeners.delete(listener)),
    createTexture: vi.fn(() => {
      const texture = { destroy: vi.fn(), format: 'rgba8unorm' };
      textures.push(texture);
      return texture;
    }),
    destroy: vi.fn(),
    queue: { onSubmittedWorkDone: vi.fn(async () => undefined) },
  };
  return { device, listeners, textures, raw: device as unknown as GPUDevice };
}

it('releases the device error listener and target exactly once on disposal', async () => {
  const f = fixture();
  const target = offscreenTarget(200, 200);
  target.canvas.getContext().configure({ device: f.raw, format: 'rgba8unorm' });
  expect(f.listeners.size).toBe(1);
  await target.destroy();
  expect(f.listeners.size).toBe(0);
  expect(f.textures[0]?.destroy).toHaveBeenCalledOnce();
  await target.destroy();
  expect(f.device.destroy).toHaveBeenCalledOnce();
});

it('retires the old surface listener when configuration changes devices', async () => {
  const first = fixture();
  const second = fixture();
  const target = offscreenTarget(200, 200);
  const context = target.canvas.getContext();
  context.configure({ device: first.raw, format: 'rgba8unorm' });
  context.configure({ device: second.raw, format: 'rgba8unorm' });
  expect(first.listeners.size).toBe(0);
  expect(first.textures[0]?.destroy).toHaveBeenCalledOnce();
  expect(first.device.destroy).not.toHaveBeenCalled();
  expect(second.listeners.size).toBe(1);
  await target.destroy();
  expect(second.listeners.size).toBe(0);
});

it('unconfigures the surface and rejects reads after its texture is retired', async () => {
  const f = fixture();
  const target = offscreenTarget(200, 200);
  const context = target.canvas.getContext();
  context.configure({ device: f.raw, format: 'rgba8unorm' });
  context.unconfigure();
  expect(f.listeners.size).toBe(0);
  expect(f.textures[0]?.destroy).toHaveBeenCalledOnce();
  await expect(target.read()).rejects.toThrow('render target was never configured');
  await target.destroy();
});

it('keeps active GPU validation errors visible and stops observing after retirement', async () => {
  const f = fixture();
  const target = offscreenTarget(200, 200);
  const context = target.canvas.getContext();
  context.configure({ device: f.raw, format: 'rgba8unorm' });
  const emit = () => {
    for (const listener of f.listeners)
      listener({ error: { message: 'native failure\ndetail' } } as GPUUncapturedErrorEvent);
  };
  emit();
  expect(target.errors).toEqual(['native failure']);
  context.unconfigure();
  emit();
  expect(target.errors).toEqual(['native failure']);
  await target.destroy();
});
