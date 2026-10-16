import { describe, expect, it } from 'vitest';
import { createCubeCaptureScheduler } from '../capture/scheduler';
import { boundedReflectionProbeFilterWork } from '../record/typed-frame-graph';
import { advanceProbeFilter, createProbeFilterState } from '../reflection/filter';
import type { RenderTarget } from '../targets/contracts';

const FRAME_COUNT = 60;
const target = {} as RenderTarget;

describe('RenderTarget and ReflectionProbe 60-frame soak contract', () => {
  it('keeps off and settled steady-state work exactly zero', () => {
    const scheduler = createCubeCaptureScheduler({ maxFacesPerFrame: 1 });
    const initialFilter = createProbeFilterState({ probeIndex: 0, faceCount: 6, mipCount: 5 });
    const completeFilter = {
      ...initialFilter,
      cursor: initialFilter.faceCount * initialFilter.mipCount,
    };

    for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
      scheduler.beginFrame();
      expect(scheduler.nextWork()).toHaveLength(0);
      expect(boundedReflectionProbeFilterWork({ work: [], maxStepsPerFrame: 1 })).toHaveLength(0);
      expect(advanceProbeFilter(completeFilter)).toBeUndefined();
    }

    expect({ extraction: 0, encoder: 0, finish: 0, submit: 0 }).toEqual({
      extraction: 0,
      encoder: 0,
      finish: 0,
      submit: 0,
    });
  });

  it('bounds one capture face and one filter step while settling one update', () => {
    const scheduler = createCubeCaptureScheduler({ maxFacesPerFrame: 1 });
    const requested = scheduler.request({
      target,
      position: [0, 0, 0],
      near: 0.1,
      far: 100,
      updateIntent: 'on-demand',
      requestVersion: 1,
      faceBudget: 1,
    });
    expect(requested.ok).toBe(true);

    let filter = createProbeFilterState({ probeIndex: 0, faceCount: 6, mipCount: 5 });
    let captureFrames = 0;
    let filterFrames = 0;
    let extraction = 0;
    let encoder = 0;
    let finish = 0;
    let submit = 0;
    let peakCandidates = 0;

    for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
      scheduler.beginFrame();
      const faces = scheduler.nextWork();
      const filterStep = advanceProbeFilter(filter);
      const filterWork = boundedReflectionProbeFilterWork({
        work: filterStep === undefined ? [] : [filterStep],
        maxStepsPerFrame: 1,
      });
      expect(faces.length).toBeLessThanOrEqual(1);
      expect(filterWork.length).toBeLessThanOrEqual(1);

      if (faces.length > 0) {
        captureFrames += 1;
        extraction += 1;
        encoder += 1;
        finish += 1;
        submit += 1;
        expect(scheduler.completeSubmission(true).ok).toBe(true);
      }
      if (filterStep !== undefined) {
        filterFrames += 1;
        filter = { ...filter, cursor: filter.cursor + 1 };
      }
      peakCandidates = Math.max(peakCandidates, scheduler.inspect(target).candidateGeneration ?? 0);
    }

    expect(captureFrames).toBe(6);
    expect(filterFrames).toBe(30);
    expect({ extraction, encoder, finish, submit }).toEqual({
      extraction: 6,
      encoder: 6,
      finish: 6,
      submit: 6,
    });
    expect(peakCandidates).toBe(1);
    expect(scheduler.inspect(target).pendingFaces).toEqual([]);
    expect(scheduler.inspect(target).activeGeneration).toBe(1);
  });
});
