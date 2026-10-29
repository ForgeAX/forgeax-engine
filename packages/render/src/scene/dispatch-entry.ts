import type { DispatchEntry } from '../render-system-extract';

/** The per-draw fields an entry adds to its shared Pass description. */
type PassFields = Omit<DispatchEntry, 'entityIndex' | 'renderableIndex' | 'layer'> & {
  readonly layer?: number;
};

const KNOWN = new Set<string>([
  'entityIndex',
  'materialHandle',
  'renderableIndex',
  'passIndex',
  'queue',
  'layer',
  'tags',
  'renderState',
  'defines',
  'vertexEntry',
  'fragmentEntry',
  'materialShaderId',
  'stencilReference',
]);
const plainPasses = new WeakMap<object, boolean>();

function onlyEntryFields(source: object): boolean {
  for (const key in source) if (!KNOWN.has(key)) return false;
  return true;
}

/**
 * One fixed-shape entry literal: every field sits in-object, instead of the
 * separate property store a spread of the Pass description allocates.
 */
function entry(
  pass: PassFields,
  entityIndex: number,
  renderableIndex: number,
  layer: number,
): DispatchEntry {
  const stencilReference = pass.stencilReference;
  return stencilReference === undefined
    ? {
        entityIndex,
        materialHandle: pass.materialHandle,
        renderableIndex,
        passIndex: pass.passIndex,
        queue: pass.queue,
        layer,
        tags: pass.tags,
        renderState: pass.renderState,
        defines: pass.defines,
        vertexEntry: pass.vertexEntry,
        fragmentEntry: pass.fragmentEntry,
        materialShaderId: pass.materialShaderId,
      }
    : {
        entityIndex,
        materialHandle: pass.materialHandle,
        renderableIndex,
        passIndex: pass.passIndex,
        queue: pass.queue,
        layer,
        tags: pass.tags,
        renderState: pass.renderState,
        defines: pass.defines,
        vertexEntry: pass.vertexEntry,
        fragmentEntry: pass.fragmentEntry,
        materialShaderId: pass.materialShaderId,
        stencilReference,
      };
}

/** Bind a Pass description to one draw: entity, frame address and layer. */
export function dispatchEntry(
  pass: PassFields,
  entityIndex: number,
  renderableIndex: number,
  layer: number,
): DispatchEntry {
  let plain = plainPasses.get(pass);
  if (plain === undefined) {
    plain = onlyEntryFields(pass);
    plainPasses.set(pass, plain);
  }
  return plain
    ? entry(pass, entityIndex, renderableIndex, layer)
    : ({ ...pass, entityIndex, renderableIndex, layer } as DispatchEntry);
}

/** The same draw at another frame address. */
export function withRenderableIndex(source: DispatchEntry, renderableIndex: number): DispatchEntry {
  return onlyEntryFields(source)
    ? entry(source, source.entityIndex, renderableIndex, source.layer)
    : { ...source, renderableIndex };
}
