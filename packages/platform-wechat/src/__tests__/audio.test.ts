import type { Platform, PlatformEvent } from '@forgeax/engine-platform';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createWechatAudioBackend, type WechatAudioSource } from '../audio.js';

const pose = {
  positionX: 1,
  positionY: 2,
  positionZ: 3,
  forwardX: 0,
  forwardY: 0,
  forwardZ: -1,
  upX: 0,
  upY: 1,
  upZ: 0,
};

function fixture(initial: 'running' | 'suspended' = 'running') {
  let state: AudioContextState = initial;
  let visible = true;
  let afterCloseReads = 0;
  const events = new Set<(event: PlatformEvent) => void>();
  const touch = new Set<() => void>(),
    begin = new Set<() => void>(),
    end = new Set<() => void>();
  const parameter = (value = 0) => ({
    value,
    cancelScheduledValues() {},
    setValueAtTime(value: number) {
      this.value = value;
    },
    linearRampToValueAtTime(value: number) {
      this.value = value;
    },
  });
  const native = {
    get state() {
      if (state === 'closed') {
        afterCloseReads++;
        throw new Error('native state read after close');
      }
      return state;
    },
    currentTime: 0,
    sampleRate: 48000,
    destination: {},
    listener: Object.fromEntries(Object.keys(pose).map((name) => [name, parameter()])),
    createGain: () => ({ context: native, gain: parameter(1), connect() {}, disconnect() {} }),
    createBufferSource: vi.fn(),
    createPanner: vi.fn(),
    createAnalyser: vi.fn(),
    createBuffer: vi.fn(),
    createBiquadFilter: vi.fn(),
    decodeAudioData: vi.fn(),
    resume: vi.fn(async () => {
      state = 'running';
    }),
    suspend: vi.fn(async () => {
      state = 'suspended';
    }),
    close: vi.fn(async () => {
      state = 'closed';
    }),
  };
  const source = {
    createWebAudioContext: vi.fn(() => native),
    onTouchStart: vi.fn((listener: () => void) => {
      touch.add(listener);
    }),
    offTouchStart: vi.fn((listener: () => void) => {
      touch.delete(listener);
    }),
    onAudioInterruptionBegin: vi.fn((listener: () => void) => {
      begin.add(listener);
    }),
    offAudioInterruptionBegin: vi.fn((listener: () => void) => {
      begin.delete(listener);
    }),
    onAudioInterruptionEnd: vi.fn((listener: () => void) => {
      end.add(listener);
    }),
    offAudioInterruptionEnd: vi.fn((listener: () => void) => {
      end.delete(listener);
    }),
  };
  const platform = {
    visible: () => visible,
    subscribe: (listener: (event: PlatformEvent) => void) => {
      events.add(listener);
      return ok(() => {
        events.delete(listener);
      });
    },
  } as Platform;
  const errors: unknown[] = [];
  const backend = createWechatAudioBackend(source, platform, {
    onError: (cause) => errors.push(cause),
  });
  return {
    native,
    source,
    platform,
    backend,
    errors,
    events,
    touch,
    begin,
    end,
    afterCloseReads: () => afterCloseReads,
    visibility(value: boolean) {
      visible = value;
      for (const listener of events) listener({ kind: 'visibility', visible });
    },
    state(value: AudioContextState) {
      state = value;
    },
  };
}

