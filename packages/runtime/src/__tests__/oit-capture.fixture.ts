import {
  buildFrameModel,
  decodeTape,
  type EncodedTape,
  openReplay,
  type ReplayBackend,
  summarizeFrame,
  type V7Tape,
} from '@forgeax/engine-rhi-debug';
import { expect } from 'vitest';
import { oitAccumulation } from '../../../render/src/oit/weight';
import {
  OIT_PROBES,
  OIT_SIZE,
  type OitProbe,
  type ProbeValues,
  probeFragments,
  probeReference,
  readPixel,
} from './oit.fixture';

/** Shared blend of every OIT accumulation target. */
const SHARED_BLEND = {
  color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
  alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one-minus-src-alpha' },
};

const CYCLIC = OIT_PROBES.filter((probe) => probe.name === 'left' || probe.name === 'right');

type Json = Record<string, unknown>;

function fragmentEntry(work: {
  pipeline: { shaders: readonly { stage: string; entryPoint: string }[] };
}) {
  return work.pipeline.shaders.find((shader) => shader.stage === 'fragment')?.entryPoint;
}

/** view id -> texture id over bootstrap and frame events. */
function viewTextures(tape: V7Tape) {
  const map = new Map<string, string>();
  const visit = (event: unknown) => {
    const e = event as { kind?: string; resultHandleId?: string; sourceHandleId?: string };
    if (e.kind === 'createTextureView' && e.resultHandleId && e.sourceHandleId)
      map.set(e.resultHandleId, e.sourceHandleId);
  };
  for (const entry of tape.bootstrap) visit(entry.create);
  for (const event of tape.events) visit(event);
  return map;
}

function pixel(result: { bytes: Uint8Array; format?: string; width?: number }, probe: OitProbe) {
  const format = result.format ?? 'rgba16float';
  const bytesPerPixel = format === 'r16float' ? 2 : format === 'rgba16float' ? 8 : 4;
  const width = result.width ?? OIT_SIZE;
  if (format === 'r16float') {
    const data = new DataView(
      result.bytes.buffer,
      result.bytes.byteOffset,
      result.bytes.byteLength,
    );
    const bits = data.getUint16((probe.y * width + probe.x) * 2, true);
    return readPixel(
      new Uint8Array([bits & 255, bits >> 8, 0, 0, 0, 0, 0, 0]),
      {
        bytesPerRow: 8,
        format: 'rgba16float',
      },
      0,
      0,
    );
  }
  return readPixel(result.bytes, { bytesPerRow: width * bytesPerPixel, format }, probe.x, probe.y);
}

/**
 * AC-4: replay one captured OIT frame on a fresh device and prove the
 * accumulation, the composite and the final color from the tape alone.
 */
