export {
  connectViewFrontend,
  mountViewWorkspace,
  mountViewViewer,
} from '@forgeax/view-viewer/host/frontend';
export {
  createInspectorRequest,
  createViewInspectorToolContributions,
  ViewInspectorClient,
  VIEW_INSPECTOR_API_VERSION,
  VIEW_INSPECTOR_OPERATIONS,
  VIEW_INSPECTOR_SERVICES,
  VIEW_INSPECTOR_TOPIC,
} from '@forgeax/view-plugin-plugins/runtime';
export {
  createBrowserPagePresentation,
  ViewWorkspaceInputController,
  ViewWorkspaceShell,
} from '@forgeax/view-plugin-viewport/workspace-shell';
export {
  createViewWorkspaceClient,
  ViewWorkspaceClient,
} from '@forgeax/view-workspace-core/client';
export {
  VIEW_EXTENSION_ID,
  VIEW_EXTENSION_CAPABILITIES,
  createViewExtensionTransport,
  createViewExtensionWorkspaceClient,
} from '@forgeax/view-workspace-core/extension-bridge';
export * from '@forgeax/view-workspace-core/contract';
export { createViewSlotRegistry } from '@forgeax/view-viewer/host/slot-registry';
export { VIEW_LAYOUT_HOST_ID } from './shell/contract.ts';
export { DISPLAY_SURFACE_ID as VIEW_DISPLAY_SURFACE_ID } from '@forgeax/view-plugin-display/identity';
