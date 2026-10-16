import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { type PluginModuleReference, validatePluginAssetSource } from '@forgeax/engine-pack/source';
import { err, ImportError, ok } from '@forgeax/engine-types';
import { producePluginAsset } from './plugin-asset-output.js';
import type { AssetOutputProducer } from './scriptable-pack.js';

function sourceRoot(sourcePath: string): string {
  for (let directory = dirname(sourcePath); ; directory = dirname(directory)) {
    if (
      existsSync(resolve(directory, 'forge.json')) ||
      existsSync(resolve(directory, 'package.json'))
    ) {
      return directory;
    }
    if (dirname(directory) === directory) {
      throw new TypeError('plugin source must belong to a project/package or supply projectRoot');
    }
  }
}

/** Source identity is independent of bytes, config, target and machine location. */
export function resolvePluginProgram(
  sourcePath: string,
  module: PluginModuleReference,
  projectRoot?: string,
): { readonly program: string; readonly module: string; readonly export: string } {
  const exportName = module.export ?? 'default';
  if (!module.specifier.startsWith('.')) {
    return {
      program: `npm:${module.specifier}#${encodeURIComponent(exportName)}`,
      module: module.specifier,
      export: exportName,
    };
  }
  const root = projectRoot ?? (isAbsolute(sourcePath) ? sourceRoot(sourcePath) : process.cwd());
  const path = resolve(dirname(resolve(root, sourcePath)), module.specifier);
  const local = relative(root, path).replaceAll('\\', '/');
  if (local === '..' || local.startsWith('../') || isAbsolute(local)) {
    throw new TypeError(
      'plugin source closure must stay inside its project; declare external packages as npm dependencies',
    );
  }
  return {
    program: `project:${local}#${encodeURIComponent(exportName)}`,
    module: path,
    export: exportName,
  };
}

export const pluginAssetOutputProducer: AssetOutputProducer = {
  kind: 'plugin',
  version: 'plugin-definition/1',
  produce(input) {
    const source = validatePluginAssetSource(input.asset);
    if (!source.ok)
      return err(
        new ImportError({
          code: 'import-internal-error',
          expected: source.error.expected,
          hint: source.error.hint,
          detail: {
            reason: `${input.sourceKey}: ${source.error.detail.path}: ${source.error.detail.reason}`,
          },
        }),
      );
    try {
      if (!input.sourcePath)
        throw new TypeError('plugin producer requires the original declaring sourcePath');
      const resolved = resolvePluginProgram(
        input.sourcePath,
        source.value.module,
        input.projectRoot,
      );
      const product = producePluginAsset(input, resolved.program);
      if (!product.ok) return product;
      return ok({
        ...product.value,
        sourceDependencies: resolved.program.startsWith('project:') ? [resolved.module] : [],
      });
    } catch (cause) {
      return err(
        new ImportError({
          code: 'import-internal-error',
          expected: 'a portable plugin module location within the declared source closure',
          hint: 'repair the module reference or project root and rebuild',
          detail: { reason: cause instanceof Error ? cause.message : String(cause) },
        }),
      );
    }
  },
};
