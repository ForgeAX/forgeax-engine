import type { RenderFeature, RenderFeatureSubmission } from '@forgeax/engine/render';
import { ok } from '@forgeax/engine/types';

export const LAB_COMPUTE_PASS = 'lab-counter-tick';

const WGSL = `
@group(0) @binding(0) var<storage, read_write> counter : array<u32>;
@compute @workgroup_size(1) fn tick() { counter[0] = counter[0] + 1u; }
`;

export interface LabComputeFeatureState {
  submitted: number;
  aborted: number;
  last: RenderFeatureSubmission | undefined;
  /** When true, plan() declares a pass bound to a program that does not exist. */
  fault: boolean;
}

/** One storage buffer and one direct compute dispatch per frame, joined to the Standard graph. */
export function createLabComputeFeature(identity: string): {
  readonly feature: RenderFeature<undefined>;
  readonly state: LabComputeFeatureState;
} {
  const state: LabComputeFeatureState = { submitted: 0, aborted: 0, last: undefined, fault: false };
  const feature: RenderFeature<undefined> = {
    identity,
    extract: () => ok(undefined),
    plan: () =>
      ok({
        work: [
          {
            scope: 'frame',
            resources: [
              {
                kind: 'compute-program',
                name: 'counter-program',
                program: {
                  wgsl: WGSL,
                  entryPoints: ['tick'],
                  bindings: [
                    { entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }] },
                  ],
                },
              },
              {
                kind: 'buffer',
                name: 'counter',
                size: 16,
                usage: ['storage'],
                data: new Uint32Array(4),
              },
              {
                kind: 'compute-bindings',
                name: 'counter-bindings',
                program: 'counter-program',
                entries: [{ binding: 0, resource: 'counter' }],
              },
            ],
            passes: [
              {
                kind: 'compute',
                name: LAB_COMPUTE_PASS,
                program: state.fault ? 'missing-program' : 'counter-program',
                bindings: 'counter-bindings',
                dispatches: [{ kind: 'direct', entryPoint: 'tick', workgroups: [1] }],
              },
            ],
          },
        ],
      }),
    onFrameSubmitted(_data, submission) {
      state.submitted += 1;
      state.last = submission;
    },
    onFrameAborted() {
      state.aborted += 1;
    },
  };
  return { feature, state };
}
