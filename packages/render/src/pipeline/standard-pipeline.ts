import { RenderGraphError } from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import { ProjectedDecalInvalidError } from '../decals/component';
import { StandardProfileInvalidError } from '../errors/render';
import type {
  RenderPipeline,
  RenderPipelineBuildContext,
  RenderPipelineFrame,
  RenderPipelineTopology,
} from '../render-pipeline';
import type { StandardPipelineBuildContext } from './standard-build-context';
import { buildStandardDeferredLane } from './standard-deferred-lane';
import { buildStandardForwardLane } from './standard-forward-lane';
import {
  deriveStandardTopologyInput,
  type StandardTopologyInputValue,
} from './standard-lighting/topology';
import {
  DEFAULT_STANDARD_PROFILE,
  STANDARD_LIGHT_COUNTS,
  STANDARD_PIPELINE_ID,
  type StandardProfile,
} from './standard-profile';

/** WGSL owner for the Standard clustered membership producer. */
export const STANDARD_CLUSTER_MEMBERSHIP_WGSL = /* wgsl */ `
struct ClusterUniform {
  grid : vec4<u32>,
  near_far_log : vec4<f32>,
};

@group(0) @binding(0) var<storage, read> cluster_grid : array<u32>;
@group(0) @binding(1) var<storage, read_write> light_index_list : array<u32>;
@group(0) @binding(2) var<uniform> cluster_uniform : ClusterUniform;
@group(0) @binding(3) var<storage, read> light_bounds : array<i32>;

@compute @workgroup_size(64)
fn cs_cluster_membership(@builtin(global_invocation_id) global_id : vec3<u32>) {
  let cluster_index = global_id.x;
  let grid_x = cluster_uniform.grid.x;
  let grid_y = cluster_uniform.grid.y;
  let grid_z = cluster_uniform.grid.z;
  let cluster_count = grid_x * grid_y * grid_z;
  if (cluster_index >= cluster_count) {
    return;
  }

  let cluster_x = cluster_index % grid_x;
  let cluster_yz = cluster_index / grid_x;
  let cluster_y = cluster_yz % grid_y;
  let cluster_z = cluster_yz / grid_y;
  let grid_offset = cluster_index * 2u;
  let output_offset = cluster_grid[grid_offset];
  let output_count = cluster_grid[grid_offset + 1u];
  let cluster_x_i = i32(cluster_x);
  let cluster_y_i = i32(cluster_y);
  let cluster_z_i = i32(cluster_z);
  var output_index = output_offset;

  var light_index = 0u;
  loop {
    if (light_index >= cluster_uniform.grid.w || light_index >= 256u) {
      break;
    }
    let bounds_offset = light_index * 6u;
    let min_x = light_bounds[bounds_offset];
    if (min_x >= 0) {
      let min_y = light_bounds[bounds_offset + 1u];
      let min_z = light_bounds[bounds_offset + 2u];
      let max_x = light_bounds[bounds_offset + 3u];
      let max_y = light_bounds[bounds_offset + 4u];
      let max_z = light_bounds[bounds_offset + 5u];
      if (
        cluster_x_i >= min_x && cluster_x_i <= max_x &&
        cluster_y_i >= min_y && cluster_y_i <= max_y &&
        cluster_z_i >= min_z && cluster_z_i <= max_z
      ) {
        if (output_index < output_offset + output_count) {
          light_index_list[output_index] = light_index;
          output_index += 1u;
        }
      }
    }
    light_index += 1u;
  }
}
`;
export function validateClusterGrid(grid: {
  x: number;
  y: number;
  z: number;
}): Result<{ x: number; y: number; z: number }, StandardProfileInvalidError> {
  const { x, y, z } = grid;
  return Number.isInteger(x) &&
    Number.isInteger(y) &&
    Number.isInteger(z) &&
    x >= 1 &&
    x <= 64 &&
    y >= 1 &&
    y <= 64 &&
    z >= 1 &&
    z <= 64
    ? ok({ x, y, z })
    : err(
        new StandardProfileInvalidError(
          `clusterGrid {x:${x}, y:${y}, z:${z}} is invalid; set x, y, and z to positive integers in [1, 64]`,
          { field: 'clusterGrid', actual: { x, y, z } },
        ),
      );
}

