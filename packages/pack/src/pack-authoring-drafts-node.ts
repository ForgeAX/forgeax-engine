import { randomUUID } from 'node:crypto';
import { readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import type { PackAuthoringError, PackParameterValue } from './pack-authoring.js';
import {
  type PackDraftSource,
  type PackDraftSourceOptions,
  readPackDraftSource,
} from './pack-authoring-document.js';
import {
  PackAuthoringDraft,
  type PackDraftDocument,
  type PackDraftOwner,
  type PackDraftRequest,
  type PackDraftSnapshot,
  type PackDraftUpdate,
} from './pack-authoring-draft.js';
import { packSourceFailure, packSourceRevision } from './pack-authoring-literals.js';
import { readPackAuthoringParent } from './pack-authoring-parent.js';

export interface FileSystemPackDraftOptions<T> extends PackDraftSourceOptions {
  readonly gameRoot: string;
  readonly sourceRoots?: readonly string[];
  readonly owner?: (document: PackDraftDocument) => Omit<PackDraftOwner<T>, 'save'>;
  readonly sourceOptions?: (sourcePath: string, source: string) => Promise<PackDraftSourceOptions>;
  readonly saved?: (sourcePath: string, revision: string) => void;
}

function conflict(sourcePath: string, reason: string): PackAuthoringError {
  return {
    code: 'pack-source-revision-conflict',
    expected: 'the opened source revision at save',
    hint: 'refresh the draft to merge unrelated changes or resolve conflicting fields',
    detail: { sourcePath, reason },
  };
}

// All document managers in this host serialize the same physical source.
const sourceSaves = new Map<string, Promise<unknown>>();
const MAX_REFRESH_ROUNDS = 3;

/** Project/connection owner retains this manager; disposing it retires only its documents. */
export function createFileSystemPackDrafts<T = unknown>(options: FileSystemPackDraftOptions<T>) {
  type Entry = {
    source: PackDraftSource;
    absolute: string;
    draft: PackAuthoringDraft<T>;
    refreshing?: Promise<unknown>;
  };
  const documents = new Map<string, Entry>();
  const paths = new Map<string, string>();
  const saves = sourceSaves;
  const openings = new Map<string, Promise<PackDraftSnapshot>>();
  let disposed = false;
  const confined = async (sourcePath: string) => {
    const root = await realpath(options.gameRoot);
    const absolute = await realpath(resolve(root, sourcePath));
    const within = (base: string) => absolute === base || absolute.startsWith(`${base}${sep}`);
    if (
      !within(root) ||
      (options.sourceRoots?.length &&
        !options.sourceRoots.some((path) => within(resolve(root, path))))
    )
      throw packSourceFailure(sourcePath, 'source is outside the configured project asset roots');
    return { absolute, path: relative(root, absolute).split(sep).join('/') };
  };
  const parse = async (path: string, source: string) => {
    const sourceOptions = { ...options, ...(await options.sourceOptions?.(path, source)) };
    if (path.endsWith('.pack.json')) {
      const json = JSON.parse(source);
      if (typeof json.parent === 'string' && !sourceOptions.inherited) {
        const parent = await readPackAuthoringParent(
          options.gameRoot,
          json.parent,
          options.sourceRoots,
        );
        return readPackDraftSource(path, source, {
          ...sourceOptions,
          inherited: parent.parameters,
          generator: parent,
        });
      }
    }
    return readPackDraftSource(path, source, sourceOptions);
  };
  const readOpeningSource = async (path: { absolute: string; path: string }) => {
    let text = await readFile(path.absolute, 'utf8');
    for (let round = 0; ; round++) {
      let source: PackDraftSource;
      try {
        source = await parse(path.path, text);
      } catch (cause) {
        // Initial legacy-source recovery has no draft for refreshEntry to settle.
        // A coalesced write must not leave that opening on its truncated read.
        const current = await readFile(path.absolute, 'utf8');
        if (current === text || round >= MAX_REFRESH_ROUNDS) throw cause;
        text = current;
        continue;
      }
      const current = await readFile(path.absolute, 'utf8');
      if (current === text) return source;
      if (round >= MAX_REFRESH_ROUNDS) throw conflict(path.path, 'source changed while opening');
      text = current;
    }
  };
  const refreshEntry = async (
    entry: Entry,
    onPrepared?: (snapshot: PackDraftSnapshot) => void,
  ): Promise<PackDraftSnapshot | undefined> => {
    const read = () => readFile(entry.absolute, 'utf8').catch((cause: unknown) => ({ cause }));
    let text = await read();
    for (let round = 0; ; round++) {
      let result: PackDraftSnapshot;
      try {
        if (typeof text !== 'string') throw text.cause;
        const next = await parse(entry.source.document.sourcePath, text);
        if (disposed || !documents.has(entry.draft.id)) return undefined;
        result = await entry.draft.refresh(next.document, (snapshot) => {
          entry.source = next;
          onPrepared?.(snapshot);
        });
        entry.source = next;
      } catch (cause) {
        if (disposed || !documents.has(entry.draft.id)) return undefined;
        result = entry.draft.reportFailure(cause);
      }
      // A watcher may report a write mid-flight (after truncation) and coalesce
      // its completion event, so the settled state must match the current file.
      const current = await read();
      if (typeof current !== 'string' || current === text || round >= MAX_REFRESH_ROUNDS)
        return result;
      text = current;
    }
  };

  const save = async (
    id: string,
    document: PackDraftDocument,
    changes: ReadonlyMap<string, PackParameterValue>,
  ): Promise<PackDraftDocument> => {
    const entry = documents.get(id);
    if (!entry) throw new Error('Pack authoring draft is closed');
    const previous = saves.get(entry.absolute) ?? Promise.resolve();
    const pending = previous
      .catch(() => {})
      .then(async () => {
        const { absolute } = await confined(document.sourcePath);
        if (absolute !== entry.absolute)
          throw conflict(document.sourcePath, 'source target changed');
        const current = await readFile(absolute, 'utf8');
        if (packSourceRevision(current) !== document.revision)
          throw conflict(document.sourcePath, 'source changed since the last refresh');
        if (changes.size === 0) return entry.source.document;
        const source = entry.source.write(changes);
        const next = await parse(document.sourcePath, source);
        const temporary = resolve(dirname(absolute), `.${randomUUID()}.pack-draft.tmp`);
        try {
          await writeFile(temporary, source, {
            encoding: 'utf8',
            flag: 'wx',
            mode: (await stat(absolute)).mode,
          });
          if (disposed || !documents.has(id))
            throw new Error('Pack authoring draft closed before save');
          if (packSourceRevision(await readFile(absolute, 'utf8')) !== document.revision)
            throw conflict(document.sourcePath, 'source changed while preparing the atomic write');
          await rename(temporary, absolute);
        } finally {
          await rm(temporary, { force: true });
        }
        entry.source = next;
        options.saved?.(document.sourcePath, next.document.revision);
        return next.document;
      });
    saves.set(entry.absolute, pending);
    try {
      return await pending;
    } finally {
      if (saves.get(entry.absolute) === pending) saves.delete(entry.absolute);
    }
  };

  return {
    async execute(
      request: PackDraftRequest,
    ): Promise<PackDraftSnapshot | PackDraftUpdate | { closed: string }> {
      if (disposed) throw new Error('Pack authoring drafts are disposed');
      if (request.action === 'open') {
        if (!request.sourcePath) throw new TypeError('Opening a draft requires sourcePath');
        const path = await confined(request.sourcePath);
        const existing = paths.get(path.absolute);
        const opened = existing ? documents.get(existing) : undefined;
        if (opened) return opened.draft.snapshot();
        const opening = openings.get(path.absolute);
        if (opening) return opening;
        if (documents.size + openings.size >= 32)
          throw packSourceFailure(
            path.path,
            'close an unused document before opening more than 32 drafts',
          );
        const pending = (async () => {
          const source = await readOpeningSource(path);
          if (disposed) throw new Error('Pack authoring drafts were disposed while opening');
          const id = randomUUID();
          const owner = options.owner?.(source.document);
          const draft = new PackAuthoringDraft<T>(id, source.document, {
            generate:
              owner?.generate ??
              (async () => {
                throw packSourceFailure(path.path, 'this host has no author generation capability');
              }),
            adopt: owner?.adopt ?? (async () => {}),
            ...(owner?.preview ? { preview: owner.preview } : {}),
            ...(owner?.release ? { release: owner.release } : {}),
            save: (document, changes) => save(id, document, changes),
          });
          documents.set(id, { source, absolute: path.absolute, draft });
          paths.set(path.absolute, id);
          paths.set(resolve(options.gameRoot, path.path), id);
          return draft.snapshot();
        })();
        openings.set(path.absolute, pending);
        try {
          return await pending;
        } finally {
          if (openings.get(path.absolute) === pending) openings.delete(path.absolute);
        }
      }
      const entry = request.draftId ? documents.get(request.draftId) : undefined;
      if (!entry)
        throw packSourceFailure(
          request.sourcePath ?? '',
          'draft is absent or belongs to another session',
        );
      switch (request.action) {
        case 'get':
          return entry.draft.snapshot();
        case 'edit':
          return (await entry.draft.edit(request.field ?? '', request.value)).unwrap();
        case 'generate':
          return entry.draft.generate();
        case 'save':
          return entry.draft.save();
        case 'undo':
          return entry.draft.undo();
        case 'redo':
          return entry.draft.redo();
        case 'discard':
          return entry.draft.discard();
        case 'refresh': {
          const source = await parse(
            entry.source.document.sourcePath,
            await readFile(entry.absolute, 'utf8'),
          );
          const snapshot = await entry.draft.refresh(source.document);
          entry.source = source;
          return snapshot;
        }
        case 'close': {
          if (entry.draft.snapshot().unsaved && !request.discard)
            throw conflict(
              entry.source.document.sourcePath,
              'save or explicitly discard unsaved edits before closing',
            );
          if (request.discard) await entry.draft.discard();
          entry.draft.close();
          documents.delete(entry.draft.id);
          for (const [path, id] of paths) if (id === entry.draft.id) paths.delete(path);
          return { closed: entry.draft.id };
        }
        default:
          throw new TypeError('Unknown Pack draft action');
      }
    },
    async previewSource(path: string): Promise<PackDraftSnapshot | undefined> {
      const id = paths.get(resolve(options.gameRoot, path));
      return id ? documents.get(id)?.draft.previewCurrent() : undefined;
    },
    invalidateGeneration(path: string): PackDraftSnapshot | undefined {
      const id = paths.get(resolve(options.gameRoot, path));
      return id ? documents.get(id)?.draft.invalidateGeneration() : undefined;
    },
    async hasSource(path: string): Promise<boolean> {
      const requested = resolve(options.gameRoot, path);
      if (paths.has(requested)) return true;
      // Preview startup may report many initial file changes before any draft is open.
      if (paths.size === 0) return false;
      try {
        return paths.has(await realpath(requested));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw cause;
      }
    },
    source(draftId: string): PackDraftSource | undefined {
      return documents.get(draftId)?.source;
    },
    sourceAt(path: string): PackDraftSource | undefined {
      const id = paths.get(resolve(options.gameRoot, path));
      return id ? documents.get(id)?.source : undefined;
    },
    async refreshSource(
      path: string,
      onPrepared?: (snapshot: PackDraftSnapshot) => void,
    ): Promise<PackDraftSnapshot | undefined> {
      const requested = resolve(options.gameRoot, path);
      const id =
        paths.get(requested) ??
        paths.get(
          await realpath(requested).catch((cause: NodeJS.ErrnoException) => {
            if (cause.code === 'ENOENT') return requested;
            throw cause;
          }),
        );
      const entry = id ? documents.get(id) : undefined;
      if (!entry) return undefined;
      const refresh = (entry.refreshing ?? Promise.resolve()).then(() =>
        refreshEntry(entry, onPrepared),
      );
      entry.refreshing = refresh.catch(() => undefined);
      return refresh;
    },
    dispose(): void {
      disposed = true;
      for (const entry of documents.values()) entry.draft.close();
      documents.clear();
      paths.clear();
    },
  };
}
