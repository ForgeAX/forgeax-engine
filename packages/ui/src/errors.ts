import type { ImportDiagnostic } from '@forgeax/engine-types';

export type UiError =
  | {
      readonly code: 'inspection-failed';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly cause?: unknown };
    }
  | {
      readonly code: 'ui-resource-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: {
        readonly message: string;
        readonly cause?: unknown;
        readonly guid: string;
        readonly sourcePath: string;
        readonly reference: string;
        readonly reason: string;
      };
    }
  | {
      readonly code: 'invalid-environment';
      readonly expected: string;
      readonly hint: string;
      readonly detail: {
        readonly message: string;
        readonly environment: string;
        readonly diagnostics?: readonly ImportDiagnostic[];
      };
    }
  | {
      readonly code: 'invalid-root';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly root: string };
    }
  | {
      readonly code: 'invalid-asset';
      readonly expected: string;
      readonly hint: string;
      readonly detail: {
        readonly message: string;
        readonly asset: string;
        readonly diagnostics?: readonly ImportDiagnostic[];
      };
    }
  | {
      readonly code: 'invalid-layer';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly layer: number };
    }
  | {
      readonly code: 'invalid-preview-rect';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly rect: string };
    }
  | {
      readonly code: 'preview-invalid-transition' | 'preview-disposed' | 'preview-stale-completion';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly state: string };
    }
  | {
      readonly code: 'preview-load-failed';
      readonly expected: string;
      readonly hint: string;
      readonly detail: {
        readonly message: string;
        readonly guid: string;
        readonly diagnostics?: readonly ImportDiagnostic[];
      };
    }
  | {
      readonly code: 'preview-scenario-failed';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly scenario: string };
    }
  | {
      readonly code: 'preview-scenario-missing-part';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly part: string };
    }
  | {
      readonly code: 'preview-scenario-timeout';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly timeoutMs: number };
    }
  | {
      readonly code: 'capture-not-ready';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly unmet: readonly string[] };
    }
  | {
      readonly code: 'capture-failed';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly stage: string };
    };
export type UiErrorCode = UiError['code'];
export type UiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: UiError };

const uiErrorPolicy = {
  'inspection-failed': {
    expected: 'a live UI root and matching document reader',
    hint: 'Use the current Host or Preview root and inspect the original failure.',
  },
  'ui-resource-invalid': {
    expected: 'a declared UI companion',
    hint: 'Reload the owning UI publication and use a live instance.',
  },
  'invalid-environment': {
    expected: 'a UI document with standard AbortController support',
    hint: 'Prepare the browser or native UI document before mounting.',
  },
  'invalid-root': {
    expected: 'an HTMLElement root owned by the caller',
    hint: 'Provide an HTMLElement root owned by the caller.',
  },
  'invalid-asset': {
    expected: 'a UiAsset with non-empty guid, html, and css strings',
    hint: 'Load a UiAsset with non-empty guid, html, and css strings.',
  },
  'invalid-layer': {
    expected: 'a non-negative integer layer',
    hint: 'Layer must be a non-negative integer.',
  },
  'invalid-preview-rect': {
    expected: 'a finite preview rectangle with positive width and height',
    hint: 'Provide finite x/y values and positive width/height.',
  },
  'preview-invalid-transition': {
    expected: 'a legal preview session state transition',
    hint: 'Call the operation from its documented session state.',
  },
  'preview-disposed': {
    expected: 'a preview session that has not been disposed',
    hint: 'Create a new preview session after disposal.',
  },
  'preview-stale-completion': {
    expected: 'the current preview generation',
    hint: 'Ignore stale async work and await the current generation.',
  },
  'preview-load-failed': {
    expected: 'the preview GUID to load successfully',
    hint: 'Repair the imported asset, then call retry().',
  },
  'preview-scenario-failed': {
    expected: 'the scenario prepare hook to complete successfully',
    hint: 'Fix the scenario prepare hook before retrying.',
  },
  'preview-scenario-missing-part': {
    expected: 'all parts declared by the scenario',
    hint: 'Restore the required data-ui-part element before retrying.',
  },
  'preview-scenario-timeout': {
    expected: 'the scenario to report ready before its timeout',
    hint: 'Make scenario.prepare resolve ready or increase scenarioTimeoutMs.',
  },
  'capture-not-ready': {
    expected: 'all capture readiness gates to be satisfied',
    hint: 'Satisfy every reported readiness fact, then capture again.',
  },
  'capture-failed': {
    expected: 'the browser screenshot operation to succeed',
    hint: 'Inspect the reported capture stage and retry in the same browser.',
  },
} satisfies Record<UiErrorCode, { expected: string; hint: string }>;

function detailFor(code: UiErrorCode, message: string): UiError['detail'] {
  switch (code) {
    case 'inspection-failed':
      return { message };
    case 'invalid-environment':
      return { message, environment: 'UI document' };
    case 'invalid-root':
      return { message, root: 'HTMLElement' };
    case 'invalid-layer':
      return { message, layer: -1 };
    case 'invalid-preview-rect':
      return { message, rect: 'preview rect' };
    case 'preview-invalid-transition':
    case 'preview-disposed':
    case 'preview-stale-completion':
      return { message, state: 'preview session' };
    case 'preview-load-failed':
      return { message, guid: 'preview GUID' };
    case 'preview-scenario-failed':
      return { message, scenario: 'preview scenario' };
    case 'preview-scenario-missing-part':
      return { message, part: 'required part' };
    case 'preview-scenario-timeout':
      return { message, timeoutMs: 0 };
    case 'capture-not-ready':
      return { message, unmet: [] };
    case 'capture-failed':
      return { message, stage: 'screenshot' };
    case 'ui-resource-invalid':
      return { message, guid: '', sourcePath: '', reference: '', reason: message };
    case 'invalid-asset':
      return { message, asset: 'UiAsset' };
  }
}

export function uiError(code: UiErrorCode, detail: string): UiResult<never> {
  const narrowedDetail = detailFor(code, detail);
  const policy = uiErrorPolicy[code];
  return {
    ok: false,
    error: {
      code,
      expected: policy.expected,
      hint: policy.hint,
      detail: narrowedDetail,
    } as UiError,
  };
}

export function uiInspectionFailed(cause: unknown): UiResult<never> {
  return {
    ok: false,
    error: {
      code: 'inspection-failed',
      ...uiErrorPolicy['inspection-failed'],
      detail: { message: cause instanceof Error ? cause.message : String(cause), cause },
    },
  };
}

export function uiPreviewLoadFailed(
  message: string,
  guid: string,
  diagnostics?: readonly ImportDiagnostic[],
): UiResult<never> {
  const result = uiError('preview-load-failed', message);
  if (result.ok) return result;
  const baseError = result.error as Extract<UiError, { code: 'preview-load-failed' }>;
  return {
    ok: false,
    error: {
      ...baseError,
      detail: {
        message,
        guid,
        ...(diagnostics === undefined ? {} : { diagnostics }),
      },
    },
  };
}
