import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShaderManifestPublication } from '@forgeax/engine-shader';
import { normalizePath } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';
import { forgeaxShader } from '../index.js';

interface EmittedAsset {
  readonly type: 'asset';
  readonly fileName: string;
  readonly source: string;
}

interface Manifest {
  readonly entries: readonly { readonly hash: string; readonly wgsl: string }[];
  readonly materialShaders: readonly {
    readonly identifier: string;
    readonly sourcePath: string;
    readonly composedWgsl: string;
    readonly variants: readonly unknown[];
  }[];
}

interface PluginContext {
  readonly emitted: EmittedAsset[];
  emitFile(asset: EmittedAsset): string;
}

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const sourcePath = normalizePath(
  resolve(repoRoot, 'apps/hello/custom-shader/src/pulse-material.wgsl'),
);
const packagePath = resolve(
  repoRoot,
  'apps/hello/custom-shader/src/pulse-material.shader.pack.json',
);

function createContext(): PluginContext {
  const emitted: EmittedAsset[] = [];
  return {
    emitted,
    emitFile(asset) {
      emitted.push(asset);
      return asset.fileName;
    },
  };
}

async function latestManifest(context: PluginContext): Promise<Manifest> {
  const manifest = [...context.emitted]
    .reverse()
    .find((asset) => asset.fileName === 'shaders/manifest.json');
  if (manifest === undefined) throw new Error('shader manifest was not emitted');
  return (await readShaderManifestPublication(JSON.parse(manifest.source))) as Manifest;
}

function materialEntry(manifest: Manifest): Manifest['materialShaders'][number] {
  const entry = manifest.materialShaders.find(
    (candidate) => candidate.identifier === 'my-game::pulse-material',
  );
  if (entry === undefined) throw new Error('pulse material manifest row was not emitted');
  return entry;
}

function materialHash(manifest: Manifest): string {
  const composedWgsl = materialEntry(manifest).composedWgsl;
  const entry = manifest.entries.find((candidate) => candidate.wgsl === composedWgsl);
  if (entry === undefined) throw new Error('pulse material hash entry was not emitted');
  return entry.hash;
}

interface LkgScenario {
  readonly baseline: Manifest['materialShaders'][number];
  readonly baselineHash: string;
  readonly baselineManifest: Manifest;
  readonly failure: unknown;
  readonly finalEntry: Manifest['materialShaders'][number];
  readonly finalManifest: Manifest;
  readonly firstRepair: Manifest;
  readonly firstRepairEntry: Manifest['materialShaders'][number];
  readonly firstRepairHash: string;
  readonly retained: Manifest;
  readonly update: readonly { readonly file: string }[] | undefined;
}

async function runLkgScenario(): Promise<LkgScenario> {
  const source = await readFile(sourcePath, 'utf8');
  const plugin = forgeaxShader({ engineEntries: false, materialPackages: [packagePath] });
  const context = createContext();

  await plugin.transform.call(context as never, source, sourcePath);
  plugin.generateBundle.call(context as never);
  const baselineManifest = await latestManifest(context);
  const baseline = materialEntry(baselineManifest);
  const baselineHash = materialHash(baselineManifest);

  const invalid = source.replace(
    'let pulse_factor = sin(material.time * material.speed) * 0.25 + 0.75;',
    'let pulse_factor = ;',
  );
  let failure: unknown;
  try {
    await plugin.transform.call(context as never, invalid, sourcePath);
  } catch (error) {
    failure = error;
  }
  plugin.generateBundle.call(context as never);
  const retained = await latestManifest(context);

  const repaired = source.replace(
    'let pulse_factor = sin(material.time * material.speed) * 0.25 + 0.75;',
    'let pulse_factor = sin(material.time * material.speed) * 0.35 + 0.65;',
  );
  await plugin.transform.call(context as never, repaired, sourcePath);
  plugin.generateBundle.call(context as never);
  const firstRepair = await latestManifest(context);
  const firstRepairEntry = materialEntry(firstRepair);
  const firstRepairHash = materialHash(firstRepair);

  const secondRepair = repaired.replace('0.35 + 0.65', '0.45 + 0.55');
  await plugin.transform.call(context as never, secondRepair, sourcePath);
  plugin.generateBundle.call(context as never);
  const finalManifest = await latestManifest(context);
  const finalEntry = materialEntry(finalManifest);

  const sourceNode = { file: sourcePath };
  const update = plugin.handleHotUpdate({
    file: sourcePath.replace('pulse-material.wgsl', 'common.wgsl'),
    modules: [sourceNode],
    server: {
      moduleGraph: {
        getModulesByFile: (file: string) =>
          file === sourcePath ? new Set([sourceNode]) : new Set(),
      },
    },
  } as never) as readonly { readonly file: string }[] | undefined;

  return {
    baseline,
    baselineHash,
    baselineManifest,
    failure,
    finalEntry,
    finalManifest,
    firstRepair,
    firstRepairEntry,
    firstRepairHash,
    retained,
    update,
  };
}

describe('authored material shader HMR LKG transaction', () => {
  let scenario!: LkgScenario;

  beforeAll(async () => {
    scenario = await runLkgScenario();
  });

  it('retains the last-known-good material after an invalid edit', () => {
    expect(scenario.baseline.sourcePath).toBe(sourcePath);
    expect(scenario.baseline.variants).toHaveLength(2);
    expect(scenario.baselineManifest.entries).toHaveLength(1);
    expect(scenario.baselineManifest.materialShaders).toHaveLength(1);
    expect(scenario.failure).toMatchObject({
      code: 'shader-compile-failed',
      hint: expect.stringContaining('WGSL'),
      expected: 'WGSL source parses + validates against naga IR',
      lineNum: 48,
      linePos: 22,
      loc: { line: 48, column: expect.any(Number) },
      meta: {
        expected: 'WGSL source parses + validates against naga IR',
        hint: expect.stringContaining('WGSL'),
      },
    });
    expect(scenario.failure).toHaveProperty('loc.column');
    expect(materialEntry(scenario.retained).composedWgsl).toBe(scenario.baseline.composedWgsl);
    expect(materialHash(scenario.retained)).toBe(scenario.baselineHash);
    expect(scenario.retained.entries).toHaveLength(1);
    expect(scenario.retained.materialShaders).toHaveLength(1);
  });

  it('publishes each valid repair once after the LKG is retained', () => {
    expect(scenario.firstRepair.materialShaders).toHaveLength(1);
    expect(scenario.firstRepair.entries).toHaveLength(1);
    expect(scenario.firstRepairHash).not.toBe(scenario.baselineHash);
    expect(scenario.firstRepairEntry.composedWgsl).not.toBe(scenario.baseline.composedWgsl);
    expect(scenario.firstRepairEntry.composedWgsl).toContain('0.35');
    expect(scenario.finalManifest.materialShaders).toHaveLength(1);
    expect(scenario.finalManifest.entries).toHaveLength(1);
    expect(materialHash(scenario.finalManifest)).not.toBe(scenario.firstRepairHash);
    expect(scenario.finalEntry.composedWgsl).not.toBe(scenario.firstRepairEntry.composedWgsl);
    expect(scenario.finalEntry.composedWgsl).toContain('0.45');
  });

  it('invalidates material modules when an imported dependency changes', () => {
    expect(scenario.update?.map((node) => node.file)).toEqual([sourcePath]);
  });
});
