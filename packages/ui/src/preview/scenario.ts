import type { UiResult } from '../errors.js';
import { uiError } from '../errors.js';
import type {
  UiPreviewScenario,
  UiPreviewScenarioContext,
  UiPreviewScenarioReady,
} from './session.js';

export interface DomPartScenarioOptions {
  readonly requiredParts: readonly string[];
  readonly prepare?: (
    context: UiPreviewScenarioContext,
    parts: Readonly<Record<string, Element>>,
  ) => UiResult<UiPreviewScenarioReady> | Promise<UiResult<UiPreviewScenarioReady>>;
}

/** Build a small development-time scenario from the public data-ui-part seam. */
export function createDomPartScenario(options: DomPartScenarioOptions): UiPreviewScenario {
  return {
    requiredParts: options.requiredParts,
    async prepare(context) {
      const shadow = context.instance.host.shadowRoot;
      if (!shadow) return uiError('preview-scenario-failed', 'mounted UI has no open shadow root');
      const parts: Record<string, Element> = {};
      for (const name of options.requiredParts) {
        const selectorName = name.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
        const part = shadow.querySelector(`[data-ui-part="${selectorName}"]`);
        if (!part)
          return uiError('preview-scenario-missing-part', `missing required UI part: ${name}`);
        parts[name] = part;
      }
      context.signal.addEventListener(
        'abort',
        () => {
          for (const part of Object.values(parts)) part.removeAttribute('data-ui-scenario-ready');
        },
        { once: true },
      );
      for (const part of Object.values(parts)) part.setAttribute('data-ui-scenario-ready', 'true');
      if (options.prepare) return options.prepare(context, parts);
      return { ok: true, value: { parts, ready: true } };
    },
  };
}
