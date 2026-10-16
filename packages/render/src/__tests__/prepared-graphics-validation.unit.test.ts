import { describe, expect, it } from 'vitest';
import type {
  PreparedKind,
  RenderFeatureDrawRecord,
  RenderFeatureGraphicsPassDescriptor,
  RenderFeaturePreparedGraphicsState,
  RenderFeaturePreparedRef,
} from '../features/prepared-graphics';
import { validateRenderFeatureGraphicsPass } from '../features/prepared-graphics';

type Ledger = {
  setPipeline: number;
  setBindGroup: number;
  setVertexBuffer: number;
  setIndexBuffer: number;
  draw: number;
};

function ref<Kind extends PreparedKind>(
  kind: Kind,
  generation = 7,
): RenderFeaturePreparedRef<Kind> {
  return { kind, generation };
}

const pipeline = ref('pipeline');
const secondPipeline = ref('pipeline');
const bindings = ref('bindings');
const vertices = ref('vertex-data');
const indices = ref('index-data');

const vertexDraw: RenderFeatureDrawRecord = {
  kind: 'draw',
  pipeline,
  bindings: [bindings],
  vertexData: [{ slot: 0, resource: vertices }],
  command: { vertexCount: 3, instanceCount: 1 },
};

const indexedDraw: RenderFeatureDrawRecord = {
  kind: 'draw-indexed',
  pipeline,
  bindings: [bindings],
  vertexData: [{ slot: 0, resource: vertices }],
  indexData: { resource: indices, format: 'uint16' },
  command: { indexCount: 3, instanceCount: 1 },
};

const vertexPass: RenderFeatureGraphicsPassDescriptor = {
  attachments: {
    colors: [{ resource: 'color', format: 'rgba8unorm', loadOp: 'load', storeOp: 'store' }],
  },
  draws: [vertexDraw],
};

const indexedPass: RenderFeatureGraphicsPassDescriptor = {
  ...vertexPass,
  draws: [indexedDraw],
};

const state: RenderFeaturePreparedGraphicsState = {
  capabilityAvailable: true,
  generation: 7,
  attachments: [{ resource: 'color', format: 'rgba8unorm' }],
  pipeline,
  bindings: [bindings],
  vertexData: [vertices],
  indexData: [indices],
};

function expectRejected(
  pass: RenderFeatureGraphicsPassDescriptor,
  nextState: RenderFeaturePreparedGraphicsState,
  ledger: Ledger,
): void {
  const result = validateRenderFeatureGraphicsPass('validation.feature', pass, nextState);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect('detail' in result.error).toBe(true);
    if ('detail' in result.error && result.error.detail !== undefined) {
      expect(result.error.detail).toMatchObject({ featureIdentity: 'validation.feature' });
    }
  }
  expect(ledger).toEqual({
    setPipeline: 0,
    setBindGroup: 0,
    setVertexBuffer: 0,
    setIndexBuffer: 0,
    draw: 0,
  });
}

describe('prepared graphics validation before RHI mutation', () => {
  it('accepts vertex-only and indexed records with complete state', () => {
    expect(validateRenderFeatureGraphicsPass('validation.feature', vertexPass, state)).toEqual({
      ok: true,
      value: { acceptedDrawCount: 1 },
    });
    expect(validateRenderFeatureGraphicsPass('validation.feature', indexedPass, state)).toEqual({
      ok: true,
      value: { acceptedDrawCount: 1 },
    });
  });

  it('accepts draws that use any prepared pipeline in the current pass', () => {
    const secondDraw = { ...vertexDraw, pipeline: secondPipeline };
    expect(
      validateRenderFeatureGraphicsPass(
        'validation.feature',
        { ...vertexPass, draws: [vertexDraw, secondDraw] },
        { ...state, pipelines: [pipeline, secondPipeline] },
      ),
    ).toEqual({ ok: true, value: { acceptedDrawCount: 2 } });
  });

  it('rejects each missing state category before the first RHI mutation', () => {
    const cases: Array<[RenderFeatureGraphicsPassDescriptor, RenderFeaturePreparedGraphicsState]> =
      [
        [vertexPass, { ...state, pipeline: undefined }],
        [vertexPass, { ...state, bindings: [] }],
        [vertexPass, { ...state, vertexData: [] }],
        [indexedPass, { ...state, indexData: [] }],
        [vertexPass, { ...state, attachments: [] }],
      ];
    for (const [pass, nextState] of cases) {
      expectRejected(pass, nextState, {
        setPipeline: 0,
        setBindGroup: 0,
        setVertexBuffer: 0,
        setIndexBuffer: 0,
        draw: 0,
      });
    }
  });

  it('rejects foreign kind and stale generation references without recording', () => {
    const ledger = {
      setPipeline: 0,
      setBindGroup: 0,
      setVertexBuffer: 0,
      setIndexBuffer: 0,
      draw: 0,
    };
    expectRejected(vertexPass, { ...state, pipeline: ref('bindings') }, ledger);
    expectRejected(vertexPass, { ...state, pipeline: ref('pipeline', 8) }, ledger);
  });

  it('rejects layout, format, and indexed-shape mismatches without a partial draw', () => {
    const ledger = {
      setPipeline: 0,
      setBindGroup: 0,
      setVertexBuffer: 0,
      setIndexBuffer: 0,
      draw: 0,
    };
    expectRejected(vertexPass, { ...state, vertexData: [ref('vertex-data', 8)] }, ledger);
    expectRejected(
      vertexPass,
      { ...state, attachments: [{ resource: 'color', format: 'bgra8unorm' }] },
      ledger,
    );
    expectRejected(
      {
        ...vertexPass,
        draws: [{ ...vertexDraw, indexData: { resource: indices, format: 'uint16' } }],
      },
      state,
      ledger,
    );
    expectRejected(
      { ...indexedPass, draws: [{ ...indexedDraw, indexData: undefined }] },
      state,
      ledger,
    );
  });
});
