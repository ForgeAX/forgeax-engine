import { resolve } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import type { ScanSourceDeclaration } from '@forgeax/engine-pack/scanner';
import { parsePackSourceJson, projectDirectPackJson } from '@forgeax/engine-pack/source';
import type {
  Asset,
  AssetGuid as AssetGuidType,
  ImportContext,
  Importer,
} from '@forgeax/engine-types';
import { ImportError } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { ImporterRegistry } from '../importer-registry.js';
import {
  canonicalScriptableSourcePath,
  createDeclaredPackAssetSnapshotSource,
  declaredPackExternalOutputs,
  prepareDirectPackTransport,
  prepareLegacyPackTransport,
} from '../scriptable-pack-host.js';

const GUID = '019ffa97-0000-7000-8000-000000000001';

describe('ScriptablePack source locator', () => {
  it.each([
    [
      'assets/3d/ea-3d/id/id/assets/packs/structured/crate.pack.ts',
      'assets/3d/ea-3d/id/id/assets/packs/structured/crate.pack.ts',
    ],
    ['/project/assets/packs/crate.pack.ts', 'assets/packs/crate.pack.ts'],
    ['C:\\project\\assets\\packs\\crate.pack.ts', 'assets/packs/crate.pack.ts'],
  ])('keeps the logical locator for %s', (source, expected) => {
    expect(canonicalScriptableSourcePath(source)).toBe(expected);
  });
});

