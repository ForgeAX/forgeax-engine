import { describe, expect, it } from 'vitest';
import {
  resolveTransmissionBackdropTopology,
  type TransmissionBackdropResourceFacts,
  TransmissionCandidateAdmission,
  type TransmissionCapabilityFacts,
} from '../backdrop';
import {
  estimateTransmissionBackdropBytes,
  inspectTransmission,
  inspectTransmissionFromAdmission,
  type TransmissionInspectionInput,
} from '../inspection';

function facts(overrides: Partial<TransmissionCapabilityFacts> = {}): TransmissionCapabilityFacts {
  return {
    format: 'rgba16float',
    renderAttachment: true,
    copySrc: true,
    textureBinding: true,
    mipView: true,
    filteringSampler: true,
    bindGroupLayout: true,
    msaaResolve: true,
    resourceCreation: true,
    ...overrides,
  };
}

function resource(overrides: Partial<TransmissionBackdropResourceFacts> = {}) {
  return {
    extent: { width: 4, height: 4 },
    format: 'rgba16float',
    mipCount: 2,
    bytes: 160,
    deviceGeneration: 3,
    ...overrides,
  } satisfies TransmissionBackdropResourceFacts;
}

function input(overrides: Partial<TransmissionInspectionInput> = {}): TransmissionInspectionInput {
  return {
    demand: { activeCount: 2, needsRoughMips: true },
    topology: resolveTransmissionBackdropTopology({
      demand: { activeCount: 2, needsRoughMips: true },
      sourceSampleCount: 1,
    }),
    extent: { width: 4, height: 4 },
    generation: 7,
    lastKnownGood: true,
    recovery: 'idle',
    transmissionDrawCount: 2,
    fallbackCount: 1,
    ...overrides,
  };
}

