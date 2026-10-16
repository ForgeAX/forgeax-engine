import type { AssetRegistryResolver, RuntimeAssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  getAssetRegistryResolver,
  AssetRegistry as LegacyAssetRegistry,
} from '@forgeax/engine-assets-runtime';
import { createWorldContext, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type {
  Asset,
  AssetDecoderLease,
  MaterialAsset,
  MeshAsset,
  Result,
  TextureAsset,
} from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import type {
  ParticleEffectInstance,
  VfxChannelInput,
  VfxDataInterfaceError,
  VfxDataInterfaceProvider,
  VfxDataInterfaceRequirement,
  VfxDataInterfaceResolution,
  VfxGpuPlayerInspectSnapshot,
  VfxGpuRuntimeDiagnostic,
  VfxReplayInput,
  VfxValueMap,
} from '@forgeax/engine-vfx';
import {
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
  vfxGpuEffectContribution,
  vfxGpuEffectPackLoader,
  vfxGpuRuntimePlugin,
} from '@forgeax/engine-vfx';
import type { ParticleRenderCameraSource } from '../feature/camera.js';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature.js';
import {
  createVfxDataInterfaceRegistry,
  type VfxDataInterfaceRegistry,
} from './data-interface-providers.js';

const stockMaterialProjection = LegacyAssetRegistry.prototype.getMaterialProjectionForPayload;

/**
 * Public authoring projection accepted by the VFX host. Editor owns the
 * projection, while the Engine App still owns bytes/decoders/cache. Keeping
 * this small structural seam public lets the Editor pass that projection
 * without importing the runtime registry's internal module or fabricating a
 * second registry identity.
 */
export interface VfxAuthoringAssetRegistry {
  readonly loaders: {
    registerPackLoader(loader: unknown): void;
  };
  lookup<T extends Asset = Asset>(guid: string): T | undefined;
  readonly load?: (guid: string, kind: string) => Promise<Result<unknown, unknown>>;
}

type AssetRegistry = LegacyAssetRegistry | RuntimeAssetRegistry | VfxAuthoringAssetRegistry;

export interface VfxRuntimeHostOptions {
  readonly camera: ParticleRenderCameraSource;
  readonly sceneSdf?: {
    read(
      world: World,
    ): import('@forgeax/engine-render').RenderFeatureSceneSdfDescriptor | undefined;
  };
  readonly maxQueuedTicks?: number;
  readonly providers?: readonly VfxDataInterfaceProvider[];
}

export interface VfxRuntimeHostError {
  readonly code:
    | 'vfx-host-loader-install-failed'
    | 'vfx-host-world-attach-failed'
    | 'vfx-host-world-detach-failed';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly cause: unknown };
}

export interface VfxRuntimeHostControlError {
  readonly code:
    | 'vfx-host-control-world-detached'
    | 'vfx-host-control-stale-generation'
    | 'vfx-host-control-runtime-unavailable'
    | 'vfx-host-control-player-unavailable'
    | 'vfx-host-control-instance-rejected';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly requestedGeneration?: number;
    readonly currentGeneration?: number;
    readonly player?: EntityHandle;
    readonly causeCode?: string;
  };
}

export interface VfxRuntimeHostControl {
  readonly generation: number;
  replay(input: {
    readonly player: EntityHandle;
    readonly replayInput?: VfxReplayInput<VfxValueMap>;
  }): Result<{ readonly state: 'queued'; readonly generation: number }, VfxRuntimeHostControlError>;
  setEmitterSessionEnabled(input: {
    readonly player: EntityHandle;
    readonly emitterId: string;
    readonly enabled: boolean;
  }): Result<
    {
      readonly state: 'enabled' | 'disabled';
      readonly generation: number;
    },
    VfxRuntimeHostControlError
  >;
  setPlayerRenderConsumption(input: {
    readonly player: EntityHandle;
    readonly enabled: boolean;
  }): Result<
    {
      readonly state: 'enabled' | 'paused';
      readonly generation: number;
    },
    VfxRuntimeHostControlError
  >;
  patchPlayerParameters(input: {
    readonly player: EntityHandle;
    readonly values: Partial<VfxValueMap>;
  }): Result<
    {
      readonly state: 'queued';
      readonly generation: number;
      readonly parameterGeneration: number;
      readonly pendingPatchCount: number;
    },
    VfxRuntimeHostControlError
  >;
  submitChannel(input: {
    readonly player: EntityHandle;
    readonly channel: string;
    readonly payload: VfxChannelInput['payload'];
    readonly sequence: number;
  }): Result<
    {
      readonly state: 'queued';
      readonly generation: number;
    },
    VfxRuntimeHostControlError
  >;
}

