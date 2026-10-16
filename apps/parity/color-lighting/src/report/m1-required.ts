import type { SceneCase } from '../contracts/types';
import requiredManifest from '../../cases/default/required.json' with { type: 'json' };

export type M1ColorInputKind =
  | 'scalar-srgb'
  | 'srgb-texture'
  | 'linear-input'
  | 'factor-texture'
  | 'channel-ramp';

export interface M1ColorInput {
  readonly kind: M1ColorInputKind;
  readonly color: readonly [number, number, number, number];
  readonly factor?: readonly [number, number, number, number];
}

export const M1_CASE_INPUTS = requiredManifest.inputs as unknown as Record<string, M1ColorInput>;

export const M1_REQUIRED_CASES = requiredManifest.caseIds.map(
  (caseId) => ({
    caseId,
    required: requiredManifest.required,
    colorDomain: requiredManifest.colorDomain,
    scene: requiredManifest.scene,
    budget: requiredManifest.budget,
  }) as unknown as SceneCase,
);

export const M1_DEFERRED_MATRIX = [
  'webgl2-webkit',
  'urp-hdrp',
  'tone-mapping',
  'material-alpha',
] as const;
