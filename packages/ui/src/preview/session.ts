import type { ImportError } from '@forgeax/engine-types';
import type { UiAsset, UiInstance } from '../asset.js';
import type { UiError, UiResult } from '../errors.js';
import { uiError, uiPreviewLoadFailed } from '../errors.js';
import { mountUi } from '../mount.js';

export interface UiPreviewRect {
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
}

export interface UiPreviewAssetSource {
  readonly invalidate: (guid: string) => void;
  readonly loadByGuid: (guid: string) => Promise<UiPreviewAssetLoadResult>;
}

export type UiPreviewAssetLoadResult =
  | UiResult<UiAsset>
  | { readonly ok: false; readonly error: ImportError };

export interface UiPreviewScenarioReady {
  readonly parts: Readonly<Record<string, Element>>;
  readonly ready: true;
}

export interface UiPreviewScenarioContext {
  readonly instance: UiInstance;
  readonly signal: AbortSignal;
}

export interface UiPreviewScenario {
  readonly requiredParts: readonly string[];
  readonly prepare: (
    context: UiPreviewScenarioContext,
  ) => UiResult<UiPreviewScenarioReady> | Promise<UiResult<UiPreviewScenarioReady>>;
}

export interface UiPreviewAssetChanged {
  readonly guids: readonly string[];
  readonly sourcePath: string;
  readonly revision: number;
}

export type UiPreviewAssetChangeSubscription = (
  listener: (change: UiPreviewAssetChanged) => Promise<UiResult<UiInstance | null>>,
) => () => void;

export type UiPreviewState = 'loading' | 'mounted' | 'rebuilding' | 'failed' | 'disposed';

export interface UiPreviewSessionOptions {
  readonly guid: string;
  readonly assets: UiPreviewAssetSource;
  readonly root: HTMLElement;
  readonly rect: UiPreviewRect;
  readonly layer?: number;
  readonly onAction?: (name: string, event: Event) => void;
  readonly scenario?: UiPreviewScenario;
  readonly scenarioTimeoutMs?: number;
}

export interface UiPreviewSession {
  readonly guid: string;
  readonly state: UiPreviewState;
  readonly instance: UiInstance | null;
  open(): Promise<UiResult<UiInstance>>;
  rebuild(): Promise<UiResult<UiInstance>>;
  retry(): Promise<UiResult<UiInstance>>;
  handleAssetChanged(change: UiPreviewAssetChanged): Promise<UiResult<UiInstance | null>>;
  subscribeToAssetChanges(subscribe: UiPreviewAssetChangeSubscription): () => void;
  dispose(): UiResult<void>;
}

function error(code: UiError['code'], message: string): UiResult<never> {
  return uiError(code, message);
}

function loadFailureMessage(loadError: UiError | ImportError): string {
  if ('message' in loadError.detail) return loadError.detail.message;
  if (loadError instanceof Error) return loadError.message;
  return 'preview asset failed to load';
}

