/**
 * Runs in the page (serialized by `page.evaluate`, so it references nothing outside
 * its body). Under pointer lock, delivers one relative mouse move to the locked
 * element: a `pointermove` carrying `movementX`/`movementY`, as the browser sends for
 * a locked mouse. Returns `false` without dispatching when nothing holds the lock.
 */
export function lookInPage(delta: { readonly dx: number; readonly dy: number }): boolean {
  const target = document.pointerLockElement;
  if (target === null) return false;
  const event = new PointerEvent('pointermove', {
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    bubbles: true,
    composed: true,
    movementX: delta.dx,
    movementY: delta.dy,
  });
  // Some engines ignore movement in the init dictionary of a synthetic event.
  if (event.movementX !== delta.dx || event.movementY !== delta.dy)
    Object.defineProperties(event, {
      movementX: { value: delta.dx },
      movementY: { value: delta.dy },
    });
  target.dispatchEvent(event);
  return true;
}
