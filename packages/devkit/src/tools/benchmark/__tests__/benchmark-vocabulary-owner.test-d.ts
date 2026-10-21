/// <reference types="node" />

import { describe, expectTypeOf, it } from 'vitest';
import type { BenchmarkHarnessOptions } from '../harness.js';
import type { BenchmarkSample } from '../report.js';

type ExpectedMode = 'private' | 'service';
type ExpectedPhase = 'cold' | 'warm';
type MeasureMode = Parameters<BenchmarkHarnessOptions['measure']>[0];
type MeasurePhase = Parameters<BenchmarkHarnessOptions['measure']>[1];
type ReportMode = BenchmarkSample['mode'];
type ReportPhase = BenchmarkSample['phase'];

describe('benchmark vocabulary owner', () => {
  it('keeps the exact mode and phase vocabularies bilateral', () => {
    expectTypeOf<ReportMode>().toEqualTypeOf<ExpectedMode>();
    expectTypeOf<ExpectedMode>().toEqualTypeOf<ReportMode>();
    expectTypeOf<MeasureMode>().toEqualTypeOf<ReportMode>();
    expectTypeOf<ReportMode>().toEqualTypeOf<MeasureMode>();
    expectTypeOf<ReportPhase>().toEqualTypeOf<ExpectedPhase>();
    expectTypeOf<ExpectedPhase>().toEqualTypeOf<ReportPhase>();
    expectTypeOf<MeasurePhase>().toEqualTypeOf<ReportPhase>();
    expectTypeOf<ReportPhase>().toEqualTypeOf<MeasurePhase>();

    const acceptsMode = (mode: ReportMode): ReportMode => mode;
    acceptsMode('private');
    acceptsMode('service');
    // @ts-expect-error Unknown benchmark modes remain outside the report vocabulary.
    acceptsMode('shared');

    const acceptsPhase = (phase: ReportPhase): ReportPhase => phase;
    acceptsPhase('cold');
    acceptsPhase('warm');
    // @ts-expect-error Unknown benchmark phases remain outside the report vocabulary.
    acceptsPhase('hot');
  });
});
