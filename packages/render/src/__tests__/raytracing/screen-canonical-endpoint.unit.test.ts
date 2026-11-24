import { expect, it } from 'vitest';
import {
  SDF_SURFACE_TRACE_HINTED_RECEIVER_WGSL,
  SDF_SURFACE_TRACE_RECEIVER_WGSL,
} from '../../../../shader/src/sdf-surface-trace-wgsl';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  screenProbeRootRoster,
  screenProbeWorldRoster,
} from '../../raytracing/screen-probe-kernels';
import { screenProbeReceiverWgsl } from '../../raytracing/screen-probe-receiver';
import {
  candidateCodec,
  endpointCandidateControl,
  endpointRowControl,
  endpointSceneControl,
} from './screen-canonical-endpoint.fixture';

it('uses a certified endpoint bound only after paying every visited World node and primitive', () => {
  const actual = endpointRowControl(4);
  expect(actual.result.state).toBe(1);
  expect(actual.result.primitive).toBe(1);
  expect(actual.remaining).toBe(0);
  expect(actual.visits).toEqual([]);
  expect(actual.segmentPreparations).toBe(1);
  expect(actual.segmentBounds).toBe(3);
});

it('shares one local row enclosure across every visited node and ordinary charged leaf', () => {
  for (const row of [0, 1]) {
    const actual = endpointRowControl(5, undefined, { row, otherTime: 1 });
    expect(actual.result.state).toBe(1);
    expect(actual.result.primitive).toBe(0);
    expect(actual.remaining).toBe(0);
    expect(actual.segmentPreparations).toBe(1);
    expect(actual.segmentBounds).toBe(3);
    expect(actual.visits).toEqual(row === 0 ? [0] : [0, 1]);
  }
});

it('derives a single paid Screen test from the real source header and accepted opaque primitive', () => {
  const endpoint = endpointCandidateControl();
  expect(endpoint.tests).toBe(1);
  expect(endpoint.tested).toBe(1);
  expect(endpoint.trace).toMatchObject({ state: 1, row: 0, primitive: 1, lower: 1, upper: 1 });
  const query = endpointRowControl(4, undefined, { seed: endpoint.trace });
  expect(query.result).toMatchObject({ state: 1, primitive: 1, lower: 1 });
  expect(query.visits).toEqual([]);
});

it('rejects stale frame/source/pose, missing coverage and unsupported receiver metadata before triangle work', () => {
  for (const input of [
    { frame: 12 },
    { revision: 4 },
    { epoch: 8 },
    { opaque: false },
    { identity: false },
    { source: false },
    { contact: false },
  ]) {
    const endpoint = endpointCandidateControl(input);
    expect(endpoint.trace.state, JSON.stringify(input)).toBe(0);
    expect(endpoint.tested).toBe(0);
    expect(endpoint.tests).toBe(0);
  }
});

it('current camera and accepted pose updates can produce a new endpoint without borrowing history identity', () => {
  for (const input of [
    { frame: 12, acceptedFrame: 12, candidateFrame: 12 },
    { frame: 0xffffffff, acceptedFrame: 0xffffffff, candidateFrame: 0xffffffff },
    {
      epoch: 8,
      acceptedEpoch: 8,
      revision: 4,
      acceptedRevision: 4,
      candidateRevision: 4,
      targetZ: 2,
    },
  ]) {
    const endpoint = endpointCandidateControl(input);
    expect(endpoint.trace.state).toBe(1);
    expect(endpoint.tests).toBe(1);
    expect(endpoint.trace.lower).toBe(input.targetZ ?? 1);
  }
});

it('a raster pixel is not an on-ray certificate and invalid hints preserve the exact original query budget', () => {
  for (const input of [{ offRay: true }, { direction: -1 }]) {
    const endpoint = endpointCandidateControl(input);
    expect(endpoint.tests).toBe(1);
    expect(endpoint.trace.state).toBe(0);
    for (const budget of [0, 1, 2, 3, 4, 5, 256]) {
      const actual = endpointRowControl(budget, undefined, { seed: endpoint.trace });
      const reference = endpointRowControl(budget, SDF_SURFACE_TRACE_RECEIVER_WGSL, {
        seed: endpoint.trace,
      });
      expect(actual).toEqual(reference);
    }
  }
});

