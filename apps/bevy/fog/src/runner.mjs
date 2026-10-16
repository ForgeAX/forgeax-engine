import { buildFogTrace, FOG_PHASES } from './oracle.mjs';

function phaseForFrame(phases, frame, frameCount) {
  const index = Math.min(phases.length - 1, Math.floor((frame * phases.length) / frameCount));
  return phases[index];
}

export async function runFogLifecycle({
  backend,
  frameCount = 60,
  phases = FOG_PHASES,
  advanceFrame,
  captureFrame,
}) {
  if (backend !== 'browser' && backend !== 'dawn') {
    throw new Error(`backend must be browser or dawn; actual=${String(backend)}`);
  }
  if (!Number.isInteger(frameCount) || frameCount <= 0) throw new Error('frameCount must be positive');
  if (!Array.isArray(phases) || phases.length === 0) throw new Error('phases must be non-empty');
  if (typeof advanceFrame !== 'function') throw new Error('advanceFrame is required');
  if (typeof captureFrame !== 'function') throw new Error('captureFrame is required');

  const phaseTrace = [];
  const cases = [];
  const resourceTrace = [];
  const visualEvidence = [];
  let previousPhase;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const phase = phaseForFrame(phases, frame, frameCount);
    const nextPhase =
      frame + 1 < frameCount ? phaseForFrame(phases, frame + 1, frameCount) : undefined;
    const phaseChanged = phase !== previousPhase;
    const sampleRequired = phaseChanged || nextPhase !== phase;
    const advanced = await advanceFrame({ frame, phase, phaseChanged, sampleRequired });
    phaseTrace.push(phase);
    if (!sampleRequired) {
      previousPhase = phase;
      continue;
    }
    const sample = await captureFrame({ frame, phase, phaseChanged, advanced });
    if (sample === null || typeof sample !== 'object') throw new Error(`frame ${frame} did not return a sample`);
    if (!Array.isArray(sample.cases) || sample.cases.length === 0) {
      throw new Error(`frame ${frame} did not return case verdicts`);
    }
    if (sample.resource === null || typeof sample.resource !== 'object') {
      throw new Error(`frame ${frame} did not return resource facts`);
    }
    if (sample.visual === null || typeof sample.visual !== 'object') {
      throw new Error(`frame ${frame} did not return visual evidence`);
    }
    cases.push(...sample.cases.map((entry) => ({ frame, phase, ...entry })));
    resourceTrace.push({ frame, phase, ...sample.resource });
    visualEvidence.push({ frame, phase, ...sample.visual });
    previousPhase = phase;
  }
  return buildFogTrace({ backend, frames: frameCount, phaseTrace, cases, resourceTrace, visualEvidence });
}
