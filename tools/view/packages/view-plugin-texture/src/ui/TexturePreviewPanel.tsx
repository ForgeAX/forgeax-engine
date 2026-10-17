import type { PreviewOwner, ViewPresentation as PreviewPresentation } from '@forgeax/view-workspace-core/engine-presentation';
import { EmptyState } from '@forgeax/view-components';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { bindWorkspacePreviewSurface } from '@forgeax/view-workspace-core/preview-surface';
import {
  selectWorkspaceResourcePreview,
  selectWorkspaceResourceSubject,
} from '@forgeax/view-workspace-core/resource-open';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import { createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { RESOURCE_KINDS } from '../identity.ts';
import { useTranslation } from '../i18n/useTranslation';
import './texture.css';


export function TexturePreviewPanel({
  client,
  presentation,
  owner,
}: {
  client?: ViewWorkspaceClient;
  presentation?: PreviewPresentation;
  owner?: PreviewOwner;
}) {
  const { t } = useTranslation();
  if (!client) {
    return <PreviewEmpty title={t('texture.previewEmpty')} description={t('texture.previewUnavailable')} />;
  }
  return <LivePreview client={client} presentation={presentation} owner={owner} />;
}

function PreviewEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="fx-asset-viewer fx-asset-preview fx-ui" data-testid="panel-texture-preview">
      <EmptyState title={title} description={description} />
    </div>
  );
}

function LivePreview({
  client,
  presentation,
  owner,
}: {
  client: ViewWorkspaceClient;
  presentation?: PreviewPresentation;
  owner?: PreviewOwner;
}) {
  const { t } = useTranslation();
  const reader = useMemo(() => createWorkspaceStateReader(client), [client]);
  const workspace = useSyncExternalStore(
    reader.subscribe,
    () => reader.getSnapshot(),
    () => reader.getSnapshot(),
  );
  const subject = selectWorkspaceResourceSubject(workspace, RESOURCE_KINDS);
  const preview = selectWorkspaceResourcePreview(workspace, subject?.guid);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failure, setFailure] = useState<{ hint?: string; expected?: string }>();

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !preview?.target) return undefined;
    const bound = bindWorkspacePreviewSurface({
      presentation,
      target: preview.target,
      container,
      owner,
      api: client,
      sceneTargetId: workspace?.scenePreview?.target?.targetId,
    });
    if (!bound.ok) {
      setFailure(bound.error);
      return undefined;
    }
    setFailure(undefined);
    return () => { void bound.dispose?.(); };
  }, [
    presentation,
    owner,
    preview?.target,
    preview?.target?.targetId,
    preview?.target?.generation,
    preview?.target?.surfaceId,
    workspace?.scenePreview?.target?.targetId,
    client,
  ]);

  if (!subject) return <PreviewEmpty title={t('texture.previewEmpty')} description={t('texture.empty')} />;
  if (!preview?.target) {
    return (
      <PreviewEmpty
        title={t('texture.previewUnavailable')}
        description={t('texture.previewCapabilityMissing')}
      />
    );
  }
  return (
    <div className="fx-asset-viewer fx-asset-preview fx-ui" data-testid="panel-texture-preview">
      <div
        ref={containerRef}
        className="fx-asset-preview-surface"
        data-forgeax-asset-preview={preview.target.targetId}
        hidden={Boolean(failure)}
      />
      {failure ? (
        <EmptyState
          title={t('texture.previewUnavailable')}
          description={failure.hint ?? failure.expected ?? t('texture.previewCapabilityMissing')}
        />
      ) : null}
    </div>
  );
}
