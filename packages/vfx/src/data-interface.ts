import { err, ok, type Result } from '@forgeax/engine-types';

export type VfxDataInterfaceKind = keyof VfxDataInterfaceBindingTypeByKind;

export type VfxDataInterfaceToken = `vfx:${VfxDataInterfaceKind}`;

export type VfxDataInterfaceBindingType = VfxDataInterfaceBindingTypeByKind[VfxDataInterfaceKind];

export type VfxDataInterfaceResourceKind = 'buffer' | 'texture-view' | 'sampler';

type VfxDataInterfaceBindingTypeByKind = {
  readonly camera: 'uniform';
  readonly 'scene-depth': 'sampled-depth';
  readonly noise: 'sampled-float';
  readonly 'scene-sdf': 'read-only-storage';
  readonly 'force-fields': 'read-only-storage';
};

export type VfxDataInterfaceLifetime = 'generation';

export interface VfxDataInterfaceRequirement {
  readonly token: VfxDataInterfaceToken;
  readonly kind: VfxDataInterfaceKind;
  readonly binding: number;
  readonly bindingType: VfxDataInterfaceBindingType;
  readonly lifetime: VfxDataInterfaceLifetime;
  /** Scene-depth composition is intentionally proven only for single-sample targets. */
  readonly sampleCount?: 1;
}

export interface VfxDataInterfaceResource {
  readonly token: VfxDataInterfaceToken;
  readonly kind: VfxDataInterfaceKind;
  readonly bindingType: VfxDataInterfaceBindingType;
  readonly generation: number;
  readonly sampleCount?: number;
  /**
   * Provider-owned opaque resource. Render owners refine this to their typed
   * prepared-resource reference; VFX never inspects a backend handle.
   */
  readonly resource?: {
    readonly kind: 'buffer' | 'texture-view' | 'sampler';
    readonly value: unknown;
    /** Required when a provider supplies an external buffer to a compute bind group. */
    readonly size?: number;
    readonly usage?: 'uniform' | 'storage';
  };
}

export interface VfxDataInterfaceErrorDetail {
  readonly token: VfxDataInterfaceToken;
  readonly providerId?: string;
  readonly expectedGeneration?: number;
  readonly actualGeneration?: number;
  readonly expectedBindingType?: VfxDataInterfaceBindingType;
  readonly actualBindingType?: VfxDataInterfaceBindingType;
  readonly expectedResourceKind?: VfxDataInterfaceResourceKind;
  readonly actualResourceKind?: VfxDataInterfaceResourceKind;
}

export interface VfxDataInterfaceError {
  readonly code:
    | 'vfx-data-interface-missing'
    | 'vfx-data-interface-wrong-type'
    | 'vfx-data-interface-stale'
    | 'vfx-data-interface-duplicate';
  readonly expected: string;
  readonly hint: string;
  readonly detail: VfxDataInterfaceErrorDetail;
}

export type VfxDataInterfaceProvider<K extends VfxDataInterfaceKind = VfxDataInterfaceKind> = {
  readonly id: string;
  readonly token: `vfx:${K}`;
  readonly kind: K;
  readonly bindingType: VfxDataInterfaceBindingTypeByKind[K];
  readonly provide: (generation: number) => Result<VfxDataInterfaceResource, VfxDataInterfaceError>;
};

export interface VfxDataInterfaceResolution {
  readonly generation: number;
  readonly readiness: 'ready';
  readonly resources: readonly VfxDataInterfaceResource[];
}

function expectedResourceKind(kind: VfxDataInterfaceKind): VfxDataInterfaceResourceKind {
  switch (kind) {
    case 'camera':
    case 'scene-sdf':
    case 'force-fields':
      return 'buffer';
    case 'scene-depth':
    case 'noise':
      return 'texture-view';
  }
}

function failure(
  code: VfxDataInterfaceError['code'],
  requirement: VfxDataInterfaceRequirement,
  expected: string,
  hint: string,
  detail: Omit<VfxDataInterfaceErrorDetail, 'token'> = {},
): VfxDataInterfaceError {
  return { code, expected, hint, detail: { token: requirement.token, ...detail } };
}

