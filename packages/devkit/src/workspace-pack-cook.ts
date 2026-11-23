import {
  assembleRuntimePackContent,
  buildScriptablePack,
  createStandardAssetOutputProducerRegistry,
  projectImportProductForBuild,
  type RuntimePackContent,
  stageRuntimePackOutput,
} from '@forgeax/engine-import';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import {
  AssetGuid,
  type DirectPackJson,
  definePackageId,
  type PackOutputMap,
  projectScriptablePackSceneComponents,
  type ScriptablePackSceneComponentInput,
} from '@forgeax/engine-pack/source';
import { ok, sha256 } from '@forgeax/engine-types';
import type { Plugin } from 'vite';

export interface WorkspacePackCookInput {
  readonly packageId: string;
  readonly sourcePath: string;
  readonly outputs: PackOutputMap;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly sceneComponents?: readonly ScriptablePackSceneComponentInput[];
  readonly signal: AbortSignal;
}

export type WorkspacePackCookPlugin = Plugin & {
  prepareContent(input: WorkspacePackCookInput): Promise<RuntimePackContent>;
};

/** The serving project's cooker session also prepares unsaved authoring candidates. */
export function workspacePackCookPlugin(cookers: readonly NativeCooker[]): WorkspacePackCookPlugin {
  return {
    name: 'forgeax:workspace-pack-cook',
    async prepareContent(input) {
      input.signal.throwIfAborted();
      for (const [sourceKey, output] of Object.entries(input.outputs)) {
        if (output.kind === 'plugin')
          throw {
            code: 'pack-source-output-invalid',
            expected: 'a prepared plugin program closure before adopting a mixed cooked draft',
            hint: 'prepare and retain plugin programs before previewing this Pack',
            detail: { sourcePath: input.sourcePath, sourceKey },
          };
      }
      const product = (
        await buildScriptablePack({
          definition: {
            schemaVersion: '2.0.0',
            packageId: definePackageId(input.packageId),
            ...(input.sceneComponents ? { sceneComponents: input.sceneComponents } : {}),
            build: () => ok(input.outputs),
          },
          sourcePath: input.sourcePath,
          outputs: createStandardAssetOutputProducerRegistry(
            projectScriptablePackSceneComponents(input.sceneComponents),
          ),
          cookers,
        })
      ).unwrap();
      input.signal.throwIfAborted();
      const keys = new Map(
        product.stagedOutputs.map((output) => [AssetGuid.format(output.guid), output.sourceKey]),
      );
      const assets: Record<string, DirectPackJson['assets'][string]> = {};
      const blobs: NonNullable<RuntimePackContent['blobs']> = {};
      for (const asset of projectImportProductForBuild(product.product).assets) {
        const sourceKey = keys.get(asset.guid);
        if (!sourceKey) throw new Error(`Missing prepared output identity: ${asset.guid}`);
        assets[sourceKey] = await stageRuntimePackOutput(
          asset,
          blobs,
          false,
          (bytes) => `sha256:${sha256(bytes)}`,
        );
      }
      input.signal.throwIfAborted();
      return assembleRuntimePackContent(input.packageId, assets, blobs, {
        dependencies: input.dependencies,
      });
    },
  };
}
