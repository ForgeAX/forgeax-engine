import { err, ok, type Result } from '@forgeax/engine-types';
import type {
  PackAuthoringError,
  PackParameterDefinition,
  PackParameterValue,
} from './pack-authoring.js';
import { normalizeParameterValue } from './pack-authoring.js';

export type PackDraftAction =
  | 'open'
  | 'get'
  | 'edit'
  | 'generate'
  | 'save'
  | 'undo'
  | 'redo'
  | 'discard'
  | 'refresh'
  | 'close';
export const PACK_DRAFT_CHANGED_TOPIC = 'engine.workspace.pack-draft.changed';
export type PackDraftReply = PackDraftSnapshot | PackDraftUpdate | { readonly closed: string };
export interface PackDraftRequest {
  readonly action: PackDraftAction;
  readonly sourcePath?: string;
  readonly draftId?: string;
  readonly field?: string;
  readonly value?: unknown;
  readonly discard?: boolean;
}

export interface PackDraftField extends PackParameterDefinition {
  /** Exact source location; also identifies direct JSON fields without synthetic parameters. */
  readonly path: readonly string[];
}

export interface PackDraftDocument {
  readonly sourcePath: string;
  readonly revision: string;
  readonly packageId: string;
  readonly format: 'pack.ts' | 'direct' | 'instance';
  readonly fields: readonly PackDraftField[];
  /** Code/dependency identity excluding live defaults. Supplied by the source owner. */
  readonly generationIdentity: string;
}

export interface PackDraftSnapshot {
  readonly id: string;
  /** Owner-assigned reply order; consumers ignore replies older than their accepted state. */
  readonly sequence: number;
  readonly sourcePath: string;
  readonly revision: string;
  readonly packageId: string;
  readonly format: PackDraftDocument['format'];
  readonly fields: readonly PackDraftField[];
  readonly values: Readonly<Record<string, PackParameterValue>>;
  readonly unsaved: boolean;
  readonly needsGeneration: boolean;
  readonly generating: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly conflicts: readonly string[];
  readonly preview: 'ready' | 'unavailable' | 'pending';
  readonly error?: PackAuthoringError;
}

export type PackDraftUpdate = Pick<
  PackDraftSnapshot,
  | 'id'
  | 'sequence'
  | 'revision'
  | 'unsaved'
  | 'needsGeneration'
  | 'generating'
  | 'canUndo'
  | 'canRedo'
  | 'conflicts'
  | 'preview'
  | 'error'
> & {
  readonly changed: { readonly field: string; readonly value: PackParameterValue };
};

export interface PackDraftGenerationInput {
  readonly document: PackDraftDocument;
  readonly values: Readonly<Record<string, PackParameterValue>>;
  readonly signal: AbortSignal;
}

/** Source/build/preview owners are injected; this domain is equally usable from CLI and View. */
export interface PackDraftOwner<T> {
  generate(input: PackDraftGenerationInput): Promise<T>;
  adopt(
    result: T,
    values: Readonly<Record<string, PackParameterValue>>,
    signal: AbortSignal,
    currentValues: () => Readonly<Record<string, PackParameterValue>>,
  ): Promise<void | boolean>;
  preview?(field: PackDraftField, value: PackParameterValue): Promise<void>;
  release?(result: T): void;
  save(
    document: PackDraftDocument,
    changes: ReadonlyMap<string, PackParameterValue>,
  ): Promise<PackDraftDocument>;
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function failure(cause: unknown): PackAuthoringError {
  if (
    cause !== null &&
    typeof cause === 'object' &&
    'code' in cause &&
    'expected' in cause &&
    'hint' in cause
  ) {
    const error = cause as PackAuthoringError;
    return {
      code: error.code,
      expected: error.expected,
      hint: error.hint,
      detail: error.detail ?? {},
    };
  }
  return {
    code: 'pack-source-write-failed',
    expected: 'a successful author operation',
    hint: 'repair the reported source or preview failure and retry',
    detail: { reason: cause instanceof Error ? cause.message : String(cause) },
  };
}

interface Change {
  readonly name: string;
  readonly before: PackParameterValue;
  readonly after: PackParameterValue;
}

/** One bounded edit history and sparse changes. No polling or World/asset mirror. */
export class PackAuthoringDraft<T> {
  private document: PackDraftDocument;
  private fields = new Map<string, PackDraftField>();
  private changes = new Map<string, PackParameterValue>();
  private undoStack: Change[] = [];
  private redoStack: Change[] = [];
  private conflicts = new Set<string>();
  private adopted: { key: string; result: T } | undefined;
  private generation: AbortController | undefined;
  private previewState: PackDraftSnapshot['preview'] = 'pending';
  private error: PackAuthoringError | undefined;
  private closed = false;
  private sequence = 0;
  private previewTail: Promise<void> = Promise.resolve();
  private inputKey: string | undefined;
  private dependencyRevision = 0;

