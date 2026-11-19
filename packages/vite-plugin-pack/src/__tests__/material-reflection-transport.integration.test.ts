import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { produceScriptablePackProducts } from '@forgeax/engine-import';
import {
  type CookedMaterialRecord,
  validateCookedMaterialRecord,
} from '@forgeax/engine-pack/material-cook';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { afterAll, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => {
  const workers = process.env.FORGEAX_SHADER_COMPILE_WORKERS;
  // Keep compilation in this realm so the simulated preceding native version
  // changes only optional reflection facts, never the actual WGSL or bindings.
  process.env.FORGEAX_SHADER_COMPILE_WORKERS = '1';
  return { legacy: true, workers };
});
vi.mock('@forgeax/engine-naga', async (original) => {
  const actual = await original<typeof import('@forgeax/engine-naga')>();
  return {
    ...actual,
    async getCompilerFingerprint() {
      const fingerprint = (await actual.getCompilerFingerprint()).unwrap();
      return ok(`${fingerprint}:${native.legacy ? 'legacy' : 'current'}`);
    },
    parseReflectionWire(json: string) {
      const wire = actual.parseReflectionWire(json);
      if (!native.legacy || wire.entryPoints === undefined) return wire;
      return {
        ...wire,
        entryPoints: wire.entryPoints.map(({ effects: _, ...entry }) => entry),
      };
    },
  };
});
afterAll(() => {
  if (native.workers === undefined) delete process.env.FORGEAX_SHADER_COMPILE_WORKERS;
  else process.env.FORGEAX_SHADER_COMPILE_WORKERS = native.workers;
});

it('replaces cached Pack metadata when native reflection changes without changing authored or shader bytes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-reflection-transport-')));
  const sourcePath = join(root, 'material.pack.ts');
  const sourceText = 'unchanged author source';
  try {
    await writeFile(sourcePath, sourceText);
    await writeFile(
      join(root, 'surface.wgsl'),
      `#define_import_path game::reflection_transport
@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0., 0., 0., 1.); }
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.); }
`,
    );
    const source = {
      sourcePath,
      displaySourcePath: 'material.pack.ts',
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: definePackageId('01900000-0000-7000-8000-000000008112'),
        build: () =>
          ok({
            material: {
              kind: 'material' as const,
              passes: [{ name: 'Forward', program: { module: 'game::reflection_transport' } }],
            },
          }),
      }),
      sourceClosure: [
        {
          path: sourcePath,
          digest: `sha256:${createHash('sha256').update(sourceText).digest('hex')}`,
        },
      ],
      publicationGeneration: 1,
      transportIdentity: 'reflection-transport/1',
      policy: () => ({
        base: '/',
        packagePath: 'material.pack.json',
        artifactPath: (guid: string, key: string) => `${guid}/${key}`,
      }),
    };
    const newCompiler = async () =>
      (await import('@forgeax/engine-shader-compiler')).createMaterialPackCooker([root]);
    let cooker = await newCompiler();
    const run = async () => {
      const prepared = (
        await produceScriptablePackProducts({
          sources: [source],
          buildCacheRoot: join(root, 'cache'),
          cacheIdentityRoot: root,
          cookers: [cooker],
        })
      )
        .unwrap()
        .get(source.displaySourcePath);
      if (prepared === undefined) throw new Error('Missing material publication');
      return prepared;
    };
    const record = (asset: { payload: unknown } | undefined) =>
      (asset?.payload as { cooked: CookedMaterialRecord }).cooked;
    const entries = (value: ReturnType<typeof record>) =>
      value.programs
        .flatMap((program) =>
          program.selections.flatMap((selection) => selection.abi.entryPoints ?? []),
        )
        .filter((entry) => entry.stage === 'fragment');
    native.legacy = true;
    const first = await run();
    const old = record(first.finalized.pack.assets[0]);
    expect(entries(old).length).toBeGreaterThan(0);
    expect(entries(old).every((entry) => entry.effects === undefined)).toBe(true);
    native.legacy = false;
    // A dependency update replaces the producer process and its in-memory compiler.
    // Keep both disk DDC layers intact, as an ordinary dev reload does.
    vi.resetModules();
    cooker = await newCompiler();
    const second = await run();
    const fresh = validateCookedMaterialRecord(record(second.product.product.assets[0])).unwrap();
    expect(fresh.programs.map((program) => program.artifact.digest)).toEqual(
      old.programs.map((program) => program.artifact.digest),
    );
    expect(entries(fresh).every((entry) => entry.effects !== undefined)).toBe(true);
    // A current product must never be hidden by an older transport cache hit.
    expect(
      record(second.finalized.pack.assets[0]).programs.map((program) => program.selections),
    ).toEqual(fresh.programs.map((program) => program.selections));
    expect(second.finalized.digest).not.toBe(first.finalized.digest);
    expect((await run()).finalized).toEqual(second.finalized);
  } finally {
    native.legacy = false;
    await rm(root, { recursive: true, force: true });
  }
});
