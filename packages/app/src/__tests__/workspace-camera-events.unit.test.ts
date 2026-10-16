import type { CanvasInputBoundary } from '@forgeax/engine-input';
import { expect, it, vi } from 'vitest';
import type { EngineWorkspacePreview, EngineWorkspaceTarget } from '../workspace';
import { bindWorkspaceCameraEvents } from '../workspace-camera-events';

it('captures observer gestures over game UI only inside the canvas and retires document listeners', async () => {
  const win = new EventTarget();
  const attributes = new Map<string, string>();
  const canvas = Object.assign(new EventTarget(), {
    ownerDocument: { defaultView: win },
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
    focus: vi.fn(),
    setPointerCapture: vi.fn(),
    getBoundingClientRect: () => ({ left: 20, right: 120, top: 20, bottom: 120 }),
  }) as unknown as HTMLCanvasElement;
  let owner = 'game';
  const begin = vi.fn();
  const update = vi.fn();
  const target: EngineWorkspacePreview = {
    target: { targetId: 'target' } as EngineWorkspaceTarget,
    getCamera: () => ({ version: 0 }),
    beginCameraInteraction: begin,
    updateCameraDraft: update,
    abortCameraInteraction: vi.fn(),
  };
  const remove = bindWorkspaceCameraEvents(
    canvas,
    { owner: () => owner } as CanvasInputBoundary,
    target,
  );
  const pointer = (type = 'pointerdown', clientX = 30) =>
    Object.assign(new Event(type, { cancelable: true }), {
      button: 2,
      pointerId: 1,
      clientX,
      clientY: 30,
    });
  try {
    // A document event can originate from a game UI overlay, not the canvas.
    expect(win.dispatchEvent(pointer())).toBe(true);
    owner = 'editor';
    expect(win.dispatchEvent(pointer('pointerdown', 120))).toBe(true);
    expect(begin).not.toHaveBeenCalled();
    expect(win.dispatchEvent(pointer())).toBe(false);
    await vi.waitFor(() => expect(begin).toHaveBeenCalledOnce());
    win.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code: 'KeyW' }));
    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ input: { type: 'move', velocity: [0, 0, -4] } }),
      ),
    );
    expect(win.dispatchEvent(pointer('contextmenu'))).toBe(false);
    expect(win.dispatchEvent(pointer('contextmenu', 120))).toBe(true);
  } finally {
    await remove();
  }
  expect(win.dispatchEvent(pointer())).toBe(true);
  expect(win.dispatchEvent(pointer('contextmenu'))).toBe(true);
  expect(begin).toHaveBeenCalledOnce();
});
