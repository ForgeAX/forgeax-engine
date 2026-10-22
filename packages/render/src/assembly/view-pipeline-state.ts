import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { emptyBloomInspection } from '../inspection-types';
import type { DeviceScope } from '../lifecycle';
import { inspectStandardBloomGraph } from '../pipeline/standard-post';
import { COOKIE_MATRIX_BYTES } from '../prepare/extended-lighting/resources';
import type { BloomFrameReceipts } from '../record/frame-snapshot';
import { MESH_PER_ENTITY_STRIDE, MESH_UBO_FULL_ARRAY_BYTES } from '../record/mesh-ssbo';
import { createPointsLinesViewBuffer } from '../record/points-lines-view-buffer';
import {
  type BloomPersistentBundle,
  MATERIAL_PER_ENTITY_STRIDE,
  MATERIAL_UNIFORM_BYTES,
  type PipelineState,
  type RenderSystemInternals,
} from '../record/render-context';
import { SHADOW_CASTER_BUFFER_SIZE } from '../record/shadow-pass';
import { SHADOW_PARAMS_BYTES, VIEW_UNIFORM_BUFFER_SIZE } from '../record/view-ubo';
import { createMeshSsboGrowController, INITIAL_MESH_SSBO_SLOT_COUNT } from './mesh-ssbo-grow';
import {
  BLOOM_COMPOSITE_PARAMS_BYTES,
  BLOOM_HORIZONTAL_PARAMS_BYTES,
  BLOOM_VERTICAL_PARAMS_BYTES,
} from './webgpu-ready-contract';
import { createReadyPerPassResources } from './webgpu-ready-per-pass';

