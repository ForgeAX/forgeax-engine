export const RECONNECT_TARGET_ID: 'multiplayer-snake-reconnect';
export const RECONNECT_VIEWPORT: Readonly<{ width: number; height: number }>;
export const RECONNECT_EXPECTATIONS: readonly [
  { readonly id: 'authority-derived-convergence'; readonly statement: string },
  { readonly id: 'continued-browser-operation'; readonly statement: string },
];

export interface ReconnectValidationFailure {
  readonly code: string;
  readonly expectationId?: string;
}

export interface ReconnectValidationResult {
  readonly ok: boolean;
  readonly failures: readonly ReconnectValidationFailure[];
}

export function validateReconnectTrace(trace: unknown): ReconnectValidationResult;
export function validateReconnectVisualReport(report: unknown): ReconnectValidationResult;
