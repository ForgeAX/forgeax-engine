import type { RenderFeature } from '@forgeax/engine-render';
import type { Buffer } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import {
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
  SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
  type SceneDataTarget,
  sceneDataTargetOwner,
} from '../../../../render/src/temporal/scene-data';

export interface ForwardGtaoSceneDataPlan {
  readonly frameNumber: number;
  readonly viewIdentity: string;
  readonly normal: SceneDataTarget<typeof SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA>;
  readonly normalOwner: ReturnType<typeof sceneDataTargetOwner>;
  readonly depth: SceneDataTarget<typeof SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA>;
  readonly depthOwner: ReturnType<typeof sceneDataTargetOwner>;
}

export interface ForwardGtaoSceneDataSubmittedWork {
  readonly planFrameNumber: number | null;
  readonly works: readonly {
    readonly scope: string;
    readonly passNames: readonly string[];
    readonly resolvedDispatchCount: number;
  }[];
}

const MAX_SUBMITTED_WORK_SNAPSHOTS = 8;

/** GPU consumer that binds the exact Standard normal/depth tokens it requests. */
export function createForwardGtaoSceneDataConsumer(width: number, height: number) {
  let enabled = false;
  let latestPlan: ForwardGtaoSceneDataPlan | undefined;
  const submittedWorkSnapshots: ForwardGtaoSceneDataSubmittedWork[] = [];
  let observationBuffer: Buffer | undefined;
  const observationBytes = width * height * Uint32Array.BYTES_PER_ELEMENT * 2;
  const feature: RenderFeature<boolean> = {
    identity: 'test.forward-gtao-scene-data-consumer',
    placement: 'scene',
    requiresPreparation: (active) => active,
    extract: () => {
      latestPlan = undefined;
      return ok(enabled);
    },
    plan: (active, context) => {
      if (!active) return ok({ work: [] });
      const view = context.views.find((candidate) => candidate.render);
      if (view === undefined) return ok({ work: [] });
      const normal = view.sceneData.require(SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA);
      const depth = view.sceneData.require(SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA);
      if (observationBuffer === undefined) {
        throw new Error('Forward GTAO SceneData observation buffer was not installed');
      }
      latestPlan = Object.freeze({
        frameNumber: context.frame.frameNumber,
        viewIdentity: view.identity,
        normal,
        normalOwner: sceneDataTargetOwner(normal),
        depth,
        depthOwner: sceneDataTargetOwner(depth),
      });
      return ok({
        work: [
          {
            scope: { view: view.identity },
            resources: [
              {
                kind: 'compute-program' as const,
                name: 'surface-data-consumer-program',
                program: {
                  wgsl: `
                    @group(0) @binding(0) var surfaceNormal: texture_2d<u32>;
                    @group(0) @binding(1) var surfaceDepth: texture_depth_2d;
                    @group(0) @binding(2) var<storage, read_write> observed: array<u32>;
                    @compute @workgroup_size(8, 8) fn consumeSurface(
                      @builtin(global_invocation_id) invocation: vec3<u32>,
                    ) {
                      let size = textureDimensions(surfaceNormal);
                      if (invocation.x >= size.x || invocation.y >= size.y) { return; }
                      let pixel = vec2<i32>(invocation.xy);
                      let normal = textureLoad(surfaceNormal, pixel, 0).x;
                      let depth = textureLoad(surfaceDepth, pixel, 0);
                      let word = (invocation.y * size.x + invocation.x) * 2u;
                      observed[word] = normal;
                      observed[word + 1u] = bitcast<u32>(depth);
                    }
                  `,
                  entryPoints: ['consumeSurface'],
                  bindings: [
                    {
                      entries: [
                        {
                          binding: 0,
                          visibility: 4,
                          texture: {
                            sampleType: 'uint' as const,
                            viewDimension: '2d' as const,
                            multisampled: false,
                          },
                        },
                        {
                          binding: 1,
                          visibility: 4,
                          texture: {
                            sampleType: 'depth' as const,
                            viewDimension: '2d' as const,
                            multisampled: false,
                          },
                        },
                        { binding: 2, visibility: 4, buffer: { type: 'storage' as const } },
                      ],
                    },
                  ],
                },
              },
              {
                kind: 'prepared-gpu-resource' as const,
                name: 'surface-normal-view',
                resource: { kind: 'texture-view' as const, value: undefined },
                logicalTarget: normal,
              },
              {
                kind: 'prepared-gpu-resource' as const,
                name: 'surface-depth-view',
                resource: { kind: 'texture-view' as const, value: undefined },
                logicalTarget: depth,
              },
              {
                kind: 'prepared-gpu-resource' as const,
                name: 'surface-observation-buffer',
                resource: {
                  kind: 'buffer' as const,
                  value: observationBuffer,
                  size: observationBytes,
                  usage: ['storage', 'copy-src'] as const,
                },
              },
              {
                kind: 'compute-bindings' as const,
                name: 'surface-data-consumer-bindings',
                program: 'surface-data-consumer-program',
                entries: [
                  { binding: 0, resource: 'surface-normal-view' },
                  { binding: 1, resource: 'surface-depth-view' },
                  { binding: 2, resource: 'surface-observation-buffer' },
                ],
              },
            ],
            passes: [
              {
                kind: 'compute' as const,
                name: 'surface-normal-depth-consumer',
                program: 'surface-data-consumer-program',
                bindings: 'surface-data-consumer-bindings',
                dispatches: [
                  {
                    kind: 'direct' as const,
                    entryPoint: 'consumeSurface',
                    workgroups: [Math.ceil(width / 8), Math.ceil(height / 8), 1],
                  },
                ],
              },
            ],
          },
        ],
      });
    },
    onFrameSubmitted: (_active, submission) => {
      const row: ForwardGtaoSceneDataSubmittedWork = Object.freeze({
        planFrameNumber: latestPlan?.frameNumber ?? null,
        works: Object.freeze(
          (submission?.works ?? []).map(({ scope, passes }) =>
            Object.freeze({
              scope: typeof scope === 'string' ? scope : `view:${scope.view}`,
              passNames: Object.freeze(passes.map((pass) => pass.name)),
              resolvedDispatchCount: passes.reduce(
                (count, pass) => count + (pass.resolvedGpuCompute?.dispatches.length ?? 0),
                0,
              ),
            }),
          ),
        ),
      });
      if (submittedWorkSnapshots.length >= MAX_SUBMITTED_WORK_SNAPSHOTS)
        submittedWorkSnapshots.shift();
      submittedWorkSnapshots.push(row);
    },
  };
  return {
    feature,
    setEnabled(value: boolean) {
      enabled = value;
    },
    setObservationBuffer(value: Buffer) {
      observationBuffer = value;
    },
    observationBytes,
    latestPlan() {
      return latestPlan;
    },
    submittedWorkSnapshots() {
      return Object.freeze([...submittedWorkSnapshots]);
    },
  };
}
