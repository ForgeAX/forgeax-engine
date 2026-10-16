import type { EngineWorkspaceCameraInput, EngineWorkspacePresentation, EngineWorkspaceTarget } from '@forgeax/engine/app';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';

/** Camera input borrows the canvas owner's public target methods when available. */
export function createViewportInputApi(api: ViewWorkspaceClient, presentation: EngineWorkspacePresentation | undefined, target: EngineWorkspaceTarget) {
  const local = presentation?.resolveTarget?.(target.targetId);
  if (!local) return api;
  const methods = { getCamera: 'getCamera', beginCamera: 'beginCameraInteraction', updateCamera: 'updateCameraDraft', commitCamera: 'commitCamera', abortCamera: 'abortCameraInteraction' } as const;
  return new Proxy(api, { get(client, key) {
    if (Object.hasOwn(methods, key)) {
      const method = local[methods[key as keyof typeof methods]];
      if (!method) throw new Error(`Engine target camera method is unavailable: ${String(key)}`);
      return (input: EngineWorkspaceCameraInput) => {
        const owned: EngineWorkspaceCameraInput = { ...input, clientId: `${api.clientId}:canvas` };
        return Promise.resolve(method(owned));
      };
    }
    const value = Reflect.get(client, key, client);
    return typeof value === 'function' ? value.bind(client) : value;
  } });
}
