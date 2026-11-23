export interface ViewportHitRequest {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly afterFrameId: number;
  readonly worldIdentity: string;
  readonly deviceGeneration: number;
}

type SampledViewportHit = {
  readonly frameId: number;
  readonly publicationRevision?: number;
};

export type ViewportHitResult =
  | ({ readonly kind: 'hit'; readonly entity: number } & SampledViewportHit)
  | ({ readonly kind: 'miss'; readonly entity: null } & SampledViewportHit)
  | {
      readonly kind: 'unavailable';
      readonly detail?: {
        readonly entity: number;
        readonly shader: string | undefined;
        readonly entryPoint: string | undefined;
        readonly effects: import('@forgeax/engine-types').ShaderEntryPointEffects | undefined;
      };
      readonly reason:
        | 'backend'
        | 'geometry-coverage'
        | 'material-coverage'
        | 'gpu-driven-draws'
        | 'hit-pass'
        | 'invalid-pixel'
        | 'no-ready-frame'
        | 'readback-timeout'
        | 'render-not-ready'
        | 'renderer'
        | 'shader-preparation'
        | 'shader-preparation-timeout'
        | 'transport'
        | 'view-coverage'
        | 'view-mapping'
        | 'view-resolution';
    }
  | {
      readonly kind: 'stale';
      readonly reason:
        | 'cancelled'
        | 'device-generation'
        | 'frame-identity'
        | 'render-session'
        | 'renderer'
        | 'session-ended'
        | 'superseded-request'
        | 'viewport-extent'
        | 'world-or-request';
    };