export async function inspectOitTape(input: {
  readonly encoded: EncodedTape;
  readonly live: ProbeValues;
  readonly msaa: boolean;
  readonly backend: ReplayBackend;
}) {
  const tape = decodeTape(input.encoded.bytes).unwrap();
  const model = buildFrameModel(tape);
  const summary = summarizeFrame(model);
  const accumulateWorks = model.works.filter(
    (work) =>
      fragmentEntry(work)?.startsWith('fs_oit') && fragmentEntry(work) !== 'fs_oit_composite',
  );
  const composite = model.works.filter((work) => fragmentEntry(work) === 'fs_oit_composite');
  expect(accumulateWorks.map(fragmentEntry)).toEqual(['fs_oit', 'fs_oit', 'fs_oit']);
  expect(composite).toHaveLength(1);
  const summaryEntries = summary.works.map(
    (work) => work.entryPoints.find((entry) => entry.stage === 'fragment')?.entryPoint,
  );
  expect(summaryEntries).toEqual(expect.arrayContaining(['fs_oit', 'fs_oit_composite']));
  const lastAccumulate = accumulateWorks.at(-1);
  const compositeWork = composite[0];
  if (lastAccumulate === undefined || compositeWork === undefined)
    throw new Error('Missing OIT works');
  expect(compositeWork.workIndex).toBeGreaterThan(lastAccumulate.workIndex);

  const attachments = lastAccumulate.attachments;
  expect(attachments?.colorViewHandleIds).toHaveLength(2);
  const resolves = attachments?.colorResolveViewHandleIds ?? [];
  if (input.msaa) expect(resolves.every((id) => typeof id === 'string')).toBe(true);
  else expect(resolves).toEqual([null, null]);
  const [accumId, weightId] = input.msaa
    ? (resolves as string[])
    : (attachments?.colorViewHandleIds ?? []);
  if (accumId === undefined || weightId === undefined) throw new Error('Missing OIT target ids');

  const descriptor = (lastAccumulate.pipeline.descriptor as Json).desc as Json;
  const targets = (descriptor.fragment as Json).targets as Json[];
  expect(targets.map((target) => target.format)).toEqual(['rgba16float', 'r16float']);
  for (const target of targets) expect(target.blend).toEqual(SHARED_BLEND);
  expect((descriptor.depthStencil as Json).depthWriteEnabled).toBe(false);
  expect((descriptor.multisample as Json | undefined)?.count ?? 1).toBe(input.msaa ? 4 : 1);

  const compositeBindings = compositeWork.bindings.map((binding) => binding.resourceId);
  expect(compositeBindings).toEqual(expect.arrayContaining([accumId, weightId]));
  const sceneId = input.msaa
    ? compositeWork.attachments?.colorResolveViewHandleIds[0]
    : compositeWork.attachments?.colorViewHandleIds[0];
  if (typeof sceneId !== 'string') throw new Error('Missing composite scene color');

  const views = viewTextures(tape);
  const unseeded = new Set(model.unseededResources.map((resource) => resource.resourceId));
  for (const id of [accumId, weightId, sceneId])
    expect(unseeded.has(views.get(id) ?? id)).toBe(false);

  const replay = (await openReplay(tape, input.backend)).unwrap();
  try {
    const inspectedAccumulate = (
      await replay.inspectWork(lastAccumulate.workIndex, ['pipeline', 'bindings'])
    ).unwrap();
    const inspectedComposite = (
      await replay.inspectWork(compositeWork.workIndex, ['pipeline', 'bindings'])
    ).unwrap();
    expect(inspectedAccumulate.pipeline?.pipelineHandleId).toBe(
      lastAccumulate.pipeline.pipelineHandleId,
    );
    expect(inspectedComposite.bindings?.map((binding) => binding.resourceId)).toEqual(
      expect.arrayContaining([accumId, weightId]),
    );
    const read = async (id: string, workIndex: number) =>
      (await replay.readResourceAtWork(id, workIndex, { mipLevel: 0, arrayLayer: 0 })).unwrap();
    const accum = await read(accumId, lastAccumulate.workIndex);
    const weight = await read(weightId, lastAccumulate.workIndex);
    const sceneBefore = await read(sceneId, lastAccumulate.workIndex);
    const sceneAfter = await read(sceneId, compositeWork.workIndex);
    expect(accum.format).toBe('rgba16float');
    expect(weight.format).toBe('r16float');

    const probes = Object.fromEntries(
      OIT_PROBES.map((probe) => {
        const expected = oitAccumulation(probeFragments(probe));
        const accumPixel = pixel(accum, probe);
        const weightPixel = pixel(weight, probe);
        const before = pixel(sceneBefore, probe).slice(0, 3);
        const after = pixel(sceneAfter, probe).slice(0, 3);
        return [
          probe.name,
          {
            expected,
            accum: accumPixel,
            weight: weightPixel[0],
            before,
            after,
            live: input.live[probe.name],
          },
        ];
      }),
    );
    for (const probe of OIT_PROBES) {
      const entry = probes[probe.name];
      if (entry === undefined) throw new Error(`Missing probe ${probe.name}`);
      const relative = (value: number, reference: number) =>
        Math.abs(value - reference) / Math.max(1, Math.abs(reference));
      if (probe.name !== 'occluded') {
        for (let c = 0; c < 3; c++)
          expect(
            relative(entry.accum[c] ?? 0, entry.expected.color[c] ?? 0),
            `${probe.name} accum[${c}]`,
          ).toBeLessThanOrEqual(0.01);
        expect(
          Math.abs((entry.accum[3] ?? 0) - entry.expected.revealage),
          `${probe.name} revealage`,
        ).toBeLessThanOrEqual(0.01);
        expect(
          relative(entry.weight ?? 0, entry.expected.weight),
          `${probe.name} weight`,
        ).toBeLessThanOrEqual(0.01);
      }
      const reference = probeReference(probe).weighted;
      for (let c = 0; c < 3; c++) {
        expect(
          Math.abs((entry.after[c] ?? 0) - (reference[c] ?? 0)),
          `${probe.name} after[${c}]`,
        ).toBeLessThanOrEqual(0.05);
        expect(
          Math.abs((entry.after[c] ?? 0) - (entry.live[c] ?? 0)),
          `${probe.name} replay vs live`,
        ).toBeLessThanOrEqual(0.01);
      }
    }
    // Falsifier: scene color before the composite fails AC-1 at the cyclic
    // probes, so the live probes observe the OIT composite.
    const beforeGap = Math.max(
      ...CYCLIC.flatMap((probe) => {
        const reference = probeReference(probe).weighted;
        const before = probes[probe.name]?.before ?? [];
        return reference.map((value, c) => Math.abs(value - (before[c] ?? 0)));
      }),
    );
    expect(beforeGap, 'pre-composite scene color must fail the AC-1 reference').toBeGreaterThan(
      0.05,
    );
    return {
      digest: input.encoded.digest,
      msaa: input.msaa,
      summary,
      works: {
        accumulate: accumulateWorks.map((work) => work.workIndex),
        composite: compositeWork.workIndex,
      },
      resources: { accum: accumId, weight: weightId, scene: sceneId },
      accumulatePipeline: inspectedAccumulate.pipeline?.descriptor,
      compositeBindings: inspectedComposite.bindings,
      probes,
      preCompositeReferenceGap: beforeGap,
      raw: {
        accum: accum.bytes,
        weight: weight.bytes,
        sceneBefore: sceneBefore.bytes,
        sceneAfter: sceneAfter.bytes,
      },
    };
  } finally {
    (await replay.dispose()).unwrap();
  }
}
