import { fileURLToPath } from 'node:url';
import { createModelingTools } from '@forgeax/engine-modeling/tools';
import { describe, expect, it } from 'vitest';
import { CAR } from '../proportions';

/** C-100 S1 through the capture Worker and module loading that `forgeax model *` use. */
const root = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Every capture runs the exact contact check of all sessions; the S5 assemblies (tens of
 * thousands of faces) need more than the default 60 s capture budget on a loaded host.
 */
function tool(id: string, timeoutMs?: number) {
  const contribution = createModelingTools({ projectRoot: root, ...(timeoutMs === undefined ? {} : { timeoutMs }) }).find(
    (t) => t.descriptor.id === id,
  );
  if (contribution === undefined) throw new Error(id);
  return (args: Record<string, unknown>) =>
    contribution.execute(args as never, {} as never) as Promise<{
      ok: boolean;
      value?: Record<string, unknown>;
      error?: { code: string; expected?: string };
    }>;
}

describe('C-100 S1 through the real Pack loader', () => {
  it('car frame: three sessions, the main one produced mesh/car-frame with its checkpoints', {
    timeout: 120000,
  }, async () => {
    const source = 'examples/mech-gt/s1-car.pack.ts';
    const out = await tool('model.inspect')({ source });
    expect(out.error).toBeUndefined();
    const sessions = out.value?.sessions as { output?: string; checkpoints: { name: string }[] }[];
    expect(sessions.map((s) => s.output ?? null)).toEqual(['mesh/car-frame', null, null]);
    expect(sessions[0]?.checkpoints.map((c) => c.name)).toEqual(['envelope', 'wheels', 'wheelbase']);
    const axles = await tool('model.select')({ source, selector: "sel.createdBy('axle')" });
    // Flat [min xyz, max xyz]; the axle bars are 15 mm in radius.
    const bounds = (axles.value?.selected as { bounds: number[] }).bounds;
    const depth = (bounds[5] as number) - (bounds[2] as number) - 0.03;
    expect(Math.abs(depth - CAR.wheelbase.value) / CAR.wheelbase.value).toBeLessThanOrEqual(0.02);
  });

  it('mech frame loads joints.json through the Pack loader and validates as pass', {
    timeout: 120000,
  }, async () => {
    const source = 'examples/mech-gt/s1-mech.pack.ts';
    const out = await tool('model.validate')({ source });
    expect(out.error).toBeUndefined();
    expect(out.value?.status).toBe('pass');
  });

  it('S4 Packs: checkpoints per hardware kind, the output session last, validate pass', {
    timeout: 180000,
  }, async () => {
    for (const [source, checkpoints] of [
      ['examples/mech-gt/s4-mech-hardware.pack.ts', ['skeleton', 'spherical', 'universal', 'revolute']],
      ['examples/mech-gt/s4-car-mechanisms.pack.ts', ['envelope', 'hinges', 'slides']],
    ] as const) {
      const inspected = await tool('model.inspect')({ source });
      expect(inspected.error).toBeUndefined();
      const sessions = inspected.value?.sessions as { output?: string; checkpoints: { name: string }[] }[];
      expect(sessions[0]?.checkpoints.map((c) => c.name)).toEqual(checkpoints);
      expect(sessions.filter((s) => s.output !== undefined)).toHaveLength(1);
      const validated = await tool('model.validate')({ source });
      expect(validated.value?.status).toBe('pass');
    }
  });

  it('S2 Pack: hull, panels, arches, intakes and parts checkpoints; validate pass', {
    timeout: 180000,
  }, async () => {
    const source = 'examples/mech-gt/s2-body.pack.ts';
    const inspected = await tool('model.inspect')({ source });
    expect(inspected.error).toBeUndefined();
    const sessions = inspected.value?.sessions as { output?: string; checkpoints: { name: string }[] }[];
    expect(sessions.map((s) => s.output ?? null)).toEqual(['mesh/s2-body']);
    expect(sessions[0]?.checkpoints.map((c) => c.name)).toEqual(['hull', 'panels', 'arches', 'intakes', 'parts']);
    expect((await tool('model.validate')({ source })).value?.status).toBe('pass');
  });

  it('S5 Packs: chassis and joint checkpoints, validate pass', { timeout: 1200000 }, async () => {
    for (const [source, checkpoints] of [
      ['examples/mech-gt/s5-chassis.pack.ts', ['body', 'chassis', 'suspension', 'powertrain']],
      ['examples/mech-gt/s5-joints.pack.ts', ['skeleton', 'spherical', 'universal', 'revolute', 'actuators']],
    ] as const) {
      const inspected = await tool('model.inspect', 300000)({ source });
      expect(inspected.error).toBeUndefined();
      const sessions = inspected.value?.sessions as { output?: string; checkpoints: { name: string }[] }[];
      const main = sessions.find((s) => s.output !== undefined);
      expect(main?.checkpoints.map((c) => c.name)).toEqual(checkpoints);
      const validated = await tool('model.validate', 300000)({ source });
      expect(validated.error).toBeUndefined();
      // The output session passes; the C-106 sub-sessions S5 reuses through S3 report their shell soft-assertion warnings.
      const reports = validated.value?.sessions as { output?: string; status: string }[];
      expect(reports.find((s) => s.output !== undefined)?.status).toBe('pass');
      expect(reports.filter((s) => s.status === 'fail')).toEqual([]);
    }
  });
});
