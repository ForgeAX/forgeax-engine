import { build } from 'esbuild';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
export const assetReferenceProgramEntry = resolve(root, 'packages/view-plugin-asset-references/src/runtime/program.ts');
const query = resolve(root, 'packages/view-plugin-asset-references/src/runtime/query.ts');
export async function compiledAssetReferenceProgram() {
  const core = resolve(root, 'packages/view-workspace-core/src/asset-references.ts');
  const result = await build({ entryPoints: [query], absWorkingDir: root, bundle: true, write: false,
    format: 'esm', platform: 'browser', target: 'es2022',
    alias: { '@forgeax/view-workspace-core/asset-references': core },
    external: ['@forgeax/engine/plugin', '@forgeax/engine/ecs', '@forgeax/engine/types', '@forgeax/engine/pack/source'],
  });
  return result.outputFiles[0].text;
}
export async function assetReferenceProgramModule() {
  return `export default function assetReferenceProgram() { return ${JSON.stringify(await compiledAssetReferenceProgram())}; }`;
}
export const assetReferenceVitePlugin = {
  name: 'view-asset-reference-program', enforce: 'pre',
  async load(id) { if (id === assetReferenceProgramEntry) {
    this.addWatchFile(query);
    this.addWatchFile(resolve(root, 'packages/view-workspace-core/src/asset-references.ts'));
    return assetReferenceProgramModule();
  } },
};
export const assetReferenceEsbuildPlugin = {
  name: 'view-asset-reference-program',
  setup(context) {
    context.onLoad({ filter: /view-plugin-asset-references\/src\/runtime\/program\.ts$/ }, async () => ({
      contents: await assetReferenceProgramModule(), loader: 'js', watchFiles: [query],
    }));
  },
};
