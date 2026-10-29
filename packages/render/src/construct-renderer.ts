import { type AssetRegistry, validateAssetBudgetBytes } from '@forgeax/engine-assets-runtime';
import { EngineEnvironmentError, type RhiBackendPack } from './assembly/backend-contract';
import type { BundlerOptions } from './assembly/factory';
import { createRenderer, exposeRenderer } from './assembly/factory';
import type {
  RendererHostImplementation,
  RendererLegacyHostAdapter,
} from './assembly/host-contract';
import { validateDynamicGeometryMeshBudget } from './dynamic-geometry';
import { type RenderError, RendererContractFailureError } from './errors/render';
import type { Renderer, RendererOptions, RenderResult } from './render-contract';

export type {
  EngineEnvironmentErrorDetail,
  RhiBackendInstrumentation,
  RhiBackendPack,
} from './assembly/backend-contract';
export { EngineEnvironmentError, loadRhiPack } from './assembly/backend-contract';
export type { RendererLegacyHostAdapter } from './assembly/host-contract';
export type { BundlerOptions };

export type RendererFeatureAssemblyHost = Pick<
  RendererLegacyHostAdapter,
  'installRenderFeature' | 'uninstallRenderFeature'
>;

export interface RendererHostAssembly {
  readonly renderer: Renderer;
  /** Scene preparation may fail while the same graphics/UI host stays usable. */
  readonly initialization: Promise<RenderResult<void, RenderError>>;
  readonly debugDrawHost: RendererHostImplementation;
  readonly featureHost: RendererFeatureAssemblyHost;
  readonly assets: AssetRegistry;
}

function describeRendererInitializationFailure(error: unknown): string {
  const candidate = error as unknown as {
    readonly code?: unknown;
    readonly hint?: unknown;
    readonly detail?: unknown;
  };
  const detail = candidate.detail;
  if (typeof detail === 'object' && detail !== null && 'compilerMessages' in detail) {
    const messages = (detail as { readonly compilerMessages?: unknown }).compilerMessages;
    if (Array.isArray(messages)) {
      const compilerMessages = messages.map((message) => {
        const value = message as {
          readonly message?: unknown;
          readonly type?: unknown;
          readonly lineNum?: unknown;
          readonly linePos?: unknown;
          readonly offset?: unknown;
          readonly length?: unknown;
        };
        return {
          message: value.message,
          type: value.type,
          lineNum: value.lineNum,
          linePos: value.linePos,
          offset: value.offset,
          length: value.length,
        };
      });
      return `${String(candidate.code)}: ${String(candidate.hint)}; detail=${JSON.stringify({ compilerMessages })}`;
    }
  }
  return `${String(candidate.code)}: ${String(candidate.hint)}; detail=${JSON.stringify(detail)}`;
}

export async function constructRendererHost(
  canvas: unknown,
  options?: RendererOptions,
  bundler?: BundlerOptions,
  backend?: RhiBackendPack,
): Promise<RenderResult<RendererHostAssembly, RenderError | EngineEnvironmentError>> {
  try {
    if (options?.dynamicGeometryMeshBudgetBytes !== undefined)
      validateDynamicGeometryMeshBudget(options.dynamicGeometryMeshBudgetBytes);
    if (options?.assetBudgetBytes !== undefined) validateAssetBudgetBytes(options.assetBudgetBytes);
    const implementation = await createRenderer(canvas, options, bundler, backend);
    const initialization = implementation.initialization.then(
      (ready): RenderResult<void, RenderError> =>
        ready.ok
          ? ready
          : {
              ok: false,
              error: new RendererContractFailureError(
                'construct',
                describeRendererInitializationFailure(ready.error),
              ),
            },
    );
    // A host with CPU UI starts its App before awaiting scene work. Hosts
    // without a presentation source retain the ordinary ready-to-draw barrier.
    if (options?.ui === undefined) {
      const initialized = await initialization;
      if (!initialized.ok) {
        implementation.dispose();
        return initialized;
      }
    }
    return {
      ok: true,
      value: {
        renderer: exposeRenderer(implementation),
        initialization,
        debugDrawHost: implementation,
        featureHost: implementation,
        assets: implementation.assetRegistry,
      },
    };
  } catch (cause) {
    if (cause instanceof EngineEnvironmentError) {
      return { ok: false, error: cause };
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      error: new RendererContractFailureError('construct', detail),
    };
  }
}
