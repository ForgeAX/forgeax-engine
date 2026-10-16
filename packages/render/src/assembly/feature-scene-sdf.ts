import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { RenderGraphBuilder, RenderGraphFrame } from '@forgeax/engine-render-graph';
import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { type MeshAsset, toShared } from '@forgeax/engine-types';
import { ResidencyLifetime } from '../device/residency-lifetime';
import { SceneSdfUnavailableError } from '../errors/scene-sdf';
import type { RenderFeatureSceneResource } from '../features/plan';
import {
  importRenderFeatureGraphBuffer,
  type RenderFeatureGraphBufferState,
} from '../features/render-graph-resources';
import type { RenderResourceScope } from '../publication/resource-scope';
import {
  createGlobalSdfCompositionRecorder,
  GLOBAL_SDF_COMPOSE_WGSL,
  type GlobalSdfCompositionInputs,
  normalizeGlobalSdfGrid,
  packGlobalSdfComposition,
} from '../raytracing/global-sdf';
import type { RenderSystemInternals } from '../record/render-context';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import { projectCollisionScene } from './scene-sdf-projection';

type Request = Extract<RenderFeatureSceneResource, { kind: 'scene-sdf' }>;
interface Region {
  readonly device: RhiDevice;
  readonly sourceKey: readonly unknown[];
  readonly rangeKey: string;
  readonly input: GlobalSdfCompositionInputs;
  readonly buffer: Buffer;
  readonly size: number;
  readonly voxelCount: number;
  readonly lifetime: ResidencyLifetime;
  readonly consumers: Set<string>;
  readonly compose: Extract<
    ReturnType<typeof createGlobalSdfCompositionRecorder>,
    { ok: true }
  >['value']['record'];
  composed: boolean;
}
export interface FeatureSceneSdfSource {
  readonly retained: PersistentGpuDrivenState['retained'];
  readonly scopes: readonly RenderResourceScope[];
}

/** A demand-scoped Renderer producer. Candidate replacement commits only after
 * the same physical submission as its consuming simulation. */
