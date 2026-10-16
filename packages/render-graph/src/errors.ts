// @forgeax/engine-render-graph/src/errors.ts — RenderGraphError closed-union
// error model + Result<T, E>.
//
// Shape (plan-strategy D-3):
// - RenderGraphErrorCode, RenderGraphErrorDetail, and the constructor argument
//   union derive from one private code-to-detail map.
// - RenderGraphError extends Error { readonly code; readonly expected;
//   readonly hint; readonly detail } — four-field structured error surface,
//   aligned with RhiError (research Finding 8).
// - RenderGraphErrorDetail is projected from that map; the
//   constructor arguments correlate each code with its accepted detail:
//   - 'dangling-read' / 'unknown-resource' -> { resourceKey, passName }
//   - 'cap-missing' -> { cap, passName }
//   - 'duplicate-resource' -> { resourceKey }
//   - 'alias-source-missing' -> { aliasKey, sourceKey }
// - Result<T, E=RenderGraphError> = binary tag union ('ok' / 'err') +
//   ok() / err() factories, aligned with RhiError Result (research Finding 8).
//
// Related: plan-strategy D-3; research Finding 8; AC-15.

import type { GraphPassKind } from './types.js';

/**
 * Private code-to-detail authority for the complete RenderGraphError surface.
 *
 * The two resource-key errors intentionally share DanglingReadDetail. Keeping
 * that fact in this map lets the public code and detail unions, plus the
 * constructor arguments, derive from one authority without
 * exporting a framework or runtime registry.
 */
interface RenderGraphErrorDetailByCode {
  'dangling-read': DanglingReadDetail;
  'cap-missing': CapMissingDetail;
  'duplicate-resource': DuplicateResourceDetail;
  'alias-source-missing': AliasSourceDetail;
  'unknown-resource': DanglingReadDetail;
  'resource-alloc-failed': ResourceAllocFailedDetail;
  'invalid-format': InvalidFormatDetail;
  'observation-absent': ObservationDetail;
  'observation-invalid-format': ObservationDetail;
  'observation-invalid-size': ObservationDetail;
  'observation-missing-copy-src': ObservationDetail;
  'observation-stale': ObservationDetail;
  'observation-retired': ObservationDetail;
  'invalid-color-domain': ColorDomainDetail;
  'missing-color-domain': ColorDomainDetail;
  'color-domain-mismatch': ColorDomainDetail;
  'duplicate-pass-name': DeclarationDetail;
  'duplicate-resource-label': DeclarationDetail;
  'builder-sealed': DeclarationDetail;
  'foreign-resource-handle': ResourceAccessDetail;
  'resource-not-declared-by-pass': ResourceAccessDetail;
  'uninitialized-read': ResourceAccessDetail;
  'access-conflict': ResourceAccessDetail;
  'capability-missing': CapabilityDetail;
  'resource-descriptor-invalid': DescriptorDetail;
  'import-usage-mismatch': DescriptorDetail;
  'resource-allocation-failed': ResourceAllocFailedDetail;
  'resource-resolution-failed': ResourceAccessDetail;
  'pass-encode-failed': PassFailureDetail;
  'compiled-graph-retired': LifecycleDetail;
  'resource-retire-failed': LifecycleDetail;
}

/** Closed RenderGraphErrorCode union derived from the private detail map. */
export type RenderGraphErrorCode = keyof RenderGraphErrorDetailByCode;

/** Detail union projected from the private code-to-detail map. */
export type RenderGraphErrorDetail = RenderGraphErrorDetailByCode[RenderGraphErrorCode];

/** Failure stages for the shared float/output surface contract. */
export type SurfaceFailureKind =
  | 'allocation'
  | 'attachment'
  | 'sampled-read'
  | 'view-domain'
  | 'raw-endpoint';

/** Closed error codes derived from the surface failure kinds. */
export type SurfaceFailureCode = `surface-${SurfaceFailureKind}-failed`;

/** Shared detail for graph and render-surface recovery. */
export interface RenderSurfaceFailureDetail {
  readonly lane: string;
  readonly stage: string;
  readonly target: string;
  readonly format: string;
  readonly domain: string;
  readonly endpoint: string;
  readonly capability: string;
}

