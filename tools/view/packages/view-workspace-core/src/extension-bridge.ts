import type { HostRequestOptions } from '@forgeax/engine-host/transport';
import type { WorkspaceRequest } from './contract.ts';
export type ViewExtensionInvoke = (input: { extensionId: string; capability: string; service: string; request: unknown; signal?: AbortSignal; generation?: number }) => unknown | Promise<unknown>;
export type ViewExtensionOptions = { invoke: ViewExtensionInvoke; extensionId?: string; capabilities?: readonly string[] };
import { VIEW_FILE_GET_SERVICE, VIEW_WORKSPACE_SERVICES, VIEW_WORKSPACE_DOMAIN_OPERATIONS, workspaceError, requireWorkspaceString } from './contract.ts';
import { createViewWorkspaceClient } from './client.ts';

export const VIEW_EXTENSION_ID = '@forgeax-extension/view';
export const VIEW_EXTENSION_CAPABILITIES = Object.freeze({
  read: 'view.workspace.read',
  author: 'view.workspace.author',
  inspect: 'view.plugins.read',
});

const AUTHORING_OPERATIONS = new Set(['asset.source.rebuild', 'asset.source.cold-cook']);
const WORKSPACE_OPERATIONS = new Set(VIEW_WORKSPACE_DOMAIN_OPERATIONS);

function requiredCapability(service: string, request: unknown) {
  const operation = request && typeof request === 'object' && 'operation' in request ? request.operation : undefined;
  if (service === VIEW_WORKSPACE_SERVICES.call) {
    if (typeof operation !== 'string' || !WORKSPACE_OPERATIONS.has(operation)) {
      throw workspaceError(
        'view-extension-operation-unknown',
        'operation to be declared by the View workspace contract',
        'Refresh the View extension capability descriptor.',
        { operation },
      );
    }
    return AUTHORING_OPERATIONS.has(operation)
      ? VIEW_EXTENSION_CAPABILITIES.author
      : VIEW_EXTENSION_CAPABILITIES.read;
  }
  if (service === VIEW_WORKSPACE_SERVICES.capabilities) return VIEW_EXTENSION_CAPABILITIES.read;
  if (service === VIEW_FILE_GET_SERVICE) return VIEW_EXTENSION_CAPABILITIES.read;
  throw workspaceError(
    'view-extension-service-unknown',
    'service to be declared by the View extension contract',
    'Use the typed View workspace client rather than a raw Host service name.',
    { service },
  );
}

/**
 * Browser-side adapter for a Scene-issued, session-bound View capability.
 * The host authenticates the iframe; this transport never receives or forwards
 * the resident Host endpoint or its bearer token.
 */
export function createViewExtensionTransport({
  invoke,
  extensionId = VIEW_EXTENSION_ID,
  capabilities = [],
}: Partial<ViewExtensionOptions> = {}) {
  if (typeof invoke !== 'function') {
    throw new TypeError('View extension transport requires a host capability invoke function');
  }
  if (extensionId !== VIEW_EXTENSION_ID) {
    throw new TypeError(`View extension transport only admits ${VIEW_EXTENSION_ID}`);
  }
  const granted = new Set(capabilities);
  return Object.freeze({
    request<TPayload, TResult>(service: string, request: TPayload, options: HostRequestOptions = {}): Promise<TResult> {
      const capability = requiredCapability(service, request);
      if (!granted.has(capability)) {
        return Promise.reject(workspaceError(
          'view-extension-capability-denied',
          `the ${capability} capability to be granted`,
          'Install or re-authorize the View extension with the required permission.',
          { extensionId, capability, service, operation: (request as Partial<WorkspaceRequest> | undefined)?.operation },
        ));
      }
      const { signal, generation } = options;
      return Promise.resolve(invoke({
        extensionId,
        capability,
        service,
        request,
        ...(signal === undefined ? {} : { signal }),
        ...(generation === undefined ? {} : { generation }),
      })) as Promise<TResult>;
    },
    close() {},
  });
}

export function createViewExtensionWorkspaceClient({ invoke, capabilities, clientId }: Partial<ViewExtensionOptions> & { clientId?: string } = {}) {
  return createViewWorkspaceClient({
    transport: createViewExtensionTransport({ invoke, capabilities }),
    clientId: requireWorkspaceString(clientId, 'clientId'),
  });
}