export function createFeatureSceneSdf(internals: RenderSystemInternals) {
  const regions = new Map<string, Region>();
  const requested = new Map<string, Region>();
  const candidates = new Map<string, Region>();
  const failed = new Set<string>();
  const release = (region: Region) => region.lifetime.retire();
  const sourceKey = (request: Request, current: FeatureSceneSdfSource) => {
    const retained = current.retained;
    if (retained === undefined || !retained.isCurrent() || !retained.isSourceCurrent())
      throw new SceneSdfUnavailableError({ reason: 'missing-source', world: request.world });
    const refs: unknown[] = [
      retained.identity,
      retained.revision,
      internals.assets.catalogEpoch,
      current.scopes[request.world],
    ];
    for (const slot of retained.slots) {
      if (slot.worldId !== request.world || slot.snapshot.authorVisible === false) continue;
      // Accepted asset payload identity changes on reimport, independently of
      // World/transform revisions. No independent mutation clock.
      const scope = current.scopes[request.world];
      if (scope === undefined)
        throw new SceneSdfUnavailableError({ reason: 'missing-source', world: request.world });
      const mesh = resolveAssetHandle<MeshAsset>(scope, toShared(slot.snapshot.assetHandle));
      refs.push(mesh.ok ? mesh.value : undefined, mesh.ok ? mesh.value.distanceField : undefined);
    }
    return refs;
  };
  return {
    begin() {
      if (requested.size !== 0) throw new Error('Scene SDF transaction is still open');
      failed.clear();
    },
    get hasSharedWork(): boolean {
      return [...requested.values()].some((region) => !region.composed);
    },
    prepare(identity: string, request: Request, current: FeatureSceneSdfSource) {
      const descriptor = request.descriptor;
      const normalized = normalizeGlobalSdfGrid({
        ...descriptor,
        coverageDistance: descriptor.maxDistance,
      });
      if (
        !Number.isSafeInteger(request.world) ||
        request.world < 0 ||
        !normalized.ok ||
        normalized.value.dimensions.some((v) => v < 2)
      ) {
        throw new SceneSdfUnavailableError({ reason: 'invalid-range', world: request.world });
      }
      const key = JSON.stringify([identity, request.name]);
      const refs = sourceKey(request, current);
      const rangeKey = JSON.stringify([
        request.world,
        normalized.value.origin,
        normalized.value.dimensions,
        normalized.value.spacing,
        normalized.value.maxDistance,
        descriptor.maxInstances,
        descriptor.maxFieldBytes,
      ]);
      const candidate = candidates.get(rangeKey);
      let region = candidate ?? regions.get(rangeKey);
      if (
        region !== undefined &&
        (region.device !== internals.device ||
          region.rangeKey !== rangeKey ||
          region.sourceKey.length !== refs.length ||
          refs.some((ref, i) => ref !== region?.sourceKey[i]))
      ) {
        // All consumers in one transaction observe the same source. Keep the
        // candidate reachable for rejection cleanup rather than overwriting it.
        if (candidate !== undefined)
          throw new SceneSdfUnavailableError({ reason: 'missing-source', world: request.world });
        region = undefined;
      }
      if (region === undefined) {
        const device = internals.device;
        if (
          !device.caps.compute ||
          !device.caps.storageBuffer ||
          device.limits.minStorageBufferOffsetAlignment > 256 ||
          256 % device.limits.minStorageBufferOffsetAlignment !== 0
        )
          throw new SceneSdfUnavailableError({ reason: 'capability', world: request.world });
        const retained = current.retained;
        if (retained === undefined)
          throw new SceneSdfUnavailableError({ reason: 'missing-source', world: request.world });
        const projection = projectCollisionScene(
          retained.slots,
          current.scopes,
          request.world,
          request.descriptor,
        );
        const packed = packGlobalSdfComposition(projection.instances, {
          ...request.descriptor,
          coverageDistance: request.descriptor.maxDistance,
        });
        if (!packed.ok)
          throw new SceneSdfUnavailableError({
            reason: 'invalid-range',
            world: request.world,
            cause: packed.error,
          });
        if (packed.value.grid.dimensions.some((v) => v < 2))
          throw new SceneSdfUnavailableError({ reason: 'invalid-range', world: request.world });
        const factory = internals.immediateShaderModuleFactory ?? internals.shaderModuleFactory;
        const module = factory?.createShaderModule({
          code: GLOBAL_SDF_COMPOSE_WGSL,
          label: 'scene-sdf.compose',
        });
        if (module === undefined || !module.ok)
          throw new SceneSdfUnavailableError({
            reason: 'preparing',
            world: request.world,
            cause: module?.error,
          });
        const compose = createGlobalSdfCompositionRecorder(device, module.value).unwrap();
        const owned: Buffer[] = [];
        try {
          const count = packed.value.voxelCount;
          const size = 256 + count * 16;
          if (
            size > device.limits.maxStorageBufferBindingSize ||
            size > device.limits.maxBufferSize
          )
            throw new SceneSdfUnavailableError({ reason: 'budget', world: request.world });
          const buffer = device
            .createBuffer({ label: 'scene-sdf.grid-and-voxels', size, usage: 128 | 12 })
            .unwrap();
          owned.push(buffer);
          const header = new Uint8Array(256);
          header.set(packed.value.data.settings);
          // World-space conservative contact expansion includes local field
          // error and interpolation across a full world-grid cell diagonal.
          new DataView(header.buffer).setFloat32(
            36,
            projection.errorBound + Math.sqrt(3) * packed.value.grid.spacing,
            true,
          );
          device.queue.writeBuffer(buffer, 0, header).unwrap();
          const input = {} as Record<
            keyof GlobalSdfCompositionInputs,
            GlobalSdfCompositionInputs['voxels']
          >;
          for (const name of ['instances', 'fields', 'bounds', 'settings'] as const) {
            const data = packed.value.data[name];
            const storage = device
              .createBuffer({
                label: `scene-sdf.${name}`,
                size: data.byteLength,
                usage: (name === 'settings' ? 64 : 128) | 12,
              })
              .unwrap();
            owned.push(storage);
            device.queue.writeBuffer(storage, 0, data).unwrap();
            input[name] = { buffer: storage, size: data.byteLength };
          }
          input.voxels = { buffer, offset: 256, size: count * 16 };
          region = {
            device,
            sourceKey: refs,
            rangeKey,
            input,
            buffer,
            size,
            voxelCount: count,
            compose: compose.record,
            composed: false,
            consumers: new Set(),
            lifetime: new ResidencyLifetime(() => {
              for (const buffer of owned) device.destroyBuffer(buffer);
            }),
          };
        } catch (error) {
          for (const buffer of owned) device.destroyBuffer(buffer);
          throw error;
        }
      }
      candidates.set(rangeKey, region);
      requested.set(key, region);
      return { buffer: region.buffer, size: region.size };
    },
    contribute<Frame extends RenderGraphFrame>(
      builder: RenderGraphBuilder<Frame>,
      state: RenderFeatureGraphBufferState,
    ) {
      for (const region of new Set(requested.values())) {
        const key = region.rangeKey;
        if (region.composed) continue;
        const accesses = Object.entries(region.input).map(([name, range]) => {
          const uniform = name === 'settings',
            output = name === 'voxels';
          const imported = importRenderFeatureGraphBuffer(
            builder,
            state,
            `scene-sdf.${key}.${name}`,
            {
              buffer: range.buffer,
              size: output ? region.size : range.size,
              physicalUsage: (uniform ? 64 : 128) | 12,
            },
          ).unwrap();
          return {
            resource: imported,
            usage: output
              ? ('storage-write' as const)
              : uniform
                ? ('uniform-read' as const)
                : ('storage-read' as const),
          };
        });
        builder
          .addComputePass(`scene-sdf.compose:${key}`, {
            accesses,
            encode: ({ pass }) => region.compose(pass, region.input, region.voxelCount).unwrap(),
          })
          .unwrap();
      }
    },
    abortFeature(identity: string) {
      failed.add(identity);
      for (const key of requested.keys()) {
        if (JSON.parse(key)[0] === identity) requested.delete(key);
      }
    },
    complete(submitted: boolean, completion?: Promise<unknown>) {
      const adopted = new Set(requested.values());
      if (submitted) {
        for (const [key, region] of regions) {
          if (adopted.has(region) || [...region.consumers].some((identity) => failed.has(identity)))
            continue;
          release(region);
          regions.delete(key);
        }
        for (const region of adopted) {
          const previous = regions.get(region.rangeKey);
          if (previous !== undefined && previous !== region) release(previous);
          if (completion !== undefined) region.lifetime.track(completion);
          for (const identity of region.consumers) {
            if (!failed.has(identity)) region.consumers.delete(identity);
          }
          for (const [key, requestedRegion] of requested) {
            if (requestedRegion === region) region.consumers.add(JSON.parse(key)[0]);
          }
          region.composed = true;
          regions.set(region.rangeKey, region);
        }
      }
      for (const region of new Set(candidates.values())) {
        if (regions.get(region.rangeKey) !== region) release(region);
      }
      candidates.clear();
      requested.clear();
      failed.clear();
    },
    dispose() {
      for (const region of new Set([...candidates.values(), ...regions.values()])) release(region);
      candidates.clear();
      requested.clear();
      regions.clear();
      failed.clear();
    },
    detach(scope: RenderResourceScope) {
      for (const map of [regions, candidates, requested])
        for (const [key, region] of map) {
          if (region.sourceKey[3] !== scope) continue;
          release(region);
          map.delete(key);
        }
    },
  };
}
