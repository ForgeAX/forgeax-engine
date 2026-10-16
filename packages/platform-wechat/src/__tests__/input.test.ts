import { snapshotFromSample } from '@forgeax/engine-input';
import type { Platform, PlatformEvent } from '@forgeax/engine-platform';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createWechatInputBackend, type WechatTouchEvent, type WechatTouchSource } from '../input';

function fixture() {
  const events = new Map<string, (event: WechatTouchEvent) => void>();
  const listeners = new Set<(event: PlatformEvent) => void>();
  const released: string[] = [];
  let visible = true;
  const source: WechatTouchSource = {
    onTouchStart: (listener) => {
      events.set('down', listener);
    },
    offTouchStart: () => {
      events.delete('down');
      released.push('down');
    },
    onTouchMove: (listener) => {
      events.set('move', listener);
    },
    offTouchMove: () => {
      events.delete('move');
      released.push('move');
    },
    onTouchEnd: (listener) => {
      events.set('up', listener);
    },
    offTouchEnd: () => {
      events.delete('up');
      released.push('up');
    },
    onTouchCancel: (listener) => {
      events.set('cancel', listener);
    },
    offTouchCancel: () => {
      events.delete('cancel');
      released.push('cancel');
    },
  };
  const platform: Platform = {
    now: () => ok(1000),
    requestFrame: () => ok(() => {}),
    visible: () => visible,
    display: () =>
      ok({
        width: 100,
        height: 200,
        pixelRatio: 3,
        drawingWidth: 200,
        drawingHeight: 600,
        safeArea: { x: 0, y: 0, width: 100, height: 200 },
      }),
    subscribe: (listener) => {
      listeners.add(listener);
      return ok(() => {
        listeners.delete(listener);
        released.push('platform');
      });
    },
    dispose: vi.fn(),
  };
  return {
    source,
    platform,
    events,
    listeners,
    released,
    touch(phase: string, x = 10, y = 20, id = 1) {
      events.get(phase)?.({ changedTouches: [{ identifier: id, clientX: x, clientY: y }] });
    },
    visibility(value: boolean) {
      visible = value;
      for (const listener of listeners) listener({ kind: 'visibility', visible });
    },
  };
}