/** Static programs and asset residency are shared; every writable view binding is private. */
export function createViewPipelineState(
  base: PipelineState,
  internals: RenderSystemInternals,
  scope: DeviceScope,
) {
  const device: RhiDevice = internals.device;
  const allocate = (label: string, size: number, usage = 0x40 | 0x08): Buffer => {
    const result = device.createBuffer({ label: `view:${scope.owner}:${label}`, size, usage });
    if (!result.ok) throw result.error;
    scope._adopt('buffer', result.value, (value) => {
      device.destroyBuffer(value);
    });
    return result.value;
  };
  const mesh = createMeshSsboGrowController({
    device: {
      limits: device.limits,
      createBuffer: (d) => {
        const result = device.createBuffer(d);
        if (!result.ok) throw result.error;
        return result.value;
      },
      destroyBuffer: (buffer) => {
        device.destroyBuffer(buffer);
      },
    },
    scope,
    meshStride: MESH_PER_ENTITY_STRIDE,
    meshBindingSize: device.caps.storageBuffer ? MESH_PER_ENTITY_STRIDE : MESH_UBO_FULL_ARRAY_BYTES,
    materialBindingSize: MATERIAL_UNIFORM_BYTES,
    uniformPages: !device.caps.storageBuffer,
    errorRegistry: internals.errorRegistry,
    initialSlotCount: INITIAL_MESH_SSBO_SLOT_COUNT,
    materialStride: MATERIAL_PER_ENTITY_STRIDE,
    meshUsage: (device.caps.storageBuffer ? 0x80 : 0x40) | 0x08,
    materialUsage: 0x40 | 0x08,
  });
  mesh.initialBuild();
  let bloom: BloomPersistentBundle | undefined;
  let candidate: BloomPersistentBundle | undefined;
  let bloomGeneration = 0;
  let receipts: BloomFrameReceipts = { uploadCount: 0, bindGroupCount: 0, encodeCount: 0 };
  const retiring = new Set<BloomPersistentBundle>();
  const ensureBloomResources = () => {
    if (bloom !== undefined || candidate !== undefined) return;
    base.perPassResources.ensureBloomResources?.();
    const shared = base.perPassResources.getBloomResources?.();
    if (shared === undefined || shared === null) return;
    base.perPassResources.commitBloomResources?.();
    const child = scope.createChild('bloom');
    const params = (label: string, size: number) => {
      const result = device.createBuffer({ label, size, usage: 0x40 | 0x08 });
      if (!result.ok) throw result.error;
      child._adopt('buffer', result.value, (buffer) => {
        device.destroyBuffer(buffer);
      });
      return result.value;
    };
    candidate = {
      ...shared,
      scope: child,
      generation: ++bloomGeneration,
      bloomHorizontalParamsBuffer: params('bloom-horizontal', BLOOM_HORIZONTAL_PARAMS_BYTES),
      bloomVerticalParamsBuffer: params('bloom-vertical', BLOOM_VERTICAL_PARAMS_BYTES),
      bloomCompositeParamsBuffer: params('bloom-composite', BLOOM_COMPOSITE_PARAMS_BYTES),
    };
  };
  const perPassResources = createReadyPerPassResources({
    ...base.perPassResources,
    skyboxRotationBuffer:
      base.perPassResources.skyboxRotationBuffer === null ? null : allocate('skybox-rotation', 16),
    shadowLightSpaceMatrix: null,
    shadowCsmLightViewProj: null,
    shadowCsmSelection: null,
    ensureBloomResources,
    getBloomResources: () => candidate ?? bloom ?? null,
    commitBloomResources: () => {
      if (candidate !== undefined) {
        bloom = candidate;
        candidate = undefined;
      }
    },
    commitBloomFrameReceipts: (value) => {
      receipts = value;
    },
    discardBloomResources: () => {
      candidate?.scope.abandon();
      candidate = undefined;
    },
    retireBloomResources: (completion) => {
      const previous = bloom;
      if (previous === undefined) return;
      bloom = undefined;
      retiring.add(previous);
      previous.scope.beginRetire();
      const release = () => {
        previous.scope.retire();
        retiring.delete(previous);
      };
      void completion.then(release, release);
    },
    drainBloomResources: () => {
      candidate?.scope.abandon();
      bloom?.scope.retire();
      candidate = bloom = undefined;
      for (const previous of retiring) previous.scope.retire();
      retiring.clear();
    },
    inspectBloomResources: (graph) => {
      const current = inspectStandardBloomGraph(graph);
      const count = [...retiring].reduce(
        (n, b) => n + b.scope.resourceDelta(),
        bloom?.scope.resourceDelta() ?? 0,
      );
      if (bloom === undefined)
        return {
          ...emptyBloomInspection(),
          resourceCount: count,
          state: retiring.size > 0 ? 'retiring' : 'off',
        };
      return {
        ...current,
        ...receipts,
        graphStatus: current.status,
        enabled: true,
        resourceCount: count,
        residentChildBytes: current.targetBytes,
        generation: bloom.generation,
        state: 'active',
      };
    },
  });
  const pointsLinesView = createPointsLinesViewBuffer(device, scope);
  const state: PipelineState = {
    ...base,
    perPassResources,
    viewUniformBuffer: allocate('camera', VIEW_UNIFORM_BUFFER_SIZE),
    get pointsLinesViewBuffer() {
      return pointsLinesView.buffer;
    },
    ensurePointsLinesViewCapacity: pointsLinesView.ensureCapacity,
    shadowCasterCascadeBuffer: allocate('shadow-casters', SHADOW_CASTER_BUFFER_SIZE),
    shadowParamsBuffer: allocate('shadow-params', SHADOW_PARAMS_BYTES),
    meshStorageBuffer: mesh.state.mesh as PipelineState['meshStorageBuffer'],
    materialUniformBuffer: mesh.state.material as PipelineState['materialUniformBuffer'],
    ...(base.cookieMatrixBuffer === undefined
      ? {}
      : {
          cookieMatrixBuffer: allocate('cookie-matrices', COOKIE_MATRIX_BYTES),
          spotModifierUploadState: { ies: new Map(), cookie: new Map(), cookieMatrix: new Map() },
        }),
  };
  return { state, mesh };
}