  constructor(
    readonly id: string,
    document: PackDraftDocument,
    private readonly owner: PackDraftOwner<T>,
  ) {
    this.document = document;
    this.indexFields();
  }

  private indexFields() {
    this.fields = new Map(this.document.fields.map((field) => [field.name, field]));
  }
  private value(name: string): PackParameterValue {
    const field = this.fields.get(name);
    if (!field) throw new Error(`Author field is absent: ${name}`);
    return this.changes.get(name) ?? field.default;
  }
  private values(): Readonly<Record<string, PackParameterValue>> {
    return Object.fromEntries([...this.fields.keys()].map((name) => [name, this.value(name)]));
  }
  private generationKey(): string {
    this.inputKey ??= JSON.stringify([
      this.document.generationIdentity,
      this.dependencyRevision,
      this.document.fields
        .filter((field) => typeof field.apply !== 'object')
        .map((field) => [field.name, this.value(field.name)]),
    ]);
    return this.inputKey;
  }
  private assertOpen() {
    if (this.closed) throw new Error('Pack authoring draft is closed');
  }

  private state() {
    this.assertOpen();
    return {
      id: this.id,
      sequence: ++this.sequence,
      revision: this.document.revision,
      unsaved: this.changes.size > 0,
      needsGeneration: this.adopted?.key !== this.generationKey(),
      generating: this.generation !== undefined,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      conflicts: [...this.conflicts],
      preview: this.previewState,
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  snapshot(): PackDraftSnapshot {
    return structuredClone({
      ...this.state(),
      sourcePath: this.document.sourcePath,
      packageId: this.document.packageId,
      format: this.document.format,
      fields: this.document.fields,
      values: { ...this.values(), ...Object.fromEntries(this.changes) },
    });
  }

  private async apply(name: string, value: PackParameterValue): Promise<void> {
    const field = this.fields.get(name);
    if (!field) throw new Error(`Author field is absent: ${name}`);
    if (equal(field.default, value)) this.changes.delete(name);
    else this.changes.set(name, structuredClone(value));
    this.error = undefined;
    if (typeof field.apply !== 'object') {
      this.inputKey = undefined;
      this.generation?.abort();
      return;
    }
    const preview = this.owner.preview;
    if (!preview) {
      this.previewState = 'pending';
      return;
    }
    // Owner operations remain ordered; a late request cannot restore an older value.
    this.previewTail = this.previewTail.then(async () => {
      if (this.closed) return;
      try {
        await preview(field, value);
        this.previewState = 'ready';
      } catch (cause) {
        this.error = failure(cause);
        this.previewState = 'unavailable';
      }
    });
    await this.previewTail;
  }

  async edit(name: string, value: unknown): Promise<Result<PackDraftUpdate, PackAuthoringError>> {
    this.assertOpen();
    const field = this.fields.get(name);
    if (!field)
      return err({
        code: 'pack-parameter-invalid',
        expected: 'a current author field',
        hint: 'refresh the declaration before editing',
        detail: { name },
      });
    const normalized = normalizeParameterValue(field, value, name);
    if (!normalized.ok) return normalized;
    const before = this.value(name);
    if (!equal(before, normalized.value)) {
      this.undoStack.push({ name, before, after: normalized.value });
      if (this.undoStack.length > 256) this.undoStack.shift();
      this.redoStack = [];
      await this.apply(name, normalized.value);
    }
    return ok({
      ...this.state(),
      changed: { field: name, value: structuredClone(this.value(name)) },
    });
  }

  async undo(): Promise<PackDraftSnapshot> {
    this.assertOpen();
    const change = this.undoStack.pop();
    if (change) {
      this.redoStack.push(change);
      await this.apply(change.name, change.before);
    }
    return this.snapshot();
  }
  async redo(): Promise<PackDraftSnapshot> {
    this.assertOpen();
    const change = this.redoStack.pop();
    if (change) {
      this.undoStack.push(change);
      await this.apply(change.name, change.after);
    }
    return this.snapshot();
  }

  /** Explicit generation alone runs expensive work. Live edits do not cancel it. */
  async generate(): Promise<PackDraftSnapshot> {
    this.assertOpen();
    if (this.generation) throw new Error('Pack generation is already running');
    const key = this.generationKey();
    const controller = new AbortController();
    this.generation = controller;
    this.error = undefined;
    let result: T | undefined;
    try {
      result =
        this.adopted?.key === key
          ? this.adopted.result
          : await this.owner.generate({
              document: this.document,
              values: this.values(),
              signal: controller.signal,
            });
      if (controller.signal.aborted || this.closed || this.generationKey() !== key) {
        controller.abort();
        throw new Error('Pack generation no longer matches the draft');
      }
      // Adoption joins the same ordered writer as live edits. Edits arriving while
      // preparing the new output follow it, without preparing the whole Pack again.
      const generated = result;
      const adoption = this.previewTail.then(async () => {
        controller.signal.throwIfAborted();
        return this.owner.adopt(generated, this.values(), controller.signal, () => this.values());
      });
      this.previewTail = adoption.then(
        () => {},
        () => {},
      );
      const visible = await adoption;
      await this.previewTail;
      controller.signal.throwIfAborted();
      if (this.generationKey() !== key || this.closed) {
        controller.abort();
        throw new Error('Pack generation no longer matches the draft');
      }
      if (this.adopted && this.adopted.result !== result) this.owner.release?.(this.adopted.result);
      this.adopted = { key, result };
      result = undefined;
      this.previewState = visible === false ? 'pending' : 'ready';
    } catch (cause) {
      if (!controller.signal.aborted) this.error = failure(cause);
    } finally {
      if (result !== undefined && result !== this.adopted?.result) this.owner.release?.(result);
      this.generation = undefined;
    }
    return this.snapshot();
  }

  async save(): Promise<PackDraftSnapshot> {
    this.assertOpen();
    if (this.conflicts.size > 0)
      throw {
        code: 'pack-source-revision-conflict',
        expected: 'resolved field conflicts before save',
        hint: 'discard or resolve conflicting fields, then save again',
        detail: { fields: [...this.conflicts] },
      } satisfies PackAuthoringError;
    const savedChanges = new Map(this.changes);
    const updated = await this.owner.save(this.document, savedChanges);
    const currentValues = new Map([...savedChanges.keys()].map((name) => [name, this.value(name)]));
    this.document = updated;
    this.indexFields();
    for (const [name, value] of currentValues) {
      if (equal(this.fields.get(name)?.default, value)) this.changes.delete(name);
      else this.changes.set(name, value);
    }
    this.error = undefined;
    return this.snapshot();
  }

  /** Three-way field merge. External edits never overwrite an unsaved local value. */
  async refresh(
    document: PackDraftDocument,
    onPrepared?: (snapshot: PackDraftSnapshot) => void,
  ): Promise<PackDraftSnapshot> {
    this.assertOpen();
    const previousKey = this.generationKey();
    const liveChanges: Array<[PackDraftField, PackParameterValue]> = [];
    const next = new Map(document.fields.map((field) => [field.name, field]));
    for (const [name, value] of this.changes) {
      const previous = this.fields.get(name);
      const field = next.get(name);
      if (
        !field ||
        !equal(previous?.apply, field.apply) ||
        previous?.type !== field.type ||
        !normalizeParameterValue(field, value, name).ok ||
        (!equal(previous?.default, field.default) && !equal(value, field.default))
      )
        this.conflicts.add(name);
      else if (equal(value, field.default)) this.changes.delete(name);
    }
    for (const field of document.fields) {
      if (
        typeof field.apply === 'object' &&
        !this.changes.has(field.name) &&
        (!equal(this.fields.get(field.name)?.default, field.default) ||
          !equal(this.fields.get(field.name)?.apply, field.apply))
      )
        liveChanges.push([field, field.default]);
    }
    this.document = document;
    this.error = undefined;
    this.inputKey = undefined;
    this.indexFields();
    if (liveChanges.length > 0) {
      this.previewState = 'pending';
      onPrepared?.(this.snapshot());
    }
    if (previousKey !== this.generationKey()) this.generation?.abort();
    // Removed fields retain their local value for conflict reporting, but cannot be replayed.
    this.undoStack = this.undoStack.filter(
      (change) => next.has(change.name) && !this.conflicts.has(change.name),
    );
    this.redoStack = this.redoStack.filter(
      (change) => next.has(change.name) && !this.conflicts.has(change.name),
    );
    for (const [field, value] of liveChanges) await this.apply(field.name, value);
    return this.snapshot();
  }

  async previewCurrent(): Promise<PackDraftSnapshot> {
    this.assertOpen();
    for (const field of this.document.fields)
      if (typeof field.apply === 'object') await this.apply(field.name, this.value(field.name));
    return this.snapshot();
  }

  async discard(): Promise<PackDraftSnapshot> {
    this.assertOpen();
    for (const name of [...this.changes.keys()]) {
      const field = this.fields.get(name);
      if (field) await this.apply(name, field.default);
      else this.changes.delete(name);
    }
    this.conflicts.clear();
    this.undoStack = [];
    this.redoStack = [];
    return this.snapshot();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation?.abort();
    if (this.adopted) this.owner.release?.(this.adopted.result);
    this.adopted = undefined;
    this.changes.clear();
    this.fields.clear();
    this.undoStack = [];
    this.redoStack = [];
  }

  invalidateGeneration(): PackDraftSnapshot {
    this.dependencyRevision++;
    this.inputKey = undefined;
    this.generation?.abort();
    return this.snapshot();
  }

  reportFailure(cause: unknown): PackDraftSnapshot {
    this.invalidateGeneration();
    this.error = failure(cause);
    return this.snapshot();
  }
}
