import type {
  GraphBuffer,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { addCardRadiosityGraph, type FieldKernelPass } from '../../raytracing/card-radiosity-graph';
import { irradianceFieldKernelBindings } from '../../raytracing/irradiance-field';
import type { PreparedIrradianceField } from '../../raytracing/renderer-irradiance-field';
import type { RenderPipelineFrame } from '../../render-pipeline';

function graphFixture(enabled = true) {
  let selected = [0, 1];
  let pendingCapture = false;
  let captureSlice: 'load' | undefined;
  const writeFrame = vi.fn();
  const legacy = vi.fn(() => ok(undefined));
  const prepared = {
    tileCount: 4,
    plan: { cardResolution: 8, raysPerProbe: 16 },
    cardRadiosity: enabled
      ? { plan: { probesPerCard: 4, raysPerProbe: 16 }, update: () => ({ tiles: selected }) }
      : undefined,
    schedule: () => ({ probes: 2 }),
    writeFrame,
    pendingMaterialCapture: () => pendingCapture,
    capture: () => captureSlice,
    view: { radiateCards: { record: legacy } },
    sample: {},
  } as unknown as PreparedIrradianceField;
  type Call = {
    label: string;
    stage: keyof PreparedIrradianceField['kernels'];
    work: number;
    workAtEncode: () => number;
    before: ((value: PreparedIrradianceField) => void) | undefined;
    after: readonly string[];
    executeIf: (() => boolean) | undefined;
    accesses: readonly string[];
  };
  const calls: Call[] = [];
  const factory: FieldKernelPass = (label, stage, work, before, after = [], executeIf) => {
    calls.push({
      label,
      stage,
      work: work(prepared),
      workAtEncode: () => work(prepared),
      before,
      after,
      executeIf,
      accesses: irradianceFieldKernelBindings('global-sdf', stage).map(
        ([, kind, name]) => `${name}:${kind}`,
      ),
    });
    return ok(undefined);
  };
  const addComputePass = vi.fn(() => ok(undefined));
  const graph = { addComputePass } as unknown as RenderGraphBuilder<RenderPipelineFrame>;
  const handle = (name: string) => ({ name }) as unknown as GraphBuffer;
  const input = {
    graph,
    prepared,
    current: () => prepared,
    kernelPass: factory,
    frameUniform: handle('frame'),
    surfaces: handle('surface'),
    cardDirect: handle('direct'),
    cardLit: handle('lit'),
    tileThreads: () => 128,
    fieldReads: () => [{ resource: handle('field'), usage: 'uniform-read' as const }],
  };
  return {
    input,
    calls,
    writeFrame,
    legacy,
    addComputePass,
    select: (tiles: number[]) => {
      selected = tiles;
    },
    capturePending: (pending: boolean) => {
      pendingCapture = pending;
    },
    capturing: (slice: 'load' | undefined) => {
      captureSlice = slice;
    },
  };
}

it('preserves the complete prior-bounce, World update, and current Card pass sequence', () => {
  const f = graphFixture();
  expect(addCardRadiosityGraph(f.input).ok).toBe(true);
  expect(f.calls.map(({ label, stage, work }) => [label, stage, work])).toEqual([
    ['card-radiosity-bounce', 'prepareCardRadiosityBounce', 256],
    ['place-probes', 'placeProbes', 2],
    ['trace-probes', 'traceProbes', 32],
    ['update-probes', 'updateProbes', 2],
    ['placeCardRadiosity', 'placeCardRadiosity', 8],
    ['traceCardRadiosity', 'traceCardRadiosity', 128],
    ['visibilityCardRadiosity', 'visibilityCardRadiosity', 128],
    ['filterCardRadiosity', 'filterCardRadiosity', 128],
    ['integrateCardRadiosity', 'integrateCardRadiosity', 8],
    ['radiosity', 'resolveCardRadiosity', 256],
  ]);
  expect(f.writeFrame).not.toHaveBeenCalled();
  f.calls[2]?.before?.(f.input.prepared);
  expect(f.writeFrame).toHaveBeenCalledTimes(1);
  expect(f.calls[3]?.after).toEqual(['deriveProbes']);
  expect(f.addComputePass).not.toHaveBeenCalled();
});

it('retains the binding authority and live selected-page gates', () => {
  const f = graphFixture();
  addCardRadiosityGraph(f.input);
  expect(f.calls[0]?.accesses).toEqual([
    'cardRadiosityFrame:uniform',
    'surfaces:read',
    'cardDirect:read',
    'cardRadiosityIndirect:read',
    'cardRadiosityBounce:storage',
    'cardRadiosityMeta:read',
  ]);
  expect(f.calls[5]?.accesses).toContain('cardRadiosityBounce:read');
  expect(f.calls[5]?.accesses).not.toContain('cardLit:read');
  const resolve = f.calls.find((call) => call.stage === 'resolveCardRadiosity');
  expect(resolve?.accesses).toContain('cardLit:storage');
  expect(resolve?.accesses).toContain('cardRadiosityIndirect:storage');
  expect(resolve?.accesses).toContain('cardRadiosityVisibility:read');
  expect(resolve?.accesses).not.toContain('cardRadiosityRays:read');
  const selected = f.calls.filter((call) => call.executeIf !== undefined);
  expect(selected.map((call) => call.executeIf?.())).toEqual([true, true, true, true, true]);
  f.capturePending(true);
  expect(selected.filter((call) => !call.executeIf?.()).map((call) => call.stage)).toEqual([
    'visibilityCardRadiosity',
  ]);
  f.capturePending(false);
  f.capturing('load');
  expect(selected.filter((call) => !call.executeIf?.()).map((call) => call.stage)).toEqual([
    'visibilityCardRadiosity',
  ]);
  f.capturing(undefined);
  f.select([]);
  expect(selected.map((call) => call.workAtEncode())).toEqual([0, 0, 0, 0, 0]);
  expect(selected.map((call) => call.executeIf?.())).toEqual([false, false, false, false, false]);
});

it('returns the same graph failure and does not assemble later passes', () => {
  const f = graphFixture();
  const failure = err({ code: 'test-only' } as unknown as RenderGraphError);
  const record = f.input.kernelPass;
  f.input.kernelPass = (...args) => (args[1] === 'filterCardRadiosity' ? failure : record(...args));
  expect(addCardRadiosityGraph(f.input)).toBe(failure);
  expect(f.calls.at(-1)?.stage).toBe('visibilityCardRadiosity');
  expect(f.writeFrame).not.toHaveBeenCalled();
});

it('keeps the feedback-off World passes and legacy radiosity pass access and encode order', () => {
  const f = graphFixture(false);
  expect(addCardRadiosityGraph(f.input).ok).toBe(true);
  expect(f.calls.map((call) => call.stage)).toEqual(['placeProbes', 'traceProbes', 'updateProbes']);
  expect(f.addComputePass).toHaveBeenCalledTimes(1);
  const [label, descriptor] = f.addComputePass.mock.calls[0] as unknown as [
    string,
    {
      accesses: readonly { resource: GraphBuffer; usage: string }[];
      encodeDirect: (pass: unknown, frame: unknown, resources: unknown) => void;
    },
  ];
  expect(label).toBe('irradiance-field.radiosity');
  expect(descriptor.accesses.map(({ resource, usage }) => [resource, usage])).toEqual([
    [f.input.frameUniform, 'uniform-read'],
    [f.input.surfaces, 'storage-read'],
    [f.input.cardDirect, 'storage-read'],
    [f.input.cardLit, 'storage-write'],
    ...f.input.fieldReads().map(({ resource, usage }) => [resource, usage]),
  ]);
  const pass = {};
  descriptor.encodeDirect(pass, {}, { buffer: (resource: GraphBuffer) => ok(resource) });
  const [encodedPass, buffers, sample, threads] = f.legacy.mock.calls[0] as unknown as [
    unknown,
    readonly { buffer: GraphBuffer }[],
    unknown,
    number,
  ];
  expect(encodedPass).toBe(pass);
  expect(buffers.map((row) => row.buffer)).toEqual([
    f.input.frameUniform,
    f.input.surfaces,
    f.input.cardDirect,
    f.input.cardLit,
  ]);
  expect(sample).toBe(f.input.prepared.sample);
  expect(threads).toBe(128);
});
