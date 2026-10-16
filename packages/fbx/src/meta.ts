import { AssetGuid, isValidAssetGuidString } from '@forgeax/engine-pack/guid';
import { sourceKeyForFbxOutput } from './fbx-importer.js';
import type { FbxRawAnimDoc } from './parse-animation-clip.js';
import type { FbxRawMaterial } from './parse-material.js';
import type { FbxRawDocument } from './parse-mesh.js';
import type { FbxRawNodes } from './parse-scene.js';
import type { FbxRawSkeletonDoc } from './parse-skeleton.js';
import type { FbxRawSkinDoc } from './parse-skin.js';
import type { FbxRawTexture } from './parse-texture.js';

/** The source topology consumed by the FBX importer and persisted in Meta. */
export interface FbxMetaSubAsset {
  readonly guid: string;
  readonly sourceIndex: number;
  readonly kind: string;
  readonly sourceKey?: string;
  readonly name?: string;
}

export interface FbxMetaDocument {
  readonly schemaVersion: 1;
  readonly kind: 'external-asset-package';
  readonly importer: 'fbx';
  readonly source: string;
  readonly importSettings: Readonly<Record<string, unknown>>;
  readonly subAssets: readonly FbxMetaSubAsset[];
  readonly sourceOverrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly sourceOverrideDescriptors?: readonly Readonly<Record<string, unknown>>[];
}

export interface FbxMetaSourceItem {
  readonly kind: string;
  readonly sourceIndex: number;
  readonly name?: string;
}

export interface FbxMetaError {
  readonly code: 'fbx-meta-source-key-conflict';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly key: string;
    readonly entries: readonly {
      readonly kind: string;
      readonly sourceIndex: number;
      readonly name?: string;
    }[];
  };
}

export type FbxMetaSourceDocument = FbxRawDocument &
  FbxRawNodes &
  FbxRawSkeletonDoc &
  FbxRawSkinDoc &
  FbxRawAnimDoc & {
    readonly materials?: readonly FbxRawMaterial[];
    readonly textures?: readonly FbxRawTexture[];
  };

function displayName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Project exactly the FBX outputs that `toAssetPack` can emit.  The CLI uses
 * this same topology to author GUID-bearing Meta before the shared import
 * runner is invoked; it does not infer a scene from node names or source
 * paths.
 */
export function fbxMetaSourceItems(doc: FbxMetaSourceDocument): readonly FbxMetaSourceItem[] {
  const items: FbxMetaSourceItem[] = [];

  for (const [sourceIndex, mesh] of (doc.meshes ?? []).entries()) {
    const name = displayName(mesh?.name);
    items.push({
      kind: 'mesh',
      sourceIndex,
      ...(name === undefined ? {} : { name }),
    });
  }

  const materials = doc.materials ?? [];
  if (materials.length === 0) {
    items.push({ kind: 'material', sourceIndex: 0 });
  } else {
    for (const [sourceIndex, material] of materials.entries()) {
      const name = displayName(material?.name);
      items.push({
        kind: 'material',
        sourceIndex,
        ...(name === undefined ? {} : { name }),
      });
    }
  }

  for (const [index, texture] of (doc.textures ?? []).entries()) {
    const sourceIndex =
      typeof texture?.sourceIndex === 'number' &&
      Number.isInteger(texture.sourceIndex) &&
      texture.sourceIndex >= 0
        ? texture.sourceIndex
        : index;
    const name = displayName(texture?.name) ?? displayName(texture?.filePath);
    items.push({ kind: 'texture', sourceIndex, ...(name === undefined ? {} : { name }) });
  }

  if ((doc.skeletons?.[0]?.jointCount ?? 0) > 0) {
    items.push({ kind: 'skeleton', sourceIndex: 0 });
  }
  if ((doc.skins?.[0]?.vertexCount ?? 0) > 0) {
    items.push({ kind: 'skin', sourceIndex: 0 });
  }

  for (const [sourceIndex, clip] of (doc.clips ?? []).entries()) {
    const name = displayName(clip?.name);
    items.push({
      kind: 'animation-clip',
      sourceIndex,
      ...(name === undefined ? {} : { name }),
    });
  }

  // `toAssetPack` always publishes one scene, including an empty source.
  items.push({ kind: 'scene', sourceIndex: 0 });
  return items;
}

