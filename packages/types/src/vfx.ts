// @forgeax/engine-types - runtime-safe VFX asset vocabulary.
import type { AssetHandle } from './asset-handle';

/** Runtime-ready definition for one cooked particle emitter. */
export interface ParticleEmitterDefinition {
  readonly id: string;
  readonly capacity: number;
}

/** Serializable cooked GPU program carried by the ordinary particle asset. */
export interface ParticleEffectProgram {
  readonly format: 'forgeax-vfx-program-4';
  readonly fingerprint: string;
  readonly emitters: readonly ParticleEffectProgramEmitter[];
}

export interface ParticleEffectProgramEmitter {
  readonly id: string;
  readonly module: string;
  readonly capacity: number;
  readonly backend: { readonly required: 'gpu' };
  readonly forceFields?: readonly VfxForceField[];
  readonly space: 'local' | 'world';
  readonly schedule: object;
  readonly bounds: object;
  readonly renderers: readonly {
    readonly kind: 'billboard' | 'mesh' | 'ribbon' | 'trail' | 'beam';
    readonly material: string | AssetHandle<'material'>;
    readonly mesh?: string | AssetHandle<'mesh'> | { readonly source: 'player' };
  }[];
  readonly simulationWhenCulled: 'continue' | 'pause' | 'restart-on-visible';
  readonly wgsl: string;
  readonly reflection: object;
  readonly channels?: readonly object[];
  readonly events?: readonly object[];
}

/** Cooked particle effect payload shared by asset and ECS consumers. */
export interface ParticleEffectAsset {
  readonly kind: 'particle-effect';
  readonly schemaVersion: 3;
  /** Content identity derived by the VFX owner from the admitted program. */
  readonly programFingerprint: string;
  readonly emitters: readonly ParticleEmitterDefinition[];
  readonly program: ParticleEffectProgram;
}

/** Runtime author content. Admission derives fingerprints and emitter summaries. */
export type ParticleEffectInput = Omit<
  ParticleEffectAsset,
  'programFingerprint' | 'emitters' | 'program'
> & {
  readonly program: Omit<ParticleEffectProgram, 'fingerprint'>;
};

/** Narrow Program v3 payload used by the new code-first compiler boundary. */
export interface ParticleEffectProgramV3 extends Omit<ParticleEffectProgram, 'format'> {
  readonly format: 'forgeax-vfx-program-4';
}

export interface ParticleEffectAssetV3
  extends Omit<ParticleEffectAsset, 'schemaVersion' | 'program'> {
  readonly schemaVersion: 3;
  readonly program: ParticleEffectProgramV3;
}

interface VfxForceFieldBase {
  /** Column-major affine field-to-world matrix. Unit support is [-1, 1]. */
  readonly transform: readonly number[];
  /** Acceleration multiplier; negative strength repels. */
  readonly strength: number;
  /** Normalized support falloff exponent, in [0, 8]. */
  readonly attenuation: number;
}

export type VfxForceField =
  | (VfxForceFieldBase & { readonly kind: 'sphere' | 'box' })
  | (VfxForceFieldBase & {
      readonly kind: 'vector';
      readonly texture: string | AssetHandle<'texture'>;
      readonly sampling: 'nearest' | 'trilinear';
    });
