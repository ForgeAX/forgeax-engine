import { resourcePreviewRequestId } from '@forgeax/view-workspace-core/resource-open';
import type { PreviewOwner, ViewPresentation as PreviewPresentation } from '@forgeax/view-workspace-core/engine-presentation';
import { EmptyState, IconButton, Toolbar, Tooltip, usePanelVisible } from '@forgeax/view-components';
import { RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { bindWorkspacePreviewSurface } from '@forgeax/view-workspace-core/preview-surface';
import {
  selectWorkspaceResourcePreview,
  selectWorkspaceResourceSubject,
} from '@forgeax/view-workspace-core/resource-open';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import { VIEW_WORKSPACE_TAB_ID, type MaterialPreviewMesh, type MaterialPreviewState } from '@forgeax/view-workspace-core/contract';
import { createWorkspaceObservation, createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import {
  previewShouldCapture,
  rememberInitialPreviewCamera,
  restorePreviewCamera,
  commitPreviewCameraPivot,
} from '@forgeax/view-workspace-core/preview-camera';
import { attachMaterialRotation } from '../preview-navigation.ts';
import { MaterialPreviewMeshControls } from './MaterialPreviewMeshControls';
import { PAGE_TYPE, RESOURCE_KINDS } from '../identity.ts';
import { useTranslation } from '../i18n/useTranslation';
import './material.css';

type InputController = {
  attach: (element: HTMLElement) => (reason?: string) => void;
  abort?: (reason?: string) => Promise<void> | void;
  finish?: () => Promise<void>;
};
type InputControllerOptions = {
  api: ViewWorkspaceClient;
  targetId: string;
  targetGeneration?: number;
  bindings?: 'scene' | 'orbit';
  dollyStepLimit?: number;
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
  const visible = usePanelVisible();
  const workspace = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  const subject = selectWorkspaceResourceSubject(workspace, RESOURCE_KINDS);
  const preview = selectWorkspaceResourcePreview(workspace, subject?.guid);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<InputController | null>(null);
  const [failure, setFailure] = useState<{ hint?: string; expected?: string }>();
  const [initialPose, setInitialPose] = useState<unknown>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [material, setMaterial] = useState<MaterialPreviewState>();
  const rotationRef = useRef<ReturnType<typeof attachMaterialRotation> | null>(null);
  const observationRef = useRef<ReturnType<typeof createWorkspaceObservation> | null>(null);
  const busyRef = useRef(false);
  const targetId = preview?.target?.targetId;
  const targetGeneration = preview?.target?.generation;

  useEffect(() => {
    const container = containerRef.current;
    const target = preview?.target;
    if (!container || !target || !visible) return undefined;
    const observation = createWorkspaceObservation(reader, state => {
      const current = selectWorkspaceResourcePreview(state, subject?.guid)?.target;
      return current?.targetId === target.targetId && current?.generation === target.generation;
    });
    observationRef.current = observation;
    const signal = observation.signal;
    let cancelled = false;
    let ready = false;
    let removeInput: ((reason?: string) => void) | undefined;
    let controller: InputController | undefined;
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
      observation.dispose();
      return undefined;
    }
    setFailure(undefined);
    setMaterial(undefined);
    setInitialPose(null);
    setRestoring(false); busyRef.current = false;
    const document = container.ownerDocument;
    const pageActive = () => {
      const active = document?.documentElement?.dataset?.forgeaxViewActivePage;
      return active === undefined || active === PAGE_TYPE;
    };
    const detachInput = () => {
      const remove = removeInput;
      removeInput = undefined;
      rotationRef.current?.dispose(); rotationRef.current = null;
      controllerRef.current = null;
      remove?.('input-detached');
    };
    const attachInput = () => {
      if (cancelled || signal.aborted || !ready || removeInput || !pageActive()) return;
      const factory = inputControllerFactory?.();
      if (typeof factory !== 'function') return;
      controller = factory({
        api: client,
        targetId: String(target.targetId),
        targetGeneration: target.generation,
        bindings: 'orbit',
        dollyStepLimit: 0.25,
        tabId: VIEW_WORKSPACE_TAB_ID,
        document,
        window: document?.defaultView ?? undefined,
        shouldCapture: (event) => !busyRef.current && previewShouldCapture(event, container, PAGE_TYPE)
          && !(event.type === 'pointerdown' && (event as PointerEvent).button === 0),
      });
      controllerRef.current = controller;
      removeInput = controller.attach(container);
      rotationRef.current = attachMaterialRotation({
        element: container, client, target, signal,
        shouldCapture: event => !busyRef.current && previewShouldCapture(event, container, PAGE_TYPE),
        onError: error => setRestoreError(error instanceof Error ? error.message : String(error)),
      });
    };
    signal.addEventListener('abort', detachInput, { once: true });
    void (async () => {
      await bound.ready;
      if (signal.aborted) return;
      const capabilities = await client.capabilities({ signal });
      if (signal.aborted) return;
      const operations = capabilities && typeof capabilities === 'object' && 'operations' in capabilities && Array.isArray(capabilities.operations) ? capabilities.operations : [];
      if (!capabilities || typeof capabilities !== 'object' || !('operations' in capabilities)
        || !Array.isArray(capabilities.operations)
        || !['get', 'set', 'rotate', 'reset'].every(action => operations.includes(`preview.material.${action}`))) {
        setRestoreError(t('material.meshUnavailable')); return;
      }
      const info = await client.call<MaterialPreviewState>('preview.material.get', {
        targetId: target.targetId, targetGeneration: target.generation,
      }, { signal });
      if (signal.aborted) return;
      const camera = await client.getCamera({ targetId: target.targetId, targetGeneration: target.generation, signal });
      if (signal.aborted) return;
      if (!(camera?.camera as { pivot?: unknown } | undefined)?.pivot && info.center.length === 3)
        await commitPreviewCameraPivot(client, target, info.center as [number, number, number], { signal });
      const pose = await rememberInitialPreviewCamera(client, target, { signal });
      if (signal.aborted) return;
      setMaterial(info); setInitialPose(pose ?? null); setRestoreError('');
      ready = true; attachInput();
    })().catch((error: unknown) => {
      if (!signal.aborted) setRestoreError(error instanceof Error ? error.message : String(error));
    });
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
      if (observationRef.current === observation) observationRef.current = null;
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
    inputControllerFactory,
    reader, visible, subject?.guid,
  ]);

  const restoreView = () => {
    const target = preview?.target;
    const signal = observationRef.current?.signal;
    if (!target || initialPose == null || busyRef.current || !signal || signal.aborted) return;
    busyRef.current = true;
    setRestoring(true);
    setRestoreError('');
    void Promise.resolve(rotationRef.current?.settle())
      .then(() => controllerRef.current?.finish?.())
      .then(async () => {
        signal.throwIfAborted();
        const info = await client.call<MaterialPreviewState>('preview.material.reset', { targetId: target.targetId, targetGeneration: target.generation }, { signal });
        signal.throwIfAborted(); setMaterial(info);
        await restorePreviewCamera(client, target, initialPose, { signal });
      })
      .catch((error: unknown) => {
        if (!signal.aborted) setRestoreError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => { if (!signal.aborted) { busyRef.current = false; setRestoring(false); } });
  };

  const changeMesh = (mesh: MaterialPreviewMesh) => {
    const target = preview?.target, signal = observationRef.current?.signal;
    if (!target || !material || material.mesh === mesh || busyRef.current || !signal || signal.aborted) return;
    busyRef.current = true; setRestoring(true); setRestoreError('');
    void Promise.resolve(rotationRef.current?.settle()).then(() => controllerRef.current?.finish?.())
      .then(() => { signal.throwIfAborted(); return client.call<MaterialPreviewState>('preview.material.set', {
        targetId: target.targetId, targetGeneration: target.generation, mesh,
      }, { signal }); })
      .then(info => { if (!signal.aborted) setMaterial(info); })
      .catch(error => { if (!signal.aborted) setRestoreError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (!signal.aborted) { busyRef.current = false; setRestoring(false); } });
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
      <Toolbar className="fx-toolbar--viewport fx-material-preview-toolbar" aria-label={t('material.previewTitle')}>
        <Tooltip title={t('material.restoreView')} description={t('material.restoreViewDescription')} placement="bottom" portaled>
          <IconButton
            label={t('material.restoreView')}
            title=""
            icon={<RotateCcw className="fx-icon" />}
            size="compact"
            variant="secondary"
            data-testid="material-restore-view"
            disabled={initialPose == null || restoring || Boolean(failure)}
            onClick={restoreView}
          />
        </Tooltip>
        <MaterialPreviewMeshControls mesh={material?.mesh} disabled={!material || restoring || Boolean(failure)} onChange={changeMesh} />
      </Toolbar>
      {restoreError ? (
        <p className="fx-material-restore-error" role="alert">{restoreError}</p>
      ) : null}
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
