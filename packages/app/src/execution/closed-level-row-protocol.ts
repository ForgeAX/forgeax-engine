import type { RenderPublicationIdentity } from '@forgeax/engine-render';
import type {
  ClosedLevelAssetPublication,
  RenderPublicationRows,
} from '@forgeax/engine-render/internal';

/** Metadata and matrices travel on their own control lane, with one unacknowledged chunk. */
export const CLOSED_LEVEL_ROWS_PER_CHUNK = 32;

export interface ClosedLevelAttempt {
  readonly instance: number;
  readonly generation: number;
  readonly request: number;
  readonly attempt: number;
}

export interface ClosedLevelRowIdentity {
  readonly publication: RenderPublicationIdentity;
  readonly worldIdentity: string;
  /** Strictly increasing start ordinals in this publication epoch. */
  readonly stream: number;
  readonly level: ClosedLevelAttempt;
}

export type ClosedLevelRowOperation =
  | {
      readonly kind: 'asset';
      readonly ordinal: number;
      readonly asset: ClosedLevelAssetPublication;
    }
  | { readonly kind: 'stage'; readonly ordinal: number; readonly rows: RenderPublicationRows }
  | {
      readonly kind: 'seal';
      readonly assets: number;
      readonly chunks: number;
      readonly rows: number;
    }
  | { readonly kind: 'prepare' }
  | { readonly kind: 'retire' };

export interface ClosedLevelRowRequest {
  readonly kind: 'closed-level-rows';
  readonly id: ClosedLevelRowIdentity;
  readonly serial: number;
  readonly operation: ClosedLevelRowOperation;
}

export interface ClosedLevelRowReceipt {
  readonly kind: 'closed-level-rows-result';
  readonly id: ClosedLevelRowIdentity;
  readonly serial: number;
  readonly result:
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly reason:
          | 'identity'
          | 'sequence'
          | 'rows'
          | 'assets'
          | 'conflict'
          | 'closed'
          | 'native';
        readonly detail?: unknown;
      };
}

export interface ClosedLevelFrameSelection {
  readonly id: ClosedLevelRowIdentity;
  readonly active: boolean;
}

export interface ClosedLevelFrameSelectionReceipt extends ClosedLevelFrameSelection {
  readonly kind: 'closed-level-selection-result';
  readonly frameId: number;
  readonly revision: number;
  readonly result:
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly reason: 'identity' | 'closed' | 'native' | 'frame' | 'pending' | 'view-obsolete';
        readonly detail?: unknown;
      };
}

export function sameClosedLevelRowIdentity(
  left: ClosedLevelRowIdentity,
  right: ClosedLevelRowIdentity,
): boolean {
  return (
    left.publication.source === right.publication.source &&
    left.publication.epoch === right.publication.epoch &&
    left.worldIdentity === right.worldIdentity &&
    left.stream === right.stream &&
    left.level.instance === right.level.instance &&
    left.level.generation === right.level.generation &&
    left.level.request === right.level.request &&
    left.level.attempt === right.level.attempt
  );
}
