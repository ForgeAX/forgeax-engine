// Shared growth policy for renderer-owned storage whose element count changes
// between frames (instance collections that spawn and retire members).

/**
 * Reserved elements for a collection whose count changed: half again the
 * count (at least 16 more), so later growth by up to a third and any shrink
 * fit the reservation without reallocating or rebinding.
 */
export function dynamicCapacity(count: number): number {
  return count === 0 ? 0 : count + Math.max(16, Math.ceil(count / 2));
}

/** Release a reservation once the collection holds under a quarter of it. */
export function shouldShrinkCapacity(count: number, capacity: number): boolean {
  return capacity > 1024 && count * 4 < capacity;
}