/**
 * Constructor arguments correlated by code. `detail` remains optional to
 * preserve the existing envelope behavior for callers that only need the
 * top-level fields.
 */
type RenderGraphErrorConstructorArgs = {
  [Code in RenderGraphErrorCode]: {
    code: Code;
    expected: string;
    hint: string;
    detail?: RenderGraphErrorDetailByCode[Code] | undefined;
  };
}[RenderGraphErrorCode];

/** Detail variant for dangling-read and unknown-resource errors. */
export interface DanglingReadDetail {
  readonly resourceKey: string;
  readonly passName: string;
}

/** Detail variant for cap-missing errors. */
export interface CapMissingDetail {
  readonly cap: 'compute' | 'storageBuffer';
  readonly passName: string;
}

/** Detail variant for duplicate-resource errors. */
export interface DuplicateResourceDetail {
  readonly resourceKey: string;
}

/** Detail variant for aliases whose source is not a registered color target. */
export interface AliasSourceDetail {
  readonly aliasKey: string;
  readonly sourceKey: string;
}

/** Detail variant for resource-alloc-failed errors. */
export interface ResourceAllocFailedDetail {
  readonly resourceKey: string;
  readonly passName?: string | undefined;
  readonly rhiCode?: string | undefined;
}

/** Detail variant for invalid-format errors. */
export interface InvalidFormatDetail {
  readonly resourceKey: string;
  readonly format: string;
  readonly expected: readonly string[];
}

/** Generic current-frame observation failures. */
export interface ObservationDetail {
  readonly frameId?: number | undefined;
  readonly expected?: string | undefined;
}

export interface ColorDomainDetail {
  readonly value?: string | undefined;
  readonly resourceKey?: string | undefined;
  readonly sourceDomain?: string | undefined;
  readonly destinationDomain?: string | undefined;
}

export interface DeclarationDetail {
  readonly passName?: string | undefined;
  readonly resourceLabel?: string | undefined;
}

export interface ResourceAccessDetail {
  readonly passName?: string | undefined;
  readonly resourceLabel?: string | undefined;
  readonly usage?: string | undefined;
  readonly accesses?: readonly string[] | undefined;
}

export interface CapabilityDetail extends ResourceAccessDetail {
  readonly capability:
    | 'compute'
    | 'storage-buffer'
    | 'storage-texture'
    | 'indirect'
    | 'color-attachments'
    | 'ray-query';
}

export interface DescriptorDetail {
  readonly resourceLabel: string;
  readonly field: string;
  readonly expected: string;
  readonly actual?: string | number | undefined;
}

export interface PassFailureDetail {
  readonly passName: string;
  readonly passKind: GraphPassKind;
  readonly cause: unknown;
}

export interface LifecycleDetail {
  readonly generation: number;
  readonly resourceLabel?: string | undefined;
  readonly cause?: unknown;
}

/**
 * Structured RenderGraph error.
 *
 * Four readonly fields aligned with AGENTS.md "Errors are structured"
 * and RhiError (research Finding 8):
 * - `.code` — closed union member (L1 key signal).
 * - `.expected` — expected-state description (L2 detail).
 * - `.hint` — actionable recovery guidance (L2 detail).
 * - `.detail` — narrowed payload per code variant.
 */
export class RenderGraphError extends Error {
  readonly code: RenderGraphErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: RenderGraphErrorDetail | undefined;

  constructor(args: RenderGraphErrorConstructorArgs) {
    super(`[RenderGraphError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'RenderGraphError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}

// Result<T, E> + ok / err + ResultOk / ResultErr live in `@forgeax/engine-types`
// (tweak-20260612-result-into-types). Consolidated upstream from this and 4
// other packages' duplicate definitions; the barrel here re-exports them so
// existing `import { err, ok, Result } from '@forgeax/engine-render-graph'`
// consumers stay unchanged.
export {
  err,
  ok,
  type Result,
  type ResultErr,
  type ResultOk,
} from '@forgeax/engine-types';
