import { err, ok, type Result } from '@forgeax/engine-types';
import {
  resolveVfxDataInterfaces,
  type VfxDataInterfaceCaptureContext,
  type VfxDataInterfaceError,
  type VfxDataInterfaceKind,
  type VfxDataInterfaceProvider,
  type VfxDataInterfaceRecoveryLease,
  type VfxDataInterfaceRequirement,
  type VfxDataInterfaceResolution,
  type VfxDataInterfaceResource,
  type VfxDataInterfaceTextureView,
  type VfxDataInterfaceToken,
  type VfxWaterSurfaceIdentity,
} from '@forgeax/engine-vfx';

export type { VfxDataInterfaceProvider } from '@forgeax/engine-vfx';

export interface VfxDataInterfaceAvailabilitySource {
  readonly available: (generation: number, context?: VfxDataInterfaceCaptureContext) => boolean;
  readonly sampleCount?: 1 | 4;
  readonly resource?: (
    generation: number,
    context?: VfxDataInterfaceCaptureContext,
  ) => VfxDataInterfaceResource['resource'] | undefined;
  readonly recovery?: (
    generation: number,
    context?: VfxDataInterfaceCaptureContext,
  ) => VfxDataInterfaceResource['recovery'] | undefined;
  readonly retainRecovery?: VfxDataInterfaceProvider['retainRecovery'];
}

export interface VfxWaterSurfaceAvailabilitySource {
  readonly available: (generation: number) => boolean;
  readonly surface: (generation: number) =>
    | {
        readonly identity: VfxWaterSurfaceIdentity;
        readonly grid: VfxDataInterfaceTextureView;
        readonly solverNormal: VfxDataInterfaceTextureView;
      }
    | undefined;
}

export interface VfxDataInterfaceRegistry {
  readonly providers: readonly VfxDataInterfaceProvider[];
  readonly snapshot:
    | {
        readonly generation: number;
        readonly result: Result<VfxDataInterfaceResolution, VfxDataInterfaceError>;
      }
    | undefined;
  register(provider: VfxDataInterfaceProvider): Result<void, VfxDataInterfaceError>;
  retainRecovery(
    resource: VfxDataInterfaceResource,
  ): Result<VfxDataInterfaceRecoveryLease | undefined, VfxDataInterfaceError>;
  resolve(
    requirements: readonly VfxDataInterfaceRequirement[],
    generation: number,
    context?: VfxDataInterfaceCaptureContext,
  ): Result<VfxDataInterfaceResolution, VfxDataInterfaceError>;
}

function duplicate(token: VfxDataInterfaceToken, providerId: string): VfxDataInterfaceError {
  return {
    code: 'vfx-data-interface-duplicate',
    expected: 'at most one provider for each reflected Data Interface token',
    hint: `remove provider ${providerId} or the existing provider for ${token} and retry`,
    detail: { token, providerId },
  };
}

function availableProvider<K extends VfxDataInterfaceKind>(
  token: VfxDataInterfaceProvider<K>['token'],
  kind: K,
  bindingType: VfxDataInterfaceProvider<K>['bindingType'],
  source: VfxDataInterfaceAvailabilitySource,
): VfxDataInterfaceProvider<K> {
  return {
    id: `${token}-provider`,
    token,
    kind,
    bindingType,
    ...(source.retainRecovery === undefined ? {} : { retainRecovery: source.retainRecovery }),
    provide: (generation, context) => {
      if (!source.available(generation, context)) {
        return err({
          code: 'vfx-data-interface-missing',
          expected: `an available ${kind} provider for ${token}`,
          hint: `make ${token} available for generation ${generation} and retry rendering`,
          detail: { token, providerId: `${token}-provider` },
        });
      }
      const prepared = source.resource?.(generation, context);
      if (prepared === undefined) {
        return err({
          code: 'vfx-data-interface-missing',
          expected: `a resident ${kind} resource for ${token}`,
          hint: `provide the generation-owned ${kind} resource before rendering`,
          detail: {
            token,
            providerId: `${token}-provider`,
            expectedResourceKind: kind === 'camera' ? 'buffer' : 'texture-view',
          },
        });
      }
      const recovery = source.recovery?.(generation, context);
      const resource: VfxDataInterfaceResource = {
        token,
        kind,
        bindingType,
        generation,
        ...(source.sampleCount === undefined ? {} : { sampleCount: source.sampleCount }),
        resource: prepared,
        ...(recovery === undefined ? {} : { recovery }),
      };
      return ok(resource);
    },
  };
}

