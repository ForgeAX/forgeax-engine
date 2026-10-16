import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { verifyDist, writeDistManifest } from '../dist.js';
import type { ProjectFacts } from '../types.js';

const readBudget = vi.hoisted(() => ({ enabled: false, active: 0, peak: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (!readBudget.enabled) return actual.readFile(...args);
      readBudget.active++;
      readBudget.peak = Math.max(readBudget.peak, readBudget.active);
      try {
        if (readBudget.active > 32) {
          throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
        }
        await new Promise<void>((done) => setImmediate(done));
        return await actual.readFile(...args);
      } finally {
        readBudget.active--;
      }
    },
  };
});

describe('dist closure', () => {
  it('hashes a large closure within a bounded open-file budget without losing artifacts', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-dist-budget-'));
    const dist = resolve(root, 'dist');
    const { mkdir, readFile, rm } = await import('node:fs/promises');
    await mkdir(resolve(dist, 'shaders'), { recursive: true });
    try {
      await writeFile(resolve(dist, 'index.html'), '<canvas></canvas>');
      await writeFile(resolve(dist, 'pack-index.json'), '[]');
      await writeFile(resolve(dist, 'shaders/manifest.json'), '{}');
      for (let index = 0; index < 96; index++) {
        await writeFile(resolve(dist, `shaders/${index}.bindings.json`), `${index}`);
      }
      const facts: ProjectFacts = {
        root,
        id: 'game',
        name: 'Game',
        roots: {},
        assetRoots: ['assets'],
        packageJson: {},
      };
      readBudget.active = 0;
      readBudget.peak = 0;
      readBudget.enabled = true;
      const manifest = await writeDistManifest(facts, '/');
      expect(readBudget.peak).toBeLessThanOrEqual(32);
      expect(manifest.artifacts).toHaveLength(99);
      expect(new Set(manifest.artifacts.map((artifact) => artifact.path)).size).toBe(99);
      expect((await verifyDist(dist)).ok).toBe(true);
      const bytes = await readFile(resolve(dist, 'shaders/73.bindings.json'));
      expect(
        manifest.artifacts.find((artifact) => artifact.path === 'shaders/73.bindings.json')?.bytes,
      ).toBe(bytes.length);
      await writeFile(resolve(dist, 'shaders/73.bindings.json'), 'tampered');
      const changed = await verifyDist(dist);
      expect(changed.ok).toBe(false);
      if (!changed.ok) expect(changed.error.code).toBe('dist-artifact-mismatch');
    } finally {
      readBudget.enabled = false;
      await rm(root, { recursive: true, force: true });
    }
  });
  it('detects artifact tampering', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-dist-'));
    const dist = resolve(root, 'dist');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(resolve(dist, 'shaders'), { recursive: true });
    await Promise.all([
      writeFile(resolve(dist, 'index.html'), '<canvas></canvas>'),
      writeFile(resolve(dist, 'pack-index.json'), '[]'),
      writeFile(resolve(dist, 'shaders/manifest.json'), '{}'),
    ]);
    const facts: ProjectFacts = {
      root,
      id: 'game',
      name: 'Game',
      roots: {},
      assetRoots: ['assets'],
      packageJson: {},
    };
    await writeDistManifest(facts, '/');
    expect((await verifyDist(dist)).ok).toBe(true);
    await writeFile(resolve(dist, 'index.html'), 'tampered');
    const result = await verifyDist(dist);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('dist-artifact-mismatch');
  });

  it('rejects files outside the declared closure', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-dist-'));
    const dist = resolve(root, 'dist');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(resolve(dist, 'shaders'), { recursive: true });
    await Promise.all([
      writeFile(resolve(dist, 'index.html'), '<canvas></canvas>'),
      writeFile(resolve(dist, 'pack-index.json'), '[]'),
      writeFile(resolve(dist, 'shaders/manifest.json'), '{}'),
    ]);
    const facts: ProjectFacts = {
      root,
      id: 'game',
      name: 'Game',
      roots: {},
      assetRoots: ['assets'],
      packageJson: {},
    };
    await writeDistManifest(facts, '/');
    await writeFile(resolve(dist, 'foreign.js'), 'export {};');
    const result = await verifyDist(dist);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('dist-artifact-undeclared');
  });

  it('writes and verifies a caller-selected static output directory', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-project-'));
    const output = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-output-'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(resolve(output, 'shaders'), { recursive: true });
    await Promise.all([
      writeFile(resolve(output, 'index.html'), '<canvas></canvas>'),
      writeFile(resolve(output, 'pack-index.json'), '[]'),
      writeFile(resolve(output, 'shaders/manifest.json'), '{}'),
    ]);
    const facts: ProjectFacts = {
      root,
      id: 'game',
      name: 'Game',
      roots: {},
      assetRoots: ['assets'],
      packageJson: {},
    };
    const manifest = await writeDistManifest(facts, '/games/game/', output);
    expect(manifest.base).toBe('/games/game/');
    expect((await verifyDist(output)).ok).toBe(true);
  });
});

it('labels partial validation material profiles and rejects unsupported identities', async () => {
  const { mkdir, rm } = await import('node:fs/promises');
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-dist-material-profile-'));
  const dist = resolve(root, 'dist');
  await mkdir(resolve(dist, 'shaders'), { recursive: true });
  try {
    await writeFile(resolve(dist, 'index.html'), '<canvas></canvas>');
    await writeFile(resolve(dist, 'pack-index.json'), '[]');
    await writeFile(resolve(dist, 'shaders/manifest.json'), '{}');
    const facts: ProjectFacts = {
      root,
      id: 'game',
      name: 'Game',
      roots: {},
      assetRoots: ['assets'],
      packageJson: {},
    };
    const ordinary = await writeDistManifest(facts, '/', dist);
    expect(ordinary).not.toHaveProperty('materialProfile');
    const selected = await writeDistManifest(facts, '/', dist, 'browser', 'webgpu-storage');
    expect(selected.materialProfile).toBe('webgpu-storage');
    expect((await verifyDist(dist)).ok).toBe(true);
    await writeFile(
      resolve(dist, 'forgeax-dist.json'),
      JSON.stringify({ ...selected, materialProfile: 'unknown' }),
    );
    expect((await verifyDist(dist)).ok).toBe(false);
    await writeFile(
      resolve(dist, 'forgeax-dist.json'),
      JSON.stringify({ ...selected, target: 'wechat' }),
    );
    expect((await verifyDist(dist)).ok).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