export interface VfxRuntimeHost {
  readonly feature: ReturnType<typeof gpuParticleRenderFeature>;
  readonly dataInterfaces: VfxDataInterfaceRegistry;
  inspect(world: World): VfxRuntimeHostInspectSnapshot | undefined;
  acquireControl(world: World): Result<VfxRuntimeHostControl, VfxRuntimeHostControlError>;
  resolveDataInterfaces(input: {
    readonly requirements: readonly VfxDataInterfaceRequirement[];
    readonly generation: number;
  }): Result<VfxDataInterfaceResolution, VfxDataInterfaceError>;
  attachWorld(input: {
    readonly world: World;
    readonly assets: AssetRegistry;
  }): Promise<Result<{ readonly state: 'attached' | 'already-attached' }, VfxRuntimeHostError>>;
  detachWorld(input: {
    readonly world: World;
  }): Promise<Result<{ readonly state: 'detached' | 'not-attached' }, VfxRuntimeHostError>>;
}

/** Install the VFX owner decoder into the core registry. */
export function installVfxRuntimeDecoder(registry: RuntimeAssetRegistry): AssetDecoderLease {
  return registry.installDecoder(vfxGpuEffectContribution.kind, vfxGpuEffectContribution.decoder);
}

export interface VfxRuntimeHostInspectSnapshot {
  readonly generation: number;
  /** VFX GPU resource generation; distinct from host attachment generation. */
  readonly renderGeneration: number;
  readonly players: readonly VfxGpuPlayerInspectSnapshot[];
  readonly diagnostics: readonly VfxGpuRuntimeDiagnostic[];
}

type PluginContext = Awaited<ReturnType<typeof createWorldContext>>;

function failure(
  code: VfxRuntimeHostError['code'],
  expected: string,
  hint: string,
  cause: unknown,
): VfxRuntimeHostError {
  return { code, expected, hint, detail: { cause } };
}

function controlFailure(
  code: VfxRuntimeHostControlError['code'],
  expected: string,
  hint: string,
  detail: VfxRuntimeHostControlError['detail'] = {},
): VfxRuntimeHostControlError {
  return { code, expected, hint, detail };
}

