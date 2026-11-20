import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AuthoredRuntimePack } from '@forgeax/engine-app';
import { inventoryScriptablePackSource } from '@forgeax/engine-pack/source-node';
import type { ProjectFacts } from '../types.js';
import {
  authoredRuntimePackDeclarations,
  authoredStaticPackPrograms,
  type StaticProgramEntry,
} from './authored-runtime-packs.js';
import { staticPackTaskUrlSpecifier } from './execution-workers.js';
import { type PluginSourceInventory, pluginAssetClosure } from './plugin-assets.js';

/** Compile the declared runtime programs into the target's native module graph. */
export async function staticPackProgramsSource(
  facts: ProjectFacts,
  inventory: PluginSourceInventory,
  runtime?: { readonly packs: readonly AuthoredRuntimePack[]; readonly generatedRoot: string },
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
  const programs: StaticProgramEntry[] = await Promise.all(
    programPaths.map(async (path) => {
      const entry = basename(path);
      return { path, entry, modules: { [entry]: await readFile(path, 'utf8') } };
    }),
  );
  if (runtime !== undefined)
    programs.push(...(await authoredStaticPackPrograms(runtime.packs, runtime.generatedRoot)));
  return `import { createStaticPackProgramHost } from '@forgeax/engine/pack/runtime';
import imports from 'virtual:forgeax/pack-program-imports';
${programs.map(({ path }, index) => `import taskUrl${index} from ${JSON.stringify(staticPackTaskUrlSpecifier(path))};`).join('\n')}
export { imports };
${authoredRuntimePackDeclarations(runtime?.packs ?? [])}
export const programHost = createStaticPackProgramHost([
${programs.map(({ entry, modules }, index) => `{ modules: ${JSON.stringify(modules)}, load: async entry => { if (entry !== ${JSON.stringify(entry)}) throw new Error('Unknown static program entry'); return import(/* @vite-ignore */ taskUrl${index}); }, taskUrl: () => taskUrl${index} }`).join(',\n')}
], imports);`;
}
