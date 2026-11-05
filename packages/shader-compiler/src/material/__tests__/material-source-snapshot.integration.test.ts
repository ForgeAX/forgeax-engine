import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScriptablePackSourceSnapshot } from '@forgeax/engine-pack/source-node';
import type { MaterialRootAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import {
  captureMaterialSourceSnapshot,
  createMaterialPackCooker,
  listMaterialSourcePaths,
} from '../pack-cooker.js';

const shader = `#define_import_path test::snapshot
#import forgeax_material::parameters::{material}
@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(material.roughness * 0.321); }
`;
const material: MaterialRootAsset = {
  kind: 'material',
  passes: [{ name: 'forward', program: { module: 'test::snapshot' } }],
  parameters: [{ name: 'roughness', type: 'f32', default: 0.5 }],
  values: { roughness: 0.5 },
};

it('captures file bytes through the existing source fence and rejects changed bytes or namespace', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-material-source-snapshot-')));
  const file = join(root, 'snapshot.wgsl');
  try {
    await writeFile(file, shader);
    const fence = createScriptablePackSourceSnapshot();
    let reads = 0;
    const snapshot = await captureMaterialSourceSnapshot([root], {
      paths: (roots) => fence.observePaths(root, () => listMaterialSourcePaths(roots)),
      readText: (path) => {
        if (path === file) reads++;
        return fence.readText(path);
      },
    });
    expect(reads).toBe(1);
    expect(snapshot.project.find((row) => row.path === file)?.source).toBe(shader);
    expect(Object.isFrozen(snapshot.project[0])).toBe(true);
    expect((await fence.verify()).ok).toBe(true);
    await writeFile(file, shader.replace('0.321', '0.777'));
    expect(await fence.verify()).toMatchObject({
      ok: false,
      error: { code: 'pack-source-revision-conflict' },
    });
    const next = await captureMaterialSourceSnapshot([root]);
    expect(next.identity).not.toBe(snapshot.identity);
    const namespace = createScriptablePackSourceSnapshot();
    await captureMaterialSourceSnapshot([root], {
      paths: (roots) => namespace.observePaths(root, () => listMaterialSourcePaths(roots)),
      readText: (path) => namespace.readText(path),
    });
    await writeFile(join(root, 'late.wgsl'), '#define_import_path test::late\n');
    expect((await namespace.verify()).ok).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('owns a captured catalog across cooks while a new capture compiles changed source', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-material-snapshot-cook-')));
  const file = join(root, 'snapshot.wgsl');
  try {
    await writeFile(file, shader);
    const borrowed = structuredClone(await captureMaterialSourceSnapshot([root]));
    const cooker = createMaterialPackCooker([root], {
      profile: 'webgpu-storage',
      sourceSnapshot: borrowed,
    });
    const cook = (owner: typeof cooker, guid: string) =>
      owner.cook({ guid, source: material, sourcePath: join(root, 'fixture.pack.ts') });
    const first = await cook(cooker, 'first');
    const row = borrowed.project.find((row) => row.path === file);
    if (row === undefined) throw new Error('Missing captured source');
    Object.assign(row, { source: shader.replace('0.321', '0.777') });
    await writeFile(file, row.source);
    const second = await cook(cooker, 'second');
    const hashes = (value: typeof first) =>
      Object.values(value.artifacts ?? {})
        .map((body) => createHash('sha256').update(body.bytes).digest('hex'))
        .sort();
    expect(hashes(second)).toEqual(hashes(first));
    const fresh = createMaterialPackCooker([root], {
      profile: 'webgpu-storage',
      sourceSnapshot: await captureMaterialSourceSnapshot([root]),
    });
    expect(hashes(await cook(fresh, 'fresh'))).not.toEqual(hashes(first));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