interface StandardPipeline extends RenderPipeline {
  readonly identity: typeof STANDARD_PIPELINE_ID;
}

function profileFor(topology: RenderPipelineTopology): StandardProfile {
  return topology.standardProfile ?? DEFAULT_STANDARD_PROFILE;
}

function resolveStandardTopologyInput(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
): Result<StandardTopologyInputValue, RenderGraphError> {
  const supplied = context.standardLighting;
  if (supplied !== undefined) {
    const derived = deriveStandardTopologyInput(supplied);
    if (derived.ok) return derived;
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'Forward/Deferred consume one prepared Standard topology input',
        hint: derived.error.hint,
        detail: {
          resourceLabel: 'forgeax::standard',
          field: `standardLighting.${derived.error.detail.field}`,
          expected: derived.error.expected,
          actual: 'invalid',
        },
      }),
    );
  }

  return err(
    new RenderGraphError({
      code: 'resource-descriptor-invalid',
      expected: 'RenderPipelineBuildContext.standardLighting from frame preparation',
      hint: 'prepare Standard lighting once, select a proven Cluster transport, and pass it to both lanes',
      detail: {
        resourceLabel: 'forgeax::standard',
        field: 'standardLighting',
        expected: 'prepared Standard lighting topology input',
        actual: 'invalid',
      },
    }),
  );
}

function standardTopology(
  topology: RenderPipelineTopology,
  profile: StandardProfile,
): RenderPipelineTopology {
  const config = {
    ...(topology.config ?? {}),
    ssao: {
      ...(topology.config?.ssao ?? {}),
      ...(typeof profile.ssao === 'object' ? profile.ssao : {}),
      enabled: profile.ssao !== false,
    },
  };
  return {
    ...topology,
    pipelineId: STANDARD_PIPELINE_ID,
    standardProfile: profile,
    config,
  };
}

/**
 * @internal
 * The sole built-in pipeline entry point. All local lights use the same
 * prepared Cluster topology; the profile chooses only Forward or Deferred
 * graph shape and never a second lighting authority.
 */
export function buildStandard(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  reuseAdjacentShadow = false,
): ReturnType<RenderPipeline['build']> {
  const standardContext = context as StandardPipelineBuildContext;
  const profile = profileFor(topology);
  if (!STANDARD_LIGHT_COUNTS.some((count) => count === profile.lightCount)) {
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'StandardProfile.lightCount is one of 1, 32, or 256',
        hint: 'set StandardProfile.lightCount to 1, 32, or 256',
        detail: {
          resourceLabel: 'forgeax::standard',
          field: 'lightCount',
          expected: '1 | 32 | 256',
          actual: profile.lightCount,
        },
      }),
    );
  }
  if (
    (topology.projectedDecals?.length ?? 0) > 0 &&
    (profile.renderPath !== 'deferred' || topology.camera.antialias === 'msaa')
  )
    throw new ProjectedDecalInvalidError(
      'renderPath',
      'Standard Deferred with single-sample depth',
    );
  const effective = standardTopology(topology, profile);
  const lighting = resolveStandardTopologyInput(context);
  if (!lighting.ok) return lighting;
  // A missing Camera is an intentional clear-only frame. Keep it on the
  // forward raster lane so clustered resources cannot introduce work.
  if (effective.clearOnly === true) {
    return buildStandardForwardLane(
      standardContext,
      effective,
      lighting.value,
      reuseAdjacentShadow,
    );
  }
  return profile.renderPath === 'forward'
    ? buildStandardForwardLane(standardContext, effective, lighting.value, reuseAdjacentShadow)
    : buildStandardDeferredLane(standardContext, effective, lighting.value, reuseAdjacentShadow);
}

export const standardPipeline: StandardPipeline = Object.freeze({
  identity: STANDARD_PIPELINE_ID,
  build: buildStandard,
});

export { DEFAULT_STANDARD_PROFILE, STANDARD_PIPELINE_ID } from './standard-profile';
