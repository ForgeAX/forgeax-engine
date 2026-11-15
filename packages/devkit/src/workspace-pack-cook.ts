import { createHash } from 'node:crypto';
import {
  buildScriptablePack,
  createStandardAssetOutputProducerRegistry,
  projectImportProductForBuild,
  type RuntimePackContent,
} from '@forgeax/engine-import';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import {
  AssetGuid,
  type DirectPackJson,
  definePackageId,
  type PackOutputMap,
  parsePackSourceJson,
  projectScriptablePackSceneComponents,
  type ScriptablePackSceneComponentInput,
} from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
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
      const blobs: Record<string, Uint8Array<ArrayBuffer>> = {};
      for (const asset of projectImportProductForBuild(product.product).assets) {
        const sourceKey = keys.get(asset.guid);
        if (!sourceKey) throw new Error(`Missing prepared output identity: ${asset.guid}`);
        const artifacts: Record<string, Record<string, unknown>> = {};
        for (const [name, artifact] of Object.entries(asset.artifacts ?? {})) {
          const path = `${asset.guid}/${name}`;
          const bytes = new Uint8Array(artifact.bytes);
          blobs[path] = bytes;
          artifacts[name] = {
            path,
            byteLength: bytes.byteLength,
            mediaType: artifact.mediaType,
            contentEncoding: 'identity',
            integrity: {
              algorithm: 'sha256',
              digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
            },
            ...(artifact.assetCodec ? { assetCodec: artifact.assetCodec } : {}),
          };
        }
        assets[sourceKey] = {
          kind: asset.kind,
          payload: asset.payload,
          refs: asset.refs,
          artifacts,
        };
      }
      const source = { schemaVersion: '3.0.0' as const, packageId: input.packageId, assets };
      parsePackSourceJson(source).unwrap();
      return { source, blobs, dependencies: input.dependencies };
    },
  };
}
