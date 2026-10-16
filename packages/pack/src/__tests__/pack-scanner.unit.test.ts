import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanEntries } from '../cli-asset.js';
import { scanInventory } from '../scanner.js';

const SOURCE_PACKAGE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INSTANCE_PACKAGE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DIRECT_PACKAGE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const roots: string[] = [];

afterEach(async () => {
  const root = roots.pop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe('ScriptablePack and Pack source scanner', () => {
  it('indexes direct v3 output keys as derived GUIDs without requiring entry GUIDs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-pack-scan-'));
    roots.push(root);
    const path = join(root, 'direct.pack.json');
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: DIRECT_PACKAGE,
        assets: {
          'scene/main': {
            kind: 'scene',
            payload: { kind: 'scene', nodes: [] },
            refs: [],
          },
        },
      }),
    );

    const result = await scanInventory([root]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.inventory).toMatchObject([
      {
        kind: 'scene',
        sourcePath: path,
        sourceKey: 'scene/main',
        sourceIndex: 0,
      },
    ]);
    expect(result.value.inventory[0]?.guid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const stdout: string[] = [];
    const stderr: string[] = [];
    const listed = await scanEntries([root], {
      stdoutWrite: (line) => stdout.push(line),
      stderrWrite: (line) => stderr.push(line),
    });
    expect(listed).toMatchObject({
      ok: true,
      value: [{ guid: result.value.inventory[0]?.guid, name: 'scene/main' }],
    });
    expect(stderr).toEqual([]);
  });

  it('captures a ScriptablePack source as metadata and resolves an instance parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-pack-source-scan-'));
    roots.push(root);
    await writeFile(
      join(root, 'source.pack.ts'),
      [
        'const packageId = new Uint8Array(16);',
        'packageId.set([170, 170, 170, 170, 170, 170, 74, 170, 138, 170, 170, 170, 170, 170, 170, 170]);',
        'export default {',
        "  schemaVersion: '2.0.0',",
        '  packageId,',
        "  parameters: [{ name: 'count', type: 'u32', default: 1 }],",
        "  build: ({ values }) => ({ ok: true, value: { ['mesh/' + values.count]: { kind: 'mesh', materialSlots: [] } } }),",
        '};',
      ].join('\n'),
    );
    await writeFile(
      join(root, 'instance.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: INSTANCE_PACKAGE,
        parent: SOURCE_PACKAGE,
        values: { count: 2, label: 'parent' },
      }),
    );
    await writeFile(
      join(root, 'grandchild.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: DIRECT_PACKAGE,
        parent: INSTANCE_PACKAGE,
        values: { count: 3 },
      }),
    );

    const result = await scanInventory([root]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const declaration = result.value.declarations.get(join(root, 'source.pack.ts'));
    expect(declaration?.format).toBe('pack.ts');
    expect(result.value.inventory).toEqual([]);
    const rootSourcePath = join(root, 'source.pack.ts');
    expect(result.value.instances.get(join(root, 'instance.pack.json'))).toMatchObject({
      root: { sourcePath: rootSourcePath },
      values: { count: 2, label: 'parent' },
    });
    expect(result.value.instances.get(join(root, 'grandchild.pack.json'))).toMatchObject({
      root: { sourcePath: rootSourcePath },
      values: { count: 3, label: 'parent' },
    });
  });

  it('fails closed when an instance parent is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-pack-parent-scan-'));
    roots.push(root);
    await writeFile(
      join(root, 'missing.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: INSTANCE_PACKAGE,
        parent: SOURCE_PACKAGE,
        values: { count: 2 },
      }),
    );

    const result = await scanInventory([root]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('pack-malformed-pack');
    expect(result.error.detail).toMatchObject({ reason: 'pack-parent-not-found' });
  });
});
