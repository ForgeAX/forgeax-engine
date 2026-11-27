import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  createDesktopGameSaves,
  createDesktopInput,
  createDesktopPackageFetcher,
  createDesktopPlatform,
  createDesktopPreferenceStorage,
  createDesktopRuntimePackCache,
} from '../desktop-platform.js';

test('projects standard gamepad axes and edges and suppresses stale presses after focus loss', () => {
  let connected = true;
  let held = false;
  const input = createDesktopInput({ pointer: () => false, cancel: () => {} }, undefined, {
    gamepads: () =>
      connected ? [{ index: 0, buttons: [Number(held)], axes: [0.5, -1, 0, 0] }] : [],
  });
  input.setInputAllowed?.(true);
  expect(input.sample().gamepads?.[0]?.axes).toEqual([0.5, -1, 0, 0]);
  held = true;
  expect(input.sample().gamepads?.[0]?.justPressed.has(0)).toBe(true);
  input.accept({ kind: 'focus', focused: false }, 1);
  expect(input.sample().gamepads).toEqual([]);
  input.accept({ kind: 'focus', focused: true }, 1);
  const restored = input.sample().gamepads?.[0];
  expect(restored?.pressed.has(0)).toBe(true);
  expect(restored?.justPressed.size).toBe(0);
  held = false;
  expect(input.sample().gamepads?.[0]?.justReleased.has(0)).toBe(true);
  connected = false;
  expect(input.sample().gamepads).toEqual([]);
  input.detach();
});

test('keeps keyboard gameplay and ordered native IME tied to the active editor', () => {
  let editing = false;
  let focusChanged: (() => void) | undefined;
  let generation = 0;
  const composition = vi.fn();
  const input = createDesktopInput(
    {
      pointer: () => false,
      cancel: () => {},
      key: () => editing,
      focusedTextArea: () => (editing ? [10, 20, 100, 30] : null),
      subscribeFocus: (listener) => {
        focusChanged = listener;
        return () => {};
      },
      composition,
    },
    undefined,
    { setImeArea: () => ++generation },
  );
  input.setInputAllowed?.(true);
  input.accept({ kind: 'key-down', key: 'w', code: 'KeyW', repeat: false, text: 'w' }, 1);
  expect(input.sample().downKeys.has('w')).toBe(true);
  editing = true;
  focusChanged?.();
  const previous = generation;
  input.accept({ kind: 'key-down', key: 'a', code: 'KeyA', repeat: false, text: 'a' }, 1);
  expect(input.sample().downCodes?.size).toBe(0);
  focusChanged?.();
  input.accept({ kind: 'ime-commit', generation: previous, text: 'old field' }, 1);
  input.accept({ kind: 'ime-commit', generation, text: '\u4e2d' }, 1);
  expect(composition.mock.calls).toEqual([[{ kind: 'commit', text: '\u4e2d' }]]);
  input.detach();
});

