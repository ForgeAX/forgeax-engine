import {
  createToolPreviewHost,
  createToolPreviewRecipe,
  type ToolPreviewRecipeOptions,
  type ToolPreviewRunResult,
} from '@forgeax/engine-app';
import type {
  CarrierLeaseRequest,
  CarrierOffer,
  CarrierResult,
  CarrierState,
  ToolDomainFailure,
  ToolExecutionContext,
} from '@forgeax/engine-tool-runtime';
import type { CaptureBackend, CaptureBackendObserved } from '../types.js';
import { runBrowserPreviewHost } from './browser-host.js';
import type { BrowserCarrierTarget } from './display-carrier.js';

export interface PreviewHostRequest {
  readonly recipe: ToolPreviewRecipeOptions;
  readonly projectRoot?: string;
  readonly carrier?: PreviewCarrierRoute;
}

export interface PreviewCarrierRoute {
  readonly lookup: () => CarrierOffer | undefined;
  readonly lease: (request: CarrierLeaseRequest) => CarrierResult<{ readonly leaseId: string }>;
  readonly started: (leaseId: string) => CarrierResult<CarrierState>;
  readonly execute: (
    leaseId: string,
    request: Omit<PreviewHostRequest, 'carrier'>,
    context: Pick<ToolExecutionContext, 'runId' | 'signal'>,
  ) => Promise<PreviewRouteResult<PreviewHostResult>>;
  readonly exit: (leaseId: string) => CarrierResult<CarrierState>;
  readonly now?: () => number;
}

/** The browser run result plus the host-observed carrier and backend lane. */
export interface PreviewHostResult extends ToolPreviewRunResult {
  readonly actualCarrier: 'headless-private' | 'headed-private' | 'visible-consumer';
  /** Requested and observed browser adapter lane for host-owned captures. */
  readonly backendRequested?: CaptureBackend;
  readonly backendObserved?: CaptureBackendObserved;
  readonly backendFallbackReason?: string;
  /** Exact target identity when the headed page was borrowed from a display host. */
  readonly carrierTarget?: BrowserCarrierTarget;
  /** Explicit reason when the display host declined and private headed fallback ran. */
  readonly carrierFallbackReason?: string;
  /** A completed capture can still carry a truthful capability limitation. */
  readonly capabilityFailure?: ToolDomainFailure;
}

export type PreviewHostRunner = (
  request: PreviewHostRequest,
  context: ToolExecutionContext,
) => Promise<
  | { readonly ok: true; readonly value: PreviewHostResult }
  | { readonly ok: false; readonly error: ToolDomainFailure }
>;

type PreviewRouteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ToolDomainFailure };

function carrierRouteFailure(
  code: string,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>>,
): PreviewRouteResult<never> {
  return { ok: false, error: { code, expected, hint, detail: detail as never } };
}

export async function runCarrierPreviewRoute<T>(
  presentation: ToolPreviewRecipeOptions['presentation'],
  carrier: PreviewCarrierRoute | undefined,
  executePrivate: () => Promise<PreviewRouteResult<T>>,
  executeConsumer: (leaseId: string) => Promise<PreviewRouteResult<T>> = executePrivate,
): Promise<PreviewRouteResult<T>> {
  if (presentation === 'hidden' || carrier === undefined) return executePrivate();
  const offer = carrier.lookup();
  if (offer === undefined) return executePrivate();
  const leased = carrier.lease({
    consumerId: offer.consumerId,
    bearerToken: offer.bearerToken,
    now: carrier.now?.() ?? Date.now(),
  });
  if (!leased.ok) return executePrivate();
  const started = carrier.started(leased.value.leaseId);
  if (!started.ok) {
    const exited = carrier.exit(leased.value.leaseId);
    if (!exited.ok)
      return carrierRouteFailure(
        exited.error.code,
        exited.error.expected,
        exited.error.hint,
        exited.error.detail,
      );
    return executePrivate();
  }
  let result: PreviewRouteResult<T> | undefined;
  let executionFailed = false;
  let executionError: unknown;
  let exitFailure: PreviewRouteResult<T> | undefined;
  try {
    result = await executeConsumer(leased.value.leaseId);
  } catch (error) {
    executionFailed = true;
    executionError = error;
  } finally {
    const exited = carrier.exit(leased.value.leaseId);
    if (!exited.ok) {
      exitFailure = carrierRouteFailure(
        exited.error.code,
        exited.error.expected,
        exited.error.hint,
        exited.error.detail,
      );
    }
  }
  if (exitFailure !== undefined) return exitFailure;
  if (executionFailed) throw executionError;
  if (result === undefined) throw new Error('preview carrier consumer returned no result');
  return result;
}

export const runPreviewHost: PreviewHostRunner = async (request, context) => {
  if (context.snapshot === undefined) {
    return carrierRouteFailure(
      'tool-snapshot-missing',
      'ToolExecutionContext.snapshot before Browser or Renderer creation',
      'Start the operation with an authority snapshot and retry the lexical ToolRun.',
      { phase: 'snapshot' },
    );
  }
  const snapshot = context.snapshot;
  const recipe = createToolPreviewRecipe(request.recipe);
  return runCarrierPreviewRoute(
    recipe.presentation,
    request.carrier,
    async () => {
      if (typeof document === 'undefined') {
        if (request.projectRoot === undefined) {
          return carrierRouteFailure(
            'tool-preview-project-root-missing',
            'the Browser Host to receive a real ForgeaX project root',
            'Create the ToolClient with projectRoot or pass projectRoot in the preview request.',
            { phase: 'project-authority' },
          );
        }
        return runBrowserPreviewHost(
          request.projectRoot,
          recipe,
          snapshot,
          context.runId,
          context.signal,
        );
      }
      const host = await createToolPreviewHost({ recipe, snapshot });
      if (!host.ok) {
        return {
          ok: false,
          error: {
            code: host.error.code,
            expected: host.error.expected,
            hint: host.error.hint,
            detail: host.error.detail as never,
          },
        };
      }
      try {
        const result = await host.value.run();
        if (!result.ok) {
          return {
            ok: false,
            error: {
              code: result.error.code,
              expected: result.error.expected,
              hint: result.error.hint,
              detail: result.error.detail as never,
            },
          };
        }
        return {
          ok: true,
          value: {
            ...result.value,
            actualCarrier: recipe.presentation === 'hidden' ? 'headless-private' : 'headed-private',
          },
        };
      } finally {
        await host.value.dispose();
      }
    },
    async (leaseId) => {
      const carrier = request.carrier;
      if (carrier === undefined) {
        return carrierRouteFailure(
          'tool-preview-carrier-unavailable',
          'a leased Consumer provider',
          'Retry the ordinary private visible carrier.',
          { phase: 'consumer-execute' },
        );
      }
      const { carrier: _carrier, ...consumerRequest } = request;
      return carrier.execute(leaseId, consumerRequest, context);
    },
  );
};
