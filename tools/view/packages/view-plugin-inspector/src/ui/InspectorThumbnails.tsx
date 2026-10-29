import { createContext, useContext, useEffect, useReducer, useState } from 'react';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { WorkspaceState, WorkspaceThumbnail } from '@forgeax/view-workspace-core/contract';
import type { WorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { inspectorThumbnailGuids, inspectorThumbnailScope, observeInspectorThumbnails } from '../thumbnails.ts';
import type { InspectorEntity } from '../inspection.ts';

const EMPTY: ReadonlyMap<string, WorkspaceThumbnail> = new Map();
export const InspectorThumbnailContext = createContext(EMPTY);
export const useInspectorThumbnail = (guid: string | undefined) => useContext(InspectorThumbnailContext).get(guid ?? '');

export function useInspectorThumbnails({ client, reader, workspace, source, active }: {
  client?: ViewWorkspaceClient;
  reader: WorkspaceStateReader;
  workspace: WorkspaceState | null;
  source: InspectorEntity | null;
  active: boolean;
}) {
  const guids = inspectorThumbnailGuids(source);
  const scope = inspectorThumbnailScope(workspace, guids);
  const [leaseRevision, restartLease] = useReducer((revision: number) => revision + 1, 0);
  const [record, setRecord] = useState<{ scope: string; rows: ReadonlyMap<string, WorkspaceThumbnail> }>();
  useEffect(() => {
    if (!active || !client || !scope || !guids.length) return;
    const observation = observeInspectorThumbnails({ client, reader, guids, scope,
      publish: rows => setRecord({ scope, rows }), onInvalidate: restartLease });
    return () => observation.dispose();
  }, [client, reader, active, scope, leaseRevision]);
  return active && record?.scope === scope ? record.rows : EMPTY;
}
