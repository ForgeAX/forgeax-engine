import type { AnimationPlaybackOptions } from '@forgeax/engine-animation';
import type { HostAudioConsumerOptions } from '@forgeax/engine-audio-webaudio';
import type { TimePolicy } from '@forgeax/engine-ecs';
import type { PhysicsOptions } from '@forgeax/engine-physics';
import type {
  OutputColorSpace,
  RenderingRequirements,
  RenderProfile,
  RenderQualityLimits,
} from '@forgeax/engine-render';
import type { ExecutionWorkersOptions } from './execution/types';

export const QUALITY_LEVELS = ['low', 'medium', 'high'] as const;
export type QualityLevel = (typeof QUALITY_LEVELS)[number];
export const QUALITY_GROUPS = [
  'resolution',
  'shadows',
  'ambientOcclusion',
  'reflections',
  'globalIllumination',
  'volumetrics',
  'textures',
  'shading',
] as const;
export type QualityGroup = (typeof QUALITY_GROUPS)[number];
export type QualityGroups = Readonly<Record<QualityGroup, QualityLevel>>;
export type QualitySelection = {
  readonly base:
    | { readonly kind: 'device-default' }
    | { readonly kind: 'preset'; readonly preset: QualityLevel };
  readonly groups?: Partial<QualityGroups>;
};

/** Explicit Host observations; an absent model never matches a model rule. */
export interface HostDeviceFacts {
  readonly platform: 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'unknown';
  readonly runtime?: 'browser' | 'wechat' | 'native';
  readonly model?: string;
}

/** Domain-owned constructor options, without native objects or callbacks. */
export interface EngineSettings {
  readonly presentation?: {
    readonly canvasPixelRatio?: number;
    readonly outputColorSpace?: OutputColorSpace;
  };
  readonly execution?: {
    readonly workers?: ExecutionWorkersOptions;
    readonly taskWorkers?: number;
    readonly renderPipelineCapacity?: 2 | 3 | 4;
  };
  readonly assets?: { readonly assetBudgetBytes?: number };
  readonly audio?: {
    readonly host?: HostAudioConsumerOptions;
    readonly publication?: {
      readonly maxPublishedBytes?: number;
      readonly maxPublishedSources?: number;
    };
  };
  readonly simulation?: {
    readonly time?: TimePolicy;
    readonly animation?: AnimationPlaybackOptions;
    readonly physics?: Pick<PhysicsOptions, 'solverIterations' | 'asyncResultsInterpolation'>;
  };
  readonly rendering?: RenderingRequirements & {
    readonly view?: { readonly maxRenderShortSide?: number };
    readonly qualityLimits?: RenderQualityLimits;
    /** @deprecated Removed in 0.7. Declare rendering requirements here and scene appearance on components. */
    readonly profile?: RenderProfile;
    readonly renderBackend?: 'auto' | 'webgpu' | 'webgl2';
    readonly resources?: {
      readonly dynamicGeometryMeshBudgetBytes?: number;
      readonly featureTextureReadbackBudgetBytes?: number;
    };
  };
}

export interface DeviceProfileDefinition {
  readonly id: string;
  readonly extends?: string;
  readonly override?: boolean;
  readonly match?: Partial<HostDeviceFacts>;
  readonly priority?: number;
  readonly defaults?: {
    readonly preset?: QualityLevel;
    readonly groups?: Partial<QualityGroups>;
  };
  readonly settings?: EngineSettings;
  readonly constraints?: { readonly maximumQuality?: Partial<QualityGroups> };
}

export interface EngineConfigurationDefinition {
  readonly schemaVersion?: 1;
  readonly settings?: EngineSettings;
  readonly quality?: QualitySelection;
  readonly deviceProfiles?: readonly DeviceProfileDefinition[];
  readonly deviceProfile?: string;
}

export interface QualityConstraint {
  readonly group: QualityGroup;
  readonly requested: QualityLevel;
  readonly effective: QualityLevel;
  readonly profile: string;
}

/** Immutable construction intent. Only domain adoption proves effective state. */
export interface EngineStartupPlan {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly facts: HostDeviceFacts;
  readonly profileId: string;
  readonly profileChain: readonly string[];
  readonly settings: EngineSettings;
  readonly rendering: { readonly profile: RenderProfile; readonly textureMipSkip: number };
  readonly selection: QualitySelection;
  readonly requestedGroups: QualityGroups;
  readonly effectiveGroups: QualityGroups;
  readonly preset: QualityLevel | 'custom';
  readonly constraints: readonly QualityConstraint[];
  readonly sources: Readonly<Record<string, string>>;
}

export interface EngineConfigurationStore {
  read(): Promise<QualitySelection | undefined>;
  write(selection: QualitySelection): Promise<void>;
}
