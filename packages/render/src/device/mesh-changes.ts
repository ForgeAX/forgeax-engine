/** Current Mesh publications only. Links carry metadata, never GPU/source payloads. */
class MeshChangeNode {
  epoch = 0;
  holders = 1; // The physical generation's logical source lease.
  retired = false;
  previous: MeshChangeNode | undefined;
  next: MeshChangeNode | undefined;
  constructor(public owner: MeshChanges | undefined) {}
}
export type MeshChangeToken = MeshChangeNode;
export type MeshChange = 'quiet' | 'content' | 'invalidated';

export class MeshChanges {
  private tail: MeshChangeNode | undefined;
  private revision = 0;
  private reading = false;
  private currentGeneration: object | undefined = {};

  get generation(): object | undefined {
    return this.currentGeneration;
  }

  get epoch(): number {
    return this.revision;
  }

  assertIdle(): void {
    if (this.reading) throw new Error('Mesh publication cannot reenter its change query');
  }

  preflight(): void {
    this.assertIdle();
    if (this.currentGeneration === undefined || this.revision === Number.MAX_SAFE_INTEGER) {
      this.currentGeneration = undefined;
      throw new RangeError('Mesh publication identity exhausted');
    }
  }

  private advance(): number {
    this.preflight();
    return ++this.revision;
  }

  private unlink(token: MeshChangeNode): void {
    if (token.previous !== undefined) token.previous.next = token.next;
    if (token.next !== undefined) token.next.previous = token.previous;
    if (this.tail === token) this.tail = token.previous;
    token.previous = undefined;
    token.next = undefined;
  }

  owns(token: MeshChangeToken | undefined): token is MeshChangeToken {
    return this.currentGeneration !== undefined && token?.owner === this && !token.retired;
  }

  create(): MeshChangeToken {
    this.assertIdle();
    const token = new MeshChangeNode(this);
    this.publish(token);
    return token;
  }

  publish(token: MeshChangeToken): number {
    this.assertIdle();
    if (!this.owns(token)) throw new Error('Mesh publication requires a live generation');
    const epoch = this.advance();
    this.unlink(token);
    token.epoch = epoch;
    token.previous = this.tail;
    if (this.tail !== undefined) this.tail.next = token;
    this.tail = token;
    return epoch;
  }

  retain(token: MeshChangeToken): void {
    this.assertIdle();
    if (!this.owns(token)) throw new Error('Cannot capture a retired Mesh generation');
    token.holders++;
  }

  release(token: MeshChangeToken): void {
    this.assertIdle();
    if (token.owner !== this) return; // Reset already severed this generation.
    if (token.holders <= 0) throw new Error('Mesh token released twice');
    if (--token.holders === 0) {
      this.unlink(token);
      token.owner = undefined;
    }
  }

  retire(token: MeshChangeToken): void {
    this.assertIdle();
    if (token.owner !== this || token.retired) return;
    try {
      if (this.currentGeneration !== undefined) this.publish(token);
    } finally {
      token.retired = true;
      this.release(token);
    }
  }

  query(
    since: number,
    generation: object | undefined,
    dependencies: ReadonlySet<MeshChangeToken>,
  ): MeshChange {
    if (
      this.currentGeneration === undefined ||
      generation !== this.generation ||
      !Number.isSafeInteger(since) ||
      since < 0 ||
      since > this.revision
    )
      return 'invalidated';
    if (this.reading) throw new Error('Mesh change queries cannot reenter');
    this.reading = true;
    try {
      let change: MeshChange = 'quiet';
      for (let node = this.tail; node !== undefined && node.epoch > since; node = node.previous) {
        if (!dependencies.has(node)) continue;
        if (node.retired || node.owner !== this) return 'invalidated';
        // A newer live edit cannot hide an older dependency's retirement.
        change = 'content';
      }
      return change;
    } finally {
      this.reading = false;
    }
  }

  reset(): void {
    this.assertIdle();
    const generation = {};
    for (let node = this.tail; node !== undefined; ) {
      const previous = node.previous;
      node.previous = undefined;
      node.next = undefined;
      node.owner = undefined;
      node.holders = 0;
      node.retired = true;
      node = previous;
    }
    this.tail = undefined;
    this.currentGeneration = generation;
    // The explicit owner-generation change disambiguates exhausted scalars.
    this.revision = this.revision === Number.MAX_SAFE_INTEGER ? 0 : this.revision + 1;
  }
}

/** A retained depth's actual dependency result; a prepared borrower holds one lease. */
export class ShadowMeshReads {
  readonly generation: object | undefined;
  readonly tokens = new Set<MeshChangeToken>();
  private holders = 1;
  private valid = true;

  constructor(readonly changes: MeshChanges) {
    this.generation = changes.generation;
  }

  add(token: MeshChangeToken | undefined): void {
    this.changes.assertIdle();
    if (!this.valid) return;
    if (!this.changes.owns(token)) {
      this.valid = false;
      return;
    }
    if (!this.tokens.has(token)) {
      this.changes.retain(token);
      try {
        this.tokens.add(token);
      } catch (cause) {
        this.valid = false;
        this.tokens.delete(token);
        this.changes.release(token);
        throw cause;
      }
    }
  }

  get fixed(): boolean {
    return (
      this.valid && this.generation !== undefined && this.generation === this.changes.generation
    );
  }

  retain(): this {
    if (this.holders <= 0) throw new Error('Cannot borrow retired shadow dependencies');
    this.holders++;
    return this;
  }

  release(): void {
    this.changes.assertIdle();
    if (this.holders <= 0) throw new Error('Shadow dependencies released twice');
    if (--this.holders !== 0) return;
    for (const token of this.tokens) this.changes.release(token);
    this.tokens.clear();
    this.valid = false;
  }
}