function sourceKeys(
  items: readonly FbxMetaSourceItem[],
):
  | { readonly ok: true; readonly keys: readonly string[] }
  | { readonly ok: false; readonly error: FbxMetaError } {
  const bases = items.map((item) => sourceKeyForFbxOutput(item));
  const keys: string[] = [];
  const seen = new Map<string, FbxMetaSourceItem>();
  for (const [index, item] of items.entries()) {
    const base = bases[index];
    if (base === undefined) {
      return {
        ok: false,
        error: {
          code: 'fbx-meta-source-key-conflict',
          expected: 'every FBX output to have a stable semantic source key',
          hint: 'name the FBX output or repair the producer topology before importing',
          detail: { key: '', entries: [item] },
        },
      };
    }

    const prior = seen.get(base);
    if (prior !== undefined) {
      return {
        ok: false,
        error: {
          code: 'fbx-meta-source-key-conflict',
          expected: 'FBX output source keys to be unique within one source package',
          hint: 'name each otherwise anonymous FBX output; sourceIndex is only a locator',
          detail: { key: base, entries: [prior, item] },
        },
      };
    }
    seen.set(base, item);
    keys.push(base);
  }
  return { ok: true, keys };
}

export interface FbxMetaPreviousDocument {
  readonly importer: 'fbx';
  readonly subAssets: readonly FbxMetaSubAsset[];
  readonly importSettings: Readonly<Record<string, unknown>>;
  readonly sourceOverrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly sourceOverrideDescriptors?: readonly Readonly<Record<string, unknown>>[];
}

function existingEntry(value: unknown): value is FbxMetaPreviousDocument {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const subAssets = candidate.subAssets;
  if (!Array.isArray(subAssets) || !subAssets.every(isFbxMetaSubAsset)) return false;
  return (
    candidate.importer === 'fbx' &&
    candidate.importSettings !== null &&
    typeof candidate.importSettings === 'object' &&
    !Array.isArray(candidate.importSettings)
  );
}

function isFbxMetaSubAsset(value: unknown): value is FbxMetaSubAsset {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isValidAssetGuidString(candidate.guid) &&
    typeof candidate.sourceIndex === 'number' &&
    Number.isInteger(candidate.sourceIndex) &&
    candidate.sourceIndex >= 0 &&
    typeof candidate.kind === 'string' &&
    candidate.kind.length > 0 &&
    (candidate.sourceKey === undefined ||
      (typeof candidate.sourceKey === 'string' && candidate.sourceKey.length > 0)) &&
    (candidate.name === undefined || typeof candidate.name === 'string')
  );
}

/**
 * Create a stable FBX Meta document from parsed source facts. Existing GUIDs
 * are matched first by producer sourceKey and then by `(kind, sourceIndex)`;
 * legacy FBX sidecars keep their old sourceKey on the locator fallback so
 * authored sourceOverrides remain attached during the first automatic import.
 */
export function createFbxMeta(
  doc: FbxMetaSourceDocument,
  source: string,
  previous?: FbxMetaPreviousDocument,
):
  | { readonly ok: true; readonly value: FbxMetaDocument }
  | { readonly ok: false; readonly error: FbxMetaError } {
  const items = fbxMetaSourceItems(doc);
  const keys = sourceKeys(items);
  if (!keys.ok) return keys;

  const byKey = new Map<string, FbxMetaSubAsset>();
  const byLocator = new Map<string, FbxMetaSubAsset>();
  for (const entry of previous?.subAssets ?? []) {
    if (!isValidAssetGuidString(entry.guid)) continue;
    if (typeof entry.sourceKey === 'string') byKey.set(entry.sourceKey, entry);
    byLocator.set(`${entry.kind}:${entry.sourceIndex}`, entry);
  }

  const subAssets = items.map((item, index) => {
    const key = keys.keys[index] as string;
    const reused = byKey.get(key) ?? byLocator.get(`${item.kind}:${item.sourceIndex}`);
    const sourceKey = reused?.sourceKey ?? key;
    return {
      guid: reused?.guid ?? AssetGuid.format(AssetGuid.random()),
      sourceIndex: item.sourceIndex,
      kind: item.kind,
      sourceKey,
      ...(item.name === undefined ? {} : { name: item.name }),
    } satisfies FbxMetaSubAsset;
  });

  const importSettings = previous?.importSettings ?? {};
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      kind: 'external-asset-package',
      importer: 'fbx',
      source,
      importSettings,
      subAssets,
      ...(previous?.sourceOverrides === undefined
        ? {}
        : { sourceOverrides: previous.sourceOverrides }),
      ...(previous?.sourceOverrideDescriptors === undefined
        ? {}
        : { sourceOverrideDescriptors: previous.sourceOverrideDescriptors }),
    },
  };
}

export function isFbxMetaDocument(value: unknown): value is FbxMetaPreviousDocument {
  return existingEntry(value);
}
