import type { ArtifactDescriptor, AssetRef, SourceDependency } from '@forgeax/engine-types';

export interface LodIncrementalAssetRow {
  readonly guid: string;
  readonly kind: string;
  readonly refs: readonly AssetRef[];
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly artifacts: Readonly<Record<string, ArtifactDescriptor>>;
}

export interface LodIncrementalRoles {
  readonly root: string;
  readonly middle: string;
  readonly lowest: string;
  readonly material: string;
  readonly scene: string;
}

export interface LodIncrementalManifest {
  readonly schemaVersion: 'e03-incremental-inputs/2';
  readonly provenance: {
    readonly baseline: string;
    readonly producerHead: string;
    readonly producer: 'produceSourcePackage(gltfImporter)';
    readonly modules: readonly { readonly specifier: string; readonly sha256: string }[];
    readonly source: { readonly path: string; readonly sha256: string };
    readonly meta: { readonly path: string; readonly sha256: string };
    readonly sourceDependencies: readonly SourceDependency[];
  };
  readonly roles: LodIncrementalRoles;
  readonly admission: {
    readonly initial: readonly string[];
    readonly later: readonly string[];
    readonly excluded: readonly string[];
    readonly route: 'complete Catalog publication -> load / reload original root';
  };
  readonly assets: readonly LodIncrementalAssetRow[];
  readonly initialRoot: LodIncrementalAssetRow;
  readonly shaderClosure:
    | {
        readonly status: 'not-prepared';
        readonly programs: readonly string[];
        readonly gpuReadiness: 'unverified';
      }
    | {
        readonly status: 'cpu-publication-verified';
        readonly programs: readonly string[];
        readonly gpuReadiness: 'unverified';
        readonly publication: {
          readonly path: 'shaders/manifest.json';
          readonly sha256: string;
          readonly byteLength: number;
        };
      };
}

export interface PrepareLodIncrementalInputsOptions {
  readonly output: string;
  readonly shaderManifest?: string;
}

export function prepareLodIncrementalInputs(
  options: PrepareLodIncrementalInputsOptions,
): Promise<LodIncrementalManifest>;
