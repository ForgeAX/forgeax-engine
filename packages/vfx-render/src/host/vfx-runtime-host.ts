import { AssetRegistry, type MaterialRenderProjection } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { createWorldContext, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type {
  AssetDecoderLease,
  AssetHandle,
  MaterialAsset,
  MeshAsset,
  Result,
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
  particleEffectContribution,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
  vfxGpuRuntimePlugin,
} from '@forgeax/engine-vfx';
import type { ParticleRenderCameraSource } from '../feature/camera.js';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature.js';
import {
  createHostMaterialSource,
  selectParticleMaterialContext,
} from '../feature/material-source.js';
import {
  createVfxDataInterfaceRegistry,
  type VfxDataInterfaceRegistry,
} from './data-interface-providers.js';

const stockMaterialProjection = AssetRegistry.prototype.getMaterialProjectionForPayload;

export interface VfxRuntimeHostOptions {
  /** Opt-in same-build A/B for separately validated view-local particle work. */
  readonly isolateViewGraph?: boolean;
  readonly instanceArenas?: boolean;
  readonly nativePlanning?: boolean;
  /** Retain native simulation/projection resources; raw and DI effects keep ordinary preparation. */
  readonly retainedResources?: boolean;
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
  const worlds = new WeakMap<
    World,
    {
      readonly assets: AssetRegistry;
      readonly generation: number;
      readonly pluginContext: PluginContext;
      readonly releaseLoaders: () => void;
    }
  >();
  const pausedPlayers = new WeakMap<World, Set<EntityHandle>>();
  let nextGeneration = 1;
  const dataInterfaces = createVfxDataInterfaceRegistry(options.providers);
  const readRenderAsset = <Kind extends 'material' | 'mesh'>(
    world: World,
    reference: string | AssetHandle<Kind>,
    kind: Kind,
  ) => {
    const assets = worlds.get(world)?.assets;
    if (
      assets === undefined ||
      typeof reference !== 'number' ||
      !assets.validate(reference, kind).ok
    )
      return undefined;
    return runtimeAssets(assets)
      .borrow<Kind extends 'material' ? MaterialAsset : MeshAsset>(reference)
      .unwrap();
  };
  const feature = gpuParticleRenderFeature({
    camera: options.camera,
    ...(options.instanceArenas === undefined ? {} : { instanceArenas: options.instanceArenas }),
    ...(options.nativePlanning === undefined ? {} : { nativePlanning: options.nativePlanning }),
    ...(options.retainedResources === undefined
      ? {}
      : { retainedResources: options.retainedResources }),
    ...(options.isolateViewGraph === undefined
      ? {}
      : { isolateViewGraph: options.isolateViewGraph }),
    ...(options.sceneSdf === undefined ? {} : { sceneSdf: options.sceneSdf }),
    dataInterfaces,
    material: createHostMaterialSource(
      (world, guid) => readRenderAsset(world, guid, 'material'),
      (world) => {
        const assets = worlds.get(world)?.assets;
        if (assets === undefined) return false;
        // Do not invoke a custom accessor merely to discover capture support.
        const own = Object.getOwnPropertyDescriptor(assets, 'getMaterialProjectionForPayload');
        if (own !== undefined) return own.value === stockMaterialProjection;
        return (
          Object.getPrototypeOf(assets) === AssetRegistry.prototype &&
          Object.getOwnPropertyDescriptor(
            AssetRegistry.prototype,
            'getMaterialProjectionForPayload',
          )?.value === stockMaterialProjection
        );
      },
      (world, material, context) => {
        const assets = worlds.get(world)?.assets;
        if (assets === undefined || !('getMaterialProjectionForPayload' in assets))
          return undefined;
        const readProjection = assets.getMaterialProjectionForPayload;
        const projection = readProjection.call(assets, material);
        if (readProjection !== stockMaterialProjection || projection === undefined)
          return projection;
        // Ordinary raster variants are never selected by particleMaterialPass.
        const passes = projection.passes.filter(
          (pass) =>
            pass.name !== 'forward' && pass.name !== 'deferred' && pass.name !== 'shadow-caster',
        );
        if (passes.length === 0) return undefined;
        if (passes.length === projection.passes.length)
          return selectParticleMaterialContext(projection, context);
        // Selection's legacy/modern address policy is derived across all passes.
        // Preserve mixed legacy inputs when removing raster rows could change it.
        const modern = (rows: MaterialRenderProjection['passes']) =>
          rows.some((pass) =>
            pass.programs.some(
              (program) =>
                program.context.pipeline !== 'ray' &&
                (program.address !== undefined ||
                  program.entry !== undefined ||
                  program.abi !== undefined),
            ),
          );
        return modern(passes) === modern(projection.passes)
          ? selectParticleMaterialContext({ ...projection, passes }, context)
          : projection;
      },
    ),
    mesh: { read: (world, guid) => readRenderAsset(world, guid, 'mesh') },
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
      if (world.hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY))
        return err(
          failure(
            'vfx-host-world-attach-failed',
            'one VFX runtime owner per World',
            'detach the active VFX host before attaching a replacement',
            undefined,
          ),
        );
      const bound = world.bindAssets(assets);
      if (!bound.ok)
        return err(
          failure(
            'vfx-host-world-attach-failed',
            'the World asset owner',
            'attach VFX using the World asset Registry',
            bound.error,
          ),
        );
      let decoder: AssetDecoderLease;
      try {
        decoder = assets.installDecoder(
          particleEffectContribution.kind,
          particleEffectContribution.decoder,
        );
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
      const releaseLoaders = () => {
        decoder.dispose();
      };
      let pluginContext: PluginContext;
      try {
        pluginContext = await createWorldContext(world, [
          vfxGpuRuntimePlugin(
            options.maxQueuedTicks === undefined ? {} : { maxQueuedTicks: options.maxQueuedTicks },
          ),
        ]);
      } catch (cause) {
        releaseLoaders();
        return err(
          failure(
            'vfx-host-world-attach-failed',
            'the World FixedUpdate VFX intent producer to install',
            'repair the reported World registration conflict and retry',
            cause,
          ),
        );
      }
      const attached = {
        assets,
        pluginContext,
        releaseLoaders,
        generation: nextGeneration++,
      };
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
      attached.releaseLoaders();
      worlds.delete(world);
      return ok({ state: 'detached' });
    },
  };
}
