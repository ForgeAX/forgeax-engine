import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { type TransferListItem, Worker } from 'node:worker_threads';
import { createRecordGameSaves } from '@forgeax/engine-app';
import { runtimePackTaskKinds } from '@forgeax/engine-import';
import {
  diffGamepadFrame,
  type GamepadSlotSample,
  type InputBackend,
  type InputBackendSample,
} from '@forgeax/engine-input';
import {
  createPlatformClock,
  createPlatformLifecycle,
  createTaskPool,
  type DisplayFacts,
  type Platform,
  platformError,
} from '@forgeax/engine-platform';
import { ok, type PackageRequest } from '@forgeax/engine-types';
import type { BlitzDesktopInput } from '@forgeax/engine-ui-blitz';
import { writeFileAtomic } from '../filesystem-path.js';
import { createDesktopRecordStore } from './desktop-storage.js';

export { desktopDeviceFacts, validateDesktopStartup } from './desktop-configuration.js';
export {
  createNativeKernelDesktopHost,
  type NativeKernelDesktopCanvas,
  type NativeKernelDesktopHost,
  type NativeKernelDesktopHostOptions,
} from './desktop-native-host.js';
export {
  createForgeaxDesktopNativeRenderer,
  ForgeaxDesktopNativeRenderer,
  type ForgeaxDesktopNativeRendererOptions,
} from './desktop-native-kernel.js';
export { createDesktopRuntimePackCache } from './desktop-runtime-pack-cache.js';
export { createDesktopFileStore } from './desktop-storage.js';

/** Submit authored Pack jobs through the installed game's Node Worker entry. */
export function createDesktopRuntimePackTasks(url: string) {
  return createTaskPool({
    kinds: runtimePackTaskKinds,
    workers: 1,
    workerFactory(listener) {
      const worker = new Worker(new URL(url), { name: 'forgeax-runtime-pack' });
      worker.on('message', listener.message);
      worker.on('error', listener.error);
      worker.once('exit', (code) =>
        listener.error(new Error(`Runtime Pack Worker exited: ${code}`)),
      );
      return {
        postMessage: (message, transfer) =>
          worker.postMessage(message, transfer as TransferListItem[] | undefined),
        terminate: () => {
          void worker.terminate();
        },
      };
    },
  });
}

export const desktopPackageUrl = 'https://forgeax.package/';

function within(root: string, path: string): boolean {
  const name = relative(root, path);
  return name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
}

/** Serve the same Catalog and Bundle descriptors directly from the installed game. */
export function createDesktopPackageFetcher(
  root: string,
): (input: string, init?: PackageRequest) => Promise<Response> {
  const base = new URL(desktopPackageUrl);
  return async (input, init) => {
    const signal = init?.signal;
    signal?.throwIfAborted();
    const url = new URL(input, base);
    if (url.origin !== base.origin || url.username || url.password)
      return new Response(null, { status: 403 });
    const local = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!within(root, local)) return new Response(null, { status: 403 });
    const method = init?.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') return new Response(null, { status: 405 });
    let path: string;
    try {
      path = await realpath(local);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return new Response(null, { status: 404 });
      throw error;
    }
    if (!within(await realpath(root), path)) return new Response(null, { status: 403 });
    return readDesktopAsset(path, method, init?.headers, signal);
  };
}

