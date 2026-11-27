import type {
  CarrierExecutionRequest,
  CarrierLeaseRequest,
  CarrierOffer,
  CarrierStateMachine,
  ToolTerminal,
} from '@forgeax/engine-tool-runtime';
import { serveLoopbackJson } from '../loopback.js';
import { failCommand } from '../types.js';

export interface CarrierProviderServiceOptions {
  readonly machine: CarrierStateMachine;
  readonly descriptorDigest: string;
  readonly recipeDigest: string;
  readonly execute: (
    request: CarrierExecutionRequest,
  ) => Promise<ToolTerminal<unknown>> | ToolTerminal<unknown>;
  readonly host?: '127.0.0.1' | 'localhost';
}

export interface CarrierProviderService {
  readonly endpoint: string;
  readonly offer: CarrierOffer;
  readonly close: () => Promise<void>;
}

export async function createCarrierProviderService(
  options: CarrierProviderServiceOptions,
): Promise<CarrierProviderService> {
  const { machine } = options;
  const bearerToken = machine.offer.bearerToken;
  const missingRoute = failCommand(
    'carrier-provider-exit',
    'a carrier protocol route',
    'Request a fresh visible offer from the provider.',
  );
  const service = await serveLoopbackJson({
    host: options.host,
    bearerToken,
    route: (path) => (path.startsWith('/carrier/') ? path.slice('/carrier/'.length) : undefined),
    missingRoute,
    rejectedToken: failCommand(
      'carrier-token-invalid',
      'the ephemeral bearer token',
      'Request a fresh authenticated offer; never guess or persist bearer tokens.',
    ),
    invalidRequest: (cause) =>
      failCommand(
        'carrier-provider-exit',
        'a valid carrier request',
        'Serialize POD only and retry from the last safe snapshot.',
        { cause: cause instanceof Error ? cause.message : String(cause) },
      ),
    async run(route, value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('carrier request must be an object');
      const body = value as Record<string, unknown>;
      if (route === 'lease') {
        const result = machine.lease({
          consumerId: String(body.consumerId ?? ''),
          bearerToken,
          now: Number(body.now),
          descriptorDigest:
            typeof body.descriptorDigest === 'string' ? body.descriptorDigest : undefined,
          recipeDigest: typeof body.recipeDigest === 'string' ? body.recipeDigest : undefined,
        } as CarrierLeaseRequest);
        return [result.ok ? 200 : 409, result];
      }
      const leaseId = typeof body.leaseId === 'string' ? body.leaseId : '';
      if (route === 'start') {
        const result = machine.started(leaseId);
        return [result.ok ? 200 : 409, result];
      }
      if (route === 'exit') {
        const result = machine.exit(leaseId);
        return [result.ok ? 200 : 409, result];
      }
      if (route === 'execute') {
        const snapshot = machine.snapshot();
        if (snapshot.state !== 'started' || snapshot.leaseId !== leaseId)
          return [
            409,
            failCommand(
              snapshot.state === 'exited' ? 'carrier-exited' : 'carrier-lease-required',
              'a started carrier lease',
              'Do not fallback after started; report the structured terminal error and offer a new carrier.',
            ),
          ];
        if (body.descriptorDigest !== options.descriptorDigest)
          return [
            409,
            failCommand(
              'carrier-descriptor-mismatch',
              'the offered descriptor digest',
              'Rebuild the offer from the current descriptor before retrying.',
            ),
          ];
        if (body.recipeDigest !== options.recipeDigest)
          return [
            409,
            failCommand(
              'carrier-recipe-mismatch',
              'the offered recipe digest',
              'Serialize a fresh snapshot and request a new carrier before retrying.',
            ),
          ];
        const terminal = await options.execute({
          leaseId,
          descriptorDigest: options.descriptorDigest,
          recipeDigest: options.recipeDigest,
          args: body.args,
        });
        return [200, { ok: true, value: terminal, state: 'started' }];
      }
      return [404, missingRoute];
    },
  });
  return {
    endpoint: `${service.origin}/carrier`,
    offer: machine.offer,
    close: () => service.close(),
  };
}
