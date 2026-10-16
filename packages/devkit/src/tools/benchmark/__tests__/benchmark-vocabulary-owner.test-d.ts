/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { BenchmarkHarnessOptions } from '../harness.js';
import type { BenchmarkSample } from '../report.js';

type ExpectedMode = 'private' | 'service';
type ExpectedPhase = 'cold' | 'warm';
type MeasureMode = Parameters<BenchmarkHarnessOptions['measure']>[0];
type MeasurePhase = Parameters<BenchmarkHarnessOptions['measure']>[1];
type ReportMode = BenchmarkSample['mode'];
type ReportPhase = BenchmarkSample['phase'];

const harnessSource = readFileSync(new URL('../harness.ts', import.meta.url), 'utf8');

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

  it('derives both runtime loop projections from BenchmarkSample', () => {
    expect(harnessSource).toContain(
      "const phases = ['cold', 'warm'] as const satisfies readonly BenchmarkSample['phase'][];",
    );
    expect(harnessSource).toContain(
      "const modes = ['private', 'service'] as const satisfies readonly BenchmarkSample['mode'][];",
    );
    expect(harnessSource).not.toContain("for (const phase of ['cold', 'warm'] as const)");
    expect(harnessSource).not.toContain("for (const mode of ['private', 'service'] as const)");
  });
});