describe('native touch InputBackend', () => {
  it.each([
    'visibility',
    'display',
  ] as const)('revokes held contacts even when UI cancellation throws on %s', (kind) => {
    const f = fixture();
    const failure = new Error('UI cancellation failed');
    const ui = {
      pointer: () => false,
      wheel: () => false,
      key: () => false,
      text: () => {},
      commitText: () => {},
      confirm: () => {},
      cancel: vi.fn(() => {
        throw failure;
      }),
      focusedText: () => null,
      subscribeFocus: () => () => {},
      subscribeTextEdit: () => () => {},
      ownsInput: () => false,
    };
    const backend = createWechatInputBackend(f.source, f.platform, { ui }).unwrap();
    f.touch('down');
    if (kind === 'visibility') {
      expect(() => f.visibility(false)).toThrow(failure);
      expect(() => f.visibility(true)).toThrow(failure);
    } else {
      expect(() => {
        for (const listener of f.listeners)
          listener({ kind: 'display', display: f.platform.display().unwrap() });
      }).toThrow(failure);
    }
    expect(backend.sample()).toMatchObject({ pointers: [], pointerEvents: [], focusReset: true });
    f.touch('move');
    f.touch('up');
    expect(backend.sample().pointerEvents).toEqual([]);
    const stale = f.events.get('down');
    expect(() => backend.detach()).toThrow();
    expect(f.events.size).toBe(0);
    expect(f.listeners.size).toBe(0);
    stale?.({ changedTouches: [{ identifier: 1, clientX: 10, clientY: 20 }] });
    expect(backend.sample().pointers).toEqual([]);
    expect(() => backend.detach()).not.toThrow();
  });

  it('preserves short contacts and maps logical coordinates to the actual drawing buffer', () => {
    const f = fixture();
    const backend = createWechatInputBackend(f.source, f.platform).unwrap();
    f.touch('down');
    f.touch('up', 12, 22);
    const sample = backend.sample();
    expect(sample.pointers).toEqual([]);
    expect(sample.pointerEvents).toEqual([
      { pointerId: 1, phase: 'down', x: 20, y: 60, pressure: 0.5, pointerType: 'touch' },
      { pointerId: 1, phase: 'up', x: 24, y: 66, pressure: 0, pointerType: 'touch' },
    ]);
    expect(snapshotFromSample(sample).mouse.pointerLocked).toBe(false);
    expect(backend.sample().pointerEvents).toEqual([]);
    backend.detach();
  });

  it('keeps contact identity, accumulated movement and previous samples independent', () => {
    const f = fixture();
    const backend = createWechatInputBackend(f.source, f.platform).unwrap();
    f.touch('down');
    f.touch('down', 40, 50, 2);
    f.touch('move', 12, 23);
    f.touch('move', 15, 26);
    const first = backend.sample();
    expect(first.pointers?.[0]?.delta).toEqual({ x: 10, y: 18 });
    expect(backend.sample().pointers?.[0]?.delta).toEqual({ x: 0, y: 0 });
    f.touch('cancel', 40, 50, 2);
    const next = backend.sample();
    expect(next.pointers).toHaveLength(1);
    expect(next.pointerEvents?.[0]?.phase).toBe('cancel');
    expect(first.pointers).toHaveLength(2);
    expect(first.pointers?.[0]?.delta).toEqual({ x: 10, y: 18 });
    backend.detach();
  });

  it('revokes contacts on hide and ownership changes without admitting stale moves', () => {
    const f = fixture();
    const backend = createWechatInputBackend(f.source, f.platform).unwrap();
    f.touch('down');
    f.visibility(false);
    expect(backend.sample()).toMatchObject({ focused: false, focusReset: true, pointers: [] });
    f.visibility(true);
    f.touch('move');
    f.touch('up');
    expect(backend.sample().pointerEvents).toEqual([]);
    f.touch('down');
    backend.setInputAllowed?.(false);
    f.touch('down', 50, 50, 2);
    backend.setInputAllowed?.(true);
    expect(backend.sample().pointers).toEqual([]);
    backend.detach();
  });

  it('fences callbacks after detach and releases only its own leases once', () => {
    const f = fixture();
    const backend = createWechatInputBackend(f.source, f.platform).unwrap();
    const stale = f.events.get('down');
    backend.detach();
    backend.detach();
    stale?.({ changedTouches: [{ identifier: 1, clientX: 10, clientY: 20 }] });
    expect(backend.sample()).toMatchObject({ focused: false, pointers: [], pointerEvents: [] });
    expect(f.released).toEqual(['cancel', 'up', 'move', 'down', 'platform']);
    expect(f.platform.dispose).not.toHaveBeenCalled();
  });

  it('rolls back partial native listener acquisition and retains cleanup failures', () => {
    const f = fixture();
    const failure = new Error('native subscribe failed');
    f.source.onTouchMove = () => {
      throw failure;
    };
    f.source.offTouchMove = () => {
      throw new Error('native cleanup failed');
    };
    const result = createWechatInputBackend(f.source, f.platform);
    expect(result).toMatchObject({
      ok: false,
      error: {
        detail: {
          operation: 'touch.subscribe',
          cause: failure,
          cleanupCause: expect.anything(),
        },
      },
    });
    expect(f.events.size).toBe(0);
    expect(f.listeners.size).toBe(0);
  });

  it('rejects an invalid batch before any partial contact can escape', () => {
    const f = fixture();
    const backend = createWechatInputBackend(f.source, f.platform).unwrap();
    expect(() =>
      f.events.get('down')?.({
        changedTouches: [
          { identifier: 1, clientX: 10, clientY: 20 },
          { identifier: 2, clientX: Number.NaN, clientY: 20 },
        ],
      }),
    ).toThrow();
    expect(backend.sample().pointers).toEqual([]);
    backend.detach();
  });
});

it('routes UI before startup gating and cancels gameplay contacts when ownership changes', () => {
  const f = fixture();
  const contacts = new Set<number>();
  const pointer = vi.fn((event: { phase: string; pointerId: number; x: number }) => {
    if (event.phase === 'down' && event.x < 50) contacts.add(event.pointerId);
    const consumed = contacts.has(event.pointerId);
    if (event.phase === 'up' || event.phase === 'cancel') contacts.delete(event.pointerId);
    return consumed;
  });
  const ui = {
    pointer,
    wheel: () => false,
    key: () => false,
    text: () => {},
    commitText: () => {},
    confirm: () => {},
    cancel: () => {
      contacts.clear();
    },
    focusedText: () => null,
    subscribeFocus: () => () => {},
    subscribeTextEdit: () => () => {},
    ownsInput: () => contacts.size > 0,
  };
  const backend = createWechatInputBackend(f.source, f.platform, { ui }).unwrap();
  f.touch('down', 80, 20, 1);
  expect(backend.sample().pointers).toHaveLength(1);
  f.touch('down', 10, 20, 2);
  expect(backend.sample()).toMatchObject({ focused: false, focusReset: true, pointers: [] });
  f.touch('up', 10, 20, 2);
  f.touch('move', 81, 20, 1);
  expect(backend.sample().pointers).toEqual([]);
  backend.setInputAllowed?.(false);
  f.touch('down', 10, 20, 3);
  f.touch('up', 10, 20, 3);
  expect(pointer).toHaveBeenLastCalledWith(
    expect.objectContaining({ pointerId: 3, x: 10, phase: 'up' }),
  );
  expect(backend.sample().focused).toBe(false);
  backend.setInputAllowed?.(true);
  f.touch('down', 80, 20, 4);
  expect(backend.sample().pointers).toHaveLength(1);
  f.visibility(false);
  f.visibility(true);
  f.touch('move', 80, 20, 4);
  expect(backend.sample().pointers).toEqual([]);
  backend.detach();
});
