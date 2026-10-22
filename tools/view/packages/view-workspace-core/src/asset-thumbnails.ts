import type { ViewWorkspaceClient } from './client.ts';
import { VIEW_WORKSPACE_TAB_ID, type WorkspaceState, type WorkspaceThumbnail } from './contract.ts';
import type { WorkspaceStateReader } from './workspace-state.ts';

export type ThumbnailObservationOptions = {
  client: Pick<ViewWorkspaceClient, 'call'>;
  reader: WorkspaceStateReader;
  guids: readonly string[];
  scope: string;
  getScope: (state: WorkspaceState | null, guids: readonly string[]) => string | null;
  publish: (rows: ReadonlyMap<string, WorkspaceThumbnail>) => void;
  onInvalidate?: () => void;
};

/** One panel read lease. Engine owns thumbnail generation and caching. */
export function observeAssetThumbnails({ client, reader, guids, scope, getScope, publish, onInvalidate }: ThumbnailObservationOptions) {
  const controller = new AbortController();
  const { signal } = controller;
  let unsubscribe: (() => void) | undefined;
  let rows = new Map<string, WorkspaceThumbnail>();
  let epoch = reader.getSnapshot()?.thumbnailEpoch;
  let reading = false;
  let refreshPending = false;
  const dispose = () => { controller.abort(); unsubscribe?.(); unsubscribe = undefined; };
  const current = () => !signal.aborted && getScope(reader.getSnapshot(), guids) === scope;
  const read = async () => {
    if (!current()) return;
    if (reading) { refreshPending = true; return; }
    reading = true;
    const state = reader.getSnapshot()!;
    const requested = [...new Set(guids)].filter(guid => !rows.has(guid) || ['queued', 'cooking'].includes(rows.get(guid)!.state));
    try {
      for (let index = 0; index < requested.length && current(); index += 32) {
        const batch = requested.slice(index, index + 32);
        try {
          const target = state.projectTarget ?? state.scenePreview?.target ?? state.preview?.target;
          const result = await client.call<{ thumbnails: WorkspaceThumbnail[] }>('assets.thumbnails', {
            projectId: state.project!.id, targetId: target?.targetId,
            guids: batch, tabId: VIEW_WORKSPACE_TAB_ID,
          }, { signal, reportError: false });
          if (!current()) return;
          const next = new Map(rows);
          for (const row of result.thumbnails) {
            const asset = state.assets?.find(asset => asset.guid === row.guid);
            if (!batch.includes(row.guid) || !asset) continue;
            if (asset.publicationId !== undefined && row.publicationId !== asset.publicationId) continue;
            if (row.state === 'ready' && asset.lifecycle !== undefined && asset.lifecycle !== 'current') continue;
            next.set(row.guid, row);
          }
          rows = next;
        } catch (error) {
          if (!current()) return;
          rows = new Map(rows);
          for (const guid of batch) rows.set(guid, { guid, state: 'failed', error: {
            code: 'thumbnail-query-failed', expected: 'Engine asset preview',
            hint: error instanceof Error ? error.message : String(error),
          } });
        }
        publish(rows);
      }
    } finally {
      reading = false;
      if (refreshPending && current()) { refreshPending = false; void read(); }
    }
  };
  const update = () => {
    if (!current()) { dispose(); publish(new Map()); onInvalidate?.(); return; }
    const nextEpoch = reader.getSnapshot()?.thumbnailEpoch;
    if (nextEpoch !== epoch) { epoch = nextEpoch; void read(); }
  };
  unsubscribe = reader.subscribe(update);
  if (signal.aborted) dispose();
  else { update(); void read(); }
  return { dispose };
}
