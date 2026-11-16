import { err, ok, type Result } from '@forgeax/engine-types';

export type VfxDataInterfaceKind = keyof VfxDataInterfaceBindingTypeByKind;

export type VfxDataInterfaceToken = `vfx:${VfxDataInterfaceKind}`;

export type VfxDataInterfaceBindingType = VfxDataInterfaceBindingTypeByKind[VfxDataInterfaceKind];

export type VfxDataInterfaceResourceKind = NonNullable<
  VfxDataInterfaceResource['resource']
>['kind'];

type VfxDataInterfaceBindingTypeByKind = {
  readonly camera: 'uniform';
  readonly 'scene-depth': 'sampled-depth';
  readonly noise: 'sampled-float';
  readonly 'scene-sdf': 'read-only-storage';
  readonly 'force-fields': 'read-only-storage';
  /** One provider and one source descriptor, bound as grid + solver-normal views. */
  readonly 'water-surface': 'sampled-float-pair';
};

export type VfxDataInterfaceLifetime = 'generation';

export interface VfxDataInterfaceRequirement {
  readonly token: VfxDataInterfaceToken;
  readonly kind: VfxDataInterfaceKind;
  readonly binding: number;
  /** Second atomic Water-surface slot; present only for `water-surface`. */
  readonly solverNormalBinding?: number;
  /** CPU-owned lattice metadata projected into the same compute group. */
  readonly domainBinding?: number;
  /** Per-tick authored grid-emission limits and curves, present for C04 emitters. */
  readonly waterEmissionBinding?: number;
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
  /** CPU identity/domain which qualifies the paired Water resources. */
  readonly waterSurface?: VfxWaterSurfaceIdentity;
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
  /** Atomic pair; both members are prepared or rejected together. */
  readonly textureViewPair?: {
    readonly grid: VfxDataInterfaceTextureView;
    readonly solverNormal: VfxDataInterfaceTextureView;
  };
}

export interface VfxDataInterfaceTextureView {
  /** RenderFeatureTextureReference for graph outputs, or a prepared resident view. */
  readonly value: unknown;
  /** Exact RenderFeatureTextureReference when the texture is produced in this frame. */
  readonly logicalTarget?: unknown;
  /** Exact Pack texture identity when Render must resolve the view from its asset owner. */
  readonly asset?: Readonly<{ guid: string; revision: number }>;
  /** Frame-candidate pin for an exact resident asset version. */
  readonly retainResidency?: () => { release(evict?: boolean): void };
}

export interface VfxWaterSurfaceIdentity {
  readonly bodyGuid: string;
  /** Current Water Body binding generation. */
  readonly bodyBindingGeneration: number;
  /** Captured source Body generation retained as lineage. */
  readonly sourceBodyGeneration: number;
  readonly source: 'live' | 'baked';
  readonly sourceRecipeGuid: string;
  readonly simulationGeneration: number;
  readonly sequence: number;
  readonly sourceFrame: Readonly<{
    readonly generation: number;
    readonly sequence: number;
    readonly step: number;
    readonly timeSeconds: number;
  }>;
  readonly completion?: Readonly<{
    readonly frameId: number;
    readonly deviceGeneration: number;
    readonly graphGeneration: number;
  }>;
  readonly domain: Readonly<{
    readonly originXZ: readonly [number, number];
    readonly originY: number;
    readonly spacingXZ: readonly [number, number];
    readonly resolution: readonly [number, number];
    readonly yawRadians: number;
    readonly basis: 'lattice-axis0-axis1-up/1';
  }>;
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
    case 'water-surface':
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
  const indexProviders = (
    providers: readonly VfxDataInterfaceProvider[],
    requirements: readonly VfxDataInterfaceRequirement[],
    byToken: Map<VfxDataInterfaceToken, VfxDataInterfaceProvider>,
  ) => {
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

    return undefined;
  };
  const indexed = indexProviders(providers, requirements, byToken);
  if (indexed !== undefined) return indexed;

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
    const validateWaterPair = (
      requirement: VfxDataInterfaceRequirement,
      resource: VfxDataInterfaceResource,
      provider: VfxDataInterfaceProvider,
    ) => {
      if (requirement.kind === 'water-surface') {
        const pair = resource.textureViewPair;
        const surface = resource.waterSurface;
        const validView = (view: VfxDataInterfaceTextureView | undefined) =>
          view !== undefined &&
          ((view.value !== undefined && view.value !== null) ||
            view.logicalTarget !== undefined ||
            (typeof view.asset?.guid === 'string' &&
              view.asset.guid.length > 0 &&
              Number.isSafeInteger(view.asset.revision) &&
              view.asset.revision >= 0));
        if (
          pair === undefined ||
          !validView(pair.grid) ||
          !validView(pair.solverNormal) ||
          surface === undefined ||
          !validWaterSurfaceIdentity(surface)
        )
          return err(
            failure(
              'vfx-data-interface-missing',
              requirement,
              'one complete Water grid + solver-normal pair with matching source identity and domain',
              `refresh provider ${provider.id} with both current Water texture views and their CPU lineage/domain`,
              { providerId: provider.id },
            ),
          );
      }

      return undefined;
    };
    const pairError = validateWaterPair(requirement, resource, provider);
    if (pairError !== undefined) return pairError;
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
  return ok({ generation, resources: Object.freeze(resources) });
}

function validWaterSurfaceIdentity(value: VfxWaterSurfaceIdentity): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value.sourceFrame;
  const domain = value.domain;
  const completion = value.completion;
  const pair = (candidate: unknown): candidate is readonly [number, number] =>
    Array.isArray(candidate) && candidate.length === 2 && candidate.every(Number.isFinite);
  const resolution = (candidate: unknown): candidate is readonly [number, number] =>
    Array.isArray(candidate) &&
    candidate.length === 2 &&
    candidate.every((part) => Number.isSafeInteger(part) && part > 0);
  const nonNegativeIntegers = (...parts: unknown[]) =>
    parts.every((part) => Number.isSafeInteger(part) && (part as number) >= 0);
  const validateIdentityRecords = (value: VfxWaterSurfaceIdentity) => {
    if (
      typeof value.bodyGuid !== 'string' ||
      value.bodyGuid.length === 0 ||
      (value.source !== 'live' && value.source !== 'baked') ||
      typeof value.sourceRecipeGuid !== 'string' ||
      value.sourceRecipeGuid.length === 0 ||
      frame === null ||
      typeof frame !== 'object' ||
      Array.isArray(frame) ||
      domain === null ||
      typeof domain !== 'object' ||
      Array.isArray(domain)
    )
      return false;

    return true;
  };
  if (!validateIdentityRecords(value)) return false;
  return (
    nonNegativeIntegers(
      value.bodyBindingGeneration,
      value.sourceBodyGeneration,
      value.simulationGeneration,
      value.sequence,
      frame.generation,
      frame.sequence,
      frame.step,
    ) &&
    Number.isFinite(frame.timeSeconds) &&
    value.sequence === frame.sequence &&
    (completion === undefined ||
      (completion !== null &&
        typeof completion === 'object' &&
        !Array.isArray(completion) &&
        nonNegativeIntegers(
          completion.frameId,
          completion.deviceGeneration,
          completion.graphGeneration,
        ))) &&
    pair(domain.originXZ) &&
    Number.isFinite(domain.originY) &&
    pair(domain.spacingXZ) &&
    domain.spacingXZ.every((part) => part > 0) &&
    resolution(domain.resolution) &&
    Number.isFinite(domain.yawRadians) &&
    domain.basis === 'lattice-axis0-axis1-up/1'
  );
}
