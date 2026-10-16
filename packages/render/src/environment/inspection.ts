import type { EnvironmentGeneration } from './generation';

export type EnvironmentInspectionStatus = 'empty' | 'active' | 'candidate' | 'failed';

export interface EnvironmentInspectionFailure {
  readonly stage: 'prepare' | 'build' | 'execute' | 'finish' | 'submit';
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface EnvironmentInspectionGeneration {
  readonly signature: string;
  readonly generation: number;
  readonly lane: 'direct' | 'clustered';
  readonly source: 'none' | 'image' | 'atmosphere';
  readonly resourceCount: number;
  readonly bytes: number;
  readonly residentBytes: number;
  readonly retiringBytes: number;
}

export interface EnvironmentInspection {
  readonly signature: string | undefined;
  readonly generation: number | undefined;
  readonly lane: 'direct' | 'clustered' | undefined;
  readonly retired: boolean | undefined;
  readonly source: 'none' | 'image' | 'atmosphere' | undefined;
  readonly status: EnvironmentInspectionStatus;
  readonly environmentSignature: string | undefined;
  readonly fogSignature: string | undefined;
  readonly activeSignature: string | undefined;
  readonly lkgSignature: string | undefined;
  readonly candidate: EnvironmentInspectionGeneration | undefined;
  readonly active: EnvironmentInspectionGeneration | undefined;
  readonly lkg: EnvironmentInspectionGeneration | undefined;
  readonly bytes: number;
  readonly resourceCount: number;
  readonly residentBytes: number;
  readonly retiringBytes: number;
  readonly lastCandidateFailure: EnvironmentInspectionFailure | undefined;
  readonly recovery:
    | {
        readonly token: number;
        readonly deviceGeneration: number;
        readonly status: 'uninitialized';
        readonly fallback: 'skylight';
      }
    | undefined;
}

export function inspectEnvironment(
  generation: EnvironmentGeneration | undefined,
  details: {
    readonly source?: 'none' | 'image' | 'atmosphere';
    readonly environmentSignature?: string;
    readonly fogSignature?: string;
    readonly active?: EnvironmentInspectionGeneration;
    readonly lkg?: EnvironmentInspectionGeneration;
    readonly candidate?: EnvironmentInspectionGeneration;
    readonly lastCandidateFailure?: EnvironmentInspectionFailure;
    readonly recovery?: EnvironmentInspection['recovery'];
    readonly retiringBytes?: number;
  } = {},
): EnvironmentInspection {
  const active = details.active;
  const lkg = details.lkg;
  const candidate = details.candidate;
  const status: EnvironmentInspectionStatus =
    candidate !== undefined
      ? 'candidate'
      : active !== undefined
        ? 'active'
        : details.lastCandidateFailure !== undefined
          ? 'failed'
          : 'empty';
  return Object.freeze({
    signature: generation?.signature,
    generation: generation?.generation,
    lane: generation?.lane,
    retired: generation?.retired,
    source: details.source,
    status,
    environmentSignature: details.environmentSignature,
    fogSignature: details.fogSignature,
    activeSignature: active?.signature,
    lkgSignature: lkg?.signature,
    candidate,
    active,
    lkg,
    bytes: active?.bytes ?? candidate?.bytes ?? 0,
    resourceCount: active?.resourceCount ?? candidate?.resourceCount ?? 0,
    residentBytes: active?.residentBytes ?? 0,
    retiringBytes: details.retiringBytes ?? active?.retiringBytes ?? 0,
    lastCandidateFailure: details.lastCandidateFailure,
    recovery: details.recovery,
  });
}