describe('native Web Audio lifecycle', () => {
  it('stays lazy without browser globals and closes the borrowed Context after owner cleanup exactly once', () => {
    const f = fixture();
    expect(f.backend.getState().activeSourceCount).toBe(0);
    expect(f.source.createWebAudioContext).not.toHaveBeenCalled();
    expect(f.events.size).toBe(0);
    f.backend.setListenerPose(pose);
    expect(f.source.createWebAudioContext).toHaveBeenCalledTimes(1);
    expect(f.native.listener.positionX?.value).toBe(1);
    expect(f.touch.size).toBe(1);
    expect(f.events.size).toBe(1);
    const stale = [...f.touch, ...f.begin, ...f.end];
    f.backend.destroy();
    f.backend.destroy();
    for (const callback of stale) callback();
    expect(f.native.close).toHaveBeenCalledTimes(1);
    expect([f.touch.size, f.begin.size, f.end.size, f.events.size]).toEqual([0, 0, 0, 0]);
    expect(f.backend.getState()).toMatchObject({ contextState: 'closed', activeSourceCount: 0 });
    expect(f.afterCloseReads()).toBe(0);
    expect(f.errors).toEqual([]);
  });

  it('does not create a Context or retain native subscriptions when disposed before audio demand', () => {
    const f = fixture();
    f.backend.destroy();
    f.backend.setListenerPose(pose);
    expect(f.source.createWebAudioContext).not.toHaveBeenCalled();
    expect(f.events.size).toBe(0);
  });

  it('serializes a pending resume with later visibility and interruption, then allows gesture retry', async () => {
    const f = fixture('suspended');
    f.backend.setListenerPose(pose);
    let resume!: () => void;
    f.native.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resume = () => {
            f.state('running');
            resolve();
          };
        }),
    );
    for (const listener of f.touch) {
      listener();
      listener();
    }
    f.visibility(false);
    expect(f.native.resume).toHaveBeenCalledTimes(1);
    expect(f.native.suspend).not.toHaveBeenCalled();
    resume();
    await vi.waitFor(() => expect(f.native.suspend).toHaveBeenCalledTimes(1));
    expect(f.backend.getState().contextState).toBe('suspended');
    f.visibility(true);
    await vi.waitFor(() => expect(f.backend.getState().contextState).toBe('running'));
    for (const listener of f.begin) listener();
    await vi.waitFor(() => expect(f.backend.getState().contextState).toBe('suspended'));
    for (const listener of f.touch) listener();
    expect(f.native.resume).toHaveBeenCalledTimes(2);
    for (const listener of f.end) listener();
    await vi.waitFor(() => expect(f.backend.getState().contextState).toBe('running'));
    f.state('suspended');
    const cause = { errMsg: 'resume denied' };
    f.native.resume.mockRejectedValueOnce(cause);
    for (const listener of f.touch) listener();
    await vi.waitFor(() => expect(f.errors).toHaveLength(1));
    expect(f.errors[0]).toMatchObject({
      code: 'platform-operation-failed',
      detail: { operation: 'WebAudioContext.resume', cause },
    });
    for (const listener of f.touch) listener();
    await vi.waitFor(() => expect(f.backend.getState().contextState).toBe('running'));
    f.backend.destroy();
  });

  it('fences pending transitions after disposal and reports native close rejection', async () => {
    const f = fixture('suspended');
    f.backend.setListenerPose(pose);
    let resume!: () => void;
    f.native.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    );
    for (const listener of f.touch) listener();
    f.visibility(false);
    const cause = new Error('native close failed');
    f.native.close.mockRejectedValueOnce(cause);
    f.backend.destroy();
    resume();
    await vi.waitFor(() => expect(f.errors).toHaveLength(1));
    expect(f.errors[0]).toMatchObject({ detail: { operation: 'WebAudioContext.close', cause } });
    expect(f.native.suspend).not.toHaveBeenCalled();
    expect(f.backend.getState().contextState).toBe('closed');
  });

  it('rolls back partial subscription and keeps actual capability failure at first demand', () => {
    const f = fixture();
    f.source.onAudioInterruptionBegin.mockImplementationOnce(() => {
      throw new Error('native subscribe failed');
    });
    expect(() => f.backend.setListenerPose(pose)).toThrow('context-creation-failed');
    expect(f.native.close).toHaveBeenCalledTimes(1);
    expect([f.touch.size, f.begin.size, f.end.size, f.events.size]).toEqual([0, 0, 0, 0]);
    expect(f.backend.getState().lastError?.code).toBe('context-creation-failed');
    f.backend.destroy();
    const errors: unknown[] = [];
    const absent = createWechatAudioBackend({} as WechatAudioSource, f.platform, {
      onError: (error) => errors.push(error),
    });
    expect(errors).toEqual([]);
    expect(() => absent.setListenerPose(pose)).toThrow('context-creation-failed');
    expect(errors[0]).toMatchObject({ detail: { cause: { code: 'platform-unavailable' } } });
    absent.destroy();
  });

  it('rejects an incompatible listener at demand and preserves startup failure if its observer throws', () => {
    const f = fixture();
    Object.assign(f.native.listener, { positionX: 0 });
    const backend = createWechatAudioBackend(f.source, f.platform, {
      onError() {
        throw new Error('observer failed');
      },
    });
    expect(() => backend.setListenerPose(pose)).toThrow('context-creation-failed');
    expect(backend.getState().lastError).toMatchObject({
      code: 'context-creation-failed',
      detail: { reason: 'native AudioListener.positionX needs AudioParam support' },
    });
    expect(f.native.close).toHaveBeenCalledTimes(1);
    expect(f.events.size).toBe(0);
    backend.destroy();
    f.backend.destroy();
  });
});
