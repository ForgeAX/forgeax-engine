import {
  type AuthenticatedLoopbackTransport,
  cancellationError,
  createServiceCapability,
  disconnectedError,
  domainFailureError,
  type JsonValue,
  type ServiceAdmissionRef,
  type ServiceCapability,
  type ToolContribution,
  type ToolTerminal,
} from '@forgeax/engine-tool-runtime';

export interface ServiceExecutorOptions<TArgs, TResult> {
  readonly contribution: ToolContribution<TArgs, TResult>;
  readonly privateExecutor: (args: TArgs) => Promise<ToolTerminal<TResult>>;
  readonly transport: AuthenticatedLoopbackTransport;
  readonly admission?: ServiceAdmissionRef;
  readonly descriptorDigest: string;
  readonly recipeDigest: string;
  readonly workloadClass: string;
  readonly codeDigest: string;
  readonly browserVersion: string;
  readonly bearerToken?: string;
}

export interface ServiceExecutor<TArgs, TResult> {
  readonly capability: ServiceCapability;
  readonly run: (
    args: TArgs,
    options?: { readonly recipeDigest?: string; readonly signal?: AbortSignal },
  ) => Promise<ToolTerminal<TResult>>;
}

export function createServiceExecutor<TArgs, TResult>(
  options: ServiceExecutorOptions<TArgs, TResult>,
): ServiceExecutor<TArgs, TResult> {
  const capability = createServiceCapability(options.admission, {
    toolId: options.contribution.descriptor.id,
    descriptorDigest: options.descriptorDigest,
    recipeDigest: options.recipeDigest,
    workloadClass: options.workloadClass,
    codeDigest: options.codeDigest,
    browserVersion: options.browserVersion,
    backend: 'webgpu',
  });
  return {
    capability,
    async run(args, runOptions = {}) {
      if (!capability.available) return options.privateExecutor(args);
      const request = {
        descriptorDigest: options.descriptorDigest,
        recipeDigest: runOptions.recipeDigest ?? options.recipeDigest,
        args: args as JsonValue,
      };
      try {
        const terminal = await options.transport.request(
          request,
          options.bearerToken ?? 'service-default-token',
          runOptions.signal === undefined ? {} : { signal: runOptions.signal },
        );
        return terminal as ToolTerminal<TResult>;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (runOptions.signal?.aborted) {
          return {
            outcome: 'failed',
            failure: cancellationError(String(runOptions.signal.reason ?? 'aborted')),
            artifacts: [],
          };
        }
        const failure = message.includes('disconnected')
          ? disconnectedError(options.transport.endpoint)
          : domainFailureError(
              'service-transport-failed',
              'the authenticated loopback service to accept the request',
              'Check the service token and recipe digest, then retry the private executor.',
              message,
            );
        return { outcome: 'failed', failure, artifacts: [] };
      }
    },
  };
}
