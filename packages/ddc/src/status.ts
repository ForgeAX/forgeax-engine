import type { DdcErrorRootKind } from './errors.js';

export const DDC_STATUS_SCHEMA = 'forgeax-ddc-status/v2' as const;

export type DdcStatusHealth = 'ready' | 'blocked' | 'missing' | 'stale' | 'failed';
export type DdcStatusLayerKind = 'build' | 'project' | 'runtime';
export type DdcStatusRootKind = DdcErrorRootKind;

export interface DdcRecoveryAction {
  readonly kind: 'inspect' | 'allocate-generation' | 'retry' | 'cold-rebuild' | 'prune';
  readonly executable: boolean;
  readonly exactTarget?: string;
  readonly reason?: string;
}

export interface DdcStatusLayer {
  readonly kind: DdcStatusLayerKind;
  readonly owner: 'engine-ddc' | 'engine-pack' | 'plugin' | 'runtime';
  readonly rootKind: DdcStatusRootKind;
  readonly scopeId?: string;
  readonly current?: number | string;
  readonly lastKnownGood?: number | string;
  readonly protection: readonly string[];
  readonly actions: readonly DdcRecoveryAction[];
}

export interface DdcStatus {
  readonly schemaVersion: typeof DDC_STATUS_SCHEMA;
  readonly health: DdcStatusHealth;
  readonly layers: readonly DdcStatusLayer[];
  readonly gameDir?: string;
  readonly projectDdcRoot?: string;
}

export type BrowserDdcRecoveryAction = Omit<DdcRecoveryAction, 'exactTarget'>;
export type BrowserDdcStatusLayer = Omit<DdcStatusLayer, 'actions'> & {
  readonly actions: readonly BrowserDdcRecoveryAction[];
};
export type BrowserDdcStatus = Omit<DdcStatus, 'gameDir' | 'projectDdcRoot' | 'layers'> & {
  readonly layers: readonly BrowserDdcStatusLayer[];
};

export function serializeDdcStatus(status: DdcStatus): string {
  return JSON.stringify(status);
}

export function projectDdcStatusForBrowser(status: DdcStatus): BrowserDdcStatus {
  return {
    schemaVersion: DDC_STATUS_SCHEMA,
    health: status.health,
    layers: status.layers.map((layer) => ({
      ...layer,
      actions: layer.actions.map(({ exactTarget: _exactTarget, ...action }) => action),
    })),
  };
}

export const toBrowserDdcStatus = projectDdcStatusForBrowser;
