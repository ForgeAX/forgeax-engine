import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

// The Pack producer externalizes a scene output only through the Pack's declared
// sceneComponents, so a rig.finish() scene with an undeclared component builds under
// model.* captures yet fails every ordinary production (game build, package, View).
const examples = fileURLToPath(new URL('../', import.meta.url));
const packs = readdirSync(examples, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== '__tests__')
  .flatMap((dir) =>
    readdirSync(`${examples}${dir.name}`)
      .filter((file) => file.endsWith('.pack.ts'))
      .map((file) => `${dir.name}/${file}`),
  );

interface PackModule {
  readonly packageId: unknown;
  readonly parameters?: readonly { readonly name: string; readonly default: unknown }[];
  readonly sceneComponents?: readonly { readonly name: string }[];
  readonly build: (context: unknown) => unknown;
}

describe('example Packs', () => {
  it.each(packs)('%s declares every component its scene outputs use', { timeout: 300000 }, async (pack) => {
    const url = pathToFileURL(`${examples}${pack}`).href;
    const definition = (await import(/* @vite-ignore */ url)).default as PackModule;
    const result = (await definition.build({
      packageId: definition.packageId,
      values: Object.fromEntries((definition.parameters ?? []).map((p) => [p.name, p.default])),
      readByGuid: async () => ({ ok: false, error: { code: 'upstream-unavailable', expected: '', hint: '' } }),
    })) as { ok: boolean; value?: Record<string, { kind?: string }>; error?: { code: string } };
    // Only Packs that read other Packs' outputs may stop here; their outputs are no scenes.
    if (!result.ok) expect(result.error?.code).toBe('upstream-unavailable');
    const scenes = Object.values(result.value ?? {}).filter(
      (output): output is SceneAsset => output.kind === 'scene',
    );
    const used = new Set(
      scenes.flatMap((scene) => Object.values(scene.entities).flatMap((e) => Object.keys(e.components))),
    );
    const declared = new Set((definition.sceneComponents ?? []).map((c) => c.name));
    expect([...used].filter((name) => !declared.has(name))).toEqual([]);
  });
});