function parseGuid(value: string): AssetGuidType {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

describe('ScriptablePack external Meta staging', () => {
  it('preserves source validation diagnostics through external staging', async () => {
    const failure = new ImportError({
      code: 'source-validation-failed',
      expected: 'valid source',
      hint: 'repair the source',
      detail: {
        diagnostics: [
          {
            code: 'fixture-invalid',
            severity: 'error',
            sourcePath: 'model.bin',
            sourceRange: { start: 0, end: 1, line: 1, column: 1 },
            rule: 'fixture-rule',
            expected: 'valid source',
            actual: 'invalid',
            hint: 'repair source',
          },
        ],
      },
    });
    const registry = new ImporterRegistry();
    registry.register({ key: 'fixture', import: async () => ({ ok: false, error: failure }) });
    const declaration = {
      format: 'meta.json',
      sourcePath: '/project/assets/model.bin.meta.json',
      sourceRevision: 'sha256:meta',
      value: {
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'fixture',
        source: 'model.bin',
        importSettings: {},
        subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'mesh' }],
      },
    } satisfies Extract<ScanSourceDeclaration, { readonly format: 'meta.json' }>;
    await expect(
      declaredPackExternalOutputs(
        new Map([[declaration.sourcePath, declaration]]),
        [],
        [parseGuid(GUID)],
        {
          importerRegistry: registry,
          fsForImport: {
            readSource: async () => ({ ok: true as const, value: new Uint8Array([1]) }),
          },
        },
      ),
    ).rejects.toBe(failure);
  });

  it('imports ordinary Meta dependencies into the current staged generation', async () => {
    const importer: Importer = {
      key: 'fixture',
      import: async (ctx: ImportContext) => ({
        ok: true,
        value: {
          assets: [
            {
              guid: ctx.subAssets[0]?.guid ?? GUID,
              kind: 'mesh',
              payload: {
                kind: 'mesh',
                vertices: new Float32Array([0, 1, 2]),
                attributes: {},
                submeshes: [],
                materialSlots: [],
              } satisfies Asset,
              refs: [],
              artifacts: {},
            },
          ],
          sourceDependencies: [],
        },
      }),
    };
    const registry = new ImporterRegistry();
    registry.register(importer);
    const declaration = {
      format: 'meta.json',
      sourcePath: '/project/assets/model.bin.meta.json',
      sourceRevision: 'sha256:meta',
      value: {
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'fixture',
        source: 'model.bin',
        importSettings: {},
        subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'mesh' }],
      },
    } satisfies Extract<ScanSourceDeclaration, { readonly format: 'meta.json' }>;

    const outputs = await declaredPackExternalOutputs(
      new Map([[declaration.sourcePath, declaration]]),
      [],
      [parseGuid(GUID)],
      {
        importerRegistry: registry,
        fsForImport: {
          readSource: async () => ({ ok: true as const, value: new Uint8Array([1, 2, 3]) }),
        },
      },
    );

    expect(outputs).toHaveLength(1);
    const output = outputs[0];
    expect(output).toBeDefined();
    if (output === undefined) return;
    expect(AssetGuid.format(output.guid)).toBe(GUID);
    expect(output.asset).toMatchObject({ kind: 'mesh' });
    expect(Array.from((output.asset as Asset & { vertices: Float32Array }).vertices)).toEqual([
      0, 1, 2,
    ]);
    const lazy = createDeclaredPackAssetSnapshotSource(
      new Map([[declaration.sourcePath, declaration]]),
      [],
      [parseGuid(GUID)],
      {
        importerRegistry: registry,
        fsForImport: {
          readSource: async () => ({ ok: true as const, value: new Uint8Array([1, 2, 3]) }),
        },
      },
    );
    expect((await lazy.readByGuid(parseGuid(GUID))).unwrap()).toEqual({
      asset: output.asset,
      generation: 1,
      digest: 'sha256:staged',
    });
  });

  it('cooks direct producer-backed outputs before exposing them to a dynamic Pack', async () => {
    const packageId = PackageId.parse('019ffa97-0000-7000-8000-000000000010');
    if (!packageId.ok) throw packageId.error;
    const outputGuid = AssetGuid.format(AssetGuid.derive(packageId.value, 'vfx/main'));
    const materialGuid = '019ffa97-0000-7000-8000-000000000099';
    const source = {
      schemaVersion: '3.0.0',
      packageId: PackageId.format(packageId.value),
      assets: {
        'vfx/main': {
          kind: 'particle-effect',
          payload: {
            schemaVersion: 3,
            emitters: [
              {
                id: 'main',
                program: { module: 'main.vfx.wgsl' },
                renderers: [],
              },
            ],
          },
          refs: [materialGuid],
        },
      },
    };
    let cookCalls = 0;
    const cooker: NativeCooker = {
      key: 'particle-effect',
      cook(input) {
        cookCalls += 1;
        const source = input as { readonly guid: string };
        return {
          guid: source.guid,
          payload: {
            kind: 'particle-effect',
            schemaVersion: 3,
            programFingerprint: 'sha256:cooked',
            emitters: [],
            program: {
              format: 'forgeax-vfx-program-4',
              fingerprint: 'sha256:cooked',
              emitters: [],
            },
          },
          refs: [materialGuid],
          artifacts: {
            'particle-effect/program.json': {
              mediaType: 'application/json',
              bytes: new TextEncoder().encode('{"program":"cooked"}'),
            },
          },
          inputFingerprint: 'sha256:cooked',
        };
      },
    };
    const declaration = {
      format: 'pack.json',
      sourcePath: resolve(process.cwd(), 'src/__tests__/scriptable-pack-host.unit.test.ts'),
      sourceRevision: 'sha256:direct',
      sourceText: JSON.stringify(source),
      value: parsePackSourceJson(source).unwrap(),
    } satisfies Extract<ScanSourceDeclaration, { readonly format: 'pack.json' }>;

    const outputs = await declaredPackExternalOutputs(
      new Map([[declaration.sourcePath, declaration]]),
      [cooker],
      [parseGuid(outputGuid), parseGuid(materialGuid)],
    );

    expect(cookCalls).toBe(1);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      sourceKey: 'vfx/main',
      asset: {
        kind: 'particle-effect',
        programFingerprint: 'sha256:cooked',
        program: { format: 'forgeax-vfx-program-4' },
      },
    });
    cookCalls = 0;
    const lazy = createDeclaredPackAssetSnapshotSource(
      new Map([[declaration.sourcePath, declaration]]),
      [cooker],
      [parseGuid(outputGuid), parseGuid(materialGuid)],
    );
    expect(cookCalls).toBe(0);
    const [first, second] = await Promise.all([
      lazy.readByGuid(parseGuid(outputGuid)),
      lazy.readByGuid(parseGuid(outputGuid)),
    ]);
    expect(cookCalls).toBe(1);
    expect(first.unwrap()).toEqual({
      asset: outputs[0]?.asset,
      generation: 1,
      digest: 'sha256:staged',
    });
    expect(second.unwrap()).toEqual(first.unwrap());
    expect(second.unwrap().asset).not.toBe(first.unwrap().asset);
  });

  it('retries a failed external owner and isolates concurrent sibling snapshots', async () => {
    const siblingGuid = '019ffa97-0000-7000-8000-000000000002';
    const declaration = {
      format: 'pack.json',
      sourcePath: '/project/effects.pack.json',
      sourceRevision: 'sha256:effects',
      sourceText: '',
      value: {
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [GUID, siblingGuid].map((guid) => ({
          guid,
          kind: 'test-effect',
          execution: 'cooked',
          payload: {},
          refs: [],
          artifacts: {},
        })),
      },
    } satisfies Extract<ScanSourceDeclaration, { readonly format: 'pack.json' }>;
    let broken = true;
    let calls = 0;
    const cooker: NativeCooker = {
      key: 'test-effect',
      cook(input) {
        calls++;
        if (broken) throw new Error('repairable external producer');
        return {
          guid: (input as { readonly guid: string }).guid,
          payload: { values: [1, 2] },
          refs: [],
          artifacts: {},
          inputFingerprint: 'sha256:effects',
        };
      },
    };
    const lazy = createDeclaredPackAssetSnapshotSource(
      new Map([[declaration.sourcePath, declaration]]),
      [cooker],
      [parseGuid(GUID), parseGuid(siblingGuid)],
    );
    expect(calls).toBe(0);
    expect(await lazy.readByGuid(parseGuid(GUID))).toMatchObject({
      ok: false,
      error: { code: 'native-cook-failed' },
    });
    expect(calls).toBe(1);
    broken = false;
    const [first, sibling] = await Promise.all([
      lazy.readByGuid(parseGuid(GUID)),
      lazy.readByGuid(parseGuid(siblingGuid)),
    ]);
    expect(calls).toBe(3);
    expect(sibling.unwrap()).toEqual(first.unwrap());
    expect(first.unwrap()).toMatchObject({ generation: 1, digest: 'sha256:staged' });
    (first.unwrap().asset as unknown as { values: number[] }).values[0] = 99;
    expect((await lazy.readByGuid(parseGuid(GUID))).unwrap().asset).toEqual({
      kind: 'test-effect',
      values: [1, 2],
    });
    expect(sibling.unwrap().asset).toEqual({ kind: 'test-effect', values: [1, 2] });
    expect(await lazy.readByGuid(parseGuid('019ffa97-0000-7000-8000-000000000003'))).toMatchObject({
      ok: false,
      error: { code: 'asset-not-found' },
    });
    const fresh = createDeclaredPackAssetSnapshotSource(
      new Map([[declaration.sourcePath, declaration]]),
      [cooker],
      [parseGuid(GUID), parseGuid(siblingGuid)],
    );
    expect((await fresh.readByGuid(parseGuid(GUID))).ok).toBe(true);
    expect(calls).toBe(5);
  });

  it('keeps a direct non-Engine POD as direct transport', async () => {
    const packageId = PackageId.parse('019ffa97-0000-0000-8000-000000000010');
    if (!packageId.ok) throw packageId.error;
    const outputGuid = AssetGuid.format(AssetGuid.derive(packageId.value, 'ui/main'));
    const source = {
      schemaVersion: '3.0.0',
      packageId: PackageId.format(packageId.value),
      assets: {
        'ui/main': {
          kind: 'ui',
          payload: { html: '<main>direct</main>', css: ':host{display:block}' },
          refs: [],
        },
      },
    };
    const declaration = {
      format: 'pack.json',
      sourcePath: resolve(process.cwd(), 'src/__tests__/scriptable-pack-host.unit.test.ts'),
      sourceRevision: 'sha256:ui',
      sourceText: JSON.stringify(source),
      value: parsePackSourceJson(source).unwrap(),
    } satisfies Extract<ScanSourceDeclaration, { readonly format: 'pack.json' }>;

    const outputs = await declaredPackExternalOutputs(
      new Map([[declaration.sourcePath, declaration]]),
      [],
      [parseGuid(outputGuid)],
    );

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.asset).toEqual({
      kind: 'ui',
      guid: outputGuid,
      html: '<main>direct</main>',
      css: ':host{display:block}',
    });
  });

  it.each([
    false,
    true,
  ])('uses the registered cooker for direct Engine material authoring (registered=%s)', async (registered) => {
    const packageId = PackageId.parse('019ffa97-0000-0000-8000-000000000011');
    if (!packageId.ok) throw packageId.error;
    const value = {
      schemaVersion: '3.0.0' as const,
      packageId: PackageId.format(packageId.value),
      assets: {
        'material/base': {
          kind: 'material',
          payload: {
            passes: [
              { name: 'Forward', program: { module: 'forgeax::default-unlit' } },
              { name: 'ShadowCaster', program: { module: 'forgeax::default-shadow-caster' } },
            ],
            values: { baseColor: [0.6, 0.6, 0.6, 1] },
          },
          refs: [],
        },
      },
    };
    const parsed = parsePackSourceJson(value);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.format !== 'direct') return;
    const projected = projectDirectPackJson(parsed.value);
    let cookCalls = 0;
    const sourcePath = resolve(process.cwd(), 'src/__tests__/scriptable-pack-host.unit.test.ts');
    const result = await prepareDirectPackTransport({
      projected,
      sourcePath,
      sourceRevision: 'sha256:direct-engine-material',
      cookers: registered
        ? [
            {
              key: 'material',
              cook(input: { readonly guid: string; readonly source: unknown }) {
                cookCalls += 1;
                return {
                  guid: input.guid,
                  payload: input.source,
                  refs: [],
                  artifacts: {},
                  inputFingerprint: 'sha256:engine-material-cooked',
                };
              },
            } satisfies NativeCooker,
          ]
        : [],
      policy: {
        base: '/',
        packagePath: 'assets/base-material.pack.json',
        artifactPath: (guid, key) => `${guid}/${key}.bin`,
      },
    });

    expect(result.ok).toBe(true);
    expect(cookCalls).toBe(registered ? 1 : 0);
    if (!result.ok) return;
    expect(result.value.finalized.pack.assets).toMatchObject([
      {
        kind: 'material',
        payload: {
          passes: [
            { program: { module: 'forgeax::default-unlit' } },
            { program: { module: 'forgeax::default-shadow-caster' } },
          ],
        },
        artifacts: {},
      },
    ]);
  });

  it('publishes already-cooked Engine-owned materials from legacy Pack v2', async () => {
    const guid = '019ffa97-0000-0000-8000-000000000012';
    const result = await prepareLegacyPackTransport(
      {
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid,
            kind: 'material',
            sourceKey: 'shaders/rusted-iron.wgsl',
            execution: 'cooked',
            payload: {
              kind: 'material',
              passes: [
                {
                  name: 'forward',
                  program: {
                    module: 'forgeax::default-standard-pbr',
                    fragmentEntry: 'fs_main',
                  },
                  renderState: { tags: { LightMode: 'Forward' } },
                },
              ],
              parameters: [{ name: 'noiseScale', type: 'f32' }],
              values: { noiseScale: 1.85 },
            },
            refs: [],
          },
        ],
      },
      [],
      (assetGuid) => ({
        base: '/',
        packagePath: `/__forgeax-ddc/${assetGuid}.pack.json`,
        artifactPath: (childGuid, key) => `${childGuid}/${key}.bin`,
      }),
    );

    expect(result.firstGuid).toBe(guid);
    expect(result.cooked?.refsByGuid.get(guid)).toEqual([]);
    expect(result.finalized?.packageUrl).toBe(`/__forgeax-ddc/${guid}.pack.json`);
    expect(result.finalized?.pack.assets[0]?.payload).toMatchObject({
      passes: [{ program: { module: 'forgeax::default-standard-pbr' } }],
    });
  });
});

it('preserves explicit direct JSON plugin outputs through the synthetic Pack definition', async () => {
  const parsed = parsePackSourceJson({
    schemaVersion: '3.0.0',
    packageId: '01900000-0000-7000-8000-000000000079',
    assets: {
      'plugin/main': { kind: 'plugin', payload: { module: { specifier: '@fixture/runtime' } } },
    },
  }).unwrap();
  if (parsed.format !== 'direct') throw new Error('Expected direct Pack');
  const result = await prepareDirectPackTransport({
    projected: projectDirectPackJson(parsed),
    sourcePath: resolve(process.cwd(), 'src/__tests__/plugin.pack.json'),
    sourceRevision: 'sha256:direct-plugin',
    policy: {
      base: '/',
      packagePath: 'assets/plugin.pack.json',
      artifactPath: (guid, key) => `${guid}/${key}.bin`,
    },
  });
  expect(result).toMatchObject({ ok: true });
  if (result.ok) expect(result.value.finalized.pack.assets).toMatchObject([{ kind: 'plugin' }]);
});
