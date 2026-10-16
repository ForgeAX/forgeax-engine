import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import * as naga from '@forgeax/engine-naga';
import {
  type MaterialShaderManifestEntry,
  readShaderManifestPublication,
} from '@forgeax/engine-shader';
import { afterEach, expect, it, vi } from 'vitest';
import { forgeaxShader } from '../index.js';

it('reuses Standard code across authored packages without accepting an invalid entry or retaining closed-server work', async () => {
  const root = resolve(import.meta.dirname, '../../../..');
  const temporary = await mkdtemp(resolve(tmpdir(), 'forgeax-authored-reuse-'));
  const compose = vi.spyOn(naga, 'composeShader');
  try {
    const template = JSON.parse(
      await readFile(
        resolve(root, 'apps/hello/physical-material/src/standard-clearcoat-factor-r.pack.json'),
        'utf8',
      ),
    );
    const packages: string[] = [];
    for (const [index, alias] of ['first', 'second', 'invalid'].entries()) {
      const pack = structuredClone(template);
      const asset = pack.assets[0];
      asset.guid = `8a5a0001-0000-4000-8000-00000000000${index + 3}`;
      asset.sourceKey = resolve(root, 'packages/shader/src/default-standard-pbr.wgsl');
      asset.payload.values = { roughness: index === 0 ? 0.25 : 0.8 };
      asset.payload.passes[0].program.module = `test::${alias}`;
      if (alias === 'invalid') asset.payload.passes[0].program.vertexEntry = 'missing';
      const path = resolve(temporary, `${alias}.pack.json`);
      await writeFile(path, JSON.stringify(pack));
      packages.push(path);
    }
    let active = packages.slice(0, 1);
    const plugin = forgeaxShader({ engineEntries: false, materialPackagesProvider: () => active });
    const emitted: { fileName: string; source: string }[] = [];
    const context = {
      emitFile(asset: { fileName: string; source: string }) {
        emitted.push(asset);
        return asset.fileName;
      },
    };
    await plugin.buildStart?.call(context as never);
    const initialCompositions = compose.mock.calls.length;
    expect(initialCompositions).toBeGreaterThan(0);
    active = packages.slice(0, 2);
    await plugin.buildStart?.call(context as never);
    expect(compose.mock.calls.length).toBe(initialCompositions);
    plugin.generateBundle?.call(context as never);
    const publication = emitted.find((asset) => asset.fileName === 'shaders/manifest.json');
    expect(publication).toBeDefined();
    if (publication === undefined) throw new Error('Authored manifest missing');
    const manifest = (await readShaderManifestPublication(JSON.parse(publication.source))) as {
      materialShaders: MaterialShaderManifestEntry[];
    };
    expect(manifest.materialShaders.map((entry) => entry.identifier)).toEqual([
      'test::first',
      'test::second',
    ]);
    expect(manifest.materialShaders[0]?.variants).toEqual(manifest.materialShaders[1]?.variants);
    active = packages;
    await expect(plugin.buildStart?.call(context as never)).rejects.toThrow(/missing/);
    await plugin.closeBundle();
    active = packages.slice(0, 1);
    const beforeRestart = compose.mock.calls.length;
    await plugin.buildStart?.call(context as never);
    expect(compose.mock.calls.length).toBeGreaterThan(beforeRestart);
    await plugin.closeBundle();
  } finally {
    vi.restoreAllMocks();
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);

it('shares direct shader composition across file identities while validating source edits and retiring closed-server work', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'forgeax-direct-reuse-'));
  const compose = vi.spyOn(naga, 'composeShader');
  const plugin = forgeaxShader({ engineEntries: false });
  const context = { emitFile: () => 'shader' };
  const source = `
@group(0) @binding(0) var<storage, read_write> output: array<f32>;
@compute @workgroup_size(1) fn main() { output[0] = 1.0; }
`;
  try {
    await plugin.buildStart.call(context as never);
    const first = await plugin.transform.call(
      context as never,
      source,
      resolve(temporary, 'first.wgsl'),
    );
    expect(first?.code).toContain('main');
    const initialCompositions = compose.mock.calls.length;
    expect(initialCompositions).toBeGreaterThan(0);
    const second = await plugin.transform.call(
      context as never,
      source,
      resolve(temporary, 'second.wgsl'),
    );
    expect(second?.code).toBe(first?.code);
    expect(compose.mock.calls.length).toBe(initialCompositions);
    await expect(
      plugin.transform.call(context as never, 'invalid WGSL', resolve(temporary, 'first.wgsl')),
    ).rejects.toThrow();
    const changed = await plugin.transform.call(
      context as never,
      source.replace('1.0', '2.0'),
      resolve(temporary, 'first.wgsl'),
    );
    expect(changed?.code).not.toBe(first?.code);
    await plugin.closeBundle();
    const beforeRestart = compose.mock.calls.length;
    const restarted = await plugin.transform.call(
      context as never,
      source,
      resolve(temporary, 'first.wgsl'),
    );
    expect(restarted?.code).toBe(first?.code);
    expect(compose.mock.calls.length).toBeGreaterThan(beforeRestart);
  } finally {
    await plugin.closeBundle();
    vi.restoreAllMocks();
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);

const root = resolve(import.meta.dirname, '../../../..');
afterEach(() => vi.restoreAllMocks());

it('shares exact Standard compilation across aliases without sharing publication identity', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'forgeax-material-alias-reuse-'));
  const original = JSON.parse(
    await readFile(
      resolve(root, 'apps/hello/physical-material/src/standard-clearcoat.pack.json'),
      'utf8',
    ),
  );
  const packages: string[] = [];
  try {
    for (const [index, module] of ['alias::first', 'alias::second'].entries()) {
      const pack = structuredClone(original);
      const asset = pack.assets[0];
      asset.guid = `00000000-0000-4000-8000-00000000000${index}`;
      asset.sourceKey = resolve(root, 'packages/shader/src/default-standard-pbr.wgsl');
      asset.payload.passes[0].program.module = module;
      const path = resolve(directory, `${index}.pack.json`);
      await writeFile(path, JSON.stringify(pack));
      packages.push(path);
    }
    const compose = vi.spyOn(naga, 'composeShader');
    const publish = async (materialPackages: string[]) => {
      const plugin = forgeaxShader({ engineEntries: false, materialPackages });
      const assets: { fileName: string; source: string }[] = [];
      const context = {
        emitFile: (asset: { fileName: string; source: string }) => {
          assets.push(asset);
          return asset.fileName;
        },
      };
      try {
        await plugin.buildStart?.call(context as never);
        plugin.generateBundle?.call(context as never);
        const emitted = assets.find((asset) => asset.fileName === 'shaders/manifest.json');
        if (!emitted) throw new Error('Missing material publication');
        return (await readShaderManifestPublication(JSON.parse(emitted.source))) as {
          materialShaders: { identifier: string; variants: unknown[] }[];
        };
      } finally {
        await plugin.closeBundle?.call(context as never);
      }
    };
    const single = await publish(packages.slice(0, 1));
    const singleCompositions = compose.mock.calls.length;
    expect(singleCompositions).toBeGreaterThan(0);
    compose.mockClear();
    const batch = await publish(packages);
    expect(batch.materialShaders.map((row) => row.identifier)).toEqual([
      'alias::first',
      'alias::second',
    ]);
    expect(batch.materialShaders[0]?.variants).toHaveLength(6);
    expect(batch.materialShaders[0]?.variants).toEqual(single.materialShaders[0]?.variants);
    expect(batch.materialShaders[1]?.variants).toEqual(single.materialShaders[0]?.variants);
    expect(compose.mock.calls.length).toBe(singleCompositions);

    // A cache hit for the same source must not admit a different, invalid entry selection.
    const secondPath = packages[1];
    if (secondPath === undefined) throw new Error('Missing second alias fixture');
    const invalid = JSON.parse(await readFile(secondPath, 'utf8'));
    invalid.assets[0].payload.passes[0].program.fragmentEntry = 'missing_fragment';
    await writeFile(secondPath, JSON.stringify(invalid));
    await expect(publish(packages)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
