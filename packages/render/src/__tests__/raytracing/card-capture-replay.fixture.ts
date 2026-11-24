import type { buildFrameModel } from '@forgeax/engine-rhi-debug';

type Tape = Parameters<typeof buildFrameModel>[0];
type Frame = ReturnType<typeof buildFrameModel>;

export function replayPassWorks(tape: Tape, model: Frame, label: string) {
  return model.works.filter(({ passIndex }) => {
    const pass = model.passes[passIndex];
    const begin = pass && tape.events[pass.beginEventIndex];
    return (
      (begin?.kind === 'beginRenderPass' || begin?.kind === 'beginComputePass') &&
      begin.desc?.label === label
    );
  });
}

export function cardCaptureReplayStages(tape: Tape, model: Frame, materialDraws: number) {
  const material = replayPassWorks(tape, model, 'cards.capture');
  const identity = replayPassWorks(tape, model, 'cards.capture-identity');
  const firstMaterial = material[0];
  const lastMaterial = material.at(-1);
  const firstIdentity = identity[0];
  const lastIdentity = identity.at(-1);
  if (
    material.length !== materialDraws ||
    !firstMaterial ||
    !lastMaterial ||
    !firstIdentity ||
    !lastIdentity ||
    firstIdentity.workIndex !== lastMaterial.workIndex + 1
  ) {
    throw new Error(
      `Expected ${materialDraws} Card material draws followed by Card identity work. Found ${material.length} material and ${identity.length} identity draws.`,
    );
  }
  return {
    firstMaterial,
    lastMaterial,
    lastIdentity,
    rasterWorks: material.length + identity.length,
  };
}

export function cardQueryReplayStages(
  tape: Tape,
  model: Frame,
  materialDraws: number,
  lookupCount: 1 | 2 = 1,
) {
  const capture = cardCaptureReplayStages(tape, model, materialDraws);
  const trace = replayPassWorks(tape, model, 'sdf.trace');
  const lookup = replayPassWorks(tape, model, 'cards.lookup');
  const [traceWork] = trace;
  const [lookupWork, secondLookupWork] = lookup;
  if (
    trace.length !== 1 ||
    !traceWork ||
    lookup.length !== lookupCount ||
    !lookupWork ||
    traceWork.workIndex !== capture.lastIdentity.workIndex + 1 ||
    lookupWork.workIndex !== traceWork.workIndex + 1 ||
    (secondLookupWork && secondLookupWork.workIndex !== lookupWork.workIndex + 1) ||
    model.works.length !== capture.rasterWorks + trace.length + lookup.length
  ) {
    throw new Error(
      'Card replay must preserve the material, identity, trace and lookup stages in order',
    );
  }
  return { ...capture, traceWork, lookupWork, secondLookupWork };
}
