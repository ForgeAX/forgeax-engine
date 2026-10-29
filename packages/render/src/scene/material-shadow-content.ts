import { STANDARD_PIPELINE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import {
  derive,
  type MaterialResourceBindingLayout,
  type ShaderBindingReads,
} from '@forgeax/engine-types';
import type { MaterialResource } from '../material-resource';
import { writeMaterialTextureCoordinateRecord } from '../material-texture-coordinates';
import { type RenderResourceScope, renderAssetRevision } from '../publication/resource-scope';
import { writePbrMaterialUboPayload } from '../record/main-pass-material';
import { MATERIAL_UNIFORM_BYTES, type RenderSystemRuntime } from '../record/render-context';
import type { MaterialSnapshot } from '../render-system-extract';
import { type MaterialFrame, materialPasses } from './material-dispatch';

const numeric = new WeakMap<MaterialSnapshot, Uint8Array>();
function payload(snapshot: MaterialSnapshot): Uint8Array {
  let bytes = snapshot.immutableValues === true ? numeric.get(snapshot) : undefined;
  if (bytes === undefined) {
    const schema = derive(snapshot.materialParamSchema ?? STANDARD_PIPELINE_PARAM_SCHEMA);
    bytes = new Uint8Array(Math.max(MATERIAL_UNIFORM_BYTES, schema.totalBytes));
    const layout = writePbrMaterialUboPayload(bytes, snapshot);
    const floats = new Float32Array(bytes.buffer);
    for (const record of layout.coordinateRecords)
      writeMaterialTextureCoordinateRecord(
        floats,
        record.offset / 4,
        snapshot.textureCoordinates?.get(record.parameter),
      );
    if (snapshot.immutableValues === true) numeric.set(snapshot, bytes);
  }
  return bytes;
}

const contracts = new WeakMap<
  MaterialSnapshot,
  readonly {
    readonly shape: string;
    readonly reads: readonly ShaderBindingReads[] | undefined;
  }[]
>();
/** Structural reads belong to the accepted Pass contract, not a frame probe. */
const NO_RESOURCE_BINDINGS: readonly MaterialResourceBindingLayout[] = Object.freeze([]);
function shadowResourceBindings(
  snapshot: MaterialSnapshot,
): readonly MaterialResourceBindingLayout[] {
  const passes = shadowPasses(snapshot);
  const layout = derive(snapshot.materialParamSchema ?? STANDARD_PIPELINE_PARAM_SCHEMA);
  const resources = layout.resourceBindings;
  // derive emits resource bindings in increasing ABI order. Numeric-only reads
  // before the first resource cannot select one. Sampler-only schemas can start at zero.
  const firstResource = resources[0];
  if (firstResource === undefined) return NO_RESOURCE_BINDINGS;
  if (resources.length === 1) {
    for (const pass of passes) {
      if (pass.reads === undefined) return resources;
      for (const read of pass.reads)
        if (read.group === 1 && read.binding === firstResource.binding) return resources;
    }
    return NO_RESOURCE_BINDINGS;
  }
  let bindings: Set<number> | undefined;
  for (const pass of passes) {
    if (pass.reads === undefined) return resources;
    for (const read of pass.reads) {
      if (read.group !== 1 || read.binding < firstResource.binding) continue;
      bindings ??= new Set<number>();
      bindings.add(read.binding);
    }
  }
  return bindings === undefined
    ? NO_RESOURCE_BINDINGS
    : resources.filter((binding) => bindings.has(binding.binding));
}
function shadowPasses(snapshot: MaterialSnapshot) {
  let contract = contracts.get(snapshot);
  if (contract !== undefined) return contract;
  contract = materialPasses(snapshot)
    .filter((pass) => pass.tags.LightMode === 'ShadowCaster')
    .map((pass) => {
      const authored = snapshot.passes[pass.passIndex];
      const entries =
        authored === undefined ? undefined : snapshot.materialEntryPoints?.[authored.name];
      const vertex = entries?.find(
        (entry) => entry.stage === 'vertex' && entry.name === (pass.vertexEntry ?? 'vs_main'),
      );
      const fragment = entries?.find(
        (entry) => entry.stage === 'fragment' && entry.name === (pass.fragmentEntry ?? 'fs_main'),
      );
      const hasFragment = entries?.some((entry) => entry.stage === 'fragment');
      return {
        shape: JSON.stringify({
          shader: pass.materialShaderId,
          vertex: pass.vertexEntry,
          fragment: pass.fragmentEntry,
          state: pass.renderState,
          defines: pass.defines,
          stencil: pass.stencilReference,
          textureMask: snapshot.standardTextureMask,
        }),
        reads:
          vertex === undefined || (hasFragment && fragment === undefined)
            ? undefined
            : [...vertex.bindings, ...(fragment?.bindings ?? [])],
      };
    });
  contracts.set(snapshot, contract);
  return contract;
}

function sameRead(a: MaterialSnapshot, b: MaterialSnapshot, read: ShaderBindingReads): boolean {
  if (read.group !== 1) return true;
  const layout = derive(a.materialParamSchema ?? STANDARD_PIPELINE_PARAM_SCHEMA);
  const next = derive(b.materialParamSchema ?? STANDARD_PIPELINE_PARAM_SCHEMA);
  if (layout.layoutIdentity !== next.layoutIdentity) return false;
  if (read.binding === 0) {
    const before = payload(a),
      after = payload(b);
    if (read.fields === undefined) return before.every((byte, index) => byte === after[index]);
    for (const name of read.fields) {
      const field = layout.uboLayout.entries.find((entry) => entry.name === name);
      const coordinates =
        field === undefined
          ? layout.coordinateRecords.find(
              (record) =>
                record.transformMember === name ||
                record.metadataMember === name ||
                record.rotationMember === name,
            )
          : undefined;
      const start =
        field !== undefined
          ? field.offset
          : coordinates === undefined
            ? undefined
            : coordinates.offset +
              (coordinates.transformMember === name
                ? 0
                : coordinates.metadataMember === name
                  ? 16
                  : 32);
      if (start === undefined) return false;
      const size = field?.size ?? 16;
      for (let offset = start; offset < start + size; offset++)
        if (before[offset] !== after[offset]) return false;
    }
    return true;
  }
  const resource = layout.resourceBindings.find((resource) => resource.binding === read.binding);
  if (resource === undefined) return false;
  const name = resource.parameter ?? resource.name;
  if (resource.kind === 'sampler')
    return a.samplerHandles?.get(name) === b.samplerHandles?.get(name);
  if (resource.kind === 'texture')
    return (
      a.textureHandles?.get(name) === b.textureHandles?.get(name) &&
      a.textureSources?.get(name) === b.textureSources?.get(name) &&
      a.videoTextureFields?.get(name) === b.videoTextureFields?.get(name)
    );
  return false;
}

/** Numeric fields come from Naga's selected entry, never a shader or parameter name policy. */
export function sameShadowMaterial(
  a: MaterialSnapshot | undefined,
  b: MaterialSnapshot | undefined,
): boolean {
  if (a === b) return true;
  const before = a === undefined ? [] : shadowPasses(a),
    after = b === undefined ? [] : shadowPasses(b);
  if (before.length !== after.length) return false;
  if (before.length === 0) return true;
  if (a === undefined || b === undefined) return false;
  return before.every((pass, index) => {
    const current = after[index];
    return (
      current !== undefined &&
      pass.shape === current.shape &&
      pass.reads !== undefined &&
      current.reads !== undefined &&
      pass.reads.every((read) => sameRead(a, b, read))
    );
  });
}

const comparisons = new WeakMap<MaterialFrame, WeakMap<MaterialFrame, boolean>>();
/** A material edit visits changed asset roots and their read fields, never caster members. */
export function sameShadowMaterialFrames(
  a: MaterialFrame | undefined,
  b: MaterialFrame | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  let cache = comparisons.get(a);
  const previous = cache?.get(b);
  if (previous !== undefined) return previous;
  let same = true;
  b.changesSince(a, (before, after) => {
    if (same && !sameShadowMaterial(before?.snapshot, after?.snapshot)) same = false;
  });
  if (cache === undefined) {
    cache = new WeakMap();
    comparisons.set(a, cache);
  }
  cache.set(b, same);
  return same;
}

interface ShadowMaterialState {
  readonly snapshot: MaterialSnapshot;
  readonly resources: readonly unknown[];
}

/**
 * Captured while preparing shared shadow work; contains no instance or
 * reverse-consumer index. Row-material batches bind one material per class
 * while each member casts with its own row, so GPU content also witnesses the
 * accepted material frame: any shadow-read edit of a member invalidates it in
 * O(changed materials).
 */
export class ShadowMaterialContent {
  private readonly entries = new Map<
    RenderResourceScope,
    Map<MaterialResource, ShadowMaterialState>
  >();

  constructor(private readonly materials?: MaterialFrame) {}

  add(
    resource: MaterialResource,
    snapshot: MaterialSnapshot,
    scope: RenderResourceScope,
    preparedMaterialTexture?: RenderSystemRuntime['preparedMaterialTexture'],
  ): void {
    let materials = this.entries.get(scope);
    if (materials?.has(resource)) return;
    const passes = shadowPasses(snapshot);
    if (passes.length === 0) return;
    const bindings = shadowResourceBindings(snapshot);
    // The owned fixed MaterialFrame already captures these immutable numeric
    // values. Keep scope membership without recording the same dependency twice.
    if (
      bindings.length === 0 &&
      snapshot.immutableValues === true &&
      this.materials?.get(resource)?.snapshot === snapshot
    ) {
      if (materials === undefined) this.entries.set(scope, new Map());
      return;
    }
    const resources: unknown[] = [];
    for (const binding of bindings) {
      const name = binding.parameter ?? binding.name;
      const prepared = preparedMaterialTexture?.(snapshot, name);
      if (prepared !== undefined) {
        resources.push(prepared);
        continue;
      }
      const handle =
        binding.kind === 'sampler'
          ? snapshot.samplerHandles?.get(name)
          : snapshot.textureHandles?.get(name);
      if (handle !== undefined) resources.push(renderAssetRevision(scope, handle));
      // Host/target/video sources have their own frame publication. Without a
      // fixed source witness, this shared depth work is deliberately not retained.
      if (snapshot.textureSources?.has(name) || snapshot.videoTextureFields?.has(name))
        resources.push({});
    }
    if (materials === undefined) {
      materials = new Map();
      this.entries.set(scope, materials);
    }
    materials.set(resource, { snapshot, resources });
  }

  same(previous: ShadowMaterialContent | undefined): boolean {
    if (previous === this) return true;
    if (previous === undefined || previous.entries.size !== this.entries.size) return false;
    if (
      (previous.materials === undefined) !== (this.materials === undefined) ||
      !sameShadowMaterialFrames(previous.materials, this.materials)
    )
      return false;
    // Runs for every shadow cache probe each frame: key iteration plus lookup
    // and indexed resource loops allocate no entry tuples or callbacks.
    for (const scope of this.entries.keys()) {
      const materials = this.entries.get(scope) as Map<MaterialResource, ShadowMaterialState>;
      const old = previous.entries.get(scope);
      if (old === undefined || old.size !== materials.size) return false;
      for (const material of materials.keys()) {
        const state = materials.get(material) as ShadowMaterialState;
        const before = old.get(material);
        if (
          before === undefined ||
          !sameShadowMaterial(before.snapshot, state.snapshot) ||
          before.resources.length !== state.resources.length
        )
          return false;
        for (let index = 0; index < state.resources.length; index++)
          if (state.resources[index] !== before.resources[index]) return false;
      }
    }
    return true;
  }
}
