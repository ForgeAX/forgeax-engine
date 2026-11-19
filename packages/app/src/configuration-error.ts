export type EngineConfigurationErrorCode =
  | 'configuration-domain-unavailable'
  | 'configuration-invalid'
  | 'configuration-profile-missing'
  | 'configuration-inheritance-cycle'
  | 'configuration-match-ambiguous'
  | 'configuration-constraint-conflict'
  | 'configuration-recreate-required'
  | 'configuration-stale';

/** Configuration failures are data; producer failures retain their original cause. */
export class EngineConfigurationError extends Error {
  readonly expected: string;
  readonly hint: string;
  constructor(
    readonly code: EngineConfigurationErrorCode,
    readonly detail: { readonly path: string; readonly reason: string; readonly cause?: unknown },
  ) {
    super(`${code}: ${detail.path}: ${detail.reason}`);
    this.name = 'EngineConfigurationError';
    this.expected = 'a valid, unambiguous engine configuration accepted before construction';
    this.hint =
      code === 'configuration-recreate-required'
        ? 'recreate the affected owner with the requested constructor settings'
        : `repair ${detail.path} and retry the configuration request`;
  }
}