export function resolveVfxDataInterfaces(
  requirements: readonly VfxDataInterfaceRequirement[],
  providers: readonly VfxDataInterfaceProvider[],
  generation: number,
): Result<VfxDataInterfaceResolution, VfxDataInterfaceError> {
  const byToken = new Map<VfxDataInterfaceToken, VfxDataInterfaceProvider>();
  for (const provider of providers) {
    const prior = byToken.get(provider.token);
    if (prior !== undefined) {
      const requirement = requirements.find((entry) => entry.token === provider.token) ?? {
        token: provider.token,
        kind: provider.kind,
        binding: -1,
        bindingType: provider.bindingType,
        lifetime: 'generation',
      };
      return err(
        failure(
          'vfx-data-interface-duplicate',
          requirement,
          'at most one provider for each reflected Data Interface token',
          `remove duplicate providers ${prior.id} and ${provider.id} and retry`,
          { providerId: provider.id },
        ),
      );
    }
    byToken.set(provider.token, provider);
  }

  const resources: VfxDataInterfaceResource[] = [];
  for (const requirement of requirements) {
    const provider = byToken.get(requirement.token);
    if (provider === undefined) {
      return err(
        failure(
          'vfx-data-interface-missing',
          requirement,
          `a registered ${requirement.kind} provider for ${requirement.token}`,
          `register ${requirement.token} for generation ${generation} before starting the effect`,
        ),
      );
    }
    if (provider.kind !== requirement.kind || provider.bindingType !== requirement.bindingType) {
      return err(
        failure(
          'vfx-data-interface-wrong-type',
          requirement,
          `${requirement.kind} with ${requirement.bindingType} binding semantics`,
          `replace provider ${provider.id} with a ${requirement.token} provider matching reflection`,
          {
            providerId: provider.id,
            expectedBindingType: requirement.bindingType,
            actualBindingType: provider.bindingType,
          },
        ),
      );
    }
    const provided = provider.provide(generation);
    if (!provided.ok) return provided;
    const resource = provided.value;
    if (resource.token !== requirement.token || resource.kind !== requirement.kind) {
      return err(
        failure(
          'vfx-data-interface-wrong-type',
          requirement,
          `${requirement.kind} resource for ${requirement.token}`,
          `repair provider ${provider.id} so its resource matches its reflected token`,
          { providerId: provider.id },
        ),
      );
    }
    if (resource.bindingType !== requirement.bindingType) {
      return err(
        failure(
          'vfx-data-interface-wrong-type',
          requirement,
          `resource binding type ${requirement.bindingType}`,
          `repair provider ${provider.id} resource binding metadata`,
          {
            providerId: provider.id,
            expectedBindingType: requirement.bindingType,
            actualBindingType: resource.bindingType,
          },
        ),
      );
    }
    const expectedKind = expectedResourceKind(requirement.kind);
    if (resource.resource === undefined) {
      return err(
        failure(
          'vfx-data-interface-missing',
          requirement,
          `${requirement.kind} backed by a resident ${expectedKind} resource`,
          `refresh provider ${provider.id} with a generation-owned resource before dispatch`,
          { providerId: provider.id, expectedResourceKind: expectedKind },
        ),
      );
    }
    if (resource.resource.kind !== expectedKind) {
      return err(
        failure(
          'vfx-data-interface-wrong-type',
          requirement,
          `${requirement.kind} backed by a ${expectedKind} resource`,
          `repair provider ${provider.id} so its opaque resource matches the reflected binding kind`,
          {
            providerId: provider.id,
            expectedResourceKind: expectedKind,
            actualResourceKind: resource.resource.kind,
          },
        ),
      );
    }
    if (requirement.sampleCount !== undefined && resource.sampleCount !== requirement.sampleCount) {
      return err(
        failure(
          'vfx-data-interface-wrong-type',
          requirement,
          `a scene-depth resource with sampleCount=${requirement.sampleCount}`,
          `provide a single-sample scene depth target for ${provider.id}; MSAA resolve is not implicit`,
          { providerId: provider.id },
        ),
      );
    }
    if (resource.generation !== generation) {
      return err(
        failure(
          'vfx-data-interface-stale',
          requirement,
          `a resource from generation ${generation}`,
          `refresh provider ${provider.id} for generation ${generation} before rendering`,
          {
            providerId: provider.id,
            expectedGeneration: generation,
            actualGeneration: resource.generation,
          },
        ),
      );
    }
    resources.push(resource);
  }
  return ok({ generation, readiness: 'ready', resources: Object.freeze(resources) });
}
