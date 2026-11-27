import { describe, expect, it, vi } from 'vitest';
import type { NativeGPUDevice } from '../gpu';
import { NativeGPUObject, NativeGPUTexture } from '../objects';

function texture(borrowed: boolean) {
  let nextView = 11;
  const native = {
    createTexture: vi.fn(() => 1),
    createView: vi.fn(() => nextView++),
    textureDestroy: vi.fn(),
  };
  const device = { native, touch: vi.fn(), releaseId: vi.fn() };
  const value = new NativeGPUTexture(
    device as unknown as NativeGPUDevice,
    { size: [640, 360], format: 'bgra8unorm', usage: 0x10 },
    borrowed ? 1 : undefined,
  );
  return { value, device, native };
}

describe('native surface texture retirement', () => {
  it('releases every borrowed view before resize even while JS retains the views', () => {
    const { value, device, native } = texture(true);
    const retained = [value.createView(), value.createView({ format: 'bgra8unorm' })];
    value.expire();
    expect(native.textureDestroy).toHaveBeenCalledExactlyOnceWith(1);
    expect(device.releaseId.mock.calls.map(([id]) => id).sort()).toEqual([1, 11, 12]);
    expect(retained.map((view) => view.nativeId)).toEqual([11, 12]);
    expect(() => value.createView()).toThrow(/expired/);
    value.expire();
    value.destroy();
    expect(device.releaseId).toHaveBeenCalledTimes(3);
  });

  it('retires borrowed views on explicit destruction without collecting JS wrappers', () => {
    const { value, device } = texture(true);
    const retained = value.createView();
    value.destroy();
    expect(device.releaseId).toHaveBeenCalledWith(retained.nativeId);
    expect(device.releaseId).toHaveBeenCalledWith(value.nativeId);
    expect(() => value.createView()).toThrow(/expired/);
  });

  it('preserves ordinary texture and view ownership', () => {
    const { value, device, native } = texture(false);
    const retained = value.createView();
    value.destroy();
    expect(native.textureDestroy).toHaveBeenCalledExactlyOnceWith(1);
    expect(device.releaseId).not.toHaveBeenCalled();
    expect(retained.texture).toBe(value);
  });

  it('retires pending commands and transitive references with their borrowed image', () => {
    const { value, device } = texture(true);
    const owner = device as unknown as NativeGPUDevice;
    const view = value.createView();
    const pending = new NativeGPUObject(owner, 21, 'pending', [view]);
    const nested = new NativeGPUObject(owner, 22, 'nested', { children: [pending, view] });
    value.expire();
    expect(device.releaseId.mock.calls.map(([id]) => id).sort()).toEqual([1, 11, 21, 22]);
    expect(nested.refs).toEqual({ children: [pending, view] });
    new NativeGPUObject(owner, 23, 'late', [view]);
    expect(device.releaseId).toHaveBeenLastCalledWith(23);
  });

  it('never releases a foreign device ID through a borrowed reference', () => {
    const first = texture(true);
    const second = texture(true);
    new NativeGPUObject(second.device as unknown as NativeGPUDevice, 21, 'foreign', [
      first.value.createView(),
    ]);
    first.value.expire();
    expect(first.device.releaseId).not.toHaveBeenCalledWith(21);
    expect(second.device.releaseId).not.toHaveBeenCalled();
  });
});
