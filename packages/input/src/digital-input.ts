/** Held state and frame edges; admission, focus and source merging belong to the backend. */
export class KeyLatch {
  readonly held = new Set<string>();
  readonly pressed = new Set<string>();
  readonly released = new Set<string>();

  press(key: string): void {
    if (!this.held.has(key)) this.pressed.add(key);
    this.held.add(key);
  }

  release(key: string): void {
    this.held.delete(key);
    this.released.add(key);
  }

  clearFrame(): void {
    this.pressed.clear();
    this.released.clear();
  }

  clear(): void {
    this.clearFrame();
    this.held.clear();
  }

  releaseAll(): void {
    this.clearFrame();
    for (const key of this.held) this.released.add(key);
    this.held.clear();
  }
}

export class ButtonLatch {
  readonly held: [boolean, boolean, boolean] = [false, false, false];
  readonly pressed: [boolean, boolean, boolean] = [false, false, false];
  readonly released: [boolean, boolean, boolean] = [false, false, false];

  set(slot: 0 | 1 | 2, down: boolean): void {
    if (down && !this.held[slot]) this.pressed[slot] = true;
    if (!down && this.held[slot]) this.released[slot] = true;
    this.held[slot] = down;
  }

  clearFrame(): void {
    this.pressed.fill(false);
    this.released.fill(false);
  }

  clear(): void {
    this.clearFrame();
    this.held.fill(false);
  }

  releaseAll(): void {
    this.clearFrame();
    for (const slot of [0, 1, 2] as const) this.set(slot, false);
  }
}
