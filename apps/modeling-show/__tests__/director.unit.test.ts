import { describe, expect, it } from 'vitest';
import { cueAt, cuePose, type ShowSegment, stagePose, timelineSeconds, timeOf } from '../assets/show/director.ts';
import { SHOW_PROGRAMS } from '../assets/show/programs.ts';
import { stepCaption } from '../assets/show/timeline.ts';

const SEGMENTS: readonly ShowSegment[] = [
  { subject: 0, kind: 'turntable', seconds: 4 },
  { subject: 0, kind: 'transform', seconds: 6 },
  { subject: 1, kind: 'history', seconds: 2 },
];

describe('Show director', () => {
  it('maps timeline time to a segment cue and loops', () => {
    expect(timelineSeconds(SEGMENTS)).toBe(12);
    expect(cueAt(SEGMENTS, 5)).toMatchObject({ index: 1, u: 1 / 6 });
    expect(cueAt(SEGMENTS, 13)).toMatchObject({ index: 0, u: 0.25 });
  });

  it('a seek to u = 1 stays on its segment', () => {
    expect(cueAt(SEGMENTS, timeOf(SEGMENTS, 1, 1)).index).toBe(1);
    expect(cueAt(SEGMENTS, timeOf(SEGMENTS, 2, 1)).index).toBe(2);
    expect(cueAt(SEGMENTS, timeOf(SEGMENTS, 1, 0))).toMatchObject({ index: 1, u: 0 });
  });

  it('each beat drives its own stage channel', () => {
    expect(stagePose('turntable', 0.5).spin).toBeCloseTo(Math.PI);
    expect(stagePose('transform', 0).transform).toBe(0);
    expect(stagePose('transform', 1).transform).toBe(1);
    expect(stagePose('explode', 0.6).explode).toBe(1);
    expect(stagePose('section', 0.5).section).toBeCloseTo(0.55);
    expect(stagePose('section', 0).section).toBeCloseTo(0.05);
    expect(stagePose('xray', 0.6)).toMatchObject({ xray: true, transform: 1 });
    expect(stagePose('history', 0.3).history).toBe(0.3);
    expect(stagePose('turntable', 0.5).history).toBeUndefined();
  });

  it('captions a history step with its stage, operation, label and author line', () => {
    expect(
      stepCaption({
        stage: 'C-107 limb',
        index: 4,
        count: 72,
        opIndex: 4,
        op: 'bevel',
        label: 'hub',
        source: { path: '/repo/examples/transforming-limb/limb.ts', line: 93 },
        faces: 120,
      }),
    ).toBe('C-107 limb · step 5/72 · #4 bevel "hub" · limb.ts:93 · 120 faces');
  });

  it('a segment form holds the transformation through other beats', () => {
    const robot: ShowSegment = { subject: 0, kind: 'turntable', seconds: 4, form: 0.5 };
    expect(cuePose(robot, 0.5).transform).toBe(0.5);
    expect(cuePose(robot, 0.5).spin).toBeCloseTo(Math.PI);
    expect(cuePose({ ...robot, kind: 'transform' }, 1).transform).toBe(1);
    expect(cuePose({ subject: 0, kind: 'explode', seconds: 1 }, 0.6).transform).toBe(0);
  });

  it('the mech-gt program plays car, transformation, robot form, explode and section', () => {
    const program = SHOW_PROGRAMS['mech-gt'];
    expect(program?.segments.map((s) => `${program.subjects[s.subject]?.name}:${s.kind}:${s.form ?? 0}`)).toEqual([
      'car:turntable:0',
      'transform:transform:0',
      'transform:turntable:1',
      'transform:explode:0',
      'transform:section:0',
    ]);
  });
});
