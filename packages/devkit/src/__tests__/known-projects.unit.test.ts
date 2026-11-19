import { execFile, spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browseProjectDirectories,
  type KnownProject,
  listKnownProjects,
  registerKnownProject,
} from '../known-projects.js';

const filesystemBarrier = vi.hoisted(() => ({
  path: '',
  entered: undefined as (() => void) | undefined,
  resume: undefined as Promise<void> | undefined,
  file: undefined as import('node:fs/promises').FileHandle | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      if (String(args[0]) === `${filesystemBarrier.path}.lock`) filesystemBarrier.file = file;
      return file;
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const bytes = await actual.readFile(...args);
      if (String(args[0]) === filesystemBarrier.path) {
        filesystemBarrier.entered?.();
        await filesystemBarrier.resume;
      }
      return bytes;
    },
  };
});

function pauseStoreRead(path: string) {
  let resume!: () => void;
  const entered = new Promise<void>((done) => {
    filesystemBarrier.entered = done;
  });
  filesystemBarrier.resume = new Promise<void>((done) => {
    resume = done;
  });
  filesystemBarrier.path = path;
  filesystemBarrier.file = undefined;
  return { entered, resume };
}

const roots: string[] = [];
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-known-projects-')));
  roots.push(root);
  const project = join(root, 'game');
  await mkdir(project);
  await writeFile(
    join(project, 'forge.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      id: 'game',
      name: 'Game',
      roots: {},
      assetRoots: ['assets'],
    }),
  );
  await writeFile(join(project, 'package.json'), '{}');
  return { root, project, path: join(root, 'data', 'known-projects.json') };
}
afterEach(async () => {
  filesystemBarrier.path = '';
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Node-owned known projects', () => {
  it('treats missing storage as empty and deduplicates canonical aliases', async () => {
    const { root, project, path } = await fixture();
    expect(await listKnownProjects({ path })).toEqual({ ok: true, value: [] });
    const alias = join(root, 'alias');
    await symlink(project, alias);
    expect((await registerKnownProject(project, { path })).ok).toBe(true);
    expect((await registerKnownProject(alias, { path })).ok).toBe(true);
    const result = await listKnownProjects({ path });
    expect(result).toMatchObject({
      ok: true,
      value: [{ id: 'game', name: 'Game', availability: 'available' }],
    });
    if (result.ok) expect(result.value).toHaveLength(1);
  });
  it('preserves corrupt storage and its original source failure on reads and writes', async () => {
    const { project, path } = await fixture();
    await mkdir(join(path, '..'), { recursive: true });
    const original = '{broken';
    await writeFile(path, original);
    for (const result of [
      await listKnownProjects({ path }),
      await registerKnownProject(project, { path }),
    ]) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'known-project-store-corrupt', detail: { path } },
      });
    }
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await readdir(join(path, '..'))).toEqual(['known-projects.json']);
  });
  it.each([
    'replaced',
    'removed',
  ])('retains corruption and release failure when the acquired lock is %s', async (mode) => {
    const { root, project, path } = await fixture();
    await mkdir(join(path, '..'), { recursive: true });
    const original = '{broken';
    await writeFile(path, original);
    const barrier = pauseStoreRead(path);
    const registration = registerKnownProject(project, { path });
    const successor = '{"pid":2147483647,"nonce":"successor"}';
    try {
      await barrier.entered;
      const lockPath = `${path}.lock`;
      const file = filesystemBarrier.file;
      if (!file) throw new Error('The writer did not acquire its actual lock');
      const acquired = await file.stat();
      expect(file.fd).toBeGreaterThanOrEqual(0);
      if (mode === 'replaced') {
        await rename(lockPath, join(root, 'retired.lock'));
        const replacement = await open(lockPath, 'wx', 0o600);
        try {
          await replacement.writeFile(successor);
          expect((await replacement.stat()).ino).not.toBe(acquired.ino);
        } finally {
          await replacement.close();
        }
      } else await rm(lockPath);
      barrier.resume();
      const result = await registration;
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'known-project-store-cleanup-failed',
          detail: {
            path,
            primary: {
              code: 'known-project-store-corrupt',
              detail: { path, reason: expect.any(String) },
            },
            cleanup: { code: 'known-project-store-io', detail: { lockPath } },
          },
        },
      });
      expect(file.fd).toBe(-1);
      expect(await readFile(path, 'utf8')).toBe(original);
      if (mode === 'replaced') expect(await readFile(lockPath, 'utf8')).toBe(successor);
      expect(await readdir(join(path, '..'))).toEqual(
        mode === 'replaced'
          ? ['known-projects.json', 'known-projects.json.lock']
          : ['known-projects.json'],
      );
    } finally {
      filesystemBarrier.path = '';
      barrier.resume();
      await registration;
    }
  });
  it.each([
    ['schema', (record: KnownProject) => ({ schemaVersion: 2, projects: [record] })],
    ['collection', () => ({ schemaVersion: 1, projects: {} })],
    ['duplicates', (record: KnownProject) => ({ schemaVersion: 1, projects: [record, record] })],
    ['record', () => ({ schemaVersion: 1, projects: [null] })],
    [
      'relative-root',
      (record: KnownProject) => ({ schemaVersion: 1, projects: [{ ...record, root: 'game' }] }),
    ],
    [
      'non-normalized-root',
      (record: KnownProject) => ({
        schemaVersion: 1,
        projects: [{ ...record, root: `${record.root}/../game` }],
      }),
    ],
    [
      'empty-id',
      (record: KnownProject) => ({ schemaVersion: 1, projects: [{ ...record, id: ' ' }] }),
    ],
    [
      'empty-name',
      (record: KnownProject) => ({ schemaVersion: 1, projects: [{ ...record, name: '' }] }),
    ],
    [
      'date',
      (record: KnownProject) => ({
        schemaVersion: 1,
        projects: [{ ...record, lastOpenedAt: 'invalid' }],
      }),
    ],
  ] as const)('preserves semantic corruption (%s) on reads and registration', async (_case, corrupt) => {
    const { project, path } = await fixture();
    const record = {
      root: project,
      id: 'game',
      name: 'Game',
      lastOpenedAt: '2026-01-01T00:00:00.000Z',
    };
    await mkdir(join(path, '..'), { recursive: true });
    const original = JSON.stringify(corrupt(record));
    await writeFile(path, original);
    for (const result of [
      await listKnownProjects({ path }),
      await registerKnownProject(project, { path }),
    ]) {
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'known-project-store-corrupt',
          detail: { path, reason: expect.any(String) },
        },
      });
    }
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await readdir(join(path, '..'))).toEqual(['known-projects.json']);
  });

  it('preserves an actual successor lock and reports publication when release loses ownership', async () => {
    const { root, project, path } = await fixture();
    await registerKnownProject(project, { path });
    const barrier = pauseStoreRead(path);
    const registration = registerKnownProject(project, { path });
    try {
      await barrier.entered;
      const file = filesystemBarrier.file;
      if (!file) throw new Error('Missing acquired lock handle');
      await rename(`${path}.lock`, join(root, 'retired.lock'));
      const successor = await open(`${path}.lock`, 'wx', 0o600);
      const bytes = '{"pid":2147483647,"nonce":"successor"}';
      try {
        await successor.writeFile(bytes);
      } finally {
        await successor.close();
      }
      barrier.resume();
      expect(await registration).toMatchObject({
        ok: false,
        error: {
          code: 'known-project-store-io',
          detail: { lockPath: `${path}.lock` },
        },
      });
      expect(file.fd).toBe(-1);
      expect(await readFile(`${path}.lock`, 'utf8')).toBe(bytes);
      const published = JSON.parse(await readFile(path, 'utf8'));
      expect(published).toMatchObject({
        schemaVersion: 1,
        projects: [{ root: project, id: 'game', name: 'Game' }],
      });
      expect(published.projects).toHaveLength(1);
      expect(await readdir(join(path, '..'))).toEqual([
        'known-projects.json',
        'known-projects.json.lock',
      ]);
    } finally {
      filesystemBarrier.path = '';
      barrier.resume();
      await registration;
    }
  });

  it('reports changed identity without rewriting storage until explicit re-import', async () => {
    const { project, path } = await fixture();
    await registerKnownProject(project, { path });
    const original = await readFile(path, 'utf8');
    const manifestPath = join(project, 'forge.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, id: 'changed', name: 'Changed' }));
    expect(await listKnownProjects({ path })).toMatchObject({
      ok: true,
      value: [
        {
          root: project,
          id: 'game',
          availability: 'unavailable',
          failure: {
            code: 'known-project-identity-changed',
            detail: { root: project, expectedId: 'game', actualId: 'changed' },
          },
        },
      ],
    });
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await registerKnownProject(project, { path })).toMatchObject({
      ok: true,
      value: { id: 'changed', name: 'Changed' },
    });
    expect(await listKnownProjects({ path })).toMatchObject({
      ok: true,
      value: [{ id: 'changed', availability: 'available' }],
    });
  });
  it('returns manifest validation failures without registering invalid roots', async () => {
    const { project, path } = await fixture();
    await writeFile(join(project, 'forge.json'), '{}');
    expect(await registerKnownProject(project, { path })).toMatchObject({
      ok: false,
      error: { code: 'project-manifest-invalid' },
    });
    expect(await listKnownProjects({ path })).toEqual({ ok: true, value: [] });
  });
  it('identifies unavailable known entries without removing them or compiling projects', async () => {
    const { project, path } = await fixture();
    await registerKnownProject(project, { path });
    await rm(project, { recursive: true });
    expect(await listKnownProjects({ path })).toMatchObject({
      ok: true,
      value: [{ availability: 'unavailable', failure: { code: 'project-manifest-unreadable' } }],
    });
    expect(JSON.parse(await readFile(path, 'utf8')).projects).toHaveLength(1);
  });
  it('browses only immediate Node directories and accepts an omitted path', async () => {
    const { root, project } = await fixture();
    expect(await browseProjectDirectories(root)).toMatchObject({
      ok: true,
      value: { directories: [{ path: project, hasForgeManifest: true }] },
    });
    expect((await browseProjectDirectories()).ok).toBe(true);
    expect(await browseProjectDirectories('relative')).toMatchObject({
      ok: false,
      error: { code: 'known-project-directory-invalid' },
    });
  });
  it('serializes separate CLI processes without losing unrelated records', async () => {
    const { root, project, path } = await fixture();
    const modulePath = join(root, 'catalogue.mjs');
    const require = createRequire(import.meta.url);
    const { build } = await import(createRequire(require.resolve('tsup')).resolve('esbuild'));
    await build({
      entryPoints: [new URL('../known-projects.ts', import.meta.url).pathname],
      outfile: modulePath,
      bundle: true,
      platform: 'node',
      format: 'esm',
    });
    const seed = {
      root: project,
      id: 'game',
      name: 'Game',
      lastOpenedAt: '2026-01-01T00:00:00.000Z',
    };
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify({ schemaVersion: 1, projects: [seed] }));
    const expected = [seed];
    await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const child = join(root, `game-${i}`);
        await mkdir(child);
        await writeFile(
          join(child, 'forge.json'),
          (await readFile(join(project, 'forge.json'), 'utf8')).replaceAll('game', `game-${i}`),
        );
        await writeFile(join(child, 'package.json'), '{}');
        const alias = join(root, `alias-${i}`);
        await symlink(child, alias);
        expected.push({ root: child, id: `game-${i}`, name: 'Game', lastOpenedAt: '' });
        await Promise.all(
          [child, alias].map((selected) =>
            promisify(execFile)(process.execPath, [
              '--experimental-strip-types',
              '--input-type=module',
              '-e',
              `import { registerKnownProject } from ${JSON.stringify(`file://${modulePath}`)}; const r = await registerKnownProject(${JSON.stringify(selected)}, {path:${JSON.stringify(path)}}); if (!r.ok) throw new Error(JSON.stringify(r.error));`,
            ]),
          ),
        );
      }),
    );
    const result = await listKnownProjects({ path });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(
      result.value
        .map(({ root, id, name }) => ({ root, id, name }))
        .sort((a, b) => a.root.localeCompare(b.root)),
    ).toEqual(
      expected
        .map(({ root, id, name }) => ({ root, id, name }))
        .sort((a, b) => a.root.localeCompare(b.root)),
    );
    const published = JSON.parse(await readFile(path, 'utf8'));
    expect(published.schemaVersion).toBe(1);
    expect(published.projects).toHaveLength(9);
    expect(published.projects.find((record: KnownProject) => record.root === project)).toEqual(
      seed,
    );
    expect(
      published.projects.every((record: KnownProject) =>
        Number.isFinite(Date.parse(record.lastOpenedAt)),
      ),
    ).toBe(true);
    expect(await readdir(join(path, '..'))).toEqual(['known-projects.json']);
  });
  it('preserves an abandoned lock instead of unlinking a possible successor', async () => {
    const { project, path } = await fixture();
    await mkdir(join(path, '..'), { recursive: true });
    const lockPath = `${path}.lock`;
    const bytes = '{"pid":2147483647,"nonce":"owner"}';
    await writeFile(lockPath, bytes);
    expect(await registerKnownProject(project, { path })).toMatchObject({
      ok: false,
      error: {
        code: 'known-project-store-lock-timeout',
        hint: expect.stringContaining('confirm its owner is stopped'),
        detail: { lockPath, ownerPid: 2147483647, ownerAlive: false, ownerNonce: 'owner' },
      },
    });
    expect(await readFile(lockPath, 'utf8')).toBe(bytes);
    expect(await readdir(join(path, '..'))).toEqual(['known-projects.json.lock']);
  });

  it.each([
    [
      'live-owner',
      JSON.stringify({ pid: process.pid, nonce: 'live' }),
      { ownerPid: process.pid, ownerAlive: true, ownerNonce: 'live' },
    ],
    ['malformed', '{broken', {}],
    ['incomplete', '{}', {}],
  ] as const)('preserves %s lock diagnostics and existing store bytes', async (_case, bytes, owner) => {
    const { project, path } = await fixture();
    await registerKnownProject(project, { path });
    const original = await readFile(path, 'utf8');
    await writeFile(`${path}.lock`, bytes);
    const result = await registerKnownProject(project, { path });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'known-project-store-lock-timeout',
        detail: { lockPath: `${path}.lock`, ...owner },
        hint: expect.stringContaining('remove only that abandoned lock'),
      },
    });
    if (!result.ok && _case !== 'live-owner') {
      expect(result.error.detail).not.toHaveProperty('ownerPid');
      expect(result.error.detail).not.toHaveProperty('ownerAlive');
    }
    expect(await readFile(`${path}.lock`, 'utf8')).toBe(bytes);
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await readdir(join(path, '..'))).toEqual([
      'known-projects.json',
      'known-projects.json.lock',
    ]);
  });

  it('requires explicit recovery of a lock abandoned by a killed actual owner', async () => {
    const { project, path } = await fixture();
    await registerKnownProject(project, { path });
    const original = await readFile(path, 'utf8');
    const lockPath = `${path}.lock`;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { open } from 'node:fs/promises';
      const file = await open(${JSON.stringify(lockPath)}, 'wx', 0o600);
      await file.writeFile(JSON.stringify({ pid: process.pid, nonce: 'crashed-owner' }));
      await file.sync();
      process.stdout.write('lock-ready\\n');
      setInterval(() => {}, 1000);
    `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    try {
      await new Promise<void>((done, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Lock owner did not reach its filesystem barrier')),
          2000,
        );
        child.once('error', reject);
        child.stdout.once('data', () => {
          clearTimeout(timeout);
          done();
        });
      });
      const bytes = await readFile(lockPath, 'utf8');
      const owner = JSON.parse(bytes) as { pid: number; nonce: string };
      expect(owner.pid).toBe(child.pid);
      child.kill('SIGKILL');
      await exited;
      expect(() => process.kill(owner.pid, 0)).toThrow();
      expect(await registerKnownProject(project, { path })).toMatchObject({
        ok: false,
        error: {
          code: 'known-project-store-lock-timeout',
          detail: {
            lockPath,
            ownerPid: owner.pid,
            ownerAlive: false,
            ownerNonce: owner.nonce,
          },
        },
      });
      expect(await readFile(lockPath, 'utf8')).toBe(bytes);
      expect(await readFile(path, 'utf8')).toBe(original);
      expect(await readdir(join(path, '..'))).toEqual([
        'known-projects.json',
        'known-projects.json.lock',
      ]);
      // Explicit owner recovery after the process has demonstrably stopped.
      await rm(lockPath);
      expect((await registerKnownProject(project, { path })).ok).toBe(true);
      expect(await readdir(join(path, '..'))).toEqual(['known-projects.json']);
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  });
});