export function createVfxRuntimeHost(options: VfxRuntimeHostOptions): VfxRuntimeHost {
  const registries = new WeakSet<AssetRegistry>();
  const worlds = new WeakMap<
    World,
    {
      readonly assets: AssetRegistry;
      readonly resolver: AssetRegistryResolver | undefined;
      readonly generation: number;
      readonly pluginContext: PluginContext;
      readonly renderAssets: Map<string, MaterialAsset | MeshAsset | TextureAsset>;
      readonly pendingRenderAssets: Map<string, Promise<void>>;
      readonly unsubscribeAssets: () => void;
      catalogEpoch: number;
    }
  >();
  const pausedPlayers = new WeakMap<World, Set<EntityHandle>>();
  let nextGeneration = 1;
  const dataInterfaces = createVfxDataInterfaceRegistry(options.providers);
  const readRenderAsset = <Kind extends 'material' | 'mesh' | 'texture'>(
    world: World,
    guid: string,
    kind: Kind,
  ):
    | (Kind extends 'material' ? MaterialAsset : Kind extends 'mesh' ? MeshAsset : TextureAsset)
    | undefined => {
    const attached = worlds.get(world);
    if (attached === undefined) return undefined;
    // The maintained Engine registry exposes its payload-cache epoch directly;
    // frontend projections expose snapshot/subscribe below. Reuse that stamp
    // so same-GUID publication cannot retain an old field payload.
    if (
      'catalogEpoch' in attached.assets &&
      typeof attached.assets.catalogEpoch === 'number' &&
      attached.assets.catalogEpoch !== attached.catalogEpoch
    ) {
      attached.catalogEpoch = attached.assets.catalogEpoch;
      for (const [key, asset] of attached.renderAssets)
        if (asset.kind !== 'texture') attached.renderAssets.delete(key);
      attached.pendingRenderAssets.clear();
    }
    const key = `${kind}:${guid.toLowerCase()}`;
    const cached = attached.renderAssets.get(key);
    const previous =
      cached?.kind === kind
        ? (cached as Kind extends 'material'
            ? MaterialAsset
            : Kind extends 'mesh'
              ? MeshAsset
              : TextureAsset)
        : undefined;
    if (kind !== 'texture' && previous !== undefined) return previous;
    if ('lookup' in attached.assets) {
      const lookup = attached.assets.lookup as (guid: string) => Asset | undefined;
      // Preserve the registry receiver: the Engine-owned legacy class uses
      // `this` to read its load-state/catalogue maps. The Editor facade may
      // expose an arrow function, but calling through the owner is safe for
      // both shapes and avoids turning a lookup into a swallowed plan error.
      const legacy = lookup.call(attached.assets, guid);
      if (legacy?.kind === kind) {
        attached.renderAssets.set(key, legacy);
        return legacy as Kind extends 'material'
          ? MaterialAsset
          : Kind extends 'mesh'
            ? MeshAsset
            : TextureAsset;
      }
    }
    const resolved = attached.resolver?.lookup<MaterialAsset | MeshAsset | TextureAsset>(guid);
    if (resolved?.kind === kind) {
      attached.renderAssets.set(key, resolved);
      return resolved as Kind extends 'material'
        ? MaterialAsset
        : Kind extends 'mesh'
          ? MeshAsset
          : TextureAsset;
    }
    if (!attached.pendingRenderAssets.has(key)) {
      const epoch = attached.catalogEpoch;
      const assets = attached.assets;
      const loading =
        'loadByGuid' in assets
          ? assets.loadByGuid<MaterialAsset | MeshAsset | TextureAsset>(assets.parseGuid(guid))
          : 'load' in assets && typeof assets.load === 'function'
            ? assets.load(guid, kind)
            : undefined;
      if (loading === undefined) return undefined;
      const request = loading
        .then((result) => {
          if (worlds.get(world) !== attached || attached.catalogEpoch !== epoch) return;
          if (!result.ok) {
            attached.renderAssets.delete(key);
            return;
          }
          const asset = result.value as Asset;
          if (asset.kind === kind)
            attached.renderAssets.set(key, asset as MaterialAsset | MeshAsset | TextureAsset);
          else attached.renderAssets.delete(key);
        })
        .catch(() => {
          if (worlds.get(world) === attached && attached.catalogEpoch === epoch)
            attached.renderAssets.delete(key);
        });
      attached.pendingRenderAssets.set(key, request);
      void request.finally(() => {
        if (attached.pendingRenderAssets.get(key) === request) {
          attached.pendingRenderAssets.delete(key);
        }
      });
    }
    // A replacement keeps the last admitted field until the ordinary owner
    // finishes loading. A missing/rejected replacement revokes it; initial
    // absence remains the feature's structured missing-asset error.
    return previous;
  };
  const feature = gpuParticleRenderFeature({
    camera: options.camera,
    ...(options.sceneSdf === undefined ? {} : { sceneSdf: options.sceneSdf }),
    dataInterfaces,
    material: {
      read: (world, guid) => readRenderAsset(world, guid, 'material'),
      projection: (world, material) => {
        const assets = worlds.get(world)?.assets;
        if (assets === undefined || !('getMaterialProjectionForPayload' in assets))
          return undefined;
        const readProjection = assets.getMaterialProjectionForPayload;
        const projection = readProjection.call(assets, material);
        // The stock registry owns plain cooked pass records. Ordinary raster
        // variants are never consumed by particleMaterialPass's fallback.
        // Keep custom providers and every non-raster pass unchanged.
        return readProjection === stockMaterialProjection &&
          projection?.passes.every(
            (pass) =>
              pass.name === 'forward' || pass.name === 'deferred' || pass.name === 'shadow-caster',
          )
          ? undefined
          : projection;
      },
    },
    mesh: { read: (world, guid) => readRenderAsset(world, guid, 'mesh') },
    texture: { read: (world, guid) => readRenderAsset(world, guid, 'texture') },
    playerConsumption: {
      isEnabled: (world, player) => !pausedPlayers.get(world)?.has(player),
    },
  });
  return {
    feature,
    dataInterfaces,
    inspect: (world) => {
      const attached = worlds.get(world);
      if (attached === undefined || !world.hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY))
        return undefined;
      const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
      return Object.freeze({
        generation: attached.generation,
        renderGeneration: runtime.renderGeneration,
        players: runtime.inspectPlayers(),
        diagnostics: runtime.diagnostics(),
      });
    },
    acquireControl: (world) => {
      const attached = worlds.get(world);
      if (attached === undefined) {
        return err(
          controlFailure(
            'vfx-host-control-world-detached',
            'an attached VFX Runtime World',
            'attach the World to this VfxRuntimeHost before acquiring controls',
          ),
        );
      }
      const requestedGeneration = attached.generation;
      const withRuntime = <T>(
        player: EntityHandle,
        action: (runtime: VfxGpuRuntime) => T,
      ): Result<T, VfxRuntimeHostControlError> => {
        const current = worlds.get(world);
        if (current === undefined) {
          return err(
            controlFailure(
              'vfx-host-control-world-detached',
              `VFX host generation ${requestedGeneration} to remain attached`,
              'reacquire controls after the World is attached again',
              { requestedGeneration },
            ),
          );
        }
        if (current.generation !== requestedGeneration) {
          return err(
            controlFailure(
              'vfx-host-control-stale-generation',
              `VFX host generation ${requestedGeneration}`,
              'discard this stale control lease and acquire one from the current host generation',
              { requestedGeneration, currentGeneration: current.generation },
            ),
          );
        }
        if (!world.hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY)) {
          return err(
            controlFailure(
              'vfx-host-control-runtime-unavailable',
              'the attached World to own its VFX GPU runtime resource',
              'repair the host attachment before retrying the preview command',
              { requestedGeneration, currentGeneration: current.generation },
            ),
          );
        }
        if (!world.get(player, ParticleEffectPlayer).ok) {
          return err(
            controlFailure(
              'vfx-host-control-player-unavailable',
              'a live entity with ParticleEffectPlayer in the attached World',
              'discard the stale player handle or target a VFX player owned by this World',
              { requestedGeneration, currentGeneration: current.generation, player },
            ),
          );
        }
        return ok(action(world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY)));
      };
      type InstanceAction<T> =
        | { readonly kind: 'value'; readonly value: T }
        | { readonly kind: 'error'; readonly causeCode: string };
      const withInstance = <T>(
        player: EntityHandle,
        action: (instance: ParticleEffectInstance) => Result<T, { readonly code: string }>,
      ): Result<T, VfxRuntimeHostControlError> => {
        const result = withRuntime(player, (runtime): InstanceAction<T> => {
          const instance = runtime.getInstance(player);
          if (instance === undefined) {
            return { kind: 'error', causeCode: 'vfx-instance-unavailable' };
          }
          const outcome = action(instance);
          return outcome.ok
            ? { kind: 'value', value: outcome.value }
            : { kind: 'error', causeCode: outcome.error.code };
        });
        if (!result.ok) return result;
        if (result.value.kind === 'error') {
          return err(
            controlFailure(
              'vfx-host-control-instance-rejected',
              'the live typed VFX instance to accept this control input',
              'run one fixed tick or repair the reflected instance contract before retrying',
              {
                requestedGeneration,
                currentGeneration: requestedGeneration,
                player,
                causeCode: result.value.causeCode,
              },
            ),
          );
        }
        return ok(result.value.value);
      };
      const control: VfxRuntimeHostControl = {
        generation: requestedGeneration,
        replay: ({ player, replayInput }) =>
          withRuntime(player, (runtime) => {
            runtime.replay(player, replayInput);
            return Object.freeze({ state: 'queued' as const, generation: requestedGeneration });
          }),
        setEmitterSessionEnabled: ({ player, emitterId, enabled }) =>
          withRuntime(player, (runtime) => {
            runtime.setEmitterSessionEnabled(player, emitterId, enabled);
            return Object.freeze({
              state: enabled ? ('enabled' as const) : ('disabled' as const),
              generation: requestedGeneration,
            });
          }),
        setPlayerRenderConsumption: ({ player, enabled }) =>
          withRuntime(player, () => {
            let paused = pausedPlayers.get(world);
            if (enabled) {
              paused?.delete(player);
              if (paused !== undefined && paused.size === 0) pausedPlayers.delete(world);
            } else {
              paused ??= new Set();
              paused.add(player);
              pausedPlayers.set(world, paused);
            }
            return Object.freeze({
              state: enabled ? ('enabled' as const) : ('paused' as const),
              generation: requestedGeneration,
            });
          }),
        patchPlayerParameters: ({ player, values }) =>
          withInstance(player, (instance) => {
            const patched = instance.patch(values);
            if (!patched.ok) return patched;
            return ok({
              state: 'queued' as const,
              generation: requestedGeneration,
              parameterGeneration: instance.generation,
              pendingPatchCount: instance.pendingPatchCount,
            });
          }),
        submitChannel: ({ player, channel, payload, sequence }) =>
          withInstance(player, (instance) => {
            const submitted = instance.submit({ channel, payload, sequence });
            if (!submitted.ok) return submitted;
            return ok({ state: 'queued' as const, generation: requestedGeneration });
          }),
      };
      return ok(Object.freeze(control));
    },
    resolveDataInterfaces: ({ requirements, generation }) =>
      dataInterfaces.resolve(requirements, generation),
    attachWorld: async ({ world, assets }) => {
      if (worlds.has(world)) return ok({ state: 'already-attached' });
      if (!registries.has(assets)) {
        try {
          // The Editor facade deliberately exposes the legacy LoaderRegistry
          // while projecting the Engine-owned App.assets instance. Prefer
          // that public authoring seam before looking for the five-action
          // runtime registry; otherwise a facade that happens to expose
          // `load` would be misclassified as a decoder owner.
          if ('loaders' in assets) {
            assets.loaders.registerPackLoader(vfxGpuEffectPackLoader);
          } else if ('installDecoder' in assets) {
            assets.installDecoder(vfxGpuEffectContribution.kind, vfxGpuEffectContribution.decoder);
          } else {
            throw new TypeError('VFX assets registry exposes neither loaders nor installDecoder');
          }
          registries.add(assets);
        } catch (cause) {
          return err(
            failure(
              'vfx-host-loader-install-failed',
              'the Program v3 VFX loader to be registered once',
              'remove a conflicting particle-effect loader and retry attachWorld',
              cause,
            ),
          );
        }
      }
      let pluginContext: PluginContext;
      try {
        pluginContext = await createWorldContext(world, [
          vfxGpuRuntimePlugin(
            options.maxQueuedTicks === undefined ? {} : { maxQueuedTicks: options.maxQueuedTicks },
          ),
        ]);
      } catch (cause) {
        return err(
          failure(
            'vfx-host-world-attach-failed',
            'the World FixedUpdate VFX intent producer to install',
            'repair the reported World registration conflict and retry',
            cause,
          ),
        );
      }
      let resolver: AssetRegistryResolver | undefined;
      if (!('loaders' in assets) && 'installDecoder' in assets) {
        try {
          resolver = getAssetRegistryResolver(assets);
        } catch {
          resolver = undefined;
        }
      }
      const attached = {
        assets,
        resolver,
        pluginContext,
        generation: nextGeneration++,
        renderAssets: new Map<string, MaterialAsset | MeshAsset | TextureAsset>(),
        pendingRenderAssets: new Map<string, Promise<void>>(),
        catalogEpoch:
          'catalogEpoch' in assets && typeof assets.catalogEpoch === 'number'
            ? assets.catalogEpoch
            : 'snapshot' in assets && typeof assets.snapshot === 'function'
              ? assets.snapshot().epoch
              : 0,
        unsubscribeAssets: () => {},
      };
      if ('subscribe' in assets && typeof assets.subscribe === 'function') {
        attached.unsubscribeAssets = assets.subscribe((snapshot) => {
          if (snapshot.epoch === attached.catalogEpoch) return;
          attached.catalogEpoch = snapshot.epoch;
          for (const [key, asset] of attached.renderAssets)
            if (asset.kind !== 'texture') attached.renderAssets.delete(key);
          attached.pendingRenderAssets.clear();
        });
      }
      worlds.set(world, attached);
      return ok({ state: 'attached' });
    },
    detachWorld: async ({ world }) => {
      const attached = worlds.get(world);
      if (attached === undefined) return ok({ state: 'not-attached' });
      try {
        await attached.pluginContext.fiber.dispose();
      } catch (cause) {
        return err(
          failure(
            'vfx-host-world-detach-failed',
            'the VFX FixedUpdate producer to detach exactly once',
            'inspect the World schedule and retry detachWorld',
            cause,
          ),
        );
      }
      pausedPlayers.delete(world);
      attached.unsubscribeAssets();
      attached.renderAssets.clear();
      attached.pendingRenderAssets.clear();
      worlds.delete(world);
      return ok({ state: 'detached' });
    },
  };
}
