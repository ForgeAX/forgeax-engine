import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  type AuthenticatedLoopbackTransport,
  createAuthenticatedLoopbackTransport,
  type ServiceWireHandler,
  type ServiceWireRequest,
  type ToolTerminal,
} from '@forgeax/engine-tool-runtime';

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

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  if (body.byteLength > 1024 * 1024) throw new Error('request body is too large');
  return JSON.parse(body.toString('utf8')) as unknown;
}

function reply(
  response: ServerResponse,
  status: number,
  payload: ToolTerminal<unknown> | { readonly error: string },
): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
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

function isAuthorized(request: IncomingMessage, bearerToken: string): boolean {
  return request.headers.authorization === `Bearer ${bearerToken}`;
}

export async function createAuthenticatedLoopbackService(
  options: AuthenticatedLoopbackServiceOptions,
): Promise<AuthenticatedLoopbackService> {
  if (options.bearerToken.length < 8) throw new TypeError('service bearer token is too short');
  const host = options.host ?? '127.0.0.1';
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/run') {
      reply(response, 404, { error: 'service route not found' });
      return;
    }
    if (!isAuthorized(request, options.bearerToken)) {
      reply(response, 401, { error: 'service bearer token rejected' });
      return;
    }
    try {
      const wireRequest = parseRequest(await readJson(request));
      if (
        options.expectedDescriptorDigest !== undefined &&
        wireRequest.descriptorDigest !== options.expectedDescriptorDigest
      ) {
        reply(response, 409, { error: 'service descriptor digest mismatch' });
        return;
      }
      if (
        options.expectedRecipeDigest !== undefined &&
        wireRequest.recipeDigest !== options.expectedRecipeDigest
      ) {
        reply(response, 409, { error: 'service recipe digest mismatch' });
        return;
      }
      reply(response, 200, await options.handler(wireRequest));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      reply(response, 400, { error: message });
    }
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, host);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('loopback service did not expose a TCP address');
  }
  const endpoint = `http://${host}:${address.port}/run`;
  const transport = createAuthenticatedLoopbackTransport({
    endpoint,
    bearerToken: options.bearerToken,
  });
  let closed = false;
  return {
    endpoint,
    transport,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      transport.close();
    },
  };
}
