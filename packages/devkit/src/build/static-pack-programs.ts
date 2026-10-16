import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { inventoryScriptablePackSource } from '@forgeax/engine-pack/source-node';
import type { ProjectFacts } from '../types.js';
import { type PluginSourceInventory, pluginAssetClosure } from './plugin-assets.js';

/** Compile the declared runtime programs into the target's native module graph. */
export async function staticPackProgramsSource(
  facts: ProjectFacts,
  inventory: PluginSourceInventory,
): Promise<string> {
  const records = [
    ...pluginAssetClosure(inventory, facts.roots.engine),
    ...pluginAssetClosure(inventory, facts.roots.frontend),
  ];
  const programPaths = [
    ...new Set(
      (
        await Promise.all(
          records
            .filter((record) => inventory.sourceInputs.has(record.module))
            .map(async (record) =>
              (await inventoryScriptablePackSource(record.module)).map((entry) => entry.path),
            ),
        )
      )
        .flat()
        .filter((path) => path.endsWith('.program.mjs')),
    ),
  ].sort();
  const programSources = await Promise.all(
    programPaths.map(async (path) => readFile(path, 'utf8')),
  );
  return `import { createStaticPackProgramHost } from '@forgeax/engine/pack/runtime';
import imports from 'virtual:forgeax/pack-program-imports';
export { imports };
export const programHost = createStaticPackProgramHost([
${programPaths.map((path, index) => `{ modules: ${JSON.stringify({ [basename(path)]: programSources[index] })}, load: async entry => { if (entry !== ${JSON.stringify(basename(path))}) throw new Error('Unknown static program entry'); return import(${JSON.stringify(path)}); } }`).join(',\n')}
], imports);`;
}