it('requires the original nearest prefix, including thin opaque and front/equal unknown coverage', () => {
  const seed = endpointCandidateControl().trace;
  const opaque = endpointRowControl(256, undefined, { seed, otherTime: 0.5 });
  expect(opaque.result).toMatchObject({ state: 1, primitive: 0, lower: 0.5 });
  for (const otherTime of [0.5, 1]) {
    const unknown = endpointRowControl(256, undefined, { seed, otherTime, otherState: 2 });
    expect(unknown.result.state).toBe(2);
  }
  const behind = endpointRowControl(256, undefined, { seed, otherTime: 1.5, otherState: 2 });
  expect(behind.result).toMatchObject({ state: 1, primitive: 1, lower: 1 });
});

it('keeps cross-row uncertainty and does not turn an unvisited endpoint into a scene hit', () => {
  expect(endpointSceneControl().result).toMatchObject({
    state: 1,
    row: 1,
    primitive: 0,
    lower: 0.5,
  });
  for (const time of [0.5, 1])
    expect(endpointSceneControl({ time, state: 2 }).result.state).toBe(2);
  expect(endpointSceneControl({ time: 1.5, state: 2 }).result).toMatchObject({
    state: 1,
    row: 0,
    primitive: 1,
    lower: 1,
  });
  expect(endpointSceneControl({ source: false }).result.state).toBe(2);
  expect(endpointSceneControl({ seedVisited: false, time: 9, state: 0 }).result.state).toBe(2);
});

it('transports complete uint frame/revision words using only normal finite Ray32 payload values', () => {
  const codec = candidateCodec();
  for (const frame of [0, 1, 0x007fffff, 0x00800000, 0x7fffffff, 0x80000000, 0xffffffff]) {
    for (const revision of [0, 1, 0x80000000, 0xffffffff]) {
      const payload = codec.pack(
        Object.assign([16383, 16383], { x: 16383, y: 16383 }),
        frame,
        revision,
      );
      const stored = Array.from(Float32Array.from(payload));
      expect(stored.every((v) => Number.isFinite(v) && Math.abs(v) >= 2 ** -126)).toBe(true);
      expect(codec.valid(stored)).toBe(true);
      expect(codec.unpack(stored).map((v) => v >>> 0)).toEqual([0x3fff3fff, frame, revision]);
    }
  }
  for (const value of [0, -0, NaN, Infinity, -Infinity]) {
    const payload = codec.pack(Object.assign([0, 0], { x: 0, y: 0 }), 11, 3);
    payload[0] = value;
    expect(codec.valid(payload)).toBe(false);
    expect(endpointCandidateControl({ payload })).toMatchObject({
      tested: 0,
      tests: 0,
      trace: { state: 0 },
    });
  }
});

it('retains strict endpoint touching and logical payment under actual-source negative controls', () => {
  const shortcut = SDF_SURFACE_TRACE_HINTED_RECEIVER_WGSL.replace(
    'var best=sdfSurfaceTraceEmpty(last);best.row=row;',
    'return seed;var best=sdfSurfaceTraceEmpty(last);best.row=row;',
  );
  expect(endpointRowControl(0, shortcut).result.state).not.toBe(3);
  const equality = SDF_SURFACE_TRACE_HINTED_RECEIVER_WGSL.replace(
    'bounds.near>seed.upper',
    'bounds.near>=seed.upper',
  );
  expect(endpointRowControl(256, equality, { otherTime: 1, otherState: 2 }).result.state).not.toBe(
    2,
  );
});

it('adds only two current identity textures and one view uniform without a ninth storage buffer', () => {
  for (const roster of [
    screenProbeWorldRoster('global-sdf'),
    screenProbeRootRoster('refineRoot'),
  ]) {
    expect(
      roster.filter(([, kind]) => kind === 'read' || kind === 'storage').length,
    ).toBeLessThanOrEqual(8);
    expect(roster.filter(([binding]) => binding >= 17)).toEqual([
      [17, 'uint', 'visibleSurface'],
      [18, 'uint', 'receiverSource'],
      [19, 'uniform', 'receiverView'],
    ]);
  }
  expect(screenProbeRootRoster('resolveRoot').some(([binding]) => binding >= 17)).toBe(false);
});

it('composes the shared endpoint identity mapper through the actual receiver producer', async () => {
  const result = await compileShader(screenProbeReceiverWgsl(), {
    id: 'screen-canonical-endpoint-receiver',
  });
  expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
});

it('cannot redeem a Screen endpoint as a World hit at zero or one remaining work unit', () => {
  for (const budget of [0, 1]) {
    const actual = endpointRowControl(budget);
    expect(actual.result.state).toBe(3);
    expect(actual.remaining).toBe(0);
  }
});
