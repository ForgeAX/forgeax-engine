import type { PreviewOwner, ViewPresentation as PreviewPresentation } from '@forgeax/view-workspace-core/engine-presentation';
import { Button, EmptyState } from '@forgeax/view-components';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { bindWorkspacePreviewSurface } from '@forgeax/view-workspace-core/preview-surface';
import {
  selectWorkspaceResourcePreview,
  selectWorkspaceResourceSubject,
} from '@forgeax/view-workspace-core/resource-open';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import { VIEW_WORKSPACE_TAB_ID } from '@forgeax/view-workspace-core/contract';
import { createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import {
  previewShouldCapture,
  rememberInitialPreviewCamera,
  restorePreviewCamera,
} from '@forgeax/view-workspace-core/preview-camera';
import { PAGE_TYPE, RESOURCE_KINDS } from '../identity.ts';
import { useTranslation } from '../i18n/useTranslation';
import './material.css';

type InputController = {
  attach: (element: HTMLElement) => (reason?: string) => void;
  abort?: (reason?: string) => Promise<void> | void;
};
type InputControllerOptions = {
  api: ViewWorkspaceClient;
  targetId: string;
  targetGeneration?: number;
  tabId: string;
  shouldCapture: (event: Event) => boolean;
  document?: Document;
  window?: Window;
};
type InputControllerFactory = (options: InputControllerOptions) => InputController;

export function MaterialPreviewPanel({
  client,
  presentation,
  owner,
  inputControllerFactory,
}: {
  client?: ViewWorkspaceClient;
  presentation?: PreviewPresentation;
  owner?: PreviewOwner;
  inputControllerFactory?: () => InputControllerFactory | undefined;
}) {
  const { t } = useTranslation();
  if (!client) {
    return <PreviewEmpty title={t('material.previewEmpty')} description={t('material.previewUnavailable')} />;
  }
  return (
    <LivePreview
      client={client}
      presentation={presentation}
      owner={owner}
      inputControllerFactory={inputControllerFactory}
    />
  );
}

function PreviewEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="fx-asset-viewer fx-asset-preview fx-ui" data-testid="panel-material-preview">
      <EmptyState title={title} description={description} />
    </div>
  );
}

function LivePreview({
  client,
  presentation,
  owner,
  inputControllerFactory,
}: {
  client: ViewWorkspaceClient;
  presentation?: PreviewPresentation;
  owner?: PreviewOwner;
  inputControllerFactory?: () => InputControllerFactory | undefined;
}) {
  const { t } = useTranslation();
  const reader = useMemo(() => createWorkspaceStateReader(client), [client]);
  const workspace = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  const subject = selectWorkspaceResourceSubject(workspace, RESOURCE_KINDS);
  const preview = selectWorkspaceResourcePreview(workspace, subject?.guid);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<InputController | null>(null);
  const [failure, setFailure] = useState<{ hint?: string; expected?: string }>();
  const [initialPose, setInitialPose] = useState<unknown>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const targetId = preview?.target?.targetId;
  const targetGeneration = preview?.target?.generation;

  useEffect(() => {
    const container = containerRef.current;
    const target = preview?.target;
    if (!container || !target) return undefined;
    let cancelled = false;
    let removeInput: ((reason?: string) => void) | undefined;
    let controller: InputController | undefined;
    const bound = bindWorkspacePreviewSurface({
      presentation,
      target,
      container,
      owner,
      api: client,
      sceneTargetId: workspace?.scenePreview?.target?.targetId,
    });
    if (!bound.ok) {
      setFailure(bound.error);
      setInitialPose(null);
      return undefined;
    }
    setFailure(undefined);
    const document = container.ownerDocument;
    const pageActive = () => {
      const active = document?.documentElement?.dataset?.forgeaxViewActivePage;
      return active === undefined || active === PAGE_TYPE;
    };
    const detachInput = () => {
      const remove = removeInput;
      removeInput = undefined;
      controllerRef.current = null;
      remove?.('input-detached');
    };
    const attachInput = () => {
      if (cancelled || removeInput || !pageActive()) return;
      const factory = inputControllerFactory?.();
      if (typeof factory !== 'function') return;
      controller = factory({
        api: client,
        targetId: String(target.targetId),
        targetGeneration: target.generation,
        tabId: VIEW_WORKSPACE_TAB_ID,
        document,
        window: document?.defaultView ?? undefined,
        shouldCapture: (event) => previewShouldCapture(event, container, PAGE_TYPE),
      });
      controllerRef.current = controller;
      removeInput = controller.attach(container);
    };
    void rememberInitialPreviewCamera(client, target).then((pose) => {
      if (!cancelled) setInitialPose(pose ?? null);
    }).catch((error: unknown) => {
      if (!cancelled) setRestoreError(error instanceof Error ? error.message : String(error));
    });
    attachInput();
    const observer = document && typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
        if (pageActive()) attachInput();
        else detachInput();
      })
      : undefined;
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-forgeax-view-active-page'] });
    return () => {
      cancelled = true;
      observer?.disconnect();
      detachInput();
      void bound.dispose?.();
    };
  }, [
    presentation,
    owner,
    targetId,
    targetGeneration,
    preview?.target,
    preview?.target?.surfaceId,
    workspace?.scenePreview?.target?.targetId,
    client,
    inputControllerFactory,
  ]);

  const restoreView = () => {
    const target = preview?.target;
    if (!target || initialPose == null || restoring) return;
    setRestoring(true);
    setRestoreError('');
    void Promise.resolve(controllerRef.current?.abort?.('camera-restore'))
      .then(() => restorePreviewCamera(client, target, initialPose))
      .catch((error: unknown) => {
        setRestoreError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setRestoring(false));
  };

  if (!subject) {
    return <PreviewEmpty title={t('material.previewEmpty')} description={t('material.previewEmptyDescription')} />;
  }
  if (!preview?.target) {
    return (
      <PreviewEmpty
        title={t('material.previewUnavailable')}
        description={t('material.previewCapabilityMissing')}
      />
    );
  }
  return (
    <div className="fx-asset-viewer fx-asset-preview fx-material-preview fx-ui" data-testid="panel-material-preview">
      <div className="fx-material-preview-toolbar">
        <Button
          size="compact"
          variant="secondary"
          data-testid="material-restore-view"
          disabled={initialPose == null || restoring || Boolean(failure)}
          onClick={restoreView}
        >
          {t('material.restoreView')}
        </Button>
        {restoreError ? (
          <p className="fx-material-restore-error" role="alert">{restoreError}</p>
        ) : null}
      </div>
      <div
        ref={containerRef}
        className="fx-asset-preview-surface"
        data-forgeax-asset-preview={preview.target.targetId}
        hidden={Boolean(failure)}
      />
      {failure ? (
        <EmptyState
          title={t('material.previewUnavailable')}
          description={failure.hint ?? failure.expected ?? t('material.previewCapabilityMissing')}
        />
      ) : null}
    </div>
  );
}
