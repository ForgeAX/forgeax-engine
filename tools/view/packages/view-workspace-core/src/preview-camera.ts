import type { ViewWorkspaceClient } from './client.ts';
import type { WorkspaceTarget } from './contract.ts';
import { VIEW_WORKSPACE_TAB_ID, workspaceError } from './contract.ts';
import { createWorkspaceId } from './id.ts';
import { selectMeshPreviewCameraTarget } from './resource-open.ts';

const initialPreviewCameras = new Map<string, unknown>();

type PreviewCameraApi = Pick<ViewWorkspaceClient, 'getCamera' | 'beginCamera' | 'commitCamera'>
  & Partial<Pick<ViewWorkspaceClient, 'abortCamera'>>;

export function previewCameraKey(target: Partial<WorkspaceTarget> | null | undefined) {
  return `${target?.targetId ?? ''}:${target?.generation ?? ''}`;
}

/** Drop lens.aspect so a later commit does not freeze the spawn-time aspect. */
export function cameraPoseForRestore(camera: unknown) {
  if (!camera || typeof camera !== 'object') return camera;
  const pose = { ...camera } as Record<string, unknown>;
  if (pose.lens && typeof pose.lens === 'object') {
    const lens = { ...pose.lens } as Record<string, unknown>;
    delete lens.aspect;
    pose.lens = lens;
  }
  return pose;
}

export function cameraPoseWithPivot(
  camera: unknown,
  pivot: readonly [number, number, number],
) {
  const pose = cameraPoseForRestore(camera);
  const next: Record<string, unknown> = pose && typeof pose === 'object' ? { ...pose } : {};
  next.pivot = [pivot[0], pivot[1], pivot[2]];
  return next;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function finiteAabb(value: unknown): readonly [number, number, number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 6) return undefined;
  if (!value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) return undefined;
  return value as [number, number, number, number, number, number];
}

/** Midpoint of a mesh AABB from an asset binding or an asset.inspect payload. */
export function meshAabbCenter(source: unknown): readonly [number, number, number] | undefined {
  const root = record(source);
  if (!root) return undefined;
  const meta = record(root.meta);
  const asset = record(root.asset);
  const inspection = record(root.inspection);
  const aabb = finiteAabb(meta?.aabb)
    ?? finiteAabb(root.aabb)
    ?? finiteAabb(asset?.aabb)
    ?? finiteAabb(record(inspection?.meta)?.aabb);
  if (!aabb) return undefined;
  return [(aabb[0] + aabb[3]) / 2, (aabb[1] + aabb[4]) / 2, (aabb[2] + aabb[5]) / 2];
}

export function previewShouldCapture(event: Event, surface: HTMLElement | null | undefined, pageType: string) {
  const eventTarget = event?.target as Element | null;
  if (!eventTarget || event?.defaultPrevented) return false;
  if (typeof eventTarget.closest === 'function' &&
    eventTarget.closest('button,input,a,select,textarea,[contenteditable="true"]')) {
    return false;
  }
  if (surface && eventTarget !== surface && surface.contains?.(eventTarget) !== true) return false;
  const activePage = surface?.ownerDocument?.documentElement?.dataset?.forgeaxViewActivePage;
  if (activePage !== undefined && activePage !== pageType) return false;
  if (event.type === 'keydown' || event.type === 'keyup') {
    const active = surface?.ownerDocument?.activeElement;
    if (!surface || (!active || (active !== surface && surface.contains?.(active) !== true))) return false;
  }
  return true;
}

/**
 * Remember the first camera.get for this preview target. Later calls keep that
 * pose so a remount after flying does not treat the flown camera as initial.
 */
export async function rememberInitialPreviewCamera(api: Pick<ViewWorkspaceClient, 'getCamera'>, target: WorkspaceTarget, {
  tabId = VIEW_WORKSPACE_TAB_ID,
  snapshots = initialPreviewCameras,
  signal,
  reportError,
}: { tabId?: string; snapshots?: Map<string, unknown>; signal?: AbortSignal; reportError?: boolean } = {}) {
  const key = previewCameraKey(target);
  if (snapshots.has(key)) return snapshots.get(key);
  const current = await api.getCamera({
    targetId: String(target.targetId),
    targetGeneration: target.generation,
    tabId,
    signal,
    reportError,
  });
  if (!snapshots.has(key)) snapshots.set(key, current?.camera ?? null);
  return snapshots.get(key);
}

export async function restorePreviewCamera(api: PreviewCameraApi, target: WorkspaceTarget, pose: unknown, {
  tabId = VIEW_WORKSPACE_TAB_ID,
}: { tabId?: string } = {}) {
  const targetId = String(target.targetId);
  const targetGeneration = target.generation;
  const current = await api.getCamera({ targetId, targetGeneration, tabId });
  const version = current?.version;
  const interactionId = createWorkspaceId('interaction');
  await api.beginCamera({
    targetId,
    targetGeneration,
    tabId,
    baseVersion: version,
    interactionId,
  });
  await api.commitCamera({
    targetId,
    targetGeneration,
    tabId,
    interactionId,
    operationId: createWorkspaceId('operation'),
    expectedVersion: version,
    camera: cameraPoseForRestore(pose),
  });
}