async function readDesktopAsset(
  path: string,
  method: 'GET' | 'HEAD',
  requestHeaders: PackageRequest['headers'],
  signal: PackageRequest['signal'],
): Promise<Response> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) return new Response(null, { status: 404 });
    const range = Object.entries(requestHeaders ?? {}).find(
      ([name]) => name.toLowerCase() === 'range',
    )?.[1];
    const match = range === undefined ? null : /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = match === null ? 0 : Number(match[1]);
    const end = Math.min(info.size - 1, match?.[2] ? Number(match[2]) : info.size - 1);
    if (range !== undefined && (match === null || !Number.isSafeInteger(start) || start > end)) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${info.size}` },
      });
    }
    const length = end - start + 1;
    const headers = new Headers({ 'Content-Length': String(length), 'Accept-Ranges': 'bytes' });
    if (range !== undefined) headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
    const status = range === undefined ? 200 : 206;
    if (method === 'HEAD') return new Response(null, { status, headers });
    const bytes = new Uint8Array(length);
    for (let offset = 0; offset < length; ) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(bytes, offset, length - offset, start + offset);
      if (bytesRead === 0) throw new Error('An installed asset changed while it was being read');
      offset += bytesRead;
    }
    signal?.throwIfAborted();
    return new Response(bytes, { status, headers });
  } finally {
    await file.close();
  }
}

/** Publish complete preference bytes with an atomic replacement. */
export function createDesktopPreferenceStorage(path: string) {
  let pending: Promise<void> = Promise.resolve();
  return {
    async read() {
      await pending;
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    write(bytes: string) {
      const write = pending.then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFileAtomic(path, bytes, { syncFile: true });
      });
      pending = write.catch(() => {});
      return write;
    },
    flush: () => pending,
  };
}

/** Writes are serialized across slots and drained after the game has stopped. */
export function createDesktopGameSaves(root: string) {
  let pending = Promise.resolve();
  const records = createDesktopRecordStore(root, {
    fileName: (slot) => `slot-${slot}.json`,
    durable: true,
  });
  const saves = createRecordGameSaves({
    async read(slot, signal) {
      await pending;
      return records.read(slot, signal);
    },
    replace(slot, bytes, signal) {
      const write = pending.then(() => records.replace(slot, bytes, signal));
      pending = write.then(() => undefined);
      return write;
    },
    remove: records.remove,
  });
  return { saves, flush: () => pending };
}

type DesktopEvent =
  | { readonly kind: 'redraw' | 'display' | 'close-requested' | 'surface-lost' | 'pointer-leave' }
  | { readonly kind: 'visibility'; readonly visible: boolean }
  | { readonly kind: 'focus'; readonly focused: boolean }
  | {
      readonly kind: 'key-down' | 'key-up';
      readonly code?: string;
      readonly key?: string;
      readonly text?: string;
      readonly repeat: boolean;
      readonly shiftKey?: boolean;
      readonly ctrlKey?: boolean;
      readonly altKey?: boolean;
      readonly metaKey?: boolean;
    }
  | {
      readonly kind: 'ime-preedit' | 'ime-commit';
      readonly text: string;
      readonly generation: number;
    }
  | { readonly kind: 'ime-cancel'; readonly generation: number }
  | { readonly kind: 'pointer-relative'; readonly dx: number; readonly dy: number }
  | {
      readonly kind: 'pointer-wheel';
      readonly x: number;
      readonly y: number;
      readonly dx: number;
      readonly dy: number;
    }
  | { readonly kind: 'pointer-move'; readonly x: number; readonly y: number }
  | {
      readonly kind: 'pointer-down' | 'pointer-up';
      readonly x: number;
      readonly y: number;
      readonly button: 'left' | 'right' | 'middle';
    };

interface DesktopWindow {
  facts(): {
    unwrap(): {
      readonly width: number;
      readonly height: number;
      readonly scaleFactor: number;
      readonly visible: boolean;
    };
  };
  pollEvents(): { unwrap(): readonly DesktopEvent[] };
  requestRedraw(): { unwrap(): void };
}

/** Schedule App through winit redraw notifications and keep pumping when hidden. */
export function createDesktopPlatform(
  window: DesktopWindow,
  onClose: () => void,
  onError: (error: unknown) => void,
  onInput: (event: DesktopEvent, pixelRatio: number) => void,
): Platform {
  const lifecycle = createPlatformLifecycle();
  const clock = createPlatformClock(() => performance.now(), 'milliseconds');
  let facts = window.facts().unwrap();
  let displayFacts = facts;
  let pending: (() => void) | undefined;
  let retryRedrawAt = 0;
  const hasDrawableSize = () => facts.width > 0 && facts.height > 0;
  const visible = () => facts.visible && hasDrawableSize();
  const display = (): DisplayFacts => {
    const width = displayFacts.width / displayFacts.scaleFactor;
    const height = displayFacts.height / displayFacts.scaleFactor;
    return {
      width,
      height,
      drawingWidth: displayFacts.width,
      drawingHeight: displayFacts.height,
      pixelRatio: displayFacts.scaleFactor,
      safeArea: { x: 0, y: 0, width, height },
    };
  };
  const pump = setInterval(() => {
    try {
      const events = window.pollEvents().unwrap();
      const wasVisible = visible();
      facts = window.facts().unwrap();
      // A minimized window may report a zero extent. Keep its last drawable viewport.
      const displayChanged =
        hasDrawableSize() &&
        (displayFacts.width !== facts.width ||
          displayFacts.height !== facts.height ||
          displayFacts.scaleFactor !== facts.scaleFactor);
      if (displayChanged) displayFacts = facts;
      if (wasVisible !== visible()) lifecycle.emit({ kind: 'visibility', visible: visible() });
      if (displayChanged) lifecycle.emit({ kind: 'display', display: display() });
      let redraw = false;
      for (const event of events) {
        if (event.kind === 'close-requested') {
          onClose();
          return;
        }
        if (event.kind === 'redraw') redraw = true;
        else if (event.kind === 'surface-lost')
          lifecycle.emit({ kind: 'surface-lost', cause: event });
        else onInput(event, facts.scaleFactor);
      }
      if (redraw || !visible()) retryRedrawAt = 0;
      if (redraw && visible() && pending !== undefined) {
        const frame = pending;
        pending = undefined;
        frame();
      }
      // Native compositors can coalesce a request without delivering another redraw event.
      const now = performance.now();
      if (visible() && pending !== undefined && now >= retryRedrawAt) {
        window.requestRedraw().unwrap();
        retryRedrawAt = now + 32;
      }
    } catch (error) {
      lifecycle.dispose();
      onError(error);
    }
  }, 4);
  lifecycle.bind((releases) => releases.push(() => clearInterval(pump))).unwrap();
  return {
    now: clock.now,
    visible,
    display: () =>
      lifecycle.disposed
        ? platformError('platform-disposed', { operation: 'display' })
        : ok(display()),
    subscribe: lifecycle.subscribe,
    requestFrame: (callback) =>
      lifecycle.requestFrame((run) => {
        if (pending !== undefined) throw new Error('A desktop frame is already pending');
        pending = run;
        return () => {
          if (pending === run) pending = undefined;
        };
      }, callback),
    dispose: lifecycle.dispose,
  };
}

interface DesktopUiPointer {
  pointer(event: {
    readonly phase: 'down' | 'move' | 'up' | 'cancel';
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
    readonly pointerType: 'mouse';
  }): boolean;
  wheel?(event: { x: number; y: number; deltaX: number; deltaY: number }): boolean;
  cancel(options?: { readonly preserveFocus?: boolean }): void;
}

type DesktopUi = DesktopUiPointer &
  Partial<Pick<BlitzDesktopInput, 'key' | 'composition' | 'focusedTextArea' | 'subscribeFocus'>>;

interface DesktopInputDevices {
  setImeArea?(area: readonly [number, number, number, number] | null): number;
  gamepads?():
    | readonly {
        readonly index: number;
        readonly buttons: readonly number[];
        readonly axes: readonly number[];
      }[]
    | null;
}

export function createDesktopInput(
  ui: DesktopUi,
  setCursorGrab: (locked: boolean) => boolean = () => false,
  devices: DesktopInputDevices = {},
): InputBackend & {
  accept(event: DesktopEvent, pixelRatio: number): void;
  refreshImeArea(): void;
  readonly controlMode: NonNullable<import('@forgeax/engine-app').GameHost['controlMode']>;
} {
  let allowed = false;
  let focused = true;
  let focusReset = false;
  const codes = new Map<string, string | undefined>();
  let pressed = new Set<string>();
  let released = new Set<string>();
  let pressedKeys = new Set<string>();
  let releasedKeys = new Set<string>();
  let buttons: [boolean, boolean, boolean] = [false, false, false];
  let pressedButtons: [boolean, boolean, boolean] = [false, false, false];
  let releasedButtons: [boolean, boolean, boolean] = [false, false, false];
  let pointer: { x: number; y: number } | undefined;
  let movementX = 0;
  let movementY = 0;
  let wheelDelta = 0;
  let lockAllowed = false;
  let pointerLocked = false;
  let imeGeneration: number | undefined;
  let previousGamepads = new Map<number, GamepadSlotSample>();
  let gamepadBaseline = true;
  const modeListeners = new Set<() => void>();
  const changeLock = (locked: boolean) => {
    if (pointerLocked === locked) return;
    const applied = setCursorGrab(locked);
    if (applied === pointerLocked) return;
    pointerLocked = applied;
    pointer = undefined;
    movementX = movementY = 0;
    for (const listener of modeListeners) listener();
  };
  const refreshImeArea = () => {
    const area = focused ? (ui.focusedTextArea?.() ?? null) : null;
    if (area !== null && area[2] > 0 && area[3] > 0) {
      changeLock(false);
      imeGeneration = devices.setImeArea?.(area);
    } else if (imeGeneration !== undefined) {
      devices.setImeArea?.(null);
      imeGeneration = undefined;
    }
  };
  const clearKeys = () => {
    codes.clear();
    pressed.clear();
    released.clear();
    pressedKeys.clear();
    releasedKeys.clear();
  };
  const stopFocus = ui.subscribeFocus?.(() => {
    if (imeGeneration !== undefined) {
      devices.setImeArea?.(null);
      imeGeneration = undefined;
    }
    refreshImeArea();
    if (imeGeneration !== undefined) {
      clearKeys();
      focusReset = true;
    }
  });
  const clear = () => {
    changeLock(false);
    wheelDelta = 0;
    clearKeys();
    previousGamepads.clear();
    gamepadBaseline = true;
    buttons = [false, false, false];
    pressedButtons = [false, false, false];
    releasedButtons = [false, false, false];
    pointer = undefined;
    movementX = movementY = 0;
    focusReset = true;
    ui.cancel();
    refreshImeArea();
  };
  const acceptButton = (
    event: Extract<DesktopEvent, { readonly kind: 'pointer-down' | 'pointer-up' }>,
    consumed: boolean,
  ): void => {
    const slot = event.button === 'left' ? 0 : event.button === 'middle' ? 1 : 2;
    if (event.kind === 'pointer-down') {
      if (consumed) return;
      pressedButtons[slot] = !buttons[slot];
      buttons[slot] = true;
      if (slot === 0 && lockAllowed) changeLock(true);
    } else if (buttons[slot]) {
      buttons[slot] = false;
      releasedButtons[slot] = true;
    }
  };
  const acceptPointer = (
    event: Extract<DesktopEvent, { readonly kind: 'pointer-move' | 'pointer-down' | 'pointer-up' }>,
    pixelRatio: number,
  ): void => {
    const { x, y } = event;
    const consumed =
      !pointerLocked &&
      (event.kind === 'pointer-move' || event.button === 'left') &&
      ui.pointer({
        phase:
          event.kind === 'pointer-move' ? 'move' : event.kind === 'pointer-down' ? 'down' : 'up',
        pointerId: 1,
        x: x / pixelRatio,
        y: y / pixelRatio,
        pointerType: 'mouse',
      });
    if (!allowed) return;
    if (event.kind !== 'pointer-move') acceptButton(event, consumed);
    else if (!pointerLocked && !consumed && pointer !== undefined) {
      movementX += x - pointer.x;
      movementY += y - pointer.y;
    }
    if (!pointerLocked) pointer = { x, y };
  };
  const releaseKey = (code: string) => {
    const held = codes.get(code);
    if (!codes.delete(code)) return;
    released.add(code);
    if (held !== undefined && !Array.from(codes.values()).includes(held)) releasedKeys.add(held);
  };
  const recordKeyDown = (code: string, key: string | undefined) => {
    if (codes.has(code)) return;
    pressed.add(code);
    const logical = key === 'Unidentified' ? undefined : key;
    if (logical !== undefined && !Array.from(codes.values()).includes(logical))
      pressedKeys.add(logical);
    codes.set(code, logical);
  };
  const acceptKey = (event: Extract<DesktopEvent, { readonly kind: 'key-down' | 'key-up' }>) => {
    const { kind, key, text, ...keys } = event;
    const { code } = keys;
    const up = kind === 'key-up';
    if (up && code !== undefined) releaseKey(code);
    if (!up && code === 'Escape' && pointerLocked) {
      changeLock(false);
      return;
    }
    const editing = imeGeneration !== undefined;
    const handled =
      !pointerLocked &&
      key !== undefined &&
      ui.key?.({
        type: up ? 'keyup' : 'keydown',
        ...keys,
        key,
        nativeText: text === undefined ? {} : { text },
      });
    if (
      !allowed ||
      up ||
      code === undefined ||
      editing ||
      imeGeneration !== undefined ||
      (handled &&
        [
          'Tab',
          'Enter',
          'Escape',
          'Space',
          'ArrowLeft',
          'ArrowRight',
          'ArrowUp',
          'ArrowDown',
        ].includes(code))
    )
      return;
    recordKeyDown(code, key);
  };
  const acceptWheel = (
    event: Extract<DesktopEvent, { readonly kind: 'pointer-wheel' }>,
    ratio: number,
  ) => {
    const consumed =
      !pointerLocked &&
      ui.wheel?.({
        x: event.x / ratio,
        y: event.y / ratio,
        deltaX: event.dx / ratio,
        deltaY: event.dy / ratio,
      });
    if (allowed && !consumed) wheelDelta += Math.sign(event.dy);
  };
  const leavePointer = () => {
    if (pointerLocked) return;
    pointer = undefined;
    for (const slot of [0, 1, 2] as const) {
      if (buttons[slot]) releasedButtons[slot] = true;
      buttons[slot] = false;
    }
    ui.cancel({ preserveFocus: true });
  };
  const sampleGamepads = () => {
    if (!allowed || !focused || imeGeneration !== undefined) {
      previousGamepads.clear();
      gamepadBaseline = true;
      return [];
    }
    const current = devices.gamepads?.() ?? [];
    let slots = diffGamepadFrame(
      previousGamepads,
      current.map(({ index, buttons, axes }) => ({
        index,
        id: '',
        mapping: 'standard',
        connected: true,
        buttons: buttons.map((value) => ({ value, pressed: value >= 0.5 })),
        axes,
      })),
    );
    if (gamepadBaseline)
      slots = slots.map((slot) => ({
        ...slot,
        justPressed: new Set<number>(),
        justReleased: new Set<number>(),
      }));
    // Snapshot consumers may own the sets returned from this frame.
    previousGamepads = new Map(
      slots.map((slot) => [slot.index, { ...slot, pressed: new Set(slot.pressed) }]),
    );
    gamepadBaseline = false;
    return slots;
  };
  refreshImeArea();
  return {
    controlMode: {
      read: () => (pointerLocked ? 'pointer-locked' : 'pointer'),
      subscribe(listener) {
        modeListeners.add(listener);
        return () => modeListeners.delete(listener);
      },
    },
    accept(event, pixelRatio) {
      if (event.kind === 'focus') {
        focused = event.focused;
        if (!focused) clear();
      }
      if (!focused) return;
      switch (event.kind) {
        case 'key-down':
        case 'key-up':
          acceptKey(event);
          break;
        case 'ime-preedit':
        case 'ime-commit':
          if (imeGeneration === event.generation)
            ui.composition?.({
              kind: event.kind === 'ime-preedit' ? 'preedit' : 'commit',
              text: event.text,
            });
          break;
        case 'ime-cancel':
          if (imeGeneration === event.generation) ui.composition?.({ kind: 'cancel' });
          break;
        case 'pointer-move':
        case 'pointer-down':
        case 'pointer-up':
          acceptPointer(event, pixelRatio);
          break;
        case 'pointer-relative':
          if (allowed && pointerLocked) {
            movementX += event.dx;
            movementY += event.dy;
          }
          break;
        case 'pointer-wheel':
          acceptWheel(event, pixelRatio);
          break;
        case 'pointer-leave':
          leavePointer();
          break;
      }
    },
    sample() {
      const sample: InputBackendSample = {
        downKeys: new Set([...codes.values()].filter((key) => key !== undefined)),
        upKeys: releasedKeys,
        pressedKeys,
        downCodes: new Set(codes.keys()),
        pressedCodes: pressed,
        upCodes: released,
        buttons: [...buttons],
        pressedButtons,
        releasedButtons,
        movementX,
        movementY,
        ...(pointer === undefined ? {} : { mouseX: pointer.x, mouseY: pointer.y }),
        wheelDelta,
        focused: allowed && focused,
        focusReset,
        pointerLocked,
        gamepads: sampleGamepads(),
        capabilities: { gamepad: devices.gamepads !== undefined, pointer: false },
      };
      pressed = new Set();
      released = new Set();
      pressedKeys = new Set();
      releasedKeys = new Set();
      pressedButtons = [false, false, false];
      releasedButtons = [false, false, false];
      movementX = movementY = 0;
      wheelDelta = 0;
      focusReset = false;
      return sample;
    },
    setInputAllowed(value) {
      if (allowed && !value) clear();
      allowed = value;
    },
    setPointerLockAllowed(value) {
      lockAllowed = value;
      if (!value) changeLock(false);
    },
    clear,
    refreshImeArea,
    detach() {
      allowed = false;
      clear();
      stopFocus?.();
      modeListeners.clear();
    },
  };
}
