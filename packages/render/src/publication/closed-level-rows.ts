import type { MaterialResource } from '../material-resource';
import { materialSourceReferences } from '../material-source';
import { sameValue } from '../same-value';
import type { PreparedMeshSource } from '../scene/prepared-mesh-source';
import type { RenderPublicationRows, RenderPublicationTemplate } from './contract';
import { renderableTemplateSnapshot } from './renderable-template';

/**
 * Pack the inactive extraction in bounded row batches. Each chunk has a private
 * material ID namespace and is sent independently of the ordinary publisher.
 * Numeric pose columns are independent; other input storage must be cloned
 * by the transport rather than transferred from this held source.
 */
export function* encodeClosedLevelRows(
  input: Pick<PreparedMeshSource, 'renderables' | 'dispatch' | 'isCurrent'>,
  rowsPerChunk: number,
) {
  if (!Number.isSafeInteger(rowsPerChunk) || rowsPerChunk < 1)
    throw new RangeError('Closed Level chunk requires a positive row capacity');
  let dispatchCursor = 0;
  for (let offset = 0; offset < input.renderables.length; offset += rowsPerChunk) {
    if (!input.isCurrent()) throw new Error('Closed Level source changed during publication');
    const count = Math.min(rowsPerChunk, input.renderables.length - offset);
    const transformEntities = new Uint32Array(count);
    const transforms = new Float32Array(count * 16);
    const upserts = new Uint32Array(count * 2);
    const templates: RenderPublicationTemplate[] = [];
    const materials: RenderPublicationRows['materials'][number][] = [];
    const ids = new Map<MaterialResource, number>();
    const materialId = (resource: MaterialResource): number => {
      const known = ids.get(resource);
      if (known !== undefined) return known;
      const id = materials.length + 1;
      const value = resource.snapshot;
      materials.push({
        id,
        value:
          value.sourceAssets === undefined
            ? value
            : { ...value, sourceAssets: materialSourceReferences(value.sourceAssets) },
      });
      ids.set(resource, id);
      return id;
    };
    for (let index = 0; index < count; index++) {
      const sourceIndex = offset + index;
      const row = input.renderables[sourceIndex];
      if (row === undefined) throw new Error('Missing closed Level row');
      const dispatch: RenderPublicationTemplate['dispatch'][number][] = [];
      let next = input.dispatch[dispatchCursor];
      while (next?.renderableIndex === sourceIndex) {
        const { entityIndex: _entity, renderableIndex: _renderable, ...entry } = next;
        dispatch.push(entry);
        dispatchCursor++;
        next = input.dispatch[dispatchCursor];
      }
      upserts[index * 2] = row.entityKey;
      upserts[index * 2 + 1] = index;
      transformEntities[index] = row.entityKey;
      transforms.set(row.transform.world, index * 16);
      templates.push({
        snapshot: renderableTemplateSnapshot(row, {
          material: materialId(row.material),
          materials: row.materials.map(materialId),
          overrides: row.materialOverrides?.map((resource) =>
            resource === undefined ? 0 : materialId(resource),
          ),
        }),
        dispatch,
      });
    }
    if (!input.isCurrent()) throw new Error('Closed Level source changed during publication');
    yield { upserts, transformEntities, transforms, templates, materials };
  }
  // Completion is the source seal boundary. The last transport ACK may have
  // yielded after the last row, and an empty group has no row-level check.
  if (!input.isCurrent()) throw new Error('Closed Level source changed during publication');
  if (dispatchCursor !== input.dispatch.length)
    throw new Error('Closed Level dispatch is outside the prepared row order');
}

/** A repeated receipt still represents the exact immutable received chunk. */
export function sameClosedLevelRows(
  left: RenderPublicationRows,
  right: RenderPublicationRows,
): boolean {
  return sameValue(left, right);
}
