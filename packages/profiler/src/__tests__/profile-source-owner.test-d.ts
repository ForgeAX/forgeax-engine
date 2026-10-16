import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ProfilerError, ProfileSource } from '../index.js';
import type { RecorderPhaseCatalog } from '../recorder.js';

type ExpectedProfileSource = 'app' | 'render';
type PhaseCatalogConflict = Extract<ProfilerError, { readonly code: 'phase-catalog-conflict' }>;

const errorsSource = readFileSync(new URL('../errors.ts', import.meta.url), 'utf8');
const recorderSource = readFileSync(new URL('../recorder.ts', import.meta.url), 'utf8');
const cliSource = readFileSync(new URL('../cli.ts', import.meta.url), 'utf8');

describe('profiler ProfileSource owner', () => {
  it('preserves the exact generated vocabulary through the public projection', () => {
    expectTypeOf<ProfileSource>().toEqualTypeOf<ExpectedProfileSource>();

    const acceptProfileSource = (source: ProfileSource): ProfileSource => source;
    expect(acceptProfileSource('app')).toBe('app');
    expect(acceptProfileSource('render')).toBe('render');
    // @ts-expect-error ProfileSource intentionally excludes additional sources.
    acceptProfileSource('ecs');
  });

  it('derives the public error and recorder views from ProfileSource', () => {
    expectTypeOf<PhaseCatalogConflict['detail']['source']>().toEqualTypeOf<ProfileSource>();
    expectTypeOf<keyof RecorderPhaseCatalog>().toEqualTypeOf<ProfileSource>();
    expectTypeOf<ProfileSource>().toEqualTypeOf<keyof RecorderPhaseCatalog>();
  });

  it('keeps private recorder and CLI projections on the same owner', () => {
    expect(errorsSource).toContain('readonly source: ProfileSource;');
    expect(recorderSource).toContain(
      'export type RecorderPhaseCatalog = Readonly<Record<ProfileSource, readonly string[]>>;',
    );
    expect(recorderSource).toContain(
      'readonly phaseArrays: Record<ProfileSource, readonly string[]>;',
    );
    expect(recorderSource).toContain(
      'readonly phaseSets: Record<ProfileSource, ReadonlySet<string>>;',
    );
    expect(cliSource).toContain('readonly source: ProfileSource;');
    expect(cliSource).toContain('source: ProfileSource | undefined;');
    expect(cliSource).toContain('source: state.source as ProfileSource');
  });
});
