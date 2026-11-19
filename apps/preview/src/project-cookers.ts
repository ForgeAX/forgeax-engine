import { resolve } from 'node:path';
import { readProjectFacts } from '@forgeax/engine-devkit';
import { loadProjectCookers } from '@forgeax/engine-devkit/plugin-build';
import { normalizePath, type Plugin } from 'vite';

/** Preview's selected project keeps its authored build root and the session it owns. */
export async function loadPreviewProjectCookers(root: string, buildCacheRoot: string) {
  const facts = await readProjectFacts(root);
  if (!facts.ok) throw Object.assign(new Error(facts.error.expected), facts.error);
  const session = await loadProjectCookers(facts.value, [], {}, { buildCacheRoot });
  const plugin: Plugin = {
    name: 'forgeax:preview-project-cookers',
    configResolved(config) {
      // Vite restarts this configuration when the captured build closure changes.
      config.configFileDependencies.push(
        ...[...session.watchFiles, resolve(root, 'forge.json'), resolve(root, 'package.json')].map(
          (path) => normalizePath(resolve(path)),
        ),
      );
    },
    async buildEnd(error) {
      if (error) await session.dispose().catch(() => undefined);
    },
    closeBundle() {
      return session.dispose();
    },
  };
  return { session, plugin };
}