test('reads the installed package and its byte ranges while confining file access', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'forgeax-desktop-'));
  const root = await mkdtemp(join(parent, 'game-'));
  try {
    await writeFile(join(root, 'data.bin'), 'abcdefghijklmnopqrstuvwxyz');
    await writeFile(join(parent, 'outside'), 'outside package');
    if (process.platform !== 'win32') await symlink(join(parent, 'outside'), join(root, 'link'));
    const fetcher = createDesktopPackageFetcher(root);
    const range = await fetcher('data.bin', { headers: { Range: 'bytes=3-5' } });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 3-5/26');
    expect(await range.text()).toBe('def');
    expect((await fetcher('data.bin', { method: 'HEAD' })).headers.get('content-length')).toBe(
      '26',
    );
    expect((await fetcher('data.bin', { headers: { Range: 'bytes=30-' } })).status).toBe(416);
    expect((await fetcher('missing')).status).toBe(404);
    if (process.platform !== 'win32') expect((await fetcher('link')).status).toBe(403);
    expect((await fetcher('https://example.test/data.bin')).status).toBe(403);
    await expect(fetcher('data.bin', { signal: AbortSignal.abort() })).rejects.toThrow();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('retries missed native redraws and releases cancelled frames', () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const close = vi.fn();
  const error = vi.fn();
  const redraw = vi.fn();
  const draw = vi.fn();
  const lifecycle = vi.fn();
  let visible = false;
  let width = 1600;
  let event: 'redraw' | 'close-requested' | undefined;
  const platform = createDesktopPlatform(
    {
      facts: () => ({ unwrap: () => ({ width, height: 1000, scaleFactor: 2, visible }) }),
      pollEvents: () => ({
        unwrap: () => {
          const pending = event;
          event = undefined;
          return pending === undefined ? [] : [{ kind: pending }];
        },
      }),
      requestRedraw: () => ({ unwrap: redraw }),
    },
    close,
    error,
    vi.fn(),
  );
  try {
    platform.subscribe(lifecycle).unwrap();
    expect(platform.display().unwrap().width).toBe(800);
    platform.requestFrame(draw).unwrap()();
    platform.requestFrame(draw).unwrap();
    vi.advanceTimersByTime(8);
    expect(redraw).not.toHaveBeenCalled();
    visible = true;
    vi.advanceTimersByTime(4);
    expect(redraw).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(28);
    expect(redraw).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4);
    expect(redraw).toHaveBeenCalledTimes(2);
    expect(draw).not.toHaveBeenCalled();
    event = 'redraw';
    vi.advanceTimersByTime(4);
    expect(draw).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(64);
    expect(redraw).toHaveBeenCalledTimes(2);
    lifecycle.mockClear();
    width = 0;
    vi.advanceTimersByTime(4);
    expect(platform.visible()).toBe(false);
    expect(platform.display().unwrap().drawingWidth).toBe(1600);
    expect(lifecycle.mock.calls).toEqual([[{ kind: 'visibility', visible: false }]]);
    width = 1200;
    vi.advanceTimersByTime(4);
    expect(platform.visible()).toBe(true);
    expect(platform.display().unwrap().drawingWidth).toBe(1200);
    expect(lifecycle).toHaveBeenLastCalledWith({
      kind: 'display',
      display: expect.objectContaining({ drawingWidth: 1200, width: 600 }),
    });
    event = 'close-requested';
    vi.advanceTimersByTime(4);
    expect(close).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  } finally {
    platform.dispose();
    vi.useRealTimers();
  }
});

test('preserves captured physical key edges and keeps UI clicks out of gameplay', () => {
  const pointer = vi.fn(() => true);
  const input = createDesktopInput({ pointer, cancel: vi.fn() });
  input.setInputAllowed?.(true);
  input.accept({ kind: 'key-down', code: 'KeyW', repeat: false }, 2);
  input.accept({ kind: 'key-up', code: 'KeyW', repeat: false }, 2);
  input.accept({ kind: 'pointer-down', button: 'left', x: 10, y: 20 }, 2);
  const sample = input.sample();
  expect(sample.pressedCodes).toEqual(new Set(['KeyW']));
  expect(sample.upCodes).toEqual(new Set(['KeyW']));
  expect(sample.buttons).toEqual([false, false, false]);
  expect(pointer).toHaveBeenCalledWith(expect.objectContaining({ x: 5, y: 10 }));
  expect(input.sample().pressedCodes?.size).toBe(0);
  input.accept({ kind: 'key-down', code: 'KeyW', repeat: false }, 2);
  input.accept({ kind: 'focus', focused: false }, 2);
  expect(input.sample()).toMatchObject({ focused: false, downCodes: new Set() });
});

