import type { Asset, AssetGuid, Result } from '@forgeax/engine-types';
import type { PackOutput } from './pack-authoring.js';

/**
 * Build-time Pack vocabulary shared by the source loader and output
 * producers. ScriptablePack and Pack authoring definitions live in the shared
 * Pack authoring implementation; this facade is the browser-safe source entry.
 */
export * from './guid.js';
export * from './pack-authoring.js';
export * from './plugin-asset.js';

/** Closed ordinary kind vocabulary shared by Pack discovery and producers. */
export type ScriptablePackAssetKind = Asset['kind'];

export const SCRIPTABLE_PACK_ASSET_KINDS = [
  'plugin',
  'mesh',
  'material',
  'scene',
  'texture',
  'equirect',
  'sampler',
  'font',
  'render-pipeline',
  'tileset',
  'video',
  'skeleton',
  'skin',
  'animation-clip',
  'animation-graph',
  'audio',
  'particle-effect',
  'ies-profile',
  'terrain',
  'navigation-mesh',
] as const satisfies readonly ScriptablePackAssetKind[];

export function isScriptablePackAssetKind(value: string): value is ScriptablePackAssetKind {
  return (SCRIPTABLE_PACK_ASSET_KINDS as readonly string[]).includes(value);
}

export const SCRIPTABLE_PACK_CAPABILITY_MANIFEST = {
  assetKinds: SCRIPTABLE_PACK_ASSET_KINDS,
  durablePayload: true,
  refs: true,
  artifacts: true,
  hostCapabilities: ['audio-install', 'video-play', 'particle-execute'] as const,
} as const;

export interface ScriptablePackSceneComponentInput {
  readonly name: string;
  readonly fields: Readonly<Record<string, string | { readonly type: string }>>;
}

export interface ScriptablePackSceneComponent {
  readonly name: string;
  readonly fields: Readonly<Record<string, string>>;
}

function sceneComponentFieldType(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const type = (value as { readonly type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

export function projectScriptablePackSceneComponents(
  components: readonly ScriptablePackSceneComponentInput[] | undefined,
): readonly ScriptablePackSceneComponent[] {
  return (components ?? []).map((component) => ({
    name: component.name,
    fields: Object.fromEntries(
      Object.entries(component.fields).map(([fieldName, field]) => [
        fieldName,
        sceneComponentFieldType(field) as string,
      ]),
    ),
  }));
}

/** Source closure evidence used to fence one isolated build generation. */
export interface ScriptablePackSourceClosureEntry {
  readonly path: string;
  readonly digest: string;
}

/** AssetReader is intentionally a small, realm-neutral source boundary. */
export interface AssetReader {
  readByGuid<TAsset extends PackOutput = Asset>(
    guid: AssetGuid,
  ): Promise<Result<TAsset, ScriptablePackReadError>>;
}

export interface ScriptablePackReadError {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
}
