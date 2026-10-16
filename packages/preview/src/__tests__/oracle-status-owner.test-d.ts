/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type evaluateMaterialOracle,
  type evaluateMeshOracle,
  type evaluateTextureOracle,
  type evaluateVfxOracle,
  failedPreviewOracle,
  type PreviewOracle,
  type PreviewOracleStatus,
  passedPreviewOracle,
} from '../evidence/oracle.js';
import type {
  PreviewOracle as PublicPreviewOracle,
  PreviewOracleStatus as PublicPreviewOracleStatus,
} from '../index.js';

const oracleSource = readFileSync(new URL('../evidence/oracle.ts', import.meta.url), 'utf8');

describe('preview oracle status owner', () => {
  it('derives the public status from the oracle discriminant', () => {
    expectTypeOf<PreviewOracleStatus>().toEqualTypeOf<PreviewOracle['status']>();
    expectTypeOf<PreviewOracle['status']>().toEqualTypeOf<PreviewOracleStatus>();
    expectTypeOf<PublicPreviewOracleStatus>().toEqualTypeOf<PreviewOracleStatus>();
    expectTypeOf<PreviewOracleStatus>().toEqualTypeOf<PublicPreviewOracleStatus>();
    expectTypeOf<PublicPreviewOracle>().toEqualTypeOf<PreviewOracle>();
    expectTypeOf<ReturnType<typeof evaluateMaterialOracle>>().toEqualTypeOf<PreviewOracle>();
    expectTypeOf<ReturnType<typeof evaluateMeshOracle>>().toEqualTypeOf<PreviewOracle>();
    expectTypeOf<ReturnType<typeof evaluateTextureOracle>>().toEqualTypeOf<PreviewOracle>();
    expectTypeOf<ReturnType<typeof evaluateVfxOracle>>().toEqualTypeOf<PreviewOracle>();
    expectTypeOf<ReturnType<typeof passedPreviewOracle>>().toEqualTypeOf<PreviewOracle>();
    expectTypeOf<ReturnType<typeof failedPreviewOracle>>().toEqualTypeOf<PreviewOracle>();

    const acceptsStatus = (value: PreviewOracleStatus): PreviewOracleStatus => value;
    acceptsStatus('passed');
    acceptsStatus('failed');
    // @ts-expect-error Unknown statuses remain outside the closed oracle vocabulary.
    acceptsStatus('unknown');

    expect(oracleSource).toContain("export type PreviewOracleStatus = PreviewOracle['status'];");
    expect(oracleSource).not.toContain("export type PreviewOracleStatus = 'passed' | 'failed';");
  });

  it('preserves passed and failed discriminant narrowing', () => {
    const narrowOracle = (oracle: PreviewOracle): boolean => {
      if (oracle.status === 'passed') {
        expectTypeOf(oracle.subjectBound).toEqualTypeOf<true>();
        expectTypeOf(oracle.rendererHealthy).toEqualTypeOf<true>();
        return oracle.subjectBound;
      }
      expectTypeOf(oracle.subjectBound).toEqualTypeOf<false>();
      expectTypeOf(oracle.rendererHealthy).toEqualTypeOf<boolean>();
      return oracle.subjectBound;
    };

    const passed = passedPreviewOracle({ drawCalls: 1, detail: {} });
    const failed = failedPreviewOracle({ detail: {} });
    expectTypeOf(narrowOracle(passed)).toEqualTypeOf<boolean>();
    expectTypeOf(narrowOracle(failed)).toEqualTypeOf<boolean>();
  });
});
