import { changes, type Node, nodes, put, remove } from '../scene/frame-tree';
import type { RenderSceneRecord } from '../scene/render-scene-types';

export interface NativeDrawEntry {
  readonly record: RenderSceneRecord;
  readonly key: string;
}
interface NativeDrawChange extends NativeDrawEntry {
  readonly present: boolean;
}

class OwnedEntry implements NativeDrawEntry {
  readonly #owned = true;
  readonly record: RenderSceneRecord;
  constructor(
    record: RenderSceneRecord,
    readonly key: string,
  ) {
    this.record = Object.freeze({
      slot: record.slot,
      generation: record.generation,
      worldId: record.worldId,
      entityKey: record.entityKey,
    });
    Object.freeze(this);
  }
  static capture(entry: NativeDrawEntry): OwnedEntry {
    return #owned in entry && Object.getPrototypeOf(entry) === OwnedEntry.prototype
      ? (entry as OwnedEntry)
      : new OwnedEntry(entry.record, entry.key);
  }
}

type Keys = ReadonlyMap<string, OwnedEntry>;

/** Fixed view draw membership. Changed paths share the unchanged rows. */
export class NativeDrawRoster implements Iterable<NativeDrawEntry> {
  #root: Node<Keys> | undefined;
  constructor() {
    // biome-ignore lint/complexity/noArguments: reject injected roots without a rest allocation.
    if (arguments.length !== 0) throw new TypeError('NativeDrawRoster owns its root');
    Object.freeze(this);
  }
  static is(value: unknown): value is NativeDrawRoster {
    return (
      typeof value === 'object' &&
      value !== null &&
      #root in value &&
      Object.getPrototypeOf(value) === NativeDrawRoster.prototype
    );
  }
  private keys(slot: number): Keys | undefined {
    let node = this.#root;
    while (node !== undefined) {
      if (node.key === slot) return node.value;
      node = slot < node.key ? node.left : node.right;
    }
    return undefined;
  }
  entry(record: RenderSceneRecord, key: string): NativeDrawEntry | undefined {
    const entry = this.keys(record.slot)?.get(key);
    return entry?.record.generation === record.generation ? entry : undefined;
  }
  has(entry: NativeDrawEntry): boolean {
    return this.entry(entry.record, entry.key) !== undefined;
  }
  edit(
    edits: readonly { readonly entry: NativeDrawEntry; readonly present: boolean }[],
  ): NativeDrawRoster {
    if (edits.length === 0) return this;
    const rows = new Map<number, Map<string, OwnedEntry>>();
    for (const { entry, present } of edits) {
      const slot = entry.record.slot;
      let keys = rows.get(slot);
      if (keys === undefined) {
        keys = new Map(this.keys(slot));
        rows.set(slot, keys);
      }
      if (present) keys.set(entry.key, OwnedEntry.capture(entry));
      else if (keys.get(entry.key)?.record.generation === entry.record.generation)
        keys.delete(entry.key);
    }
    const value = new NativeDrawRoster();
    let root = this.#root;
    for (const [slot, keys] of rows)
      root = keys.size === 0 ? remove(root, 0, slot) : put(root, keys, 0, slot, keys.size);
    value.#root = root;
    return value;
  }
  /** Shared tree paths skip unaffected membership, including delayed readers. */
  changesSince(previous: NativeDrawRoster, visit: (change: NativeDrawChange) => void): void {
    changes(previous.#root, this.#root, (before, after) => {
      for (const entry of before?.values() ?? [])
        if (after?.get(entry.key)?.record.generation !== entry.record.generation)
          visit({ ...entry, present: false });
      for (const entry of after?.values() ?? [])
        if (before?.get(entry.key)?.record.generation !== entry.record.generation)
          visit({ ...entry, present: true });
    });
  }
  *[Symbol.iterator](): IterableIterator<NativeDrawEntry> {
    for (const node of nodes(this.#root)) yield* node.value.values();
  }
}

/** Match required output facts once; commit only real membership flips. */
export class NativeDrawRosterOwner {
  private current = new NativeDrawRoster();
  private entries: NativeDrawEntry[] = [];
  private scratch: NativeDrawEntry[] = [];
  private readonly references = new Map<NativeDrawEntry, number>();

  clear(): void {
    this.current = new NativeDrawRoster();
    this.entries.length = this.scratch.length = 0;
    this.references.clear();
  }

  capture(draws: Iterable<NativeDrawEntry>): NativeDrawRoster {
    let count = 0;
    // Both ledgers stay absent on a quiet output. They scale with changed
    // output facts, not the complete native or entity population.
    let deltas: Map<NativeDrawEntry, number> | undefined;
    let fresh: Map<string, NativeDrawEntry> | undefined;
    let completed = false;
    const add = (entry: NativeDrawEntry, delta: number) => {
      deltas ??= new Map();
      deltas.set(entry, (deltas.get(entry) ?? 0) + delta);
    };
    try {
      for (const { record, key } of draws) {
        const previous = this.entries[count];
        if (
          previous?.record.slot === record.slot &&
          previous.record.generation === record.generation &&
          previous.key === key
        )
          this.scratch[count] = previous;
        else {
          let entry = this.current.entry(record, key);
          if (entry === undefined) {
            fresh ??= new Map();
            const identity = `${record.slot}:${record.generation}:${key}`;
            entry = fresh.get(identity);
            if (entry === undefined) {
              entry = new OwnedEntry(record, key);
              fresh.set(identity, entry);
            }
          }
          this.scratch[count] = entry;
          if (previous !== undefined) add(previous, -1);
          add(entry, 1);
        }
        count++;
      }
      for (let index = count; index < this.entries.length; index++)
        add(this.entries[index] as NativeDrawEntry, -1);
      this.scratch.length = count;
      if (deltas !== undefined) {
        const edits: { entry: NativeDrawEntry; present: boolean }[] = [];
        for (const [entry, delta] of deltas) {
          if (delta === 0) continue;
          const before = this.references.get(entry) ?? 0;
          const after = before + delta;
          if (after < 0) throw new Error('Native draw released an absent output');
          if (after === 0) this.references.delete(entry);
          else this.references.set(entry, after);
          if ((before === 0) !== (after === 0)) edits.push({ entry, present: after > 0 });
        }
        this.current = this.current.edit(edits);
      }
      const previous = this.entries;
      this.entries = this.scratch;
      this.scratch = previous;
      completed = true;
    } finally {
      // Quiet ledgers contain only the same detached entries already owned by
      // the current root. Keep their backing; drop retired or failed candidates.
      if (!completed || deltas !== undefined) this.scratch.length = 0;
    }
    return this.current;
  }
}
