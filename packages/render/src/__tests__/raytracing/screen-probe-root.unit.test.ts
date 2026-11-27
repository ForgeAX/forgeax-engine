import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { screenProbeRootRoster, screenProbeWorldWgsl } from '../../raytracing/screen-probe-kernels';
import {
  planScreenProbeLayout,
  SCREEN_PROBE_DEFAULTS,
  SCREEN_PROBE_TEXELS,
  screenProbeAllocationSizes,
} from '../../raytracing/screen-probe-plan';
import {
  screenProbeRootPrepareWgsl,
  screenProbeRootRefineWgsl,
} from '../../raytracing/screen-probe-root-kernels';

it('seals both canonical origin endpoints and the original primitive without recreating a depth bias', () => {
  const prepare = screenProbeRootPrepareWgsl(),
    refine = screenProbeRootRefineWgsl();
  expect(prepare).toContain(
    'request.originLo=probe.canonicalLo;request.originHi=probe.canonicalHi;',
  );
  expect(prepare).not.toContain('worldSurfaceOrigin(');
  expect(prepare).toContain('request.receiverPrimitive=probe.receiverPrimitive');
  expect(refine).toContain('request.originLo,request.originHi');
  expect(refine).toContain('world.originHi,bitcast<vec3u>(ray.direction),contact');
  expect(refine).toContain('all(request.originHi==probe.canonicalHi)');
  expect(refine).not.toContain('sdfSurfaceRedeemRoot');
});

it('compiles every actual paid-root stage after composing its surface-launch authority', async () => {
  for (const [id, source] of [
    ['prepare', screenProbeRootPrepareWgsl()],
    ['refine', screenProbeRootRefineWgsl()],
    ['resolve', screenProbeWorldWgsl('global-sdf', true)],
    ['combined', screenProbeWorldWgsl('global-sdf')],
  ] as const) {
    const result = await compileShader(source, { id: `screen-probe-root-${id}` });
    expect(result.ok, result.ok ? id : result.error.message).toBe(true);
  }
});

it('admits continuation bytes through the same allocation ledger and rejects an insufficient span before allocation', () => {
  const layout = planScreenProbeLayout(SCREEN_PROBE_DEFAULTS, 64, 64),
    limit = 128 * 1024 * 1024;
  const original = screenProbeAllocationSizes(layout, limit),
    candidate = screenProbeAllocationSizes(layout, limit, true);
  expect(original.rootRequests).toBeUndefined();
  const extra = layout.probeCount * SCREEN_PROBE_TEXELS * 128;
  expect(candidate.rootRequests).toBe(extra);
  for (const [slot, size] of Object.entries(original))
    expect(candidate[slot as keyof typeof candidate]).toBe(size);
  expect(
    Object.values(candidate).reduce((a, b) => a + b, 0) -
      Object.values(original).reduce((a, b) => a + b, 0),
  ).toBe(extra);
  expect(() => screenProbeAllocationSizes(layout, extra - 1, true)).toThrow('rootRequests');
  expect(() =>
    screenProbeAllocationSizes({ ...layout, probeCount: Number.MAX_SAFE_INTEGER }, limit, true),
  ).toThrow('screen-probe');
});

it('keeps all three actual stage rosters below eight storage buffers without a field sample group', () => {
  const sources = {
    prepareRoot: screenProbeRootPrepareWgsl(),
    refineRoot: screenProbeRootRefineWgsl(),
    resolveRoot: screenProbeWorldWgsl('global-sdf', true),
  };
  const counts = [];
  for (const stage of ['prepareRoot', 'refineRoot', 'resolveRoot'] as const) {
    const roster = screenProbeRootRoster(stage),
      source = sources[stage];
    const count = roster.filter(([, kind]) => kind === 'read' || kind === 'storage').length;
    counts.push(count);
    expect(count).toBeLessThanOrEqual(8);
    for (const [binding, kind, name] of roster) {
      const match = new RegExp(
        `@group\\(0\\) @binding\\(${binding}\\) var(?:<([^>]+)>)? (\\w+)\\s*:`,
      ).exec(source);
      expect(match, name).not.toBeNull();
      if (kind === 'read') expect(match?.[1]).toBe('storage,read');
      if (kind === 'storage') expect(match?.[1]).toBe('storage,read_write');
    }
  }
  expect(counts).toEqual([3, 7, 8]);
  expect(sources.prepareRoot).not.toMatch(/fn sdfSurface(Triangle|LeafTriangle|TraceRow|Accept)\(/);
  expect(sources.refineRoot).toContain('screenProbeContact(probe,ray.direction)');
  expect(sources.resolveRoot).toContain('let hit=screenProbePreparedHit(i);');
});
