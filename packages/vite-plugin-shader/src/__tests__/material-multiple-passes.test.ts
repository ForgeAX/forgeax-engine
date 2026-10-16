import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as naga from '@forgeax/engine-naga';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { forgeaxShader } from '../index.js';

function shader(module: string, factor: number): string {
  return `#define_import_path ${module}
#import forgeax_material::parameters::{material}
@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
@fragment fn fs_main() -> @location(0) vec4<f32> { return material.tint * ${factor}.0; }
@fragment fn fs_second() -> @location(0) vec4<f32> { return material.tint * 0.5; }
`;
}

interface MaterialManifest {
  entries: Array<{ hash: string; wgsl: string }>;
  materialShaders: Array<{ identifier: string; composedWgsl: string }>;
}

interface MultiPassScenario {
  root: string;
  baseline: MaterialManifest;
  baselineCompositions: number;
  transformedCode: string | undefined;
  invalidPassError: unknown;
  retainedAfterInvalidPass: MaterialManifest;
  crossPassError: unknown;
  retainedAfterCrossPassFailure: MaterialManifest;
  repaired: MaterialManifest;
}

async function runMultiPassScenario(): Promise<MultiPassScenario> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-vite-material-passes-'));
  try {
    const firstPath = join(root, 'first.wgsl');
    const secondPath = join(root, 'second.wgsl');
    const packPath = join(root, 'material.pack.json');
    const first = shader('game::first', 1);
    const second = shader('game::second', 2);
    await writeFile(firstPath, first);
    await writeFile(secondPath, second);
    await writeFile(
      packPath,
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: 'b28aa8f3-af10-44b4-8c8b-526b6c17cd76',
            kind: 'material',
            execution: 'cooked',
            sourceKey: 'first.wgsl',
            refs: [],
            payload: {
              kind: 'material',
              parameters: [{ name: 'tint', type: 'color' }],
              passes: [
                { name: 'Forward', program: { module: 'game::first', fragmentEntry: 'fs_main' } },
                {
                  name: 'Overlay',
                  program: { module: 'game::second', fragmentEntry: 'fs_main' },
                },
                {
                  name: 'Outline',
                  program: { module: 'game::second', fragmentEntry: 'fs_second' },
                },
              ],
            },
          },
        ],
      }),
    );
    const emitted: Array<{ fileName: string; source: string }> = [];
    const ctx = {
      emitFile(asset: { fileName: string; source: string }) {
        emitted.push(asset);
        return asset.fileName;
      },
    };
    const plugin = forgeaxShader({ engineEntries: false, materialPackages: [packPath] });
    const manifest = (): MaterialManifest => {
      plugin.generateBundle.call(ctx as never);
      const output = emitted.filter((asset) => asset.fileName === 'shaders/manifest.json').at(-1);
      if (output === undefined) throw new Error('missing shader manifest');
      return JSON.parse(output.source) as MaterialManifest;
    };

    const compose = vi.spyOn(naga, 'composeShader');
    let baselineCompositions = 0;
    try {
      await plugin.buildStart.call(ctx as never);
      baselineCompositions = compose.mock.calls.length;
    } finally {
      compose.mockRestore();
    }
    const baseline = manifest();
    const transformed = await plugin.transform.call(ctx as never, second, secondPath);
    const invalid = second.replace('return material.tint * 2.0;', 'return ;');
    let invalidPassError: unknown;
    try {
      await plugin.transform.call(ctx as never, invalid, secondPath);
    } catch (error) {
      invalidPassError = error;
    }
    const retainedAfterInvalidPass = manifest();

    // A transform of the first source must validate the other Pass too.
    await writeFile(secondPath, invalid);
    let crossPassError: unknown;
    try {
      await plugin.transform.call(ctx as never, first.replace('* 1.0', '* 3.0'), firstPath);
    } catch (error) {
      crossPassError = error;
    }
    const retainedAfterCrossPassFailure = manifest();

    await writeFile(secondPath, shader('game::second', 4));
    await plugin.transform.call(ctx as never, first, firstPath);
    const repaired = manifest();

    return {
      root,
      baseline,
      baselineCompositions,
      transformedCode: transformed?.code,
      invalidPassError,
      retainedAfterInvalidPass,
      crossPassError,
      retainedAfterCrossPassFailure,
      repaired,
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

describe('authored multi-pass Vite material publication', () => {
  let scenario!: MultiPassScenario;

  beforeAll(async () => {
    scenario = await runMultiPassScenario();
  });

  afterAll(async () => {
    await rm(scenario.root, { recursive: true, force: true });
  });

  it('publishes each module once while deduplicating shared entries', () => {
    expect(scenario.baselineCompositions).toBe(2);
    expect(scenario.baseline.materialShaders.map((row) => row.identifier)).toEqual([
      'game::first',
      'game::second',
    ]);
    expect(scenario.baseline.entries).toHaveLength(2);
    expect(new Set(scenario.baseline.entries.map((row) => row.hash)).size).toBe(2);
    expect(scenario.transformedCode).toContain('fs_second');
    expect(scenario.transformedCode).toContain('MaterialParameters');
  });

  it('retains the complete last-known-good generation after any pass fails', () => {
    expect(scenario.invalidPassError).toBeDefined();
    expect(scenario.crossPassError).toBeDefined();
    expect(scenario.retainedAfterInvalidPass).toEqual(scenario.baseline);
    expect(scenario.retainedAfterCrossPassFailure).toEqual(scenario.baseline);
  });

  it('publishes a repaired generation after all passes become valid again', () => {
    expect(scenario.repaired.entries).toHaveLength(2);
    expect(scenario.repaired.materialShaders[0]).toEqual(scenario.baseline.materialShaders[0]);
    expect(scenario.repaired.materialShaders[1]).not.toEqual(scenario.baseline.materialShaders[1]);
  });
});
