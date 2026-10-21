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
  ParticleSoftParticleSource,
  ParticleStageSource,
  ParticleTextureSheetSource,
} from './code-source.js';
import type {
  ParticleEmitterSourceV3,
  ParticleRendererSortingV3,
  ParticleRendererSourceV3,
  ParticleRendererSourceV3Base,
} from './code-source-v3.js';
import type { VfxDataInterfaceRequirement } from './data-interface.js';
import type { VfxEffectReflection } from './effect-contract.js';

/** The only cooked GPU program ABI exposed by the runtime. */
export const VFX_GPU_PROGRAM_FORMAT = 'forgeax-vfx-program-4' as const;
export const VFX_GPU_PROGRAM_ARTIFACT_KEY = 'particle-effect/program.json' as const;

export interface VfxGpuStageReflection extends ParticleStageSource {
  readonly entryPoint: string;
}

/** Reflection of one executable renderer projection. */
export interface VfxGpuRendererReflection
  extends Required<
    Pick<
      ParticleRendererSourceV3Base,
      'capacity' | 'overflow' | 'enabled' | 'attributes' | 'materialInputs'
    >
  > {
  readonly topology: ParticleRendererSourceV3['kind'];
  readonly resource: string;
  readonly shaderInputs: readonly string[];
  readonly materialInputDefinitions?: readonly MaterialParticleInput[];
  readonly textureSheet?: Required<ParticleTextureSheetSource>;
  readonly pivot?: readonly [number, number];
  readonly softParticle?: ParticleSoftParticleSource & { readonly requiresDepth: true };
  readonly sorting?: ParticleRendererSortingV3;
  readonly stripKey?: 'alive-index';
  readonly historyLength?: number;
  readonly endpointField?: 'velocity';
  readonly lighting?: 'unlit' | 'standard';
  readonly castShadows: boolean;
  readonly receiveShadows: boolean;
}

export interface VfxGpuProgramReflection {
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
  readonly renderers: readonly VfxGpuRendererReflection[];
}

/** Explicit compiler-authored multi-instance compute contract. The original
 * program remains the fallback for devices or emitters outside this ABI. */
export interface VfxGpuInstanceComputeProgram {
  readonly format: 'forgeax-vfx-instance-compute-1';
  readonly jobBytes: 336;
  readonly wgsl: string;
  readonly bindings: readonly BindGroupLayoutDescriptor[];
}

export interface VfxGpuEmitterProgram
  extends Omit<ParticleEffectProgramEmitter, 'renderers' | 'reflection'> {
  readonly schedule: ParticleEmitterSourceV3['schedule'];
  readonly bounds: ParticleEmitterSourceV3['bounds'];
  readonly renderers: readonly ParticleRendererSourceV3[];
  readonly channels?: readonly ParticleChannelSource[];
  readonly events?: readonly ParticleEventSource[];
  readonly simulationWhenCulled: NonNullable<ParticleEmitterSourceV3['simulationWhenCulled']>;
  readonly instanceCompute?: VfxGpuInstanceComputeProgram;
  readonly reflection: VfxGpuProgramReflection;
}

export interface VfxGpuProgram extends Omit<ParticleEffectProgramV3, 'emitters'> {
  readonly emitters: readonly VfxGpuEmitterProgram[];
}

export interface VfxGpuEffectAsset extends Omit<ParticleEffectAssetV3, 'program'> {
  readonly guid: string;
  readonly program: VfxGpuProgram;
}
