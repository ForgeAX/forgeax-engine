import { err, ok, type Result } from '@forgeax/engine-types';
import {
  resolveVfxDataInterfaces,
  type VfxDataInterfaceError,
  type VfxDataInterfaceKind,
  type VfxDataInterfaceProvider,
  type VfxDataInterfaceRequirement,
  type VfxDataInterfaceResolution,
  type VfxDataInterfaceResource,
  type VfxDataInterfaceToken,
} from '@forgeax/engine-vfx';

export type { VfxDataInterfaceProvider } from '@forgeax/engine-vfx';

export interface VfxDataInterfaceAvailabilitySource {
  readonly available: (generation: number) => boolean;
  readonly sampleCount?: 1 | 4;
  readonly resource?: (generation: number) => VfxDataInterfaceResource['resource'] | undefined;
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
  resolve(
    requirements: readonly VfxDataInterfaceRequirement[],
    generation: number,
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
    provide: (generation) => {
      if (!source.available(generation)) {
        return err({
          code: 'vfx-data-interface-missing',
          expected: `an available ${kind} provider for ${token}`,
          hint: `make ${token} available for generation ${generation} and retry rendering`,
          detail: { token, providerId: `${token}-provider` },
        });
      }
      const prepared = source.resource?.(generation);
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
      const resource: VfxDataInterfaceResource = {
        token,
        kind,
        bindingType,
        generation,
        ...(source.sampleCount === undefined ? {} : { sampleCount: source.sampleCount }),
        resource: prepared,
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

export function createNoiseProvider(
  source: VfxDataInterfaceAvailabilitySource,
): VfxDataInterfaceProvider<'noise'> {
  return availableProvider('vfx:noise', 'noise', 'sampled-float', source);
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
    resolve(requirements, generation) {
      const result =
        registrationError === undefined
          ? resolveVfxDataInterfaces(requirements, [...entries.values()], generation)
          : err(registrationError);
      lastSnapshot = Object.freeze({ generation, result });
      return result;
    },
  };
  for (const provider of initialProviders) registry.register(provider);
  return registry;
}
