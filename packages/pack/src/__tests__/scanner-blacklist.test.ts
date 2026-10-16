import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scan } from '../scanner.js';

const EMPTY_PACK = JSON.stringify({
  schemaVersion: '1.0.0',
  kind: 'internal-text-package',
  assets: [],
});

describe('asset scanner test-directory boundary', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it('skips arbitrarily nested __tests__ declarations while keeping normal assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-scanner-tests-'));
    temporaryRoots.push(root);
    const visible = join(root, 'world', 'scene.pack.json');
    const nestedFixture = join(root, 'world', '__tests__', 'fixture.pack.json');
    const rootFixture = join(root, '__tests__', 'nested', 'fixture.pack.json');

    await mkdir(join(root, 'world', '__tests__'), { recursive: true });
    await mkdir(join(root, '__tests__', 'nested'), { recursive: true });
    await writeFile(visible, EMPTY_PACK);
    // Deliberately malformed: a test fixture must not be able to degrade the
    // production scan simply because it lives below the asset root.
    await writeFile(nestedFixture, '{}');
    await writeFile(rootFixture, '{}');

    const result = await scan([root]);

    expect(result).toMatchObject({ ok: true, value: [visible] });
  });

  it('allows an explicit __tests__ root when a test intentionally opts in', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-scanner-tests-'));
    temporaryRoots.push(root);
    const testRoot = join(root, '__tests__');
    const fixture = join(testRoot, 'fixture.pack.json');

    await mkdir(testRoot, { recursive: true });
    await writeFile(fixture, EMPTY_PACK);

    const result = await scan([testRoot]);

    expect(result).toMatchObject({ ok: true, value: [fixture] });
  });
});
