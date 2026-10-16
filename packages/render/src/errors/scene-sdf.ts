export type SceneSdfUnavailableReason =
  | 'invalid-range'
  | 'missing-source'
  | 'missing-field'
  | 'invalid-field'
  | 'unsupported-geometry'
  | 'budget'
  | 'capability'
  | 'preparing';

export class SceneSdfUnavailableError extends Error {
  readonly code = 'scene-sdf-unavailable' as const;
  readonly expected = 'a current geometric field for the complete requested World and range';
  readonly hint =
    'inspect detail, cook the same Mesh GUID with a geometric distance-field policy, or recover the named producer';
  readonly detail: {
    readonly reason: SceneSdfUnavailableReason;
    readonly world: number;
    readonly entity?: number;
    readonly cause?: unknown;
  };
  constructor(detail: SceneSdfUnavailableError['detail']) {
    super(`Scene SDF unavailable: ${detail.reason}`);
    this.name = 'SceneSdfUnavailableError';
    this.detail = detail;
  }
}
