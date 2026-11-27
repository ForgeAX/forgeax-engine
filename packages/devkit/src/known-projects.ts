import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { processAlive } from './backend-lifetime.js';
import { writeFileAtomic } from './filesystem-path.js';
import type { CommandError } from './types.js';
import { failCommand, rejectCommand } from './types.js';

export type KnownProject = Readonly<{
  root: string;
  id: string;
  name: string;
  lastOpenedAt: string;
}>;
type ValidatedProject = Readonly<{ root: string; id: string; name: string }>;

export type ProjectDirectoryEntry = Readonly<{
  path: string;
  name: string;
  hasForgeManifest: boolean;
}>;

export type ProjectDirectoryListing = Readonly<{
  path: string;
  parent: string | null;
  directories: readonly ProjectDirectoryEntry[];
}>;

export type KnownProjectEntry = KnownProject &
  (
    | { readonly availability: 'available' }
    | { readonly availability: 'unavailable'; readonly failure: CommandError }
  );
export type KnownProjectErrorCode =
  | 'known-project-store-corrupt'
  | 'known-project-store-lock-timeout'
  | 'known-project-directory-invalid'
  | 'known-project-identity-changed'
  | 'known-project-store-io'
  | 'known-project-store-cleanup-failed';
type KnownProjectSourceError = Readonly<{
  code: Exclude<KnownProjectErrorCode, 'known-project-store-cleanup-failed'>;
  expected: string;
  hint: string;
  detail: Readonly<Record<string, unknown>>;
}>;
export type KnownProjectError =
  | KnownProjectSourceError
  | Readonly<{
      code: 'known-project-store-cleanup-failed';
      expected: string;
      hint: string;
      detail: Readonly<{
        path: string;
        primary: KnownProjectSourceError;
        cleanup: KnownProjectSourceError;
      }>;
    }>;
export type KnownProjectResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: KnownProjectError | CommandError };

type Store = { schemaVersion: 1; projects: KnownProject[] };

const STORE_NAME = 'known-projects.json';
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 2_000;

export class KnownProjectStoreError extends Error {
  readonly code: KnownProjectSourceError['code'];
  readonly expected = 'Readable project catalogue storage and a validated Node-visible directory';
  readonly hint: string;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    code: KnownProjectStoreError['code'],
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'KnownProjectStoreError';
    this.code = code;
    this.hint = message;
    this.detail = detail;
  }
}

class KnownProjectStoreCleanupError extends AggregateError {
  readonly failure: Extract<KnownProjectError, { code: 'known-project-store-cleanup-failed' }>;

  constructor(path: string, primary: unknown, cleanup: unknown) {
    super([primary, cleanup], 'Project catalogue work and lock release both failed.', {
      cause: primary,
    });
    this.failure = {
      code: 'known-project-store-cleanup-failed',
      expected: 'The catalogue failure and lock release diagnostic to remain available',
      hint: 'Repair the initiating catalogue failure and inspect its lock owner before explicit recovery.',
      detail: {
        path,
        primary: sourceFailure(path, primary),
        cleanup: sourceFailure(path, cleanup),
      },
    };
  }
}

function sourceFailure(path: string, cause: unknown): KnownProjectSourceError {
  if (cause instanceof KnownProjectStoreError)
    return { code: cause.code, expected: cause.expected, hint: cause.hint, detail: cause.detail };
  return {
    code: 'known-project-store-io',
    expected: 'Readable project catalogue storage and a validated Node-visible directory',
    hint: 'Repair the project catalogue storage permissions or filesystem.',
    detail: {
      path,
      reason: cause instanceof Error ? cause.message : String(cause),
      ...(cause && typeof cause === 'object' && 'code' in cause ? { sourceCode: cause.code } : {}),
    },
  };
}

export function knownProjectStorePath(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
) {
  const base =
    env.FORGEAX_DATA_HOME?.trim() ||
    env.XDG_DATA_HOME?.trim() ||
    (platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : platform === 'win32'
        ? env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local')
        : join(homedir(), '.local', 'share'));
  return join(resolve(base), 'ForgeaX', STORE_NAME);
}

function isKnownProject(value: unknown): value is KnownProject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.root === 'string' &&
    isAbsolute(item.root) &&
    item.root === resolve(item.root) &&
    typeof item.id === 'string' &&
    item.id.trim() !== '' &&
    typeof item.name === 'string' &&
    item.name.trim() !== '' &&
    typeof item.lastOpenedAt === 'string' &&
    Number.isFinite(Date.parse(item.lastOpenedAt))
  );
}

