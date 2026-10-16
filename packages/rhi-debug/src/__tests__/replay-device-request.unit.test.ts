import { RAY_QUERY_FEATURE } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import type { Tape } from '../protocol/types';
import { replayDeviceRequest } from '../replay/device-request';

describe('replay device descriptor features', () => {
  const empty: Tape = {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
    bootstrap: [],
    events: [],
    blobs: [],
  };
  for (const phase of ['bootstrap', 'frame'] as const) {
    it(`requests float32 blending from ${phase} pipelines on a fresh device`, () => {
      const create = {
        kind: 'createRenderPipeline' as const,
        handleId: 'render-pipeline:1',
        layoutHandleId: 'pipeline-layout:1',
        desc: {
          fragment: {
            targets: [
              {
                format: 'rgba32float',
                blend: {
                  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                },
              },
            ],
          },
        },
      } satisfies Tape['events'][number];
      const tape: Tape =
        phase === 'bootstrap'
          ? {
              ...empty,
              bootstrap: [{ handleId: create.handleId, kind: 'pipeline', create, initialData: [] }],
            }
          : { ...empty, events: [create] };
      expect(replayDeviceRequest(tape, new Set(), {}).requiredFeatures).toEqual([
        'float32-blendable',
      ]);
    });
    it(`requests read-write RGBA32Float storage from ${phase} descriptors on a fresh device`, () => {
      const create = {
        kind: 'createBindGroupLayout' as const,
        handleId: 'bind-group-layout:1',
        desc: {
          entries: [
            {
              binding: 5,
              visibility: 4,
              storageTexture: { access: 'read-write' as const, format: 'rgba32float' as const },
            },
          ],
        },
      };
      const tape: Tape =
        phase === 'bootstrap'
          ? {
              ...empty,
              bootstrap: [{ handleId: create.handleId, kind: 'binding', create, initialData: [] }],
            }
          : { ...empty, events: [create] };
      // A missing adapter feature must fail requestDevice rather than replay weaker work.
      expect(replayDeviceRequest(tape, new Set(), {}).requiredFeatures).toEqual([
        'texture-formats-tier2',
      ]);
    });
    it(`requests float depth/stencil from ${phase} resources, even on an unsupported adapter`, () => {
      const create = {
        kind: 'createTexture' as const,
        handleId: 'texture:1',
        desc: {
          size: [64, 64] as [number, number],
          format: 'depth32float-stencil8' as const,
          usage: 16,
        },
      };
      const tape: Tape =
        phase === 'bootstrap'
          ? {
              ...empty,
              bootstrap: [{ handleId: create.handleId, kind: 'texture', create, initialData: [] }],
            }
          : { ...empty, events: [create] };
      expect(replayDeviceRequest(tape, new Set(), {}).requiredFeatures).toEqual([
        'depth32float-stencil8',
      ]);
    });
  }
  it('enables adapter timestamps for per-pass replay timing without requiring them', () => {
    expect(replayDeviceRequest(empty, new Set(['timestamp-query']), {}).requiredFeatures).toEqual([
      'timestamp-query',
    ]);
    const recorded = { ...empty, header: { ...empty.header, rhiCaps: { timestampQuery: true } } };
    expect(
      replayDeviceRequest(recorded, new Set(['timestamp-query']), {}).requiredFeatures,
    ).toEqual(['timestamp-query']);
    expect(replayDeviceRequest(recorded, new Set(), {})).toEqual({});
  });
  it('does not impose a renderer depth format on generic tapes', () => {
    expect(
      replayDeviceRequest(
        empty,
        new Set(['depth32float-stencil8', 'texture-formats-tier2' as GPUFeatureName]),
        {},
      ),
    ).toEqual({});
  });
  it('does not require float32 blending for unblended float32 or blended float16 targets', () => {
    const tape: Tape = {
      ...empty,
      events: [
        {
          kind: 'createRenderPipeline',
          handleId: 'render-pipeline:1',
          layoutHandleId: 'pipeline-layout:1',
          desc: {
            fragment: {
              targets: [
                null,
                { format: 'rgba32float' },
                { format: 'rgba16float', blend: { color: {}, alpha: {} } },
              ],
            },
          },
        },
      ],
    };
    expect(replayDeviceRequest(tape, new Set(['float32-blendable']), {})).toEqual({});
  });
  for (const format of ['r32float', 'r32uint', 'r32sint'] as const) {
    it(`retains core ${format} read-write replay without tier2`, () => {
      const tape: Tape = {
        ...empty,
        events: [
          {
            kind: 'createBindGroupLayout',
            handleId: 'binding:1',
            desc: {
              entries: [
                { binding: 0, visibility: 4, storageTexture: { access: 'read-write', format } },
              ],
            },
          },
        ],
      };
      expect(replayDeviceRequest(tape, new Set(), {})).toEqual({});
    });
  }
  for (const phase of ['bootstrap', 'frame'] as const) {
    it(`requests WGSL device features from ${phase}, regardless of adapter support`, () => {
      const create = {
        kind: 'createShaderModule' as const,
        handleId: 'shader-module:1',
        wgslCode: 'enable primitive_index, f16; enable subgroups; enable primitive_index;',
      };
      const tape: Tape =
        phase === 'bootstrap'
          ? {
              ...empty,
              bootstrap: [
                { handleId: create.handleId, kind: 'shader-module', create, initialData: [] },
              ],
            }
          : { ...empty, events: [create] };
      expect(replayDeviceRequest(tape, new Set(), {}).requiredFeatures).toEqual([
        'primitive-index',
        'shader-f16',
        'subgroups',
      ]);
    });
  }
  it('ignores nested comments and accepts comments between enable tokens', () => {
    const tape: Tape = {
      ...empty,
      events: [
        {
          kind: 'createShaderModule',
          handleId: 'shader-module:1',
          wgslCode: `// enable f16;
          /* outer /* inner */ enable subgroups; // this is still a block comment */
          enable/* separator */primitive_index;
          // enable subgroups;`,
        },
      ],
    };
    expect(replayDeviceRequest(tape, new Set(), {}).requiredFeatures).toEqual(['primitive-index']);
  });
  it('requests the Ray Query extension when the tape builds acceleration structures', () => {
    const tape: Tape = {
      ...empty,
      events: [
        {
          kind: 'createTlas',
          handleId: 'tlas:1',
          desc: { maxInstances: 1 },
        },
      ],
    };
    expect(replayDeviceRequest(tape, new Set(), {}).requiredFeatures).toEqual([RAY_QUERY_FEATURE]);
    expect(replayDeviceRequest(empty, new Set([RAY_QUERY_FEATURE as GPUFeatureName]), {})).toEqual(
      {},
    );
  });
});
