import type { AssetGuid, BindGroupLayoutDescriptor } from '@forgeax/engine-types';

export const CLOUD_LAYER_FEATURE_IDENTITY = 'forgeax.cloud-layer';

export const CLOUD_REFERENCE_TEXTURE_ROLES = [
  ['layoutPattern', '2d'],
  ['layoutMask', '2d'],
  ['heightProfile', '2d'],
  ['bodyNoise', '3d'],
] as const;

export type CloudRgb = readonly [number, number, number];
export type CloudVector = CloudRgb | readonly [number, number, number, number];

export interface MediumSample {
  readonly extinctionPerMeter: number;
  readonly albedo: CloudRgb;
  readonly emissivePerMeter: CloudRgb;
  readonly materialAO: number;
}

export type CloudParameterValue = number | boolean | string | CloudVector;
export type CloudParameter = {
  readonly label?: string;
  readonly group?: string;
} & (
  | {
      readonly kind: 'scalar';
      readonly default: number;
      readonly unit: 'm' | 'm/s' | 'm^-1' | 'unitless';
      readonly range?: readonly [number, number];
    }
  | { readonly kind: 'vector'; readonly default: CloudVector }
  | { readonly kind: 'static'; readonly default: boolean }
  | {
      readonly kind: 'texture';
      readonly default: string;
      readonly dimension: '2d' | '3d';
      readonly colorSpace: 'linear' | 'srgb';
      readonly mipLevels: number;
    }
);

export type CloudMediumModel =
  | { readonly kind: 'uniform'; readonly sample: MediumSample }
  | { readonly kind: 'program'; readonly source: string };

export interface CloudMaterialSource {
  readonly version: 1;
  readonly model: CloudMediumModel;
  readonly parameters: Readonly<Record<string, CloudParameter>>;
}

export interface CloudMaterialInstanceSource {
  readonly version: 1;
  readonly material: string;
  readonly overrides: Readonly<Record<string, CloudParameterValue>>;
}

export interface CloudTracePolicy {
  readonly tracingStartMaxDistanceMeters: number;
  readonly tracingMaxDistanceMeters: number;
  readonly tracingMaxDistanceMode: 'from-layer-entry' | 'from-camera';
  readonly viewSampleCountScale: number;
  readonly shadowViewSampleCountScale: number;
  readonly stopTransmittance: number;
}

export interface CloudLayerSource {
  readonly material: AssetGuid;
  readonly bottomMeters: number;
  readonly thicknessMeters: number;
  readonly trace: CloudTracePolicy;
}

export const CLOUD_RENDERER_UNIFORM_ABI_VERSION = 2;

export interface CloudProgramVariant {
  readonly renderer?: {
    readonly uniformAbiVersion: typeof CLOUD_RENDERER_UNIFORM_ABI_VERSION;
    readonly artifact: string;
    readonly programDigest: string;
    readonly bindings: readonly BindGroupLayoutDescriptor[];
    readonly parameterNames: readonly string[];
  };
  readonly staticValues: Readonly<Record<string, boolean>>;
  readonly programIdentity: string;
  readonly artifact: string;
  readonly compilerIdentity: string;
  readonly programDigest: string;
  readonly bindings: readonly BindGroupLayoutDescriptor[];
}

export interface CloudMaterialAsset {
  /** Verified composed renderer artifacts retained by the decoder, keyed by variant identity. */
  readonly rendererPrograms?: Readonly<Record<string, string>>;
  readonly kind: 'cloud-material';
  readonly version: 1 | 2;
  readonly model: 'uniform' | 'program';
  readonly sample?: MediumSample;
  readonly parameters: Readonly<Record<string, CloudParameter>>;
  readonly variants: readonly CloudProgramVariant[];
  readonly cookIdentity: string;
  /** Exact canonical Engine density module digest shared by Cook and Standard. */
  readonly densityKernelIdentity?: string;
}

export interface CloudMaterialInstanceAsset extends CloudMaterialInstanceSource {
  readonly kind: 'cloud-material-instance';
  readonly parameterIdentity: string;
}
