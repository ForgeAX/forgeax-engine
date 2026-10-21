import { resourcePreviewRequestId } from '@forgeax/view-workspace-core/resource-open';
import type { PreviewOwner, ViewPresentation as PreviewPresentation } from '@forgeax/view-workspace-core/engine-presentation';
import { EmptyState } from '@forgeax/view-components';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import { VIEW_WORKSPACE_TAB_ID } from '@forgeax/view-workspace-core/contract';
import { unwrapWorkspaceInspection } from '@forgeax/view-workspace-core/inspection-presentation';
import {
  cameraPoseWithPivot,
  commitPreviewCameraPivot,
  meshAabbCenter,
  previewShouldCapture,
  rememberInitialPreviewCamera,
  restorePreviewCamera,
} from '@forgeax/view-workspace-core/preview-camera';
import { bindWorkspacePreviewSurface } from '@forgeax/view-workspace-core/preview-surface';
import {
  selectWorkspaceResourcePreview,
  selectWorkspaceResourceSubject,
} from '@forgeax/view-workspace-core/resource-open';
import { createWorkspaceObservation, createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { PAGE_TYPE, RESOURCE_KINDS } from '../identity.ts';
import { useTranslation } from '../i18n/useTranslation';
import './mesh.css';
import { MeshDisplayControls } from './MeshDisplayControls';

type InputController = {
  attach: (element: HTMLElement) => (reason?: string) => void;
  abort?: (reason?: string) => Promise<void> | void;
};
type InputControllerOptions = {
  api: ViewWorkspaceClient;
  targetId: string;
  targetGeneration?: number;
  tabId: string;
  bindings?: 'scene' | 'orbit';
  shouldCapture: (event: Event) => boolean;
  onFocusSelection?: () => unknown;
  document?: Document;
  window?: Window;
};
type InputControllerFactory = (options: InputControllerOptions) => InputController;

export function MeshPreviewPanel({
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
    return <PreviewEmpty title={t('mesh.previewEmpty')} description={t('mesh.previewUnavailable')} />;
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
    <div className="fx-asset-viewer fx-asset-preview fx-ui" data-testid="panel-mesh-preview">
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
  const pivotRef = useRef<readonly [number, number, number] | undefined>(undefined);
  const restoreRef = useRef<() => void>(() => {});
  const [failure, setFailure] = useState<{ hint?: string; expected?: string }>();
  const [initialPose, setInitialPose] = useState<unknown>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const targetId = preview?.target?.targetId;
  const targetGeneration = preview?.target?.generation;
  const projectId = workspace?.project?.id;
  const guid = subject?.guid;
  const orbitCenter = meshAabbCenter(preview?.assetBinding);
  const orbitCenterKey = orbitCenter?.join(':') ?? '';

  useEffect(() => {
    const container = containerRef.current;
    const target = preview?.target;
    if (!container || !target) return undefined;
    let cancelled = false;
    let ready = false;
    let removeInput: ((reason?: string) => void) | undefined;
    const bound = bindWorkspacePreviewSurface({
      requestId: resourcePreviewRequestId(workspace, target.targetId),
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
      pivotRef.current = undefined;
      return undefined;
    }
    const observation = createWorkspaceObservation(reader, (current) => {
      const currentTarget = selectWorkspaceResourcePreview(current, guid)?.target;
      return currentTarget?.targetId === target.targetId && currentTarget?.generation === target.generation;
    });
    const { signal } = observation;
    void bound.ready?.catch(error => {
      if (!cancelled && !signal.aborted) setFailure({ hint: error instanceof Error ? error.message : String(error) });
    });
    setFailure(undefined);
    setInitialPose(null);
    setRestoreError('');
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
      if (cancelled || signal.aborted || !ready || removeInput || !pageActive()) return;
      const factory = inputControllerFactory?.();
      if (typeof factory !== 'function') return;
      const controller = factory({
        api: client,
        targetId: String(target.targetId),
        targetGeneration: target.generation,
        tabId: VIEW_WORKSPACE_TAB_ID,
        document,
        window: document?.defaultView ?? undefined,
        shouldCapture: (event) => previewShouldCapture(event, container, PAGE_TYPE),
        onFocusSelection: () => restoreRef.current(),
      });
      controllerRef.current = controller;
      removeInput = controller.attach(container);
    };
    signal.addEventListener('abort', detachInput, { once: true });
    void (async () => {
      let pose: unknown = null;
      try {
        pose = await rememberInitialPreviewCamera(client, target, { signal, reportError: false });
      } catch (error: unknown) {
        if (!signal.aborted && !cancelled) setRestoreError(error instanceof Error ? error.message : String(error));
      }
      if (signal.aborted || cancelled) return;
      let pivot = orbitCenter;
      if (!pivot && guid && projectId) {
        try {
          const inspected = await client.inspectAsset(guid, {
            projectId,
            tabId: VIEW_WORKSPACE_TAB_ID,
            signal,
            reportError: false,
          });
          pivot = meshAabbCenter(unwrapWorkspaceInspection(inspected));
        } catch (error: unknown) {
          if (!signal.aborted && !cancelled) {
            setRestoreError(error instanceof Error ? error.message : String(error));
          }
          pivot = undefined;
        }
      }
      if (signal.aborted || cancelled) return;
      if (pivot) {
        try {
          await commitPreviewCameraPivot(client, target, pivot, { signal, reportError: false });
        } catch (error: unknown) {
          pivot = undefined;
          if (!signal.aborted && !cancelled) setRestoreError(error instanceof Error ? error.message : String(error));
        }
      }
      if (signal.aborted || cancelled) return;
      pivotRef.current = pivot;
      setInitialPose(pose);
      ready = true;
      attachInput();
    })();
    const observer = document && typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
        if (pageActive()) attachInput();
        else detachInput();
      })
      : undefined;
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-forgeax-view-active-page'] });
    return () => {
      cancelled = true;
      observation.dispose();
      observer?.disconnect();
      detachInput();
      void bound.dispose?.();
    };
  }, [
    presentation,
    owner,
    targetId,
    targetGeneration,
    preview?.target?.surfaceId,
    workspace?.scenePreview?.target?.targetId,
    client,
    reader,
    inputControllerFactory,
    guid,
    projectId,
    orbitCenterKey,
  ]);

  const restoreView = () => {
    const target = preview?.target;
    if (!target || initialPose == null || restoring) return;
    const pivot = pivotRef.current;
    setRestoring(true);
    setRestoreError('');
    void Promise.resolve(controllerRef.current?.abort?.('camera-restore'))
      .then(() => restorePreviewCamera(
        client,
        target,
        pivot ? cameraPoseWithPivot(initialPose, pivot) : initialPose,
      ))
      .catch((error: unknown) => {
        setRestoreError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setRestoring(false));
  };
  restoreRef.current = restoreView;

  if (!subject) return <PreviewEmpty title={t('mesh.previewEmpty')} description={t('mesh.empty')} />;
  if (!preview?.target) {
    return (
      <PreviewEmpty
        title={t('mesh.previewUnavailable')}
        description={t('mesh.previewCapabilityMissing')}
      />
    );
  }
  return (
    <div className="fx-asset-viewer fx-asset-preview fx-mesh-preview fx-ui" data-testid="panel-mesh-preview">
      <MeshDisplayControls key={`${preview.target.targetId}:${preview.target.generation}`} client={client} preview={preview} reader={reader} resetDisabled={initialPose == null || restoring || Boolean(failure)} onReset={restoreView} />
        {restoreError ? (
          <p className="fx-mesh-restore-error" role="alert">{restoreError}</p>
        ) : null}
      <div
        ref={containerRef}
        className="fx-asset-preview-surface"
        data-forgeax-asset-preview={preview.target.targetId}
        hidden={Boolean(failure)}
      />
      {failure ? (
        <EmptyState
          title={t('mesh.previewUnavailable')}
          description={failure.hint ?? failure.expected ?? t('mesh.previewCapabilityMissing')}
        />
      ) : null}
    </div>
  );
}
