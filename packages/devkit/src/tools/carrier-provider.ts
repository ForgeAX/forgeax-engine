import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type {
  CarrierLeaseRequest,
  CarrierOffer,
  CarrierResult,
  CarrierState,
  CarrierStateMachine,
  ToolTerminal,
} from '@forgeax/engine-tool-runtime';

export interface CarrierProvider {
  readonly offer: CarrierOffer;
  readonly accept: (request: CarrierLeaseRequest) => CarrierResult<{ readonly leaseId: string }>;
  readonly started: (leaseId: string) => CarrierResult<CarrierState>;
  readonly exit: (leaseId: string) => CarrierResult<CarrierState>;
}

export interface CarrierProviderServiceOptions {
  readonly machine: CarrierStateMachine;
  readonly descriptorDigest: string;
  readonly recipeDigest: string;
  readonly execute: (
    request: CarrierExecutionRequest,
  ) => Promise<ToolTerminal<unknown>> | ToolTerminal<unknown>;
  readonly host?: '127.0.0.1' | 'localhost';
}

/** Local structural view keeps DevKit source-compatible with an unbuilt runtime dist. */
export interface CarrierExecutionRequest {
  readonly leaseId: string;
  readonly descriptorDigest: string;
  readonly recipeDigest: string;
  readonly args: unknown;
}

export interface CarrierProviderService {
  readonly endpoint: string;
  readonly offer: CarrierOffer;
  readonly close: () => Promise<void>;
}

type WireResult =
  | { readonly ok: true; readonly value: unknown; readonly state: string }
  | { readonly ok: false; readonly error: unknown };

function errorResult(
  code: string,
  expected: string,
  hint: string,
  detail: Record<string, unknown> = {},
): WireResult {
  return { ok: false, error: { code, expected, hint, detail } };
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('carrier request must be an object');
  return value as Record<string, unknown>;
}

function reply(response: ServerResponse, status: number, payload: WireResult): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
}

export async function createCarrierProviderService(
  options: CarrierProviderServiceOptions,
): Promise<CarrierProviderService> {
  const host = options.host ?? '127.0.0.1';
  const bearerToken = options.machine.offer.bearerToken;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url?.startsWith('/carrier/')) {
      reply(
        response,
        404,
        errorResult(
          'carrier-provider-exit',
          'a carrier protocol route',
          'Request a fresh visible offer from the provider.',
        ),
      );
      return;
    }
    if (request.headers.authorization !== `Bearer ${bearerToken}`) {
      reply(
        response,
        401,
        errorResult(
          'carrier-token-invalid',
          'the ephemeral bearer token',
          'Request a fresh authenticated offer; never guess or persist bearer tokens.',
        ),
      );
      return;
    }
    try {
      const body = await readBody(request);
      const route = request.url.slice('/carrier/'.length);
      if (route === 'lease') {
        const result = options.machine.lease({
          consumerId: String(body.consumerId ?? ''),
          bearerToken,
          now: Number(body.now),
          descriptorDigest:
            typeof body.descriptorDigest === 'string' ? body.descriptorDigest : undefined,
          recipeDigest: typeof body.recipeDigest === 'string' ? body.recipeDigest : undefined,
        } as CarrierLeaseRequest);
        reply(response, result.ok ? 200 : 409, result.ok ? result : result);
        return;
      }
      const leaseId = typeof body.leaseId === 'string' ? body.leaseId : '';
      if (route === 'start') {
        const result = options.machine.started(leaseId);
        reply(response, result.ok ? 200 : 409, result.ok ? result : result);
        return;
      }
      if (route === 'exit') {
        const result = options.machine.exit(leaseId);
        reply(response, result.ok ? 200 : 409, result.ok ? result : result);
        return;
      }
      if (route === 'execute') {
        const snapshot = options.machine.snapshot();
        if (snapshot.leaseId !== leaseId || snapshot.state !== 'started') {
          reply(
            response,
            409,
            errorResult(
              snapshot.state === 'exited' ? 'carrier-exited' : 'carrier-lease-required',
              'a started carrier lease',
              'Do not fallback after started; report the structured terminal error and offer a new carrier.',
            ),
          );
          return;
        }
        if (body.descriptorDigest !== options.descriptorDigest) {
          reply(
            response,
            409,
            errorResult(
              'carrier-descriptor-mismatch',
              'the offered descriptor digest',
              'Rebuild the offer from the current descriptor before retrying.',
            ),
          );
          return;
        }
        if (body.recipeDigest !== options.recipeDigest) {
          reply(
            response,
            409,
            errorResult(
              'carrier-recipe-mismatch',
              'the offered recipe digest',
              'Serialize a fresh snapshot and request a new carrier before retrying.',
            ),
          );
          return;
        }
        const terminal = await options.execute({
          leaseId,
          descriptorDigest: options.descriptorDigest,
          recipeDigest: options.recipeDigest,
          args: body.args,
        });
        reply(response, 200, { ok: true, value: terminal, state: 'started' });
        return;
      }
      reply(
        response,
        404,
        errorResult(
          'carrier-provider-exit',
          'a carrier protocol route',
          'Request a fresh visible offer from the provider.',
        ),
      );
    } catch (cause) {
      reply(
        response,
        400,
        errorResult(
          'carrier-provider-exit',
          'a valid carrier request',
          'Serialize POD only and retry from the last safe snapshot.',
          { cause: cause instanceof Error ? cause.message : String(cause) },
        ),
      );
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
  if (address === null || typeof address === 'string')
    throw new Error('carrier provider did not expose a loopback port');
  const endpoint = `http://${host}:${address.port}/carrier`;
  let closed = false;
  return {
    endpoint,
    offer: options.machine.offer,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}

export function createCarrierProvider(machine: CarrierStateMachine): CarrierProvider {
  return {
    offer: machine.offer,
    accept(request) {
      const result = machine.lease(request);
      if (!result.ok) return result;
      return { ok: true, value: { leaseId: result.value.leaseId }, state: result.state };
    },
    started: machine.started,
    exit: machine.exit,
  };
}
