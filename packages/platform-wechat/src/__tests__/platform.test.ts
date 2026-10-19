import { describe, expect, it, vi } from 'vitest';
import { createWechatPlatform, type WechatHost, type WechatWindowInfo } from '../index.js';

function nativeHost() {
  const calls: string[] = [];
  const show = new Set<() => void>();
  const hide = new Set<() => void>();
  const resize = new Set<() => void>();
  const orientation = new Set<(event: { value: 'landscape' | 'portrait' }) => void>();
  const memory = new Set<(event: { level: number }) => void>();
  const frames = new Map<number, () => void>();
  let frameId = 0;
  let now = 1_000_000;
  let info: WechatWindowInfo = {
    windowWidth: 400,
    windowHeight: 800,
    pixelRatio: 2,
    safeArea: { left: 0, top: 30, width: 400, height: 740 },
  };
  const canvas = { width: 800, height: 1600 };
  const host: WechatHost = {
    wx: {
      createCanvas: () => {
        calls.push('canvas');
        return canvas;
      },
      getPerformance: () => ({ now: () => now }),
      getDeviceInfo: () => ({ platform: 'ios' }),
      getWindowInfo: () => info,
      onShow: (listener) => {
        show.add(listener);
      },
      offShow: (listener) => {
        calls.push('offShow');
        show.delete(listener);
      },
      onHide: (listener) => {
        hide.add(listener);
      },
      offHide: (listener) => {
        calls.push('offHide');
        hide.delete(listener);
      },
      onWindowResize: (listener) => {
        resize.add(listener);
      },
      offWindowResize: (listener) => {
        calls.push('offResize');
        resize.delete(listener);
      },
      onDeviceOrientationChange: (listener) => {
        orientation.add(listener);
      },
      offDeviceOrientationChange: (listener) => {
        calls.push('offOrientation');
        orientation.delete(listener);
      },
      onMemoryWarning: (listener) => {
        memory.add(listener);
      },
      offMemoryWarning: (listener) => {
        calls.push('offMemory');
        memory.delete(listener);
      },
    },
    requestAnimationFrame: (callback) => {
      const id = frameId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => {
      calls.push(`cancel:${id}`);
      if (typeof id === 'number') frames.delete(id);
    },
  };
  return {
    host,
    canvas,
    calls,
    show,
    hide,
    resize,
    orientation,
    memory,
    frames,
    setTime: (time: number) => {
      now = time;
    },
    setInfo: (next: WechatWindowInfo) => {
      info = next;
    },
  };
}

describe('native Mini Game platform contract', () => {
  it('uses the native canvas without DOM identity and preserves native display facts', () => {
    const native = nativeHost();
    const platform = createWechatPlatform(native.host).unwrap();
    expect(platform.canvas).toBe(native.canvas);
    expect(native.calls).toEqual(['canvas']);
    expect(platform.now().unwrap()).toBe(1000);
    expect(platform.display().unwrap()).toEqual({
      width: 400,
      height: 800,
      pixelRatio: 2,
      drawingWidth: 800,
      drawingHeight: 1600,
      safeArea: { x: 0, y: 30, width: 400, height: 740 },
    });
    platform.dispose();
  });

  it('retains an explicitly supplied display canvas', () => {
    const native = nativeHost();
    const platform = createWechatPlatform(native.host, native.canvas).unwrap();
    expect(platform.canvas).toBe(native.canvas);
    expect(native.calls).toEqual([]);
    platform.dispose();
  });

  it('cancels native frame zero once and fences late callbacks after cancellation or disposal', () => {
    const native = nativeHost();
    const platform = createWechatPlatform(native.host).unwrap();
    const callback = vi.fn();
    const cancel = platform.requestFrame(callback).unwrap();
    const late = native.frames.get(0);
    cancel();
    cancel();
    late?.();
    expect(callback).not.toHaveBeenCalled();
    expect(native.calls.filter((call) => call === 'cancel:0')).toHaveLength(1);
    platform.requestFrame(callback).unwrap();
    const retired = native.frames.get(1);
    platform.dispose();
    platform.dispose();
    retired?.();
    expect(callback).not.toHaveBeenCalled();
    expect(native.frames.size).toBe(0);
    expect(platform.requestFrame(callback)).toMatchObject({
      ok: false,
      error: { code: 'platform-disposed' },
    });
    expect(platform.now()).toMatchObject({ ok: false, error: { code: 'platform-disposed' } });
  });

  it('delivers native visibility, size and memory events and unregisters every native listener', () => {
    const native = nativeHost();
    const platform = createWechatPlatform(native.host).unwrap();
    const listener = vi.fn();
    platform.subscribe(listener).unwrap();
    for (const callback of native.hide) callback();
    expect(platform.visible()).toBe(false);
    for (const callback of native.show) callback();
    expect(platform.visible()).toBe(true);
    native.setInfo({ windowWidth: 800, windowHeight: 400, pixelRatio: 2 });
    native.canvas.width = 1600;
    native.canvas.height = 800;
    for (const callback of native.resize) callback();
    for (const callback of native.memory) callback({ level: 15 });
    expect(listener.mock.calls.map(([event]) => event.kind)).toEqual([
      'visibility',
      'visibility',
      'display',
      'memory-pressure',
    ]);
    expect(listener.mock.calls[2]?.[0].display.drawingWidth).toBe(1600);
    const late = [...native.hide][0];
    platform.dispose();
    late?.();
    expect(listener).toHaveBeenCalledTimes(4);
    expect([native.show.size, native.hide.size, native.resize.size, native.memory.size]).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it('keeps independent leases for the same subscriber', () => {
    const native = nativeHost();
    const platform = createWechatPlatform(native.host).unwrap();
    const listener = vi.fn();
    const first = platform.subscribe(listener).unwrap();
    const second = platform.subscribe(listener).unwrap();
    first();
    for (const callback of native.hide) callback();
    expect(listener).toHaveBeenCalledOnce();
    second();
    for (const callback of native.show) callback();
    expect(listener).toHaveBeenCalledOnce();
    platform.dispose();
  });

  it('publishes changed native display facts when rotation emits no window-resize event', () => {
    const native = nativeHost();
    native.setInfo({ windowWidth: 844, windowHeight: 390, pixelRatio: 3 });
    native.canvas.width = 2532;
    native.canvas.height = 1170;
    const platform = createWechatPlatform(native.host).unwrap();
    const observed = vi.fn();
    platform.subscribe(observed).unwrap();

    native.setInfo({
      windowWidth: 390,
      windowHeight: 844,
      pixelRatio: 3,
      safeArea: { left: 0, top: 47, width: 390, height: 763 },
    });
    for (const callback of native.orientation) callback({ value: 'portrait' });
    expect(observed).toHaveBeenLastCalledWith({
      kind: 'display',
      display: {
        width: 390,
        height: 844,
        pixelRatio: 3,
        drawingWidth: 2532,
        drawingHeight: 1170,
        safeArea: { x: 0, y: 47, width: 390, height: 763 },
      },
    });
    expect(native.canvas).toEqual({ width: 2532, height: 1170 });

    native.setInfo({
      windowWidth: 844,
      windowHeight: 390,
      pixelRatio: 3,
      safeArea: { left: 47, top: 0, width: 750, height: 369 },
    });
    for (const callback of native.orientation) callback({ value: 'landscape' });
    expect(observed).toHaveBeenLastCalledWith({
      kind: 'display',
      display: {
        width: 844,
        height: 390,
        pixelRatio: 3,
        drawingWidth: 2532,
        drawingHeight: 1170,
        safeArea: { x: 47, y: 0, width: 750, height: 369 },
      },
    });
    const late = [...native.orientation][0];
    platform.dispose();
    expect(native.orientation.size).toBe(0);
    expect(native.calls.filter((call) => call === 'offOrientation')).toHaveLength(1);
    late?.({ value: 'portrait' });
    expect(observed).toHaveBeenCalledTimes(2);
  });

  it('preserves invalid display failure when orientation changes', () => {
    const native = nativeHost();
    const platform = createWechatPlatform(native.host).unwrap();
    const observed = vi.fn();
    platform.subscribe(observed).unwrap();
    native.setInfo({ windowWidth: 390, windowHeight: 844, pixelRatio: 0 });
    for (const callback of native.orientation) callback({ value: 'portrait' });
    expect(observed).toHaveBeenCalledWith({
      kind: 'surface-lost',
      cause: expect.objectContaining({ code: 'platform-display-invalid' }),
    });
    platform.dispose();
  });

  it('rolls back orientation subscription failure through the existing native lease cleanup', () => {
    const native = nativeHost();
    const cause = new Error('orientation registration failed');
    native.host.wx.onDeviceOrientationChange = (listener) => {
      native.orientation.add(listener);
      throw cause;
    };
    expect(createWechatPlatform(native.host)).toMatchObject({
      ok: false,
      error: { detail: { operation: 'subscribe', cause } },
    });
    expect(native.calls).toEqual(['canvas', 'offOrientation', 'offResize', 'offHide', 'offShow']);
    expect([
      native.show.size,
      native.hide.size,
      native.resize.size,
      native.orientation.size,
    ]).toEqual([0, 0, 0, 0]);
  });

  it('rolls back partially installed native subscriptions in reverse order', () => {
    const native = nativeHost();
    const cause = new Error('resize registration failed');
    native.host.wx.onWindowResize = () => {
      throw cause;
    };
    const result = createWechatPlatform(native.host);
    expect(result).toMatchObject({
      ok: false,
      error: { detail: { operation: 'subscribe', cause } },
    });
    expect(native.calls).toEqual(['canvas', 'offResize', 'offHide', 'offShow']);
    expect([native.show.size, native.hide.size]).toEqual([0, 0]);
  });

  it('rejects invalid display facts before native subscriptions are acquired', () => {
    const native = nativeHost();
    native.setInfo({ windowWidth: 400, windowHeight: 800, pixelRatio: 0 });
    expect(createWechatPlatform(native.host)).toMatchObject({
      ok: false,
      error: { code: 'platform-display-invalid' },
    });
    expect(native.show.size).toBe(0);
  });
  it('preserves subscription failure while attempting every failing cleanup', () => {
    const native = nativeHost();
    const cause = new Error('registration failure');
    const cleanup = new Error('unregister failure');
    native.host.wx.onWindowResize = () => {
      throw cause;
    };
    native.host.wx.offWindowResize = () => {
      throw cleanup;
    };
    const result = createWechatPlatform(native.host);
    expect(result).toMatchObject({
      ok: false,
      error: {
        detail: {
          cause,
          cleanupCause: {
            code: 'platform-operation-failed',
            detail: { cause: expect.any(AggregateError) },
          },
        },
      },
    });
    expect(native.hide.size).toBe(0);
    expect(native.show.size).toBe(0);
  });

  it('fences frames and releases listeners even when native cancellation fails', () => {
    const native = nativeHost();
    const platform = createWechatPlatform(native.host).unwrap();
    const callback = vi.fn();
    platform.requestFrame(callback).unwrap();
    const late = native.frames.get(0);
    native.host.cancelAnimationFrame = () => {
      throw new Error('cancel failed');
    };
    expect(() => platform.dispose()).toThrow(
      expect.objectContaining({ code: 'platform-operation-failed' }),
    );
    expect(native.hide.size).toBe(0);
    expect(native.show.size).toBe(0);
    late?.();
    expect(callback).not.toHaveBeenCalled();
    platform.dispose();
  });

  it('rejects a synchronous native frame implementation without executing game code', () => {
    const native = nativeHost();
    native.host.requestAnimationFrame = (callback) => {
      callback();
      return 0;
    };
    const platform = createWechatPlatform(native.host).unwrap();
    const callback = vi.fn();
    expect(platform.requestFrame(callback)).toMatchObject({
      ok: false,
      error: { code: 'platform-operation-failed' },
    });
    expect(callback).not.toHaveBeenCalled();
    platform.dispose();
  });

  it('delivers visibility to later leases when an observer throws', () => {
    const native = nativeHost();
    const platform = createWechatPlatform(native.host).unwrap();
    platform
      .subscribe(() => {
        throw new Error('observer failure');
      })
      .unwrap();
    const observed = vi.fn();
    platform.subscribe(observed).unwrap();
    expect(() => {
      for (const hide of native.hide) hide();
    }).toThrow(AggregateError);
    expect(observed).toHaveBeenCalledWith({ kind: 'visibility', visible: false });
    platform.dispose();
  });

  it('preserves opaque native frame tokens observed in the DevTools game module', () => {
    const native = nativeHost();
    const token = Object(9999);
    native.host.requestAnimationFrame = () => token;
    const cancel = vi.fn();
    native.host.cancelAnimationFrame = cancel;
    const platform = createWechatPlatform(native.host).unwrap();
    const released = platform.requestFrame(() => {}).unwrap();
    released();
    expect(cancel).toHaveBeenCalledWith(token);
    expect(cancel.mock.calls[0]?.[0]).toBe(token);
    platform.dispose();
  });

  it('normalizes the explicitly identified DevTools millisecond clock without magnitude guessing', () => {
    const native = nativeHost();
    native.host.wx.getDeviceInfo = () => ({ platform: 'devtools' });
    native.setTime(42);
    const platform = createWechatPlatform(native.host).unwrap();
    expect(platform.now().unwrap()).toBe(42);
    native.setTime(42 + 16);
    expect(platform.now().unwrap()).toBe(58);
    platform.dispose();
  });
  it('honors subscription changes and disposal during the current event delivery', () => {
    const native = nativeHost();
    const platform = createWechatPlatform(native.host).unwrap();
    const later = vi.fn();
    let releaseLater = () => {};
    platform
      .subscribe(() => {
        releaseLater();
        platform.subscribe(later).unwrap();
      })
      .unwrap();
    releaseLater = platform.subscribe(later).unwrap();
    for (const callback of native.hide) callback();
    expect(later).not.toHaveBeenCalled();
    for (const callback of native.show) callback();
    expect(later).toHaveBeenCalledOnce();
    platform.subscribe(() => platform.dispose()).unwrap();
    const afterDisposal = vi.fn();
    platform.subscribe(afterDisposal).unwrap();
    for (const callback of native.hide) callback();
    expect(afterDisposal).not.toHaveBeenCalled();
    expect(platform.visible()).toBe(false);
  });

  it('fences a native callback retained by a failed frame acquisition', () => {
    const native = nativeHost();
    let late = () => {};
    native.host.requestAnimationFrame = (callback) => {
      late = callback;
      throw new Error('native acquisition failed');
    };
    const platform = createWechatPlatform(native.host).unwrap();
    const callback = vi.fn();
    expect(platform.requestFrame(callback).ok).toBe(false);
    late();
    expect(callback).not.toHaveBeenCalled();
    platform.dispose();
  });
});
