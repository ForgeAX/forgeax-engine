import { fileURLToPath } from 'node:url';
import { createModelingTools } from '@forgeax/engine-modeling/tools';
import { describe, expect, it } from 'vitest';

/**
 * C-107 through the real Pack loader and capture Worker: `forgeax model pose` and
 * `forgeax model interference` find the rig the Pack built, pose it along the path its
 * finish() exported, and scan that path.
 */
const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = 'examples/transforming-limb/limb.pack.ts';

type ToolResult = { ok: boolean; value?: Record<string, unknown>; error?: { code: string; expected?: string } };

function tool(id: string) {
  const contribution = createModelingTools({ projectRoot: root }).find((t) => t.descriptor.id === id);
  if (contribution === undefined) throw new Error(id);
  return (args: Record<string, unknown>) => contribution.execute(args as never, {} as never) as Promise<ToolResult>;
}

describe('C-107 through model.pose and model.interference', () => {
  it('poses the exported path and reports joints, limits and contacts', { timeout: 300000 }, async () => {
    const robot = await tool('model.pose')({ source, u: 1 });
    expect(robot.error).toBeUndefined();
    const value = robot.value as {
      rigs: { session: number; output?: string; parts: { name: string }[]; path?: number[] }[];
      pose: { u: number; values: Record<string, number>; clamped: unknown[]; joints: unknown[]; interference: { pass: boolean; pairs: unknown[] }; highlighted: string[] };
    };
    expect(value.rigs).toHaveLength(1);
    expect(value.rigs[0]?.output).toBe('scene/limb');
    expect(value.rigs[0]?.parts.map((p) => p.name)).toEqual(['chassis', 'fender', 'upper-arm', 'forearm', 'wheel', 'slider', 'claw']);
    expect(value.rigs[0]?.path?.[0]).toBe(0);
    expect(value.pose.values).toMatchObject({ shoulder: 90, elbow: -160, telescope: 0.1, claw: -80, 'fender-hinge': 60 });
    expect(value.pose.clamped).toEqual([]);
    expect(value.pose.joints).toHaveLength(7);
    expect(value.pose.interference.pass).toBe(true);
    expect(value.pose.highlighted).toEqual([]);

    const forced = await tool('model.pose')({ source, pose: { elbow: -170, shoulder: 120 } });
    const clamped = (forced.value as { pose: { clamped: { joint: string; applied: number }[] } }).pose.clamped;
    expect(clamped).toEqual([{ joint: 'shoulder', requested: 120, applied: 100 }]);
    const rejected = await tool('model.pose')({ source, pose: { shoulder: 120 }, limits: 'reject' });
    expect(rejected.ok).toBe(false);
    const both = await tool('model.pose')({ source, u: 0.5, pose: { shoulder: 10 } });
    expect(both.error?.code).toBe('tool-invalid-args');
  });

  it('scans the exported path, and catches the first design', { timeout: 300000 }, async () => {
    const scan = await tool('model.interference')({ source });
    expect(scan.error).toBeUndefined();
    const report = (scan.value as { scan: { rig: number; report: { pass: boolean; pairs: unknown[]; evaluated: number } } }).scan.report;
    expect(report.pass).toBe(true);
    expect(report.pairs).toEqual([]);

    const first = await tool('model.interference')({ source, values: { beamEnd: 0.45 } });
    const pairs = (first.value as { scan: { report: { pass: boolean; pairs: { parts: string[]; status: string; firstContact: number }[] } } }).scan.report;
    expect(pairs.pass).toBe(false);
    expect(pairs.pairs[0]).toMatchObject({ parts: ['forearm', 'upper-arm'], status: 'confirmed' });

    const atClash = await tool('model.interference')({ source, values: { beamEnd: 0.45 }, u: 0.8 });
    const pose = (atClash.value as { pose: { interference: { confirmed: number }; highlighted: string[] } }).pose;
    expect(pose.interference.confirmed).toBe(1);
    expect(pose.highlighted).toEqual(['forearm', 'upper-arm']);
  });
});