function parseStore(contents: string, path: string): Store {
  try {
    const value: unknown = JSON.parse(contents);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new TypeError('Expected an object');
    const record = value as Record<string, unknown>;
    if (
      record.schemaVersion !== 1 ||
      !Array.isArray(record.projects) ||
      !record.projects.every(isKnownProject)
    )
      throw new TypeError('Expected schemaVersion 1 and valid project records');
    const roots = new Set<string>();
    for (const project of record.projects) {
      if (roots.has(project.root)) throw new TypeError(`Duplicate canonical root: ${project.root}`);
      roots.add(project.root);
    }
    return { schemaVersion: 1, projects: record.projects.map((project) => ({ ...project })) };
  } catch (cause) {
    throw new KnownProjectStoreError(
      'known-project-store-corrupt',
      `Known project store is corrupt: ${path}`,
      {
        path,
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    );
  }
}

async function readStore(path: string): Promise<Store> {
  try {
    return parseStore(await readFile(path, 'utf8'), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { schemaVersion: 1, projects: [] };
    throw error;
  }
}

async function acquireLock(path: string) {
  const started = Date.now();
  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Never unlink a lock observed by path: another process could own its successor.
      // An abandoned lock is an explicit storage failure requiring owner recovery.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
      continue;
    }
    try {
      await file.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
      await file.sync();
      const identity = await file.stat();
      return async () => {
        try {
          const current = await lstat(path);
          if (current.ino !== identity.ino || current.dev !== identity.dev)
            throw new KnownProjectStoreError(
              'known-project-store-io',
              'The catalogue lock was replaced while its owner was active. Preserve the replacement and inspect storage.',
              { lockPath: path },
            );
          // Contenders never reclaim locks; only the same inode's owner releases it.
          await rm(path);
        } catch (cause) {
          if (cause instanceof KnownProjectStoreError) throw cause;
          throw new KnownProjectStoreError(
            'known-project-store-io',
            'The catalogue lock could not be released. Inspect its owner and storage before retrying.',
            { ...sourceFailure(path, cause).detail, lockPath: path },
          );
        } finally {
          await file.close();
        }
      };
    } catch (error) {
      // Preserve an incomplete lock on failed initialization. Its source must be inspected.
      await file.close().catch(() => {});
      throw error;
    }
  }
  let owner: Record<string, unknown> = {};
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const pid = Number.isSafeInteger(record.pid) ? Number(record.pid) : undefined;
      owner = {
        ...(pid === undefined ? {} : { ownerPid: pid, ownerAlive: processAlive(pid) }),
        ...(typeof record.nonce === 'string' ? { ownerNonce: record.nonce } : {}),
      };
    }
  } catch {
    /* Include the lock path even when its contents are incomplete. */
  }
  throw new KnownProjectStoreError(
    'known-project-store-lock-timeout',
    `Timed out waiting for known project store lock. Inspect ${path}, confirm its owner is stopped, remove only that abandoned lock, then retry.`,
    { lockPath: path, ...owner },
  );
}

async function syncDirectory(path: string) {
  try {
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    /* Some filesystems do not support directory sync. */
  }
}

async function writeStore(path: string, store: Store) {
  await writeFileAtomic(path, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600,
    syncFile: true,
  });
  await syncDirectory(path);
}

async function storageResult<T>(
  path: string,
  action: () => Promise<T>,
): Promise<KnownProjectResult<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (cause) {
    return rejectCommand(
      cause instanceof KnownProjectStoreCleanupError ? cause.failure : sourceFailure(path, cause),
    );
  }
}

export async function listKnownProjects({
  path = knownProjectStorePath(),
}: {
  path?: string;
} = {}): Promise<KnownProjectResult<readonly KnownProjectEntry[]>> {
  return storageResult(path, async () => {
    const store = await readStore(resolve(path));
    const ordered = [...store.projects].sort(
      (a, b) =>
        Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt) || a.name.localeCompare(b.name),
    );
    const { readProjectFacts } = await import('./project.js');
    return Promise.all(
      ordered.map(async (project) => {
        const facts = await readProjectFacts(project.root);
        if (!facts.ok)
          return { ...project, availability: 'unavailable' as const, failure: facts.error };
        if (facts.value.id !== project.id)
          return {
            ...project,
            availability: 'unavailable' as const,
            failure: {
              code: 'known-project-identity-changed',
              expected: 'The registered project identity',
              hint: 'Import this directory explicitly to accept its changed identity.',
              detail: { root: project.root, expectedId: project.id, actualId: facts.value.id },
            },
          };
        return { ...project, name: facts.value.name, availability: 'available' as const };
      }),
    );
  });
}

