import { Update, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { attachBrowserInputBackend } from '../browser-backend';
import { INPUT_BACKEND_KEY, InputFrameStartScan } from '../frame-start-scan-system';
import { INPUT_SNAPSHOT_RESOURCE_KEY, snapshotFromSample } from '../input-snapshot';

type Listener = (event: Event) => void;

function buildEnvironment(): {
  readonly backend: ReturnType<typeof attachBrowserInputBackend>['backend'];
  fire(target: 'canvas' | 'document' | 'window', kind: string, event: Event): void;
} {
  const listeners = new Map<string, Map<string, Set<Listener>>>();
  const target = (name: string) => ({
    addEventListener(kind: string, listener: Listener): void {
      let byKind = listeners.get(name);
      if (byKind === undefined) {
        byKind = new Map();
        listeners.set(name, byKind);
      }
      let handlers = byKind.get(kind);
      if (handlers === undefined) {
        handlers = new Set();
        byKind.set(kind, handlers);
      }
      handlers.add(listener);
    },
    removeEventListener(kind: string, listener: Listener): void {
      listeners.get(name)?.get(kind)?.delete(listener);
    },
  });
  const canvas = {
    ...target('canvas'),
    width: 800,
    height: 600,
    style: { touchAction: '' },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect,
    requestPointerLock: () => {},
    setPointerCapture: () => {},
  } as unknown as HTMLCanvasElement;
  const document = {
    ...target('document'),
    hasFocus: () => true,
    visibilityState: 'visible',
    pointerLockElement: null,
    exitPointerLock: () => {},
  } as unknown as Document;
  const window = target('window') as unknown as Window;
  const handle = attachBrowserInputBackend(canvas, { document, window });
  return {
    backend: handle.backend,
    fire(targetName, kind, event) {
      for (const listener of listeners.get(targetName)?.get(kind) ?? []) listener(event);
    },
  };
}

function keyEvent(key: string, code: string, repeat = false): Event {
  return { key, code, repeat } as unknown as Event;
}

function pointerEvent(type: 'pointerdown' | 'pointerup', button: 0 | 1 | 2): Event {
  return {
    pointerId: 1,
    pointerType: 'mouse',
    button,
    clientX: 100,
    clientY: 100,
    pressure: type === 'pointerdown' ? 0.5 : 0,
    movementX: 0,
    movementY: 0,
  } as unknown as Event;
}

describe('browser input edge latch', () => {
  it('preserves key and mouse down/up transitions that arrive between scans', () => {
    const env = buildEnvironment();
    env.fire('window', 'keydown', keyEvent('a', 'KeyA'));
    env.fire('window', 'keyup', keyEvent('a', 'KeyA'));
    env.fire('canvas', 'pointerdown', pointerEvent('pointerdown', 0));
    env.fire('canvas', 'pointerup', pointerEvent('pointerup', 0));

    const sample = env.backend.sample();
    expect(sample.downKeys.has('a')).toBe(false);
    expect(sample.upKeys.has('a')).toBe(true);
    expect(sample.pressedKeys?.has('a')).toBe(true);
    expect(sample.downCodes?.has('KeyA')).toBe(false);
    expect(sample.upCodes?.has('KeyA')).toBe(true);
    expect(sample.pressedCodes?.has('KeyA')).toBe(true);
    expect(sample.buttons).toEqual([false, false, false]);
    expect(sample.pressedButtons).toEqual([true, false, false]);
    expect(sample.releasedButtons).toEqual([true, false, false]);

    const next = env.backend.sample();
    expect(next.upKeys.size).toBe(0);
    expect(next.pressedKeys?.size).toBe(0);
    expect(next.upCodes?.size).toBe(0);
    expect(next.pressedCodes?.size).toBe(0);
    expect(next.pressedButtons).toEqual([false, false, false]);
    expect(next.releasedButtons).toEqual([false, false, false]);
  });

  it('latches intermediate mouse chord changes delivered as pointermove', () => {
    const env = buildEnvironment();
    env.fire('canvas', 'pointerdown', pointerEvent('pointerdown', 2));
    env.backend.sample();
    const move = (buttons: number) =>
      env.fire('canvas', 'pointermove', {
        pointerId: 1,
        pointerType: 'mouse',
        buttons,
        clientX: 100,
        clientY: 100,
        movementX: 0,
        movementY: 0,
        pressure: 0.5,
      } as unknown as Event);
    move(3);
    expect(env.backend.sample()).toMatchObject({
      buttons: [true, false, true],
      pressedButtons: [true, false, false],
    });
    move(2);
    expect(env.backend.sample()).toMatchObject({
      buttons: [false, false, true],
      releasedButtons: [true, false, false],
    });
    env.fire('canvas', 'pointerup', pointerEvent('pointerup', 2));
    expect(env.backend.sample()).toMatchObject({
      buttons: [false, false, false],
      releasedButtons: [false, false, true],
    });
  });

  it('does not synthesize a second press for repeated keydown events', () => {
    const env = buildEnvironment();
    env.fire('window', 'keydown', keyEvent('w', 'KeyW'));
    expect(env.backend.sample().pressedKeys?.has('w')).toBe(true);

    env.fire('window', 'keydown', keyEvent('w', 'KeyW', true));
    const repeated = env.backend.sample();
    expect(repeated.downKeys.has('w')).toBe(true);
    expect(repeated.pressedKeys?.has('w')).toBe(false);
  });

  it('fences keyboard events across a closed-and-reopened producer gate', () => {
    const env = buildEnvironment();
    env.backend.setInputAllowed?.(false);
    env.fire('window', 'keydown', keyEvent('w', 'KeyW'));
    env.backend.setInputAllowed?.(true);

    const sample = env.backend.sample();
    expect(sample.downKeys.has('w')).toBe(false);
    expect(sample.pressedKeys?.has('w')).toBe(false);
    expect(sample.downCodes?.has('KeyW')).toBe(false);
  });

  it('lets snapshot and frame-start scan consume the latched edges exactly once', () => {
    const sample = {
      downKeys: new Set<string>(),
      upKeys: new Set(['a']),
      downCodes: new Set<string>(),
      upCodes: new Set(['KeyA']),
      pressedKeys: new Set(['a']),
      pressedCodes: new Set(['KeyA']),
      buttons: [false, false, false] as const,
      pressedButtons: [true, false, false] as const,
      releasedButtons: [true, false, false] as const,
      movementX: 0,
      movementY: 0,
      wheelDelta: 0,
      focused: true,
      pointerLocked: false,
    };
    const direct = snapshotFromSample(sample);
    expect(direct.keyboard.justPressed('a')).toBe(true);
    expect(direct.keyboard.justPressedCode('KeyA')).toBe(true);
    expect(direct.mouse.justPressed(0)).toBe(true);
    expect(direct.mouse.justReleased(0)).toBe(true);
    expect(direct.mouse.button(0)).toBe(false);

    let calls = 0;
    const world = new World();
    world.insertResource(INPUT_BACKEND_KEY, {
      sample: () => {
        calls += 1;
        return sample;
      },
      detach: () => {},
    });
    world.addSystem(Update, InputFrameStartScan).unwrap();
    world.update(0).unwrap();
    const scanned = world.getResource<typeof direct>(INPUT_SNAPSHOT_RESOURCE_KEY);
    expect(calls).toBe(1);
    expect(scanned.keyboard.justPressed('a')).toBe(true);
    expect(scanned.mouse.justReleased(0)).toBe(true);
  });
});
