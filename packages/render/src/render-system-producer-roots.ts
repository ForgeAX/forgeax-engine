export type RendererProducerRootKind =
  | 'backend-surface'
  | 'shader-material-pipeline'
  | 'mesh-texture-sampler'
  | 'render-scene'
  | 'gpu-driven'
  | 'feature'
  | 'external-source'
  | 'render-graph'
  | 'target-history'
  | 'observation-lease';

export interface RendererProducerRoot {
  readonly kind: RendererProducerRootKind;
  readonly owner: string;
  readonly candidateScope: 'device-scope';
  readonly visibility: 'visible-workset' | 'non-visible-lazy';
  readonly disabledWork: 'zero' | 'lazy';
}

const PRODUCER_ROOT_MATRIX: readonly RendererProducerRoot[] = Object.freeze([
  {
    kind: 'backend-surface',
    owner: 'backend-surface-owner',
    candidateScope: 'device-scope',
    visibility: 'visible-workset',
    disabledWork: 'zero',
  },
  {
    kind: 'shader-material-pipeline',
    owner: 'shader-material-pipeline-owner',
    candidateScope: 'device-scope',
    visibility: 'visible-workset',
    disabledWork: 'zero',
  },
  {
    kind: 'mesh-texture-sampler',
    owner: 'gpu-residency',
    candidateScope: 'device-scope',
    visibility: 'visible-workset',
    disabledWork: 'lazy',
  },
  {
    kind: 'render-scene',
    owner: 'persistent-render-scene',
    candidateScope: 'device-scope',
    visibility: 'visible-workset',
    disabledWork: 'zero',
  },
  {
    kind: 'gpu-driven',
    owner: 'gpu-driven-production',
    candidateScope: 'device-scope',
    visibility: 'visible-workset',
    disabledWork: 'zero',
  },
  {
    kind: 'feature',
    owner: 'render-feature-host',
    candidateScope: 'device-scope',
    visibility: 'visible-workset',
    disabledWork: 'lazy',
  },
  {
    kind: 'external-source',
    owner: 'external-source-owner',
    candidateScope: 'device-scope',
    visibility: 'non-visible-lazy',
    disabledWork: 'zero',
  },
  {
    kind: 'render-graph',
    owner: 'typed-frame-graph',
    candidateScope: 'device-scope',
    visibility: 'visible-workset',
    disabledWork: 'zero',
  },
  {
    kind: 'target-history',
    owner: 'temporal-target-owner',
    candidateScope: 'device-scope',
    visibility: 'visible-workset',
    disabledWork: 'zero',
  },
  {
    kind: 'observation-lease',
    owner: 'render-observation-owner',
    candidateScope: 'device-scope',
    visibility: 'non-visible-lazy',
    disabledWork: 'zero',
  },
]);

export function createRendererProducerRootMatrix(): readonly RendererProducerRoot[] {
  return PRODUCER_ROOT_MATRIX;
}