/** Publish facts already validated by the project owner; no runtime/session state is stored. */
export async function rememberKnownProject(
  project: ValidatedProject,
  { path = knownProjectStorePath() }: { path?: string } = {},
): Promise<KnownProjectResult<KnownProject>> {
  return storageResult(path, async () => {
    const root = await realpath(resolve(project.root));
    const destination = resolve(path);
    await mkdir(dirname(destination), { recursive: true });
    const release = await acquireLock(`${destination}.lock`);
    let outcome: { ok: true; value: KnownProject } | { ok: false; cause: unknown };
    try {
      const store = await readStore(destination);
      const next: KnownProject = {
        root,
        id: project.id,
        name: project.name,
        lastOpenedAt: new Date().toISOString(),
      };
      if (!isKnownProject(next))
        throw new KnownProjectStoreError(
          'known-project-directory-invalid',
          'Project facts require a valid identity.',
          { root },
        );
      // Canonicalize persisted aliases inside the same locked transaction too.
      const canonical = await Promise.all(
        store.projects.map(async (entry) => {
          try {
            return { ...entry, root: await realpath(entry.root) };
          } catch {
            return entry;
          }
        }),
      );
      const records = new Map(canonical.map((entry) => [entry.root, entry]));
      records.set(root, next);
      await writeStore(destination, { schemaVersion: 1, projects: [...records.values()] });
      outcome = { ok: true, value: next };
    } catch (cause) {
      outcome = { ok: false, cause };
    }
    try {
      await release();
    } catch (cleanup) {
      if (!outcome.ok) throw new KnownProjectStoreCleanupError(destination, outcome.cause, cleanup);
      throw cleanup;
    }
    if (!outcome.ok) throw outcome.cause;
    return outcome.value;
  });
}

export async function registerKnownProject(
  root: string,
  options: { path?: string } = {},
): Promise<KnownProjectResult<KnownProject>> {
  if (!isAbsolute(root))
    return failCommand(
      'known-project-directory-invalid',
      'An absolute Node-visible project directory',
      'Choose a directory on the backend machine.',
      { path: root },
    );
  const { readProjectFacts } = await import('./project.js');
  const facts = await readProjectFacts(root);
  if (!facts.ok) return facts;
  return rememberKnownProject(facts.value, options);
}

export async function browseProjectDirectories(
  inputPath = homedir(),
): Promise<KnownProjectResult<ProjectDirectoryListing>> {
  return storageResult(inputPath, async () => {
    if (!isAbsolute(inputPath))
      throw new KnownProjectStoreError(
        'known-project-directory-invalid',
        'Project directory browsing requires an absolute path.',
        { path: inputPath },
      );
    let path: string;
    try {
      path = await realpath(resolve(inputPath));
    } catch (cause) {
      throw new KnownProjectStoreError(
        'known-project-directory-invalid',
        `Directory is unavailable: ${inputPath}`,
        { path: inputPath, reason: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    if (!(await stat(path)).isDirectory())
      throw new KnownProjectStoreError(
        'known-project-directory-invalid',
        `Path is not a directory: ${path}`,
        { path },
      );
    const entries = await readdir(path, { withFileTypes: true });
    const directories = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map(async (entry) => {
          const child = join(path, entry.name);
          if (entry.isSymbolicLink()) {
            try {
              if (!(await stat(child)).isDirectory()) return undefined;
            } catch {
              return undefined;
            }
          }
          let hasForgeManifest = false;
          try {
            hasForgeManifest = (await stat(join(child, 'forge.json'))).isFile();
          } catch {
            /* Not a project root. */
          }
          return { path: child, name: basename(child), hasForgeManifest };
        }),
    );
    const resolvedDirectories = directories.filter(
      (entry): entry is ProjectDirectoryEntry => entry !== undefined,
    );
    resolvedDirectories.sort((a, b) => a.name.localeCompare(b.name));
    return {
      path,
      parent: dirname(path) === path ? null : dirname(path),
      directories: resolvedDirectories,
    };
  });
}
