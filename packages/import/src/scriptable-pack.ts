import type { MeshDistanceFieldDescriptor } from '@forgeax/engine-geometry';
import type { ScriptablePackAssetKind } from '@forgeax/engine-pack';
import type {
  PackOutput,
  PluginAssetSource,
  ScriptablePackReadError,
} from '@forgeax/engine-pack/source';
import type {
  AnimationGraph,
  Asset,
  AssetGuid as AssetGuidType,
  AssetPublicationEnvelope,
  AssetPublicationExternalEvidence,
  FontAsset,
  ImportError,
  MaterialAsset,
  MeshAsset,
  Result,
  TilesetAsset,
} from '@forgeax/engine-types';
import type { ImportAssetProduct, TerminalImportProduct } from './import-product.js';

export type { ScriptablePackSourceClosureEntry } from '@forgeax/engine-pack/source';

export interface ScriptablePackAssetSnapshot {
  readonly asset: PackOutput;
  readonly generation: number;
  readonly digest: string;
}

export interface ScriptablePackStagedOutput {
  readonly guid: AssetGuidType;
  readonly sourceKey: string;
  readonly asset: PackOutput;
  readonly digest?: string;
}

export interface ScriptablePackAssetSnapshotSource {
  readByGuid(
    guid: AssetGuidType,
  ): Promise<Result<ScriptablePackAssetSnapshot, ScriptablePackReadError>>;
}

export interface AssetOutputInput {
  readonly guid: string;
  readonly sourceKey: string;
  readonly asset: Asset | PluginAssetSource;
  /** Filesystem-backed authoring host; absent for pure payload projections. */
  readonly sourcePath?: string;
  readonly projectRoot?: string;
}

type MaterialPackPayload = Omit<MaterialAsset, 'parent' | 'values'> & {
  readonly parent?: number;
  readonly values?: Readonly<Record<string, unknown>>;
};

type ScenePackPayload = { readonly kind: 'scene'; readonly [key: string]: unknown };

type FontPackPayload = Omit<FontAsset, 'atlas' | 'sampler'> & {
  readonly atlasGuid: string;
  readonly samplerGuid: string;
};

type TilesetPackPayload = Omit<TilesetAsset, 'atlases'> & { readonly atlases: readonly number[] };

type AnimationGraphPackPayload = Omit<AnimationGraph, 'nodes'> & {
  readonly nodes: readonly (
    | Exclude<AnimationGraph['nodes'][number], { readonly type: 'clip' }>
    | (Omit<Extract<AnimationGraph['nodes'][number], { readonly type: 'clip' }>, 'clip'> & {
        readonly clip: number;
      })
  )[];
};

/** Serialized producer payloads; runtime Assets never carry ref indices. */
type SerializedPayloads = {
  readonly mesh: (Omit<MeshAsset, 'distanceField'> | { readonly kind: 'mesh' }) & {
    readonly distanceField?: MeshDistanceFieldDescriptor;
  };
  readonly material: MaterialPackPayload;
  readonly scene: ScenePackPayload;
  readonly font: FontPackPayload;
  readonly tileset: TilesetPackPayload;
  readonly 'animation-graph': AnimationGraphPackPayload;
  readonly audio: {
    readonly kind: 'audio';
    readonly sourceKey: string;
    readonly mediaType: `audio/${string}`;
  };
};

export type AssetOutputPayloadByKind = Omit<
  { readonly [A in Asset as A['kind']]: A },
  keyof SerializedPayloads
> &
  SerializedPayloads;

export type AssetOutputPayload = AssetOutputPayloadByKind[ScriptablePackAssetKind];
export interface AssetOutputProduct extends ImportAssetProduct<AssetOutputPayload> {
  readonly inputFingerprint?: string;
  readonly sourceDependencies?: readonly string[];
}

export interface AssetOutputProducer {
  readonly kind: string;
  readonly version: string;
  produce(
    input: AssetOutputInput,
  ): Result<AssetOutputProduct, ImportError> | Promise<Result<AssetOutputProduct, ImportError>>;
}

export class AssetOutputProducerRegistry {
  private readonly producers = new Map<string, AssetOutputProducer>();

  register(producer: AssetOutputProducer): void {
    if (producer.kind.trim().length === 0 || producer.version.trim().length === 0) {
      throw new TypeError('Pack output producer kind and version must be non-empty');
    }
    if (typeof producer.produce !== 'function') {
      throw new TypeError(`Pack output producer ${producer.kind} must expose produce`);
    }
    this.producers.set(producer.kind, producer);
  }

  get(kind: string): AssetOutputProducer | undefined {
    return this.producers.get(kind);
  }

  versions(): Readonly<Record<string, string>> {
    return Object.fromEntries(
      [...this.producers.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([kind, producer]) => [kind, producer.version]),
    );
  }
}

/** Shared terminal product envelope for every Pack source form. */
export interface PackBuildProduct {
  readonly product: TerminalImportProduct<unknown>;
  readonly stagedOutputs: readonly ScriptablePackStagedOutput[];
  readonly externalEvidence: readonly AssetPublicationExternalEvidence[];
  readonly inputFingerprint: string;
  readonly publication?: AssetPublicationEnvelope;
}

export interface ScriptablePackDomainError {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
}
