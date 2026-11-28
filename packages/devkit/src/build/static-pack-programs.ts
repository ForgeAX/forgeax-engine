import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AuthoredRuntimePack } from '@forgeax/engine-app';
import { inventoryScriptablePackSource } from '@forgeax/engine-pack/source-node';
import { normalizePath } from 'vite';
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
  runtime?: {
    readonly packs: readonly AuthoredRuntimePack[];
    readonly generatedRoot: string;
    readonly localOnly?: true;
  },
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
  const localOnly = runtime?.localOnly === true;
  const { taskUrls, entries } = staticProgramEntries(programs, localOnly);
  return `import { createStaticPackProgramHost } from '@forgeax/engine/pack/runtime';
import imports from 'virtual:forgeax/pack-program-imports';
${taskUrls}
export { imports };
${authoredRuntimePackDeclarations(runtime?.packs ?? [])}
export const programHost = createStaticPackProgramHost(${entries}, imports);`;
}

export async function shippedBrowserPackProgramsSource(
  packs: readonly AuthoredRuntimePack[],
  generatedRoot: string,
): Promise<string> {
  const programs = await authoredStaticPackPrograms(packs, generatedRoot);
  const { taskUrls, entries } = staticProgramEntries(
    programs,
    false,
    (_program, index) => `authored[${index}].program.modules`,
  );
  return `${taskUrls}
const shippedPrograms = ${entries};`;
}

function staticProgramEntries(
  programs: readonly StaticProgramEntry[],
  localOnly: boolean,
  moduleExpression = (program: StaticProgramEntry, _index: number) =>
    JSON.stringify(program.modules),
) {
  const taskUrls = localOnly
    ? ''
    : programs
        .map(
          ({ path }, index) =>
            `import taskUrl${index} from ${JSON.stringify(staticPackTaskUrlSpecifier(path))};`,
        )
        .join('\n');
  const entries = programs.map((program, index) => {
    const { path, entry } = program;
    const locator = localOnly
      ? JSON.stringify(normalizePath(path))
      : `/* @vite-ignore */ taskUrl${index}`;
    const taskUrl = localOnly ? '' : `, taskUrl: () => taskUrl${index}`;
    return `{ entry: ${JSON.stringify(entry)}, modules: ${moduleExpression(program, index)}, load: async entry => { if (entry !== ${JSON.stringify(entry)}) throw new Error('Unknown static program entry'); return import(${locator}); }${taskUrl} }`;
  });
  return {
    taskUrls,
    entries: `[
${entries.join(',\n')}
]`,
  };
}
