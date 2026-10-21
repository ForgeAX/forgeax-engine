import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { AssetHandle, ArtifactDescriptor, AssetRef } from '@forgeax/engine-types';

export interface LodProducerRoles {
  readonly root: string;
  readonly middle: string;
  readonly lowest: string;
  readonly material: string;
  readonly scene: string;
}

export interface LodProducerAssetRow {
  readonly guid: string;
  readonly kind: string;
  readonly refs: readonly AssetRef[];
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly artifacts: Readonly<Record<string, ArtifactDescriptor>>;
}

export interface LodProducerManifest {
  readonly schemaVersion: 'e03-incremental-inputs/2';
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly roles: LodProducerRoles;
  readonly admission: {
    readonly initial: readonly string[];
    readonly later: readonly string[];
    readonly excluded: readonly string[];
    readonly route: string;
  };
  readonly assets: readonly LodProducerAssetRow[];
  readonly initialRoot: LodProducerAssetRow;
  readonly shaderClosure: Readonly<Record<string, unknown>>;
}

export interface LodProducerIdentity {
  readonly producerHead: string;
  readonly manifestSha256: string;
}

export function verifyLodProducerManifestBytes(
  bytes: Uint8Array,
  expectedRoles: LodProducerRoles,
  producer: LodProducerIdentity,
): Promise<{ readonly manifest: LodProducerManifest; readonly sha256: string }>;

export function loadLodProducerAssets(
  assets: AssetRegistry,
  manifest: LodProducerManifest,
  readBytes: (path: string) => Promise<Uint8Array>,
  expectedRoles: LodProducerRoles,
): Promise<{
  readonly manifest: LodProducerManifest;
  readonly root: AssetHandle<'mesh'>;
  admitLowest(): Promise<unknown>;
}>;

export interface LodSubmitIdentity {
  readonly frameId: number;
  readonly build: string;
  readonly deviceGeneration: number;
}

export interface LodCountEvidence {
  readonly candidates: number;
  readonly visible: number;
  readonly occluded: number;
}

export interface LodCameraEvidence {
  readonly cameraEntity: number;
  readonly entityKey: number;
  readonly viewKey: string;
  readonly eye?: string;
  readonly attachmentId: string;
  readonly lodRows: number;
  readonly viewGeneration: number;
  readonly graphGeneration: number;
  readonly count: LodCountEvidence;
  readonly lodHistogram: readonly { readonly level: number; readonly count: number }[];
}

export interface LodAcceptanceEvidence {
  readonly submit: LodSubmitIdentity;
  readonly attachmentId: string;
  readonly attribution: Readonly<Record<string, unknown>>;
  readonly aggregate: LodCountEvidence & {
    readonly lodHistogram: readonly { readonly level: number; readonly count: number }[];
  };
  readonly cameraViews: readonly LodCameraEvidence[];
}

export interface HiddenAcceptanceEvidence {
  readonly submit: Pick<LodSubmitIdentity, 'frameId' | 'deviceGeneration'>;
  readonly attachmentId: string;
  readonly attribution: Readonly<Record<string, unknown>>;
  readonly cameraViews: readonly Omit<LodCameraEvidence, 'count' | 'lodRows' | 'lodHistogram'>[];
  readonly draws: { readonly status: 'complete'; readonly draws: readonly [] };
  readonly lodObservation: Readonly<Record<string, unknown>>;
}

export function summarizeHiddenObservation(
  observed: unknown,
  receipt: Pick<LodReceipt, 'frameId' | 'deviceGeneration'>,
  cameraEntityIds: readonly number[],
  worldIdentity: string,
): HiddenAcceptanceEvidence;

export interface LodPhaseToken {
  readonly phase: string;
  readonly epoch: number;
}

export interface LodCompletedFrame {
  readonly epoch: number;
  readonly phase: string;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly uniqueIncreasing: boolean;
  readonly currentPhase: boolean;
}

export interface LodReceipt {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly completed: Promise<unknown>;
}

export interface LodPhaseProgressSnapshot {
  readonly phase: string;
  readonly phaseEpoch: number;
  readonly phaseCompletedFrames: number;
  readonly phaseAcceptedFrames: number;
  readonly totalCompletedFrames: number;
  readonly totalAcceptedFrames: number;
  readonly latestReceipt?: { readonly frameId: number; readonly deviceGeneration: number };
  readonly latestEvidence?: LodAcceptanceEvidence | HiddenAcceptanceEvidence;
}

export type LodReceiptObservationResult<TCompletion> =
  | {
      readonly status: 'observed';
      readonly receipt: {
        readonly frameId: number;
        readonly deviceGeneration: number;
      };
      readonly completion: TCompletion;
      readonly value: unknown;
    }
  | {
      readonly status: 'observation-failed';
      readonly receipt: {
        readonly frameId: number;
        readonly deviceGeneration: number;
      };
      readonly completion: TCompletion;
      readonly error: unknown;
    }
  | {
      readonly status: 'completion-failed';
      readonly receipt: {
        readonly frameId: number;
        readonly deviceGeneration: number;
      };
      readonly error: unknown;
    };

export function summarizeLodObservation(
  observedValue: unknown,
  receipt: { readonly frameId: number; readonly deviceGeneration: number },
  cameraEntityIds: readonly number[],
  rootMeshHandle: number,
): LodAcceptanceEvidence;

export function createSerialFrameQueue(): {
  enqueue<T>(work: () => T | Promise<T>): Promise<T>;
  drain(): Promise<void>;
};

export function createLodPhaseProgress(): {
  beginPhase(phase: string, frameLimit?: number): LodPhaseToken;
  markCompleted(
    token: LodPhaseToken,
    receipt: { readonly frameId: number; readonly deviceGeneration: number },
  ): LodCompletedFrame;
  accept(
    token: LodPhaseToken,
    completed: LodCompletedFrame,
    evidence: LodAcceptanceEvidence | HiddenAcceptanceEvidence,
  ): boolean;
  snapshot(): LodPhaseProgressSnapshot;
};

export function observeCompletedReceipt<TReceipt extends LodReceipt, TCompletion>(
  receipt: TReceipt,
  observe: (receipt: TReceipt) => Promise<{
    readonly ok: boolean;
    readonly value?: unknown;
    readonly error?: unknown;
  }>,
  onCompleted: (receipt: TReceipt) => TCompletion,
): Promise<LodReceiptObservationResult<TCompletion>>;

export function selectedLod(
  cameraEvidence: LodCameraEvidence | null | undefined,
): number | undefined;
