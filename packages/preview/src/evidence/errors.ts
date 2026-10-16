import type { JsonValue, ToolRecoveryAction, ToolRuntimeError } from '@forgeax/engine-tool-runtime';

export type ResourcePreviewFailureCode =
  | 'resource-preview-kind-mismatch'
  | 'resource-preview-subject-invalid'
  | 'resource-preview-oracle-failed';

export interface ResourcePreviewFailure {
  readonly code: ResourcePreviewFailureCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, JsonValue>>;
}

export interface ResourcePreviewRecovery {
  readonly failure: ResourcePreviewFailure;
  readonly suggestedOperation?: string;
  readonly actions: readonly ToolRecoveryAction[];
}

function isResourcePreviewFailureCode(value: string): value is ResourcePreviewFailureCode {
  return (
    value === 'resource-preview-kind-mismatch' ||
    value === 'resource-preview-subject-invalid' ||
    value === 'resource-preview-oracle-failed'
  );
}

function isRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function suggestedOperation(payload: Readonly<Record<string, JsonValue>>): string | undefined {
  const actualKind = payload.actualKind;
  if (
    actualKind !== 'material' &&
    actualKind !== 'mesh' &&
    actualKind !== 'vfx' &&
    actualKind !== 'texture'
  )
    return undefined;
  return `${actualKind}.preview`;
}

function exhaustive(value: never): never {
  throw new Error(`unhandled resource preview failure: ${String(value)}`);
}

export function describeResourcePreviewFailure(
  failure: ToolRuntimeError,
): ResourcePreviewRecovery | undefined {
  if (failure.code !== 'tool-domain-failed') return undefined;
  const code = failure.detail.code;
  if (!isResourcePreviewFailureCode(code)) return undefined;
  const detail = isRecord(failure.detail.payload) ? failure.detail.payload : {};
  const base: ResourcePreviewFailure = {
    code,
    expected: failure.expected,
    hint: failure.hint,
    detail,
  };
  switch (code) {
    case 'resource-preview-kind-mismatch': {
      const operation = suggestedOperation(detail);
      return {
        failure: base,
        ...(operation === undefined ? {} : { suggestedOperation: operation }),
        actions: [
          ...(operation === undefined
            ? []
            : [
                {
                  action: 'switch-operation' as const,
                  operation,
                  hint: 'Run the suggested operation for the loaded asset kind.',
                },
              ]),
          {
            action: 'repair-owner',
            hint: 'Repair the asset owner kind facts and reload the GUID.',
          },
          {
            action: 'stop',
            hint: 'Stop when the GUID does not belong to a supported preview kind.',
          },
        ],
      };
    }
    case 'resource-preview-subject-invalid':
      return {
        failure: base,
        actions: [
          {
            action: 'repair-owner',
            hint: 'Repair the owner facts or recook the subject, then retry.',
          },
          {
            action: 'retry',
            hint: 'Retry the same operation after the producer publishes a new digest.',
          },
          { action: 'stop', hint: 'Stop when the owner cannot produce a valid subject.' },
        ],
      };
    case 'resource-preview-oracle-failed':
      return {
        failure: base,
        actions: [
          {
            action: 'inspect-evidence',
            hint: 'Inspect the report and RHI diagnostics before retrying.',
          },
          {
            action: 'retry',
            hint: 'Retry only after the renderer or binding producer is repaired.',
          },
          {
            action: 'stop',
            hint: 'Stop publication when fresh evidence still falsifies the oracle.',
          },
        ],
      };
  }
  return exhaustive(code);
}