function validRect(rect: UiPreviewRect): boolean {
  return (
    Number.isFinite(rect.x ?? 0) &&
    Number.isFinite(rect.y ?? 0) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function applyRect(instance: UiInstance, rect: UiPreviewRect): void {
  const style = instance.host.style;
  style.inset = 'auto';
  style.left = `${rect.x ?? 0}px`;
  style.top = `${rect.y ?? 0}px`;
  style.width = `${rect.width}px`;
  style.height = `${rect.height}px`;
}

async function prepareScenario(
  scenario: UiPreviewScenario,
  instance: UiInstance,
  timeoutMs: number,
): Promise<UiResult<UiPreviewScenarioReady>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = Promise.resolve(scenario.prepare({ instance, signal: instance.signal }));
    const timeout = new Promise<UiResult<UiPreviewScenarioReady>>((resolve) => {
      timer = setTimeout(
        () =>
          resolve(
            error(
              'preview-scenario-timeout',
              `scenario did not become ready within ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      );
    });
    const result = await Promise.race([pending, timeout]);
    if (!result.ok) return result;
    for (const part of scenario.requiredParts) {
      if (!(part in result.value.parts) || !result.value.parts[part]) {
        return error(
          'preview-scenario-missing-part',
          `scenario did not provide required part: ${part}`,
        );
      }
    }
    if (!result.value.ready)
      return error('preview-scenario-failed', 'scenario did not report ready');
    return result;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return error('preview-scenario-failed', message);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createUiPreviewSession(options: UiPreviewSessionOptions): UiPreviewSession {
  let state: UiPreviewState = 'loading';
  let current: UiInstance | null = null;
  let generation = 0;
  const timeoutMs = options.scenarioTimeoutMs ?? 5000;
  const unsubscribers: Array<() => void> = [];

  const run = async (token: number): Promise<UiResult<UiInstance>> => {
    if (token !== generation)
      return error('preview-stale-completion', 'an older preview generation completed');
    if (typeof document === 'undefined' || typeof AbortController === 'undefined') {
      state = 'failed';
      return error('invalid-environment', 'DOM APIs are unavailable');
    }
    if (!(options.root instanceof HTMLElement)) {
      state = 'failed';
      return error('invalid-root', 'root is not an HTMLElement');
    }
    if (!validRect(options.rect)) {
      state = 'failed';
      return error('invalid-preview-rect', 'rect width and height must be positive finite numbers');
    }
    const loaded = await options.assets.loadByGuid(options.guid);
    if (token !== generation)
      return error('preview-stale-completion', 'an older preview generation completed');
    if (!loaded.ok) {
      state = 'failed';
      const message = loadFailureMessage(loaded.error);
      const diagnostics =
        'diagnostics' in loaded.error.detail ? loaded.error.detail.diagnostics : undefined;
      return uiPreviewLoadFailed(message, options.guid, diagnostics);
    }
    const mountOptions = options.onAction
      ? { root: options.root, layer: options.layer ?? 0, onAction: options.onAction }
      : { root: options.root, layer: options.layer ?? 0 };
    const mounted = mountUi(loaded.value, mountOptions);
    if (!mounted.ok) {
      state = 'failed';
      return mounted;
    }
    const instance = mounted.value;
    applyRect(instance, options.rect);
    if (token !== generation) {
      instance.dispose();
      return error('preview-stale-completion', 'an older preview generation completed');
    }
    if (options.scenario) {
      const prepared = await prepareScenario(options.scenario, instance, timeoutMs);
      if (token !== generation) {
        instance.dispose();
        return error('preview-stale-completion', 'an older preview generation completed');
      }
      if (!prepared.ok) {
        instance.dispose();
        state = 'failed';
        return prepared;
      }
    }
    current = instance;
    state = 'mounted';
    return { ok: true, value: instance };
  };

  const session: UiPreviewSession = {
    guid: options.guid,
    get state() {
      return state;
    },
    get instance() {
      return current;
    },
    async open() {
      if (state === 'disposed') return error('preview-disposed', 'preview session is disposed');
      if (state === 'mounted' && current) return { ok: true, value: current };
      if (state !== 'loading')
        return error('preview-invalid-transition', `open is not valid from ${state}`);
      const token = ++generation;
      return run(token);
    },
    async rebuild() {
      if (state === 'disposed') return error('preview-disposed', 'preview session is disposed');
      if (
        state !== 'loading' &&
        state !== 'mounted' &&
        state !== 'failed' &&
        state !== 'rebuilding'
      )
        return error('preview-invalid-transition', `rebuild is not valid from ${state}`);
      current?.dispose();
      current = null;
      options.assets.invalidate(options.guid);
      const token = ++generation;
      state = 'rebuilding';
      return run(token);
    },
    async retry() {
      if (state === 'disposed') return error('preview-disposed', 'preview session is disposed');
      if (state !== 'failed')
        return error('preview-invalid-transition', `retry is not valid from ${state}`);
      const token = ++generation;
      state = 'loading';
      return run(token);
    },
    async handleAssetChanged(change) {
      if (state === 'disposed') return error('preview-disposed', 'preview session is disposed');
      const target = options.guid.toLowerCase();
      const matched = change.guids.some((guid) => guid.toLowerCase() === target);
      if (!matched) return { ok: true, value: current };
      const rebuilt = await session.rebuild();
      return rebuilt;
    },
    subscribeToAssetChanges(subscribe) {
      let active = true;
      const unsubscribe = subscribe(async (change) => {
        if (!active || state === 'disposed') return { ok: true, value: current };
        return session.handleAssetChanged(change);
      });
      const stop = (): void => {
        if (!active) return;
        active = false;
        unsubscribe();
        const index = unsubscribers.indexOf(stop);
        if (index >= 0) unsubscribers.splice(index, 1);
      };
      unsubscribers.push(stop);
      return stop;
    },
    dispose() {
      if (state === 'disposed') return { ok: true, value: undefined };
      generation++;
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      current?.dispose();
      current = null;
      state = 'disposed';
      return { ok: true, value: undefined };
    },
  };
  return session;
}
