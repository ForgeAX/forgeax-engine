import type { CloudSnapshotV1, ReadyCloudFrame } from './cloud-controls.ts';

const HISTORY_LIMIT = 16;
const MAX_REQUEST_REVISION = 0xffffffff;

export type CloudSnapshotHistoryEntry = CloudSnapshotV1 & {
  readonly id: string;
  readonly kind: 'initial' | 'saved';
};

/** Owns records for one live World. Reads never run restore logic or expose mutable state. */
export function createCloudSnapshotHistory(worldIdentity: string) {
  const entries: CloudSnapshotHistoryEntry[] = [];
  let nextId = 0;
  const scope = encodeURIComponent(worldIdentity);
  return {
    capture(snapshot: CloudSnapshotV1, kind: CloudSnapshotHistoryEntry['kind']) {
      const { config, frame } = snapshot;
      const entry: CloudSnapshotHistoryEntry = Object.freeze({
        id: `${scope}:cloud-snapshot:${++nextId}`,
        kind,
        version: snapshot.version,
        preset: snapshot.preset,
        config: Object.freeze({
          ...config,
          parameters: Object.freeze({ ...config.parameters }),
          clock: Object.freeze({
            ...config.clock,
            windOffsetMeters: Object.freeze([...config.clock.windOffsetMeters] as const),
          }),
          camera: Object.freeze({ ...config.camera, pose: Object.freeze({ ...config.camera.pose }) }),
          assets: Object.freeze({ ...config.assets }),
        }),
        frame: frame?.worldIdentity === worldIdentity ? Object.freeze({ ...frame }) : null,
      });
      entries.unshift(entry);
      if (entries.length > HISTORY_LIMIT) entries.pop();
    },
    read: () => Object.freeze({ version: 1 as const, entries: Object.freeze(entries.slice()) }),
  };
}

/** Publish a revision only after a successful change; non-rendering actions never enter this path. */
export function createCloudRequestTracker<Request extends object>(writeRevision: (revision: number) => void) {
  let active: (Request & { readonly requestRevision: number }) | null = null;
  return {
    apply(request: Request, change: () => string | void): string | undefined {
      const revision = (active?.requestRevision ?? 0) + 1;
      if (revision > MAX_REQUEST_REVISION) return '云请求版本已用尽，请重新载入场景。';
      const error = change();
      if (typeof error === 'string') return error;
      writeRevision(revision);
      active = Object.freeze({ ...request, requestRevision: revision });
    },
    read: () => active,
  };
}

export function readWorldReadyCloudFrame(value: unknown, worldIdentity: string): ReadyCloudFrame | null {
  if (value === null || typeof value !== 'object' || !('worldIdentity' in value) || value.worldIdentity !== worldIdentity ||
    !('frameId' in value) || typeof value.frameId !== 'number' || !Number.isSafeInteger(value.frameId) || value.frameId < 0 ||
    !('deviceGeneration' in value) || typeof value.deviceGeneration !== 'number' || !Number.isSafeInteger(value.deviceGeneration) || value.deviceGeneration < 0)
    return null;
  return { frameId: value.frameId, deviceGeneration: value.deviceGeneration, worldIdentity };
}
