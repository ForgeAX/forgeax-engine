import { fileURLToPath } from 'node:url';
import { type ScanSourceDeclaration, scanInventory } from '@forgeax/engine-pack/build';
import {
  AssetGuid,
  definePackageId,
  executePackBuild,
  resolvePackParameterValues,
} from '@forgeax/engine-pack/source';
import { loadScriptablePack } from '@forgeax/engine-pack/source-node';
import { err, type MeshAsset, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { triangleSet } from '../../../src/__tests__/contract';
import { buildLamp, LAMP_DEFAULTS } from '../lamp';

/**
 * Design 10.1 reuse paths, each through the real Pack loader: `scanInventory` loads
 * every source of this directory in the isolated ScriptablePack Worker and resolves
 * the `*.pack.json` instance through its parent; each build loads its source again
 * (a loaded executor serves one build), as the producer does. The test plays the
 * producer's asset reader: upstream outputs are addressed only by derived GUIDs.
 */
const DIRECTORY = fileURLToPath(new URL('..', import.meta.url));
const LAMP_ID = definePackageId('01900000-0000-7000-8000-0000000c0002');
const TALL_ID = definePackageId('01900000-0000-7000-8000-0000000c0003');
const PAIR_ID = definePackageId('01900000-0000-7000-8000-0000000c0004');
const TALL_VALUES = { height: 0.32, reach: 25, shadeRadius: 0.09 };

type PackTs = Extract<ScanSourceDeclaration, { readonly format: 'pack.ts' }>;

async function loadDirectory() {
  const scanned = await scanInventory([DIRECTORY]);
  if (!scanned.ok) throw scanned.error;
  const source = (name: string) => {
    const declaration = [...scanned.value.declarations.values()].find((d) =>
      d.sourcePath.endsWith(`/${name}`),
    );
    if (declaration?.format !== 'pack.ts') throw new Error(`${name} is not a loaded pack.ts`);
    return declaration as PackTs;
  };
  return { scanned: scanned.value, source };
}

type Outputs = Readonly<Record<string, unknown>>;

async function build(
  declaration: PackTs,
  packageId: Uint8Array,
  overrides: Readonly<Record<string, unknown>>,
  outputs: ReadonlyMap<string, unknown> = new Map(),
): Promise<Outputs> {
  const loaded = await loadScriptablePack(declaration.sourcePath);
  if (!loaded.ok) throw loaded.error;
  const definition = loaded.value;
  const reads: string[] = [];
  const result = await executePackBuild(definition, {
    packageId: packageId as never,
    readByGuid: async (guid: Uint8Array) => {
      const key = AssetGuid.format(guid as never);
      reads.push(key);
      return outputs.has(key) ? ok(outputs.get(key) as never) : err({ code: 'missing', guid: key });
    },
    ...('parameters' in definition
      ? { values: resolvePackParameterValues(definition, overrides).unwrap() }
      : {}),
  } as never);
  if (!result.ok) throw Object.assign(new Error('build failed'), { cause: result.error, reads });
  return result.value as Outputs;
}

const mesh = (outputs: Outputs, key: string) => outputs[key] as MeshAsset;
const guid = (packageId: Uint8Array, key: string) =>
  AssetGuid.format(AssetGuid.derive(packageId as never, key));

describe('W-104 reuse paths through the real Pack loader', () => {
  it('(a) function reuse: the Pack statically imports the recipe module', {
    timeout: 120000,
  }, async () => {
    const { source } = await loadDirectory();
    const lamp = source('lamp.pack.ts');
    expect(lamp.sourceClosure.map((entry) => entry.path.split('/').pop())).toContain('lamp.ts');
    const outputs = await build(lamp, LAMP_ID, {});
    expect(Object.keys(outputs)).toEqual(['mesh/lamp']);
    const direct = buildLamp(LAMP_DEFAULTS).toMesh({ normals: { mode: 'weighted' } });
    if (!direct.ok) throw direct.error;
    expect(triangleSet(mesh(outputs, 'mesh/lamp'))).toEqual(triangleSet(direct.value.mesh));
  });

  it('(b) parameter variants: a *.pack.json instance with parent and values', {
    timeout: 120000,
  }, async () => {
    const { scanned, source } = await loadDirectory();
    const instance = [...scanned.instances.entries()].find(([path]) =>
      path.endsWith('/lamp-tall.pack.json'),
    );
    if (instance === undefined) throw new Error('lamp-tall.pack.json was not resolved');
    const [, resolved] = instance;
    expect(resolved.root.sourcePath).toBe(source('lamp.pack.ts').sourcePath);
    expect(resolved.values).toEqual(TALL_VALUES);
    expect([...resolved.packageId]).toEqual([...TALL_ID]);
    expect(guid(TALL_ID, 'mesh/lamp')).not.toBe(guid(LAMP_ID, 'mesh/lamp'));
    const tall = await build(resolved.root, resolved.packageId, resolved.values);
    const lamp = await build(resolved.root, LAMP_ID, {});
    const direct = buildLamp(TALL_VALUES).toMesh({ normals: { mode: 'weighted' } });
    if (!direct.ok) throw direct.error;
    expect(triangleSet(mesh(tall, 'mesh/lamp'))).toEqual(triangleSet(direct.value.mesh));
    const top = (m: MeshAsset) => (m.aabb as ArrayLike<number>)[4] as number;
    expect(top(mesh(tall, 'mesh/lamp'))).toBeGreaterThan(top(mesh(lamp, 'mesh/lamp')) + 0.05);
  });

  it('(c) product reuse: readByGuid of upstream meshes, then lift()', {
    timeout: 120000,
  }, async () => {
    const { scanned, source } = await loadDirectory();
    const lampPack = source('lamp.pack.ts');
    const resolved = [...scanned.instances.values()].find((r) => r.root === lampPack);
    if (resolved === undefined) throw new Error('instance');
    const upstream = new Map<string, unknown>([
      [guid(LAMP_ID, 'mesh/lamp'), mesh(await build(lampPack, LAMP_ID, {}), 'mesh/lamp')],
      [
        guid(TALL_ID, 'mesh/lamp'),
        mesh(await build(lampPack, resolved.packageId, resolved.values), 'mesh/lamp'),
      ],
    ]);
    const pair = await build(source('lamp-pair.pack.ts'), PAIR_ID, {}, upstream);
    const product = mesh(pair, 'mesh/pair');
    const parts = [...upstream.values()] as MeshAsset[];
    const triangles = (m: MeshAsset) => (m.indices as ArrayLike<number>).length / 3;
    expect(triangles(product)).toBe(triangles(parts[0] as MeshAsset) + triangles(parts[1] as MeshAsset));
    expect(product.materialSlots.map((s) => s.slotName).sort()).toEqual(
      (parts[0] as MeshAsset).materialSlots.map((s) => s.slotName).sort(),
    );
    const box = product.aabb as ArrayLike<number>;
    expect((box[3] as number) - (box[0] as number)).toBeGreaterThan(0.4);
    await expect(build(source('lamp-pair.pack.ts'), PAIR_ID, {}, new Map())).rejects.toMatchObject({
      reads: [guid(LAMP_ID, 'mesh/lamp')],
    });
  });
});
