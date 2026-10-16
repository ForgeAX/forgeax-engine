import { describe, expectTypeOf, it } from 'vitest';
import {
  type AliasSourceDetail,
  type CapabilityDetail,
  type CapMissingDetail,
  type ColorDomainDetail,
  type DanglingReadDetail,
  type DeclarationDetail,
  type DescriptorDetail,
  type DuplicateResourceDetail,
  type InvalidFormatDetail,
  type LifecycleDetail,
  type ObservationDetail,
  type PassFailureDetail,
  RenderGraphError,
  type RenderGraphErrorCode,
  type RenderGraphErrorDetail,
  type ResourceAccessDetail,
  type ResourceAllocFailedDetail,
} from '../errors.js';
import type { GraphPassKind, GraphResourceKind } from '../types.js';

describe('RenderGraphError code/detail correlation', () => {
  it('accepts every existing code with its matching detail interface', () => {
    new RenderGraphError({
      code: 'dangling-read',
      expected: '',
      hint: '',
      detail: { resourceKey: 'resource', passName: 'pass' } satisfies DanglingReadDetail,
    });
    new RenderGraphError({
      code: 'cap-missing',
      expected: '',
      hint: '',
      detail: { cap: 'compute', passName: 'pass' } satisfies CapMissingDetail,
    });
    new RenderGraphError({
      code: 'duplicate-resource',
      expected: '',
      hint: '',
      detail: { resourceKey: 'resource' } satisfies DuplicateResourceDetail,
    });
    new RenderGraphError({
      code: 'alias-source-missing',
      expected: '',
      hint: '',
      detail: { aliasKey: 'alias', sourceKey: 'source' } satisfies AliasSourceDetail,
    });
    new RenderGraphError({
      code: 'unknown-resource',
      expected: '',
      hint: '',
      detail: { resourceKey: 'resource', passName: 'pass' } satisfies DanglingReadDetail,
    });
    new RenderGraphError({
      code: 'resource-alloc-failed',
      expected: '',
      hint: '',
      detail: {
        resourceKey: 'resource',
        passName: 'pass',
        rhiCode: 'lost',
      } satisfies ResourceAllocFailedDetail,
    });
    new RenderGraphError({
      code: 'invalid-format',
      expected: '',
      hint: '',
      detail: {
        resourceKey: 'resource',
        format: 'rgba16float',
        expected: ['rgba16float'],
      } satisfies InvalidFormatDetail,
    });
    for (const code of [
      'observation-absent',
      'observation-invalid-format',
      'observation-invalid-size',
      'observation-missing-copy-src',
      'observation-stale',
      'observation-retired',
    ] as const) {
      new RenderGraphError({
        code,
        expected: '',
        hint: '',
        detail: { frameId: 1, expected: 'frame' } satisfies ObservationDetail,
      });
    }
    for (const code of [
      'invalid-color-domain',
      'missing-color-domain',
      'color-domain-mismatch',
    ] as const) {
      new RenderGraphError({
        code,
        expected: '',
        hint: '',
        detail: { value: 'linear' } satisfies ColorDomainDetail,
      });
    }
  });

  it('keeps detail optional, including explicit undefined', () => {
    new RenderGraphError({ code: 'dangling-read', expected: '', hint: '' });
    new RenderGraphError({ code: 'invalid-format', expected: '', hint: '', detail: undefined });
  });

  it('rejects a detail belonging to a different code', () => {
    new RenderGraphError({
      code: 'dangling-read',
      expected: '',
      hint: '',
      // @ts-expect-error -- dangling-read accepts DanglingReadDetail, not CapMissingDetail.
      detail: { cap: 'compute', passName: 'pass' },
    });
  });

  it('preserves the closed code and detail-shape public unions', () => {
    expectTypeOf<RenderGraphErrorCode>().toEqualTypeOf<
      | 'dangling-read'
      | 'cap-missing'
      | 'duplicate-resource'
      | 'alias-source-missing'
      | 'unknown-resource'
      | 'resource-alloc-failed'
      | 'invalid-format'
      | 'observation-absent'
      | 'observation-invalid-format'
      | 'observation-invalid-size'
      | 'observation-missing-copy-src'
      | 'observation-stale'
      | 'observation-retired'
      | 'invalid-color-domain'
      | 'missing-color-domain'
      | 'color-domain-mismatch'
      | 'duplicate-pass-name'
      | 'duplicate-resource-label'
      | 'builder-sealed'
      | 'foreign-resource-handle'
      | 'resource-not-declared-by-pass'
      | 'uninitialized-read'
      | 'access-conflict'
      | 'capability-missing'
      | 'resource-descriptor-invalid'
      | 'import-usage-mismatch'
      | 'resource-allocation-failed'
      | 'resource-resolution-failed'
      | 'pass-encode-failed'
      | 'compiled-graph-retired'
      | 'resource-retire-failed'
    >();
    expectTypeOf<RenderGraphErrorDetail>().toEqualTypeOf<
      | DanglingReadDetail
      | CapMissingDetail
      | DuplicateResourceDetail
      | AliasSourceDetail
      | ResourceAllocFailedDetail
      | InvalidFormatDetail
      | ObservationDetail
      | ColorDomainDetail
      | DeclarationDetail
      | ResourceAccessDetail
      | CapabilityDetail
      | DescriptorDetail
      | PassFailureDetail
      | LifecycleDetail
    >();
  });
});

function assertNever(value: never): never {
  throw new Error(String(value));
}

function exhaustivePass(kind: GraphPassKind): string {
  switch (kind) {
    case 'raster':
      return kind;
    case 'compute':
      return kind;
    case 'copy':
      return kind;
  }
  return assertNever(kind);
}

function exhaustiveResource(kind: GraphResourceKind): string {
  switch (kind) {
    case 'texture':
      return kind;
    case 'buffer':
      return kind;
    case 'acceleration-structure':
      return kind;
  }
  return assertNever(kind);
}

describe('M4 render graph closed unions', () => {
  it('keeps pass and resource variants exhaustively handled without a default branch', () => {
    expectTypeOf(exhaustivePass).returns.toEqualTypeOf<string>();
    expectTypeOf(exhaustiveResource).returns.toEqualTypeOf<string>();
  });

  it('keeps RenderGraphErrorCode closed', () => {
    expectTypeOf<RenderGraphErrorCode>().not.toEqualTypeOf<string>();
  });
});
