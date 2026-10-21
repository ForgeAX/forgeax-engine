import { type AssetRegistry, retainAssetPublications } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { type RuntimePackContent, RuntimePackProducer } from '@forgeax/engine-import';
import type { RuntimePackEnvelope } from '@forgeax/engine-pack/runtime';
import { isScriptablePackAssetKind } from '@forgeax/engine-pack/source';
import { sceneEntity, worldWriteSceneField } from '@forgeax/engine-scene';
import type { AssetHandle, SceneAsset } from '@forgeax/engine-types';

export interface WorkspaceAssetFieldWrite {
  readonly guid: string;
  readonly path: readonly string[];
  readonly value: unknown;
}

/** Holds only explicitly bound targets for this preview; never enumerates the Catalog or World. */
export function createWorkspaceAssetAuthoring(input: {
  readonly assets: AssetRegistry;
  readonly world: World;
  readonly scene?: {
    readonly guid: string;
    readonly sourceKey: string;
    readonly root: EntityHandle;
    readonly asset: SceneAsset | undefined;
  };
}) {
  const held = new Map<
    string,
    { handle: AssetHandle; kind: RuntimePackEnvelope['assets'][number]['kind'] }
  >();
  let closed = false;
  let sequence = 0;
  let prepared:
    | { readonly id: number; readonly pack: RuntimePackEnvelope; readonly dispose: () => void }
    | undefined;
  return {
    async prepare(content: RuntimePackContent, signal?: AbortSignal): Promise<number> {
      if (closed) throw new Error('Author preview is closed');
      const source = input.assets.catalogSource;
      if (!source) throw new Error('The preview has no asset source');
      const scopeId = input.assets.runtimeBinding?.scopeId ?? source.expectedScope?.scopeId;
      if (!scopeId) throw new Error('The preview has no fixed Catalog scope');
      prepared?.dispose();
      prepared = undefined;
      const id = ++sequence;
      const pins: Array<{ dispose(): void }> = [];
      let pack: RuntimePackEnvelope | undefined;
      // A short-lived producer prepares a normal publication, but only the
      // Registry adopts its content. No draft is published into the source Catalog.
      const producer = new RuntimePackProducer({
        scopeId,
        assetSource: {
          currentRow: (guid) => input.assets.catalogEntry(guid),
          async retain(versions, dependencySignal) {
            const entries = (await input.assets.enumerateCatalog()).unwrap();
            const result = await retainAssetPublications(
              input.assets,
              versions,
              entries,
              source,
              input.assets.fetchAsset,
              dependencySignal ? { signal: dependencySignal } : {},
            );
            // Link ordinary handles only after fixing the source bytes; the retained
            // decoded values stay GUID-addressed for generation and validation.
            for (const [guid, digest] of versions) {
              const row = input.assets.catalogEntry(guid);
              if (!row || !isScriptablePackAssetKind(row.kind))
                throw new Error(`Missing dependency ${guid}`);
              const handle = (
                await input.assets.load(
                  guid,
                  row.kind,
                  dependencySignal ? { signal: dependencySignal } : undefined,
                )
              ).unwrap();
              pins.push({
                dispose: () => {
                  input.assets.release(handle).unwrap();
                },
              });
              const provenance = input.assets.sourceOf(handle);
              if (
                provenance?.modified ||
                provenance?.publication?.outputs.find((output) => output.guid === guid)?.digest !==
                  digest
              )
                throw new Error(`Dependency changed: ${guid}`);
            }
            return result;
          },
        },
        validate: (state, fetcher, dependencies) =>
          input.assets.preparePublication(
            state.rows,
            fetcher,
            { catalog: source, fetcher: input.assets.fetchAsset },
            {
              registry: input.assets,
              shaderRegistry: input.assets.shaderRegistry,
              pack: state.publication?.pack,
              dependencies,
            },
          ),
        onCommit(state) {
          if (!state.publication) return; // producer disposal withdraws its private preparation
          signal?.throwIfAborted();
          if (closed) throw new Error('Author preview retired before adoption');
          pack = state.publication.pack;
        },
      });
      const dispose = () => {
        producer.dispose();
        for (const pin of pins) pin.dispose();
      };
      try {
        (await producer.admit(content, signal)).unwrap();
        if (closed || sequence !== id || !pack)
          throw new Error('Author generation preparation retired');
        prepared = { id, pack, dispose };
        return id;
      } catch (cause) {
        dispose();
        throw cause;
      }
    },
    commit(
      id: number,
      fields: readonly WorkspaceAssetFieldWrite[],
      beforeCommit?: (handles: ReadonlyMap<string, AssetHandle>) => void,
    ): void {
      const candidate = prepared;
      if (closed || !candidate || candidate.id !== id)
        throw new Error('Author preparation retired');
      prepared = undefined;
      try {
        let adopted: ReadonlyMap<string, AssetHandle> | undefined;
        input.assets
          .adoptPreparedContent(candidate.pack, fields, (handles) => {
            beforeCommit?.(handles);
            adopted = handles;
          })
          .unwrap();
        // Generated outputs can precede their first saved Catalog publication.
        // Retain the exact accepted handles, so later edits need no source lookup.
        const current = new Set(candidate.pack.assets.map((asset) => asset.guid));
        for (const [guid, binding] of held) {
          if (current.has(guid)) continue;
          input.assets.release(binding.handle).unwrap();
          held.delete(guid);
        }
        for (const asset of candidate.pack.assets) {
          const handle = adopted?.get(asset.guid);
          if (handle === undefined || held.has(asset.guid)) continue;
          input.assets.retain(handle).unwrap();
          held.set(asset.guid, { handle, kind: asset.kind });
        }
      } finally {
        candidate.dispose();
      }
    },
    async write(write: WorkspaceAssetFieldWrite): Promise<void> {
      if (closed) throw new Error('Author preview is closed');
      const { guid, path, value } = write;
      const [root, key, section, item, index, components, component, field] = path;
      if (input.scene?.guid === guid) {
        if (root !== 'entities' || key === undefined)
          throw new TypeError('Scene live bindings require an exact entity component field');
        if (
          path.length === 5 &&
          section === 'components' &&
          item !== undefined &&
          index !== undefined
        ) {
          worldWriteSceneField(
            input.world,
            input.scene.root,
            sceneEntity(input.scene.sourceKey, key),
            item,
            index,
            value,
          ).unwrap();
        } else if (
          path.length === 8 &&
          section === 'instance' &&
          item === 'overrides' &&
          index !== undefined &&
          component !== undefined &&
          field !== undefined &&
          /^(0|[1-9][0-9]*)$/.test(index) &&
          components === 'components'
        ) {
          const override = input.scene.asset?.entities[key]?.instance?.overrides?.[Number(index)];
          if (!override)
            throw new TypeError(
              'Nested live binding requires an existing explicit instance override',
            );
          worldWriteSceneField(
            input.world,
            input.scene.root,
            sceneEntity(input.scene.sourceKey, [key, ...override.target]),
            component,
            field,
            value,
          ).unwrap();
        } else
          throw new TypeError(
            'Scene live bindings require an exact field or explicit instance override',
          );
        return;
      }
      const binding = held.get(guid);
      let handle = binding?.handle;
      const kind = binding?.kind ?? input.assets.catalogEntry(guid)?.kind;
      if (!kind || !isScriptablePackAssetKind(kind))
        throw new TypeError('Authoring target is absent from this preview');
      if (!handle) {
        handle = (await input.assets.load(guid, kind)).unwrap();
        if (closed) {
          input.assets.release(handle).unwrap();
          throw new Error('Author preview closed while binding');
        }
        held.set(guid, { handle, kind });
      }
      if (path.some((part) => ['__proto__', 'prototype', 'constructor'].includes(part)))
        throw new TypeError('Unsafe author field path');
      if (kind === 'material' && path.length === 2 && root === 'values' && key !== undefined) {
        input.assets.update(handle, { values: { [key]: value } }).unwrap();
      } else if (kind !== 'scene' && path.length === 1 && root !== undefined && root !== 'kind') {
        input.assets.update(handle, { [root]: value }).unwrap();
      } else throw new TypeError('This field requires generation or its owning scene preview');
    },
    close(): void {
      if (closed) return;
      closed = true;
      prepared?.dispose();
      prepared = undefined;
      for (const { handle } of held.values()) input.assets.release(handle).unwrap();
      held.clear();
    },
  };
}