/** One begin/commit that leaves the pose in place and records the orbit pivot. */
export async function commitPreviewCameraPivot(
  api: PreviewCameraApi,
  target: WorkspaceTarget,
  pivot: readonly [number, number, number],
  { tabId = VIEW_WORKSPACE_TAB_ID, signal, reportError }: { tabId?: string; signal?: AbortSignal; reportError?: boolean } = {},
) {
  if (signal?.aborted) return;
  const targetId = String(target.targetId);
  const targetGeneration = target.generation;
  const current = await api.getCamera({ targetId, targetGeneration, tabId, signal, reportError });
  if (signal?.aborted) return;
  const version = current?.version;
  const interactionId = createWorkspaceId('interaction');
  let begun = false;
  let committed = false;
  try {
    await api.beginCamera({
      targetId,
      targetGeneration,
      tabId,
      baseVersion: version,
      interactionId,
      signal,
      reportError,
    });
    begun = true;
    if (signal?.aborted) return;
    await api.commitCamera({
      targetId,
      targetGeneration,
      tabId,
      interactionId,
      operationId: createWorkspaceId('operation'),
      expectedVersion: version,
      camera: cameraPoseWithPivot(current?.camera, pivot),
      signal,
      reportError,
    });
    committed = true;
  } finally {
    if (begun && !committed && api.abortCamera) {
      try {
        await api.abortCamera({
          targetId, targetGeneration, tabId, interactionId,
          reason: 'preview-camera-seed-ended', reportError: false,
        });
      } catch {
        // The preview may already be closed by the time cancellation arrives.
      }
    }
  }
}

export { selectMeshPreviewCameraTarget } from './resource-open.ts';

/** Same motion samples the scene viewport submits through camera.update. */
export type PreviewCameraMotion = {
  type: 'move' | 'look' | 'pan' | 'orbit' | 'dolly';
  velocity?: readonly [number, number, number];
  yaw?: number;
  pitch?: number;
  pitchLimit?: number;
  distance?: number;
  x?: number;
  y?: number;
  amount?: number;
};

type PreviewCameraDriveApi = Pick<
  ViewWorkspaceClient,
  'getCamera' | 'beginCamera' | 'updateCamera' | 'commitCamera' | 'abortCamera'
>;

/**
 * One camera transaction on an existing preview target.
 * get → begin, then update, then commit or abort. The caller keeps this
 * object on the same connection; move velocity integrates only until commit.
 */
export async function beginPreviewCameraDrive(
  api: PreviewCameraDriveApi,
  target: WorkspaceTarget,
  { tabId = VIEW_WORKSPACE_TAB_ID }: { tabId?: string } = {},
) {
  const targetId = String(target.targetId);
  const address = {
    targetId,
    tabId,
    ...(target.generation === undefined ? {} : { targetGeneration: target.generation }),
  };
  const current = await api.getCamera(address);
  const version = current?.version;
  if (typeof version !== 'number') {
    throw workspaceError(
      'view-workspace-invalid-args',
      'camera.get to return a version',
      'Read the preview camera before beginning a drive.',
      { targetId },
    );
  }
  const interactionId = createWorkspaceId('interaction');
  await api.beginCamera({ ...address, baseVersion: version, interactionId });
  let settled = false;
  const finish = () => {
    if (settled) {
      throw workspaceError(
        'view-workspace-invalid-args',
        'an open preview camera drive',
        'Begin a new drive before updating the camera again.',
        { targetId, interactionId },
      );
    }
    settled = true;
  };
  return {
    targetId,
    ...(address.targetGeneration === undefined ? {} : { targetGeneration: address.targetGeneration }),
    interactionId,
    version,
    update(input: PreviewCameraMotion) {
      if (settled) finish();
      return api.updateCamera({ ...address, interactionId, input });
    },
    setCamera(camera: unknown) {
      if (settled) finish();
      return api.updateCamera({ ...address, interactionId, camera });
    },
    async commit() {
      finish();
      try {
        return await api.commitCamera({
          ...address,
          interactionId,
          operationId: createWorkspaceId('operation'),
          expectedVersion: version,
        });
      } catch (error) {
        await api.abortCamera({
          ...address,
          interactionId,
          reason: 'commit-failed',
        }).catch(() => {});
        throw error;
      }
    },
    abort(reason = 'preview-camera-abort') {
      if (settled) return undefined;
      settled = true;
      return api.abortCamera({ ...address, interactionId, reason });
    },
  };
}

type MeshPreviewCameraApi = PreviewCameraDriveApi & Pick<ViewWorkspaceClient, 'getState'>;

/**
 * Drive the open mesh preview with the scene camera API.
 * The scene target is never selected. Hold the returned drive to keep
 * a move sample integrating, then commit or abort on the same connection.
 */
export async function openMeshPreviewCamera(
  api: MeshPreviewCameraApi,
  input?: PreviewCameraMotion,
) {
  const target = selectMeshPreviewCameraTarget(await api.getState());
  if (!target) {
    throw workspaceError(
      'view-workspace-preview-required',
      'an open mesh preview',
      'Open the mesh before moving its camera.',
    );
  }
  const drive = await beginPreviewCameraDrive(api, target);
  if (input) {
    try {
      await drive.update(input);
    } catch (error) {
      await drive.abort('mesh-camera-update-failed');
      throw error;
    }
  }
  return drive;
}
