import type {
  BindGroupLayoutDescriptor,
  MaterialParticleInput,
  ParticleEffectAssetV3,
  ParticleEffectProgramEmitter,
  ParticleEffectProgramV3,
} from '@forgeax/engine-types';
import type {
  ParticleChannelSource,
  ParticleEventSource,
  ParticleStageDomain,
  ParticleStageResourceAccess,
} from './code-source.js';
import type {
  ParticleEmitterSourceV3,
  ParticleRendererSemanticMap,
  ParticleRendererSortingV3,
  ParticleRendererSourceV3,
} from './code-source-v3.js';
import type { VfxDataInterfaceRequirement } from './data-interface.js';
import type { VfxEffectReflection } from './effect-contract.js';

/** The only cooked GPU program ABI exposed by the runtime. */
export const VFX_GPU_PROGRAM_FORMAT = 'forgeax-vfx-program-4' as const;
export const VFX_GPU_PROGRAM_ARTIFACT_KEY = 'particle-effect/program.json' as const;

export interface VfxGpuStageReflection {
  readonly id: string;
  readonly entry: string;
  readonly entryPoint: string;
  readonly domain: ParticleStageDomain;
  readonly resources: readonly {
    readonly name: string;
    readonly access: ParticleStageResourceAccess;
  }[];
  readonly dependsOn: readonly string[];
  readonly iterationBudget: number;
}

/** Reflection of one executable renderer projection. */
export interface VfxGpuRendererReflectionV3 {
  readonly topology: ParticleRendererSourceV3['kind'];
  readonly resource: string;
  readonly capacity: number;
  readonly overflow: 'drop-newest' | 'drop-oldest';
  readonly enabled: boolean;
  readonly shaderInputs: readonly string[];
  readonly attributes: ParticleRendererSemanticMap;
  readonly materialInputs: readonly string[];
  readonly materialInputDefinitions?: readonly MaterialParticleInput[];
  readonly textureSheet?: {
    readonly columns: number;
    readonly rows: number;
    readonly frameRate: number;
    readonly frameCount: number;
  };
  readonly pivot?: readonly [number, number];
  readonly softParticle?: { readonly fadeDistance: number; readonly requiresDepth: true };
  readonly sorting?: ParticleRendererSortingV3;
  readonly stripKey?: 'alive-index';
  readonly historyLength?: number;
  readonly endpointField?: 'velocity';
  readonly lighting?: 'unlit' | 'standard';
  readonly castShadows: boolean;
  readonly receiveShadows: boolean;
}

export interface VfxGpuProgramReflectionV3 {
  readonly hooks: readonly ['vfx_spawn', 'vfx_update'];
  readonly imports: readonly string[];
  readonly resources: readonly string[];
  readonly entryPoints: readonly string[];
  readonly bindings: readonly BindGroupLayoutDescriptor[];
  readonly layout: VfxEffectReflection;
  readonly dataInterfaces: readonly VfxDataInterfaceRequirement[];
  readonly eventChannels: readonly ParticleChannelSource[];
  readonly events: readonly ParticleEventSource[];
  readonly eventEntryPoint: 'forgeax_vfx_event_main';
  readonly stages: readonly VfxGpuStageReflection[];
  readonly renderers: readonly VfxGpuRendererReflectionV3[];
}

export interface VfxGpuEmitterProgramV3
  extends Omit<ParticleEffectProgramEmitter, 'renderers' | 'reflection'> {
  readonly id: string;
  readonly module: string;
  readonly capacity: number;
  readonly backend: ParticleEmitterSourceV3['backend'];
  readonly space: ParticleEmitterSourceV3['space'];
  readonly schedule: ParticleEmitterSourceV3['schedule'];
  readonly bounds: ParticleEmitterSourceV3['bounds'];
  readonly renderers: readonly ParticleRendererSourceV3[];
  readonly channels?: readonly ParticleChannelSource[];
  readonly events?: readonly ParticleEventSource[];
  readonly simulationWhenCulled: NonNullable<ParticleEmitterSourceV3['simulationWhenCulled']>;
  readonly wgsl: string;
  readonly reflection: VfxGpuProgramReflectionV3;
}

export interface VfxGpuProgramV3 extends Omit<ParticleEffectProgramV3, 'emitters'> {
  readonly format: typeof VFX_GPU_PROGRAM_FORMAT;
  readonly fingerprint: string;
  readonly emitters: readonly VfxGpuEmitterProgramV3[];
}

export interface VfxGpuEffectAssetV3 extends Omit<ParticleEffectAssetV3, 'program'> {
  readonly guid: string;
  readonly kind: 'particle-effect';
  readonly schemaVersion: 3;
  readonly programFingerprint: string;
  readonly emitters: readonly { readonly id: string; readonly capacity: number }[];
  readonly program: VfxGpuProgramV3;
}

/** Public names point at the same one-cut Program v3 shapes. */
export type VfxGpuRendererReflection = VfxGpuRendererReflectionV3;
export type VfxGpuProgramReflection = VfxGpuProgramReflectionV3;
export type VfxGpuEmitterProgram = VfxGpuEmitterProgramV3;
export type VfxGpuProgram = VfxGpuProgramV3;
export type VfxGpuEffectAsset = VfxGpuEffectAssetV3;
export type VfxGpuEmitterProgramAny = VfxGpuEmitterProgramV3;
export type VfxGpuEffectAssetAny = VfxGpuEffectAssetV3;
