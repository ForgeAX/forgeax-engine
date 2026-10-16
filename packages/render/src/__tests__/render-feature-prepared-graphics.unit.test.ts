import { describe, expect, it } from 'vitest';
import type {
  PreparedKind,
  RenderFeatureDrawRecord,
  RenderFeatureGraphicsPassDescriptor,
  RenderFeaturePreparedGraphicsState,
  RenderFeaturePreparedRef,
} from '../features/prepared-graphics';
import { validateRenderFeatureGraphicsPass } from '../features/prepared-graphics';

function ref<Kind extends PreparedKind>(
  kind: Kind,
  generation = 1,
): RenderFeaturePreparedRef<Kind> {
  return { kind, generation };
}

const pipeline = ref('pipeline');
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

const validPass: RenderFeatureGraphicsPassDescriptor = {
  attachments: {
    colors: [{ resource: 'color', format: 'rgba8unorm', loadOp: 'load', storeOp: 'store' }],
  },
  draws: [vertexDraw, indexedDraw],
};

const validState: RenderFeaturePreparedGraphicsState = {
  capabilityAvailable: true,
  generation: 1,
  attachments: [{ resource: 'color', format: 'rgba8unorm' }],
  pipeline,
  bindings: [bindings],
  vertexData: [vertices],
  indexData: [indices],
};

function expectFailure(
  pass: RenderFeatureGraphicsPassDescriptor,
  state: RenderFeaturePreparedGraphicsState,
): void {
  const result = validateRenderFeatureGraphicsPass('prepared.graphics.unit', pass, state);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toMatch(/^render-feature-/);
  expect(result.error.expected).toBeTypeOf('string');
  expect(result.error.hint).toBeTypeOf('string');
  expect(result.error).toHaveProperty('detail.featureIdentity', 'prepared.graphics.unit');
}

describe('prepared graphics descriptor validation', () => {
  it('validates hidden draws and accepts their resources without executing them', () => {
    const hidden = { ...validPass, draws: [{ ...vertexDraw, enabled: false }] };
    expect(validateRenderFeatureGraphicsPass('hidden', hidden, validState).unwrap()).toEqual({
      acceptedDrawCount: 1,
    });
    expectFailure(hidden, { ...validState, bindings: [] });
    expectFailure({ ...hidden, draws: [{ ...vertexDraw, enabled: 0 as never }] }, validState);
  });
  it('accepts complete vertex-only and indexed records', () => {
    const result = validateRenderFeatureGraphicsPass(
      'prepared.graphics.unit',
      validPass,
      validState,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.acceptedDrawCount).toBe(2);
  });

  it('rejects missing capability before recording', () => {
    expectFailure(validPass, { ...validState, capabilityAvailable: false });
  });

  it('rejects missing pipeline, binding, vertex, index, and attachment state', () => {
    expectFailure(validPass, { ...validState, pipeline: undefined });
    expectFailure(validPass, { ...validState, bindings: [] });
    expectFailure(validPass, { ...validState, vertexData: [] });
    expectFailure(validPass, { ...validState, indexData: [] });
    expectFailure(validPass, { ...validState, attachments: [] });
  });

  it('rejects foreign kind and stale generation references', () => {
    expectFailure(validPass, { ...validState, pipeline: ref('bindings') });
    expectFailure(validPass, { ...validState, pipeline: ref('pipeline', 2) });
  });

  it('rejects layout and attachment format mismatches', () => {
    expectFailure(validPass, {
      ...validState,
      vertexData: [ref('vertex-data', 2)],
    });
    expectFailure(validPass, {
      ...validState,
      attachments: [{ resource: 'color', format: 'bgra8unorm' }],
    });
  });

  it('rejects indexed records without index data and vertex records with index data', () => {
    const missingIndex: RenderFeatureGraphicsPassDescriptor = {
      ...validPass,
      draws: [{ ...indexedDraw, indexData: undefined }],
    };
    const unexpectedIndex: RenderFeatureGraphicsPassDescriptor = {
      ...validPass,
      draws: [{ ...vertexDraw, indexData: { resource: indices, format: 'uint16' } }],
    };
    expectFailure(missingIndex, validState);
    expectFailure(unexpectedIndex, validState);
  });
});