export function createCameraProvider(
  source: VfxDataInterfaceAvailabilitySource,
): VfxDataInterfaceProvider<'camera'> {
  return availableProvider('vfx:camera', 'camera', 'uniform', source);
}

export function createSceneDepthProvider(
  source: VfxDataInterfaceAvailabilitySource,
): VfxDataInterfaceProvider<'scene-depth'> {
  return availableProvider('vfx:scene-depth', 'scene-depth', 'sampled-depth', source);
}

/** One provider atomically binds the Water grid and its matching solver-normal view. */
export function createWaterSurfaceProvider(
  source: VfxWaterSurfaceAvailabilitySource,
): VfxDataInterfaceProvider<'water-surface'> {
  return {
    id: 'vfx:water-surface-provider',
    token: 'vfx:water-surface',
    kind: 'water-surface',
    bindingType: 'sampled-float-pair',
    provide(generation) {
      if (!source.available(generation))
        return err({
          code: 'vfx-data-interface-missing',
          expected: 'an available paired Water grid + solver-normal source',
          hint: `make the complete Water source pair available for host generation ${generation}`,
          detail: { token: 'vfx:water-surface', providerId: 'vfx:water-surface-provider' },
        });
      const surface = source.surface(generation);
      if (surface === undefined)
        return err({
          code: 'vfx-data-interface-missing',
          expected: 'one complete generation-qualified Water grid + solver-normal pair',
          hint: 'publish both Water texture views from the same accepted frame and lineage',
          detail: { token: 'vfx:water-surface', providerId: 'vfx:water-surface-provider' },
        });
      return ok({
        token: 'vfx:water-surface',
        kind: 'water-surface',
        bindingType: 'sampled-float-pair',
        generation,
        resource: { kind: 'texture-view', value: surface.grid.value },
        waterSurface: surface.identity,
        textureViewPair: {
          grid: surface.grid,
          solverNormal: surface.solverNormal,
        },
      });
    },
  };
}

export function createVfxDataInterfaceRegistry(
  initialProviders: readonly VfxDataInterfaceProvider[] = [],
): VfxDataInterfaceRegistry {
  const entries = new Map<VfxDataInterfaceToken, VfxDataInterfaceProvider>();
  let registrationError: VfxDataInterfaceError | undefined;
  let lastSnapshot: VfxDataInterfaceRegistry['snapshot'];
  const registry: VfxDataInterfaceRegistry = {
    get providers() {
      return Object.freeze([...entries.values()]);
    },
    get snapshot() {
      return lastSnapshot;
    },
    register(provider) {
      if (entries.has(provider.token)) {
        const error = duplicate(provider.token, provider.id);
        registrationError ??= error;
        return err(error);
      }
      entries.set(provider.token, provider);
      return ok(undefined);
    },
    retainRecovery(resource) {
      if (!resource.recovery) return ok(undefined);
      const provider = entries.get(resource.token);
      if (!provider?.retainRecovery)
        return err({
          code: 'vfx-data-interface-missing',
          expected: 'a source owner lease for the exact temporal producer version',
          hint: 'provide retainRecovery and keep the source checkpoint/tape alive until its VFX input history is released',
          detail: {
            token: resource.token,
            ...(provider === undefined ? {} : { providerId: provider.id }),
          },
        });
      return provider.retainRecovery(resource.recovery);
    },
    resolve(requirements, generation, context) {
      const result =
        registrationError === undefined
          ? resolveVfxDataInterfaces(requirements, [...entries.values()], generation, context)
          : err(registrationError);
      lastSnapshot = Object.freeze({ generation, result });
      return result;
    },
  };
  for (const provider of initialProviders) registry.register(provider);
  return registry;
}
