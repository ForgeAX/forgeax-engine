import { err, ok, type Result } from '@forgeax/engine-types';
import { EngineConfigurationError, resolveEngineStartup } from './configuration';
import { ownConfigurationData } from './configuration-data';
import type {
  EngineConfigurationDefinition,
  EngineConfigurationStore,
  EngineStartupPlan,
  QualitySelection,
} from './configuration-types';

export interface EngineConfigurationInspection {
  readonly requested: EngineStartupPlan;
  /** Parameters accepted by the domain owners; rendering still requires picture receipts. */
  readonly applied: EngineStartupPlan;
  readonly pendingRestart?: EngineStartupPlan;
  readonly rendering: { readonly submittedRevision?: number; readonly completedRevision?: number };
  readonly failure?: EngineConfigurationError;
}

export interface EngineConfigurationControl {
  inspect(): EngineConfigurationInspection;
  setQuality(
    selection: QualitySelection,
  ): Promise<Result<EngineStartupPlan, EngineConfigurationError>>;
}

export interface EngineConfigurationFrame {
  readonly configurationRevision?: number;
  readonly presentation?: 'ready' | 'pending' | 'ui-only';
}

/** Serial requests do not publish a revision until its real owner accepts the entire hot slice. */
export function createEngineConfigurationControl(
  definition: EngineConfigurationDefinition,
  startup: EngineStartupPlan,
  target: {
    apply(plan: EngineStartupPlan): Promise<Result<void, EngineConfigurationError>>;
    readonly store?: EngineConfigurationStore;
  },
): EngineConfigurationControl & {
  observe(kind: 'submitted' | 'completed', frame: EngineConfigurationFrame): void;
  dispose(): void;
} {
  // Re-resolve owns the caller's definition, so later object mutation cannot change recovery.
  const owned = structuredClone(definition);
  let requested = startup;
  let applied = startup;
  let pendingRestart: EngineStartupPlan | undefined;
  let failure: EngineConfigurationError | undefined;
  let submittedRevision: number | undefined;
  let completedRevision: number | undefined;
  let disposed = false;
  let queue = Promise.resolve();
  const inspect = (): EngineConfigurationInspection =>
    Object.freeze({
      requested,
      applied,
      ...(pendingRestart === undefined ? {} : { pendingRestart }),
      rendering: Object.freeze({
        ...(submittedRevision === undefined ? {} : { submittedRevision }),
        ...(completedRevision === undefined ? {} : { completedRevision }),
      }),
      ...(failure === undefined ? {} : { failure }),
    });
  const stale = () =>
    new EngineConfigurationError('configuration-stale', {
      path: 'quality',
      reason: 'the owning App has been disposed',
    });
  return {
    inspect,
    dispose() {
      disposed = true;
    },
    observe(kind, frame) {
      if (
        disposed ||
        frame.presentation !== 'ready' ||
        frame.configurationRevision !== applied.revision
      )
        return;
      if (kind === 'submitted') submittedRevision = frame.configurationRevision;
      else completedRevision = frame.configurationRevision;
    },
    setQuality(selection) {
      let snapshot: QualitySelection;
      try {
        snapshot = ownConfigurationData(selection, 'quality') as QualitySelection;
      } catch (cause) {
        return Promise.resolve(
          err(
            cause instanceof EngineConfigurationError
              ? cause
              : new EngineConfigurationError('configuration-invalid', {
                  path: 'quality',
                  reason: 'quality request could not be copied',
                  cause,
                }),
          ),
        );
      }
      let complete!: (result: Result<EngineStartupPlan, EngineConfigurationError>) => void;
      const result = new Promise<Result<EngineStartupPlan, EngineConfigurationError>>((resolve) => {
        complete = resolve;
      });
      queue = queue
        .then(async () => {
          if (disposed) {
            complete(err(stale()));
            return;
          }
          const resolved = resolveEngineStartup(
            owned,
            startup.facts,
            snapshot,
            requested.revision + 1,
          );
          if (!resolved.ok) {
            complete(resolved);
            return;
          }
          requested = resolved.value;
          failure = undefined;
          // Texture residency has no transactional replacement operation yet. Preflight before any setter.
          if (requested.rendering.textureMipSkip !== applied.rendering.textureMipSkip) {
            pendingRestart = requested;
            failure = new EngineConfigurationError('configuration-recreate-required', {
              path: 'quality.groups.textures',
              reason: 'texture residency must be recreated before this request can apply',
            });
            try {
              await target.store?.write(requested.selection);
            } catch (cause) {
              failure = new EngineConfigurationError('configuration-invalid', {
                path: 'configurationHost.store',
                reason: 'the restart preference could not be saved',
                cause,
              });
            }
            complete(err(failure));
            return;
          }
          const accepted = await target.apply(requested);
          if (disposed) {
            complete(err(stale()));
            return;
          }
          if (!accepted.ok) {
            failure = accepted.error;
            complete(accepted);
            return;
          }
          applied = requested;
          try {
            await target.store?.write(applied.selection);
          } catch (cause) {
            failure = new EngineConfigurationError('configuration-invalid', {
              path: 'configurationHost.store',
              reason: 'quality applied but the preference could not be saved',
              cause,
            });
            complete(err(failure));
            return;
          }
          pendingRestart = undefined;
          complete(ok(applied));
        })
        .catch((cause) => {
          failure =
            cause instanceof EngineConfigurationError
              ? cause
              : new EngineConfigurationError('configuration-invalid', {
                  path: 'quality',
                  reason: 'configuration application failed',
                  cause,
                });
          complete(err(failure));
        });
      return result;
    },
  };
}
