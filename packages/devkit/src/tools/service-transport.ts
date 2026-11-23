import {
  type AuthenticatedLoopbackTransport,
  createAuthenticatedLoopbackTransport,
  type ServiceWireHandler,
  type ServiceWireRequest,
} from '@forgeax/engine-tool-runtime';

import { serveLoopbackJson } from '../loopback.js';

export type {
  AuthenticatedLoopbackTransport,
  AuthenticatedLoopbackTransportOptions,
  ServiceWireHandler,
  ServiceWireRequest,
} from '@forgeax/engine-tool-runtime';
export { createAuthenticatedLoopbackTransport } from '@forgeax/engine-tool-runtime';

export interface AuthenticatedLoopbackServiceOptions {
  readonly bearerToken: string;
  readonly handler: ServiceWireHandler;
  readonly host?: '127.0.0.1' | 'localhost';
  readonly expectedDescriptorDigest?: string;
  readonly expectedRecipeDigest?: string;
}

export interface AuthenticatedLoopbackService {
  readonly endpoint: string;
  readonly transport: AuthenticatedLoopbackTransport;
  readonly close: () => Promise<void>;
}

function parseRequest(value: unknown): ServiceWireRequest {
  if (typeof value !== 'object' || value === null) throw new Error('request must be an object');
  const request = value as Record<string, unknown>;
  if (
    typeof request.descriptorDigest !== 'string' ||
    typeof request.recipeDigest !== 'string' ||
    request.args === undefined
  ) {
    throw new Error('request is missing descriptorDigest, recipeDigest, or args');
  }
  return {
    descriptorDigest: request.descriptorDigest,
    recipeDigest: request.recipeDigest,
    args: request.args as ServiceWireRequest['args'],
  };
}

export async function createAuthenticatedLoopbackService(
  options: AuthenticatedLoopbackServiceOptions,
): Promise<AuthenticatedLoopbackService> {
  if (options.bearerToken.length < 8) throw new TypeError('service bearer token is too short');
  const service = await serveLoopbackJson({
    host: options.host,
    bearerToken: options.bearerToken,
    route: (path) => (path === '/run' ? path : undefined),
    missingRoute: { error: 'service route not found' },
    rejectedToken: { error: 'service bearer token rejected' },
    invalidRequest: (cause) => ({ error: cause instanceof Error ? cause.message : String(cause) }),
    maxBodyBytes: 1024 * 1024,
    async run(_route, body) {
      const wireRequest = parseRequest(body);
      if (
        options.expectedDescriptorDigest !== undefined &&
        wireRequest.descriptorDigest !== options.expectedDescriptorDigest
      )
        return [409, { error: 'service descriptor digest mismatch' }];
      if (
        options.expectedRecipeDigest !== undefined &&
        wireRequest.recipeDigest !== options.expectedRecipeDigest
      )
        return [409, { error: 'service recipe digest mismatch' }];
      return [200, await options.handler(wireRequest)];
    },
  });
  const endpoint = `${service.origin}/run`;
  const transport = createAuthenticatedLoopbackTransport({
    endpoint,
    bearerToken: options.bearerToken,
  });
  return { endpoint, transport, close: () => service.close(() => transport.close()) };
}