test('restores the most recently committed preferences in a fresh host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-preferences-'));
  try {
    const path = join(root, 'game', 'quality.json');
    const storage = createDesktopPreferenceStorage(path);
    expect(await storage.read()).toBeNull();
    await Promise.all([storage.write('first'), storage.write('second')]);
    expect(await createDesktopPreferenceStorage(path).read()).toBe('second');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('drains atomic checkpoint replacements and reads them in a fresh host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-game-saves-'));
  try {
    const storage = createDesktopGameSaves(root);
    expect((await storage.saves.read('checkpoint')).unwrap()).toBeNull();
    await mkdir(join(root, 'slot-occupied.json'));
    const denied = storage.saves.write('occupied', { version: 1, data: null });
    const writes = [
      storage.saves.write('checkpoint', { version: 1, data: { position: [1, 2, 3] } }),
      storage.saves.write('autosave', { version: 1, data: 'next-slot' }),
      storage.saves.write('checkpoint', { version: 2, data: { position: [2, 3, 4] } }),
    ];
    await storage.flush();
    expect((await createDesktopGameSaves(root).saves.read('autosave')).unwrap()).toEqual({
      version: 1,
      data: 'next-slot',
    });
    expect((await createDesktopGameSaves(root).saves.read('checkpoint')).unwrap()).toEqual({
      version: 2,
      data: { position: [2, 3, 4] },
    });
    expect(await denied).toMatchObject({ error: { code: 'storage-unavailable' } });
    expect((await Promise.all(writes)).every((result) => result.ok)).toBe(true);
    expect(await storage.saves.read('../quality')).toMatchObject({
      error: { code: 'invalid-slot' },
    });
    expect(await storage.saves.write('checkpoint', { version: 3, data: NaN })).toMatchObject({
      error: { code: 'invalid-save' },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('foreground cursor grab uses relative motion and clears its lease with focus or Escape', () => {
  const pointer = vi.fn(() => false);
  const grab = vi.fn((locked: boolean) => locked);
  const wheel = vi.fn(() => false);
  const input = createDesktopInput({ pointer, wheel, cancel: vi.fn() }, grab);
  const observe = vi.fn();
  const stop = input.controlMode.subscribe(observe);
  input.setInputAllowed?.(true);
  input.setPointerLockAllowed?.(true);
  input.accept({ kind: 'pointer-down', button: 'left', x: 10, y: 20 }, 2);
  input.accept({ kind: 'pointer-move', x: 20, y: 30 }, 2);
  input.accept({ kind: 'pointer-relative', dx: 3, dy: -4 }, 2);
  input.accept({ kind: 'pointer-wheel', x: 20, y: 30, dx: 0, dy: -40 }, 2);
  expect(input.sample()).toMatchObject({
    movementX: 3,
    movementY: -4,
    pointerLocked: true,
    wheelDelta: -1,
  });
  expect(pointer).toHaveBeenCalledTimes(1);
  expect(wheel).not.toHaveBeenCalled();
  expect(input.sample().wheelDelta).toBe(0);
  input.accept({ kind: 'key-down', code: 'Escape', repeat: false }, 2);
  expect(input.controlMode.read()).toBe('pointer');
  expect(observe).toHaveBeenCalledTimes(2);
  input.accept({ kind: 'pointer-wheel', x: 20, y: 30, dx: 0, dy: 40 }, 2);
  expect(wheel).toHaveBeenCalledWith({ x: 10, y: 15, deltaX: 0, deltaY: 20 });
  input.accept({ kind: 'pointer-down', button: 'left', x: 10, y: 20 }, 2);
  input.accept({ kind: 'focus', focused: false }, 2);
  expect(input.sample()).toMatchObject({ pointerLocked: false, focused: false, focusReset: true });
  stop();
  expect(grab.mock.calls).toEqual([[true], [false], [true], [false]]);
});

test('reopens committed Pack bytes and preserves them when the replacement is cancelled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-desktop-pack-cache-'));
  const key = `sha256:${'a'.repeat(64)}`;
  const signal = new AbortController().signal;
  const prior = new Uint8Array([1, 2, 3]);
  try {
    const store = createDesktopRuntimePackCache(join(root, 'packs'));
    expect(await store.read(key, signal)).toBeUndefined();
    await store.write(key, prior, signal);
    const reopened = createDesktopRuntimePackCache(join(root, 'packs'));
    await expect(reopened.write(key, new Uint8Array([9]), AbortSignal.abort())).rejects.toThrow();
    expect(await reopened.read(key, signal)).toEqual(prior);
    await expect(reopened.read('../quality.json', signal)).rejects.toThrow('cache key');
    expect(await readdir(join(root, 'packs'))).toEqual([`${'a'.repeat(64)}.bin`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bounds the Pack namespace and sweeps abandoned temporary files independently of settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-desktop-pack-eviction-'));
  const stale = new Date('2020-01-01T00:00:00Z');
  const oldest = `${'0'.repeat(64)}.bin`;
  const abandoned = `${oldest}.00000000-0000-4000-8000-000000000000.tmp`;
  const signal = new AbortController().signal;
  try {
    await Promise.all(
      Array.from({ length: 128 }, (_, index) =>
        writeFile(join(root, `${index.toString(16).padStart(64, '0')}.bin`), 'cache'),
      ),
    );
    await writeFile(join(root, abandoned), 'partial');
    await writeFile(join(root, 'quality.json'), 'settings');
    await Promise.all([
      utimes(join(root, oldest), stale, stale),
      utimes(join(root, abandoned), stale, stale),
    ]);
    const store = createDesktopRuntimePackCache(root);
    await store.write(`sha256:${'b'.repeat(64)}`, new Uint8Array([9]), signal);
    const files = await readdir(root);
    expect(files.filter((file) => file.endsWith('.bin'))).toHaveLength(128);
    expect(files).not.toContain(oldest);
    expect(files).not.toContain(abandoned);
    expect(files).toContain('quality.json');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
