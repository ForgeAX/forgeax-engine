export type LoadStatus = 'unloaded' | 'prepared' | 'provisional' | 'ready' | 'failed';

export interface LoadRecord {
  readonly status: LoadStatus;
  readonly refs: readonly string[];
  readonly value?: unknown;
  readonly error?: unknown;
}

interface MutableLoadRecord {
  status: LoadStatus;
  refs: readonly string[];
  value?: unknown;
  error?: unknown;
}

export class LoadStateStore {
  private readonly records = new Map<string, MutableLoadRecord>();
  private readonly consumers = new Map<string, Set<string>>();

  private set(guid: string, record: MutableLoadRecord): void {
    this.remove(guid);
    this.records.set(guid, record);
    for (const ref of record.refs) {
      const key = ref.toLowerCase();
      let consumers = this.consumers.get(key);
      if (!consumers) {
        consumers = new Set();
        this.consumers.set(key, consumers);
      }
      consumers.add(guid);
    }
  }

  /** Reverse edges derive from existing load records; visit only the affected closure. */
  affected(guid: string): ReadonlySet<string> {
    const affected = new Set<string>();
    const visit = (key: string): void => {
      if (affected.has(key)) return;
      affected.add(key);
      for (const consumer of this.consumers.get(key) ?? []) visit(consumer);
    };
    visit(guid.toLowerCase());
    return affected;
  }

  prepare(guid: string, value: unknown, refs: readonly string[]): void {
    this.set(guid.toLowerCase(), { status: 'prepared', value, refs });
  }

  getPrepared<T>(guid: string): T | undefined {
    const record = this.records.get(guid.toLowerCase());
    return record?.status === 'prepared' ? (record.value as T) : undefined;
  }

  get(guid: string): LoadRecord | undefined {
    return this.records.get(guid.toLowerCase());
  }

  getReady<T = unknown>(guid: string): T | undefined {
    const record = this.records.get(guid.toLowerCase());
    return record?.status === 'ready' ? (record.value as T) : undefined;
  }

  /**
   * Return a provisional value only for the internal SCC back-edge bridge.
   * Public callers must use getReady so promotion remains the visibility gate.
   */
  getProvisional<T = unknown>(guid: string): T | undefined {
    const record = this.records.get(guid.toLowerCase());
    return record?.status === 'provisional' ? (record.value as T) : undefined;
  }

  begin(guid: string, refs: readonly string[]): LoadRecord {
    const key = guid.toLowerCase();
    const existing = this.records.get(key);
    if (existing?.status === 'provisional' || existing?.status === 'ready') return existing;
    const record: MutableLoadRecord = {
      status: 'provisional',
      refs: refs.map((ref) => ref.toLowerCase()),
    };
    this.set(key, record);
    return record;
  }

  resolveAsset(guid: string, value: unknown): void {
    const key = guid.toLowerCase();
    const record = this.records.get(key);
    if (record === undefined) {
      this.set(key, { status: 'provisional', refs: [], value });
      return;
    }
    record.value = value;
  }

  registerReady(guid: string, value: unknown): void {
    this.begin(guid, []);
    this.resolveAsset(guid, value);
    this.promoteReady(guid);
  }

  promoteReady(guid: string): void {
    const root = guid.toLowerCase();
    const group = this.provisionalGroup(root);
    if (group.size === 0) return;
    for (const key of group) {
      const record = this.records.get(key);
      if (record?.value === undefined) return;
      for (const ref of record.refs) {
        const dependency = this.records.get(ref);
        if (dependency === undefined || (dependency.status !== 'ready' && !group.has(ref))) return;
      }
    }
    for (const key of group) {
      const record = this.records.get(key);
      if (record !== undefined) record.status = 'ready';
    }
  }

  fail(guid: string, error: unknown): readonly string[] {
    const doomed = this.provisionalGroup(guid.toLowerCase());
    if (doomed.size === 0) doomed.add(guid.toLowerCase());
    for (const key of doomed) {
      this.set(key, { status: 'unloaded', refs: [] });
    }
    const root = this.records.get(guid.toLowerCase());
    if (root !== undefined) root.error = error;
    return [...doomed];
  }

  remove(guid: string): void {
    const key = guid.toLowerCase();
    for (const ref of this.records.get(key)?.refs ?? []) {
      const consumers = this.consumers.get(ref.toLowerCase());
      consumers?.delete(key);
      if (consumers?.size === 0) this.consumers.delete(ref.toLowerCase());
    }
    this.records.delete(key);
  }

  clear(): void {
    this.records.clear();
    this.consumers.clear();
  }

  private provisionalGroup(root: string): Set<string> {
    const group = new Set<string>();
    const visit = (key: string): void => {
      if (group.has(key)) return;
      const record = this.records.get(key);
      if (record?.status !== 'provisional') return;
      group.add(key);
      for (const ref of record.refs) visit(ref);
    };
    visit(root);
    return group;
  }
}
