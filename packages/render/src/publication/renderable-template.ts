import type { RenderableSnapshot } from '../render-system-extract';
import type { RenderPublicationTemplate } from './contract';

/** Remove row-local identities and replace live material resources with wire IDs. */
export function renderableTemplateSnapshot(
  row: RenderableSnapshot,
  references: {
    readonly material: number;
    readonly materials: readonly number[];
    readonly overrides: readonly number[] | undefined;
  },
): RenderPublicationTemplate['snapshot'] {
  const {
    entityKey: _entity,
    transform: _transform,
    material: _material,
    materials: _materials,
    materialOverrides: _overrides,
    ...content
  } = row;
  return {
    ...content,
    material: references.material,
    materials: references.materials,
    ...(references.overrides === undefined ? {} : { materialOverrides: references.overrides }),
  };
}