describe('detached transmission inspection', () => {
  it('derives the bounded cost fields from demand and typed topology', () => {
    const inspection = inspectTransmission(input());

    expect(inspection).toEqual({
      activeCount: 2,
      needsRoughMips: true,
      extent: { width: 4, height: 4 },
      format: 'rgba16float',
      mipCount: 2,
      bytes: 160,
      copyCount: 1,
      transmissionDrawCount: 2,
      fallbackCount: 1,
      generation: 7,
      singleLayer: true,
      lifecycle: 'resident',
      lastKnownGood: true,
      recovery: 'idle',
      capability: { ok: true, missing: [] },
    });
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection.extent)).toBe(true);
    expect(estimateTransmissionBackdropBytes({ width: 4, height: 4 }, 2)).toBe(160);
  });

  it('restores exact zero physical work when demand has no active candidate', () => {
    const inspection = inspectTransmission({
      demand: { activeCount: 0, needsRoughMips: false },
      topology: resolveTransmissionBackdropTopology({
        demand: { activeCount: 0, needsRoughMips: false },
        sourceSampleCount: 4,
      }),
      extent: { width: 320, height: 200 },
      generation: 8,
      lastKnownGood: false,
      recovery: 'idle',
    });

    expect(inspection).toMatchObject({
      activeCount: 0,
      needsRoughMips: false,
      mipCount: 0,
      bytes: 0,
      copyCount: 0,
      transmissionDrawCount: 0,
      fallbackCount: 0,
      singleLayer: true,
      lifecycle: 'inactive',
    });
  });

  it('projects only committed admission facts and keeps a compatible LKG on rejection', () => {
    const admission = new TransmissionCandidateAdmission();
    const demand = { activeCount: 1, needsRoughMips: true } as const;
    expect(admission.admit(demand, facts(), resource()).ok).toBe(true);

    const rejected = admission.admit(demand, facts({ copySrc: false }), resource());
    expect(rejected).toMatchObject({ ok: false, published: false, generation: 1 });

    const inspection = inspectTransmissionFromAdmission({
      admission: admission.inspectLifecycle(),
      topology: resolveTransmissionBackdropTopology({ demand, sourceSampleCount: 1 }),
      extent: { width: 99, height: 99 },
      transmissionDrawCount: 1,
    });
    expect(inspection).toMatchObject({
      generation: 1,
      extent: { width: 4, height: 4 },
      bytes: 160,
      copyCount: 1,
      lifecycle: 'resident',
      lastKnownGood: true,
      recovery: 'compatible-lkg',
      capability: { ok: false, missing: ['copySrc'] },
    });
  });

  it('does not expose live GPU objects and serializes deterministically', () => {
    const inspection = inspectTransmission(
      input({
        capability: { ok: false, missing: ['resourceCreation'] },
        lifecycle: 'failed',
        recovery: 'rebuild-required',
      }),
    );
    const serialized = JSON.stringify(inspection);
    expect(JSON.parse(serialized)).toEqual(inspection);
    expect(serialized).not.toMatch(/texture|view|encoder|queue/i);
    expect(Object.keys(inspection)).toEqual([
      'activeCount',
      'needsRoughMips',
      'extent',
      'format',
      'mipCount',
      'bytes',
      'copyCount',
      'transmissionDrawCount',
      'fallbackCount',
      'generation',
      'singleLayer',
      'lifecycle',
      'lastKnownGood',
      'recovery',
      'capability',
    ]);
  });

  it('clears the old physical resource after device loss while retaining demand for rebuild', () => {
    const admission = new TransmissionCandidateAdmission();
    const demand = { activeCount: 1, needsRoughMips: false } as const;
    admission.admit(demand, facts(), resource({ mipCount: 1, bytes: 128 }));
    admission.markDeviceLost();

    const inspection = inspectTransmissionFromAdmission({
      admission: admission.inspectLifecycle(),
      topology: resolveTransmissionBackdropTopology({ demand, sourceSampleCount: 1 }),
      extent: { width: 4, height: 4 },
    });
    expect(inspection).toMatchObject({
      activeCount: 1,
      needsRoughMips: false,
      mipCount: 0,
      bytes: 0,
      copyCount: 0,
      generation: 1,
      lifecycle: 'device-lost',
      lastKnownGood: false,
      recovery: 'rebuild-required',
    });
  });

  it('retires an incompatible resize candidate instead of exposing stale LKG bytes', () => {
    const admission = new TransmissionCandidateAdmission();
    const demand = { activeCount: 1, needsRoughMips: true } as const;
    expect(admission.admit(demand, facts(), resource()).ok).toBe(true);

    const rejected = admission.admit(
      demand,
      facts({ copySrc: false }),
      resource({ extent: { width: 8, height: 4 }, mipCount: 4, bytes: 352 }),
    );
    expect(rejected).toMatchObject({
      ok: false,
      published: false,
      generation: 1,
      demand,
      missing: ['copySrc'],
    });
    expect(admission.inspectLifecycle()).toMatchObject({
      lifecycle: 'failed',
      lastKnownGood: false,
      recovery: 'rebuild-required',
    });
    expect(admission.inspectLifecycle()).not.toHaveProperty('resource');
  });

  it('publishes a recovered resource after an explicit device-loss recovery', () => {
    const admission = new TransmissionCandidateAdmission();
    const demand = { activeCount: 1, needsRoughMips: true } as const;
    expect(admission.admit(demand, facts(), resource()).ok).toBe(true);

    admission.markRecoveryStarted();
    expect(admission.inspectLifecycle()).toMatchObject({
      lifecycle: 'recovering',
      lastKnownGood: false,
      recovery: 'rebuild-required',
    });

    const recovered = admission.admit(
      demand,
      facts(),
      resource({ deviceGeneration: 4, extent: { width: 8, height: 4 }, mipCount: 3, bytes: 336 }),
    );
    expect(recovered).toMatchObject({ ok: true, published: true, generation: 2 });
    expect(admission.inspectLifecycle()).toMatchObject({
      lifecycle: 'resident',
      lastKnownGood: true,
      recovery: 'recovered',
      resource: expect.objectContaining({ deviceGeneration: 4, extent: { width: 8, height: 4 } }),
    });
  });
});

it('retains the actual F32 backdrop format and complete mip cost in admission inspection', () => {
  const admission = new TransmissionCandidateAdmission();
  const demand = { activeCount: 2, needsRoughMips: true };
  const extent = { width: 4, height: 4 };
  const bytes = estimateTransmissionBackdropBytes(extent, 3, 'rgba32float');
  expect(bytes).toBe((16 + 4 + 1) * 16);
  expect(
    admission.admit(
      demand,
      facts({ format: 'rgba32float' }),
      resource({
        extent,
        format: 'rgba32float',
        mipCount: 3,
        bytes,
      }),
    ).ok,
  ).toBe(true);
  const inspected = inspectTransmissionFromAdmission({
    admission: admission.inspectLifecycle(),
    extent,
    topology: resolveTransmissionBackdropTopology({ demand, sourceSampleCount: 1 }),
  });
  expect(inspected).toMatchObject({ format: 'rgba32float', mipCount: 3, bytes: 336, copyCount: 1 });
});
