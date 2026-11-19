import type { Renderer } from '@forgeax/engine-render';
import { err, ok, type Result } from '@forgeax/engine-types';
import { EngineConfigurationError } from './configuration-error';
import { projectEngineStartup } from './configuration-host';
import type { EngineStartupPlan } from './configuration-types';
import type { ExecutionControl } from './execution/types';
import { serializableDetail } from './execution/worker-error';

export interface ConfigurationApplyRequest {
  readonly kind: 'configuration-apply';
  readonly requestId: number;
  readonly worldIdentity: string;
  readonly previousRevision: number;
  readonly plan: EngineStartupPlan;
}
export interface ConfigurationApplyResponse {
  readonly kind: 'configuration-result';
  readonly requestId: number;
  readonly worldIdentity: string;
  readonly revision: number;
  readonly result:
    | { readonly ok: true; readonly value: void }
    | {
        readonly ok: false;
        readonly error: Pick<EngineConfigurationError, 'code' | 'expected' | 'hint' | 'detail'>;
      };
}

export function staleConfiguration(reason: string): EngineConfigurationError {
  return new EngineConfigurationError('configuration-stale', { path: 'configuration', reason });
}

/** Synchronous constructor-profile transaction, used only between frame recordings. */
export function applyRenderConfiguration(
  renderer: Renderer,
  plan: EngineStartupPlan,
): Result<void, EngineConfigurationError> {
  const profile = projectEngineStartup(plan).standardProfile;
  if (profile === undefined) return err(staleConfiguration('the render configuration is absent'));
  const applied = renderer.setProfile(profile);
  return applied.ok
    ? ok(undefined)
    : err(
        new EngineConfigurationError('configuration-invalid', {
          path: 'settings.rendering',
          reason: 'the Renderer rejected the complete quality request',
          cause: applied.error,
        }),
      );
}

/** A bounded, identity-fenced channel. Replaced realms cannot acknowledge a newer request. */
export class ConfigurationRequests {
  private nextId = 0;
  private closed = false;
  private pending:
    | {
        readonly id: number;
        readonly world: string;
        readonly revision: number;
        finish(result: Result<void, EngineConfigurationError>): void;
      }
    | undefined;

  request(
    plan: EngineStartupPlan,
    previousRevision: number,
    world: string,
    send: (message: ConfigurationApplyRequest) => void,
  ): Promise<Result<void, EngineConfigurationError>> {
    if (this.closed || this.pending !== undefined)
      return Promise.resolve(err(staleConfiguration('the configuration channel is unavailable')));
    const id = ++this.nextId;
    return new Promise((resolve) => {
      const finish = (result: Result<void, EngineConfigurationError>) => {
        if (this.pending?.id !== id) return;
        clearTimeout(deadline);
        this.pending = undefined;
        resolve(result);
      };
      const deadline = setTimeout(
        () => finish(err(staleConfiguration('configuration acknowledgement timed out'))),
        30_000,
      );
      this.pending = { id, world, revision: plan.revision, finish };
      try {
        send({
          kind: 'configuration-apply',
          requestId: id,
          worldIdentity: world,
          previousRevision,
          plan,
        });
      } catch (cause) {
        finish(
          err(
            new EngineConfigurationError('configuration-stale', {
              path: 'configuration',
              reason: 'configuration transport failed',
              cause,
            }),
          ),
        );
      }
    });
  }

  receive(message: ConfigurationApplyResponse): void {
    const pending = this.pending;
    if (
      pending === undefined ||
      message.requestId !== pending.id ||
      message.worldIdentity !== pending.world ||
      message.revision !== pending.revision
    )
      return;
    pending.finish(
      message.result.ok
        ? ok(undefined)
        : err(new EngineConfigurationError(message.result.error.code, message.result.error.detail)),
    );
  }

  invalidate(reason: string): void {
    this.pending?.finish(err(staleConfiguration(reason)));
  }
  dispose(): void {
    this.closed = true;
    this.invalidate('the configuration channel was disposed');
  }
}

/** Error cloning does not preserve producer-owned fields; publish an explicit data result. */
export function configurationApplyResponse(
  request: ConfigurationApplyRequest,
  result:
    | { readonly ok: true; readonly value: void }
    | { readonly ok: false; readonly error: EngineConfigurationError },
): ConfigurationApplyResponse {
  return {
    kind: 'configuration-result',
    requestId: request.requestId,
    worldIdentity: request.worldIdentity,
    revision: request.plan.revision,
    result: result.ok
      ? { ok: true, value: undefined }
      : {
          ok: false,
          error: {
            code: result.error.code,
            expected: result.error.expected,
            hint: result.error.hint,
            detail: {
              path: result.error.detail.path,
              reason: result.error.detail.reason,
              ...(result.error.detail.cause === undefined
                ? {}
                : { cause: serializableDetail(result.error.detail.cause) }),
            },
          },
        },
  };
}

/** Assembly-private extension. Public callers configure through App.configuration. */
export interface ConfiguredExecutionControl extends ExecutionControl {
  applyConfiguration(
    plan: EngineStartupPlan,
    previousRevision: number,
  ): Promise<Result<void, EngineConfigurationError>>;
}
