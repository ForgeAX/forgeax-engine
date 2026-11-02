import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { fileURLToPath } from 'node:url';
import { buildCombo, cornerQuality, coverShutLine, hemAttempt, ROSTER, scanKit } from '../body';

const SOURCE = fileURLToPath(new URL('../body.ts', import.meta.url));

describe('C-131 combo stress case', () => {
  it('records the pipeline and measures what the kernel does on it', { timeout: 300000 }, () => {
    const recording = recordingSessions();
    const { kit, joints } = buildCombo(recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE);
    expect(steps.length).toBeGreaterThanOrEqual(3);

    const welded = joints.filter((j) => j.weld === 'ball').map((j) => j.name);
    expect(welded).toEqual(ROSTER.filter((r) => r.expect === 'ball').map((r) => r.name));
    for (const j of joints.filter((x) => x.weld === 'refused'))
      expect(j.reason).toMatch(/^model-precondition:weld-(clamp|radius)$/);
    expect(joints.every((j) => j.watertight)).toBe(true);

    const scan = scanKit(kit, joints);
    expect(scan.result.ok).toBe(true);
    expect(JSON.stringify(scan.result)).toContain('"confirmed":2');

    const shut = coverShutLine(kit);
    expect(shut.ok && shut.value.pass).toBe(true);

    const quality = cornerQuality();
    expect(quality.ok).toBe(true);
    expect(hemAttempt().left).toMatchObject({ code: 'model-precondition' });
  });
});
