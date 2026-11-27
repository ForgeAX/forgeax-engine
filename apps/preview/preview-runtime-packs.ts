import type { AuthoredRuntimePack } from '@forgeax/engine-app';
import { authoredRuntimePackImports, executionWorkerEntries } from '@forgeax/engine-devkit/plugin-build';
import type { Plugin } from 'vite';

const moduleId = 'virtual:forgeax/preview-runtime-packs';
const resolvedId = '\0' + moduleId;

export function previewRuntimePacks(
  packs: Readonly<Record<string, readonly AuthoredRuntimePack[]>> = {},
): Plugin[] {
  return [
    {
      name: 'forgeax:preview-runtime-packs',
      resolveId(id) {
        if (id === moduleId) return resolvedId;
      },
      load(id) {
        if (id === resolvedId) return `export default ${JSON.stringify(packs)};`;
      },
    },
    executionWorkerEntries(authoredRuntimePackImports(Object.values(packs).flat())),
  ];
}
