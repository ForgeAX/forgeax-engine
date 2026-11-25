import { STANDARD_PIPELINE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import {
  derive,
  getAdmittedParamSchemaInterface,
  type MaterialResourceBindingLayout,
  type ShaderBindingReads,
} from '@forgeax/engine-types';
import type { SubmissionPlan } from '../gpu-driven/batch-topology';
import { rowMaterialResource } from '../gpu-driven/row-materials';
import { type MaterialResource, ownedMaterialPassDeclaration } from '../material-resource';
import { writeMaterialTextureCoordinateRecord } from '../material-texture-coordinates';
import { type RenderResourceScope, renderAssetRevision } from '../publication/resource-scope';
import { writePbrMaterialUboPayload } from '../record/main-pass-material';
import { MATERIAL_UNIFORM_BYTES, type RenderSystemRuntime } from '../record/render-context';
import type { MaterialSnapshot } from '../render-system-extract';
import { type MaterialFrame, materialPasses } from './material-dispatch';
import type { PersistentGpuDrivenState } from './render-scene';

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

interface ShadowPass {
  readonly shape: string;
  readonly reads: readonly ShaderBindingReads[] | undefined;
}
interface ShadowPassContract {
  readonly passes: readonly ShadowPass[];
  readonly schema: MaterialSnapshot['materialParamSchema'];
  readonly bindings: readonly MaterialResourceBindingLayout[] | undefined;
}
const contracts = new WeakMap<object, ShadowPassContract>();
const NO_RESOURCE_BINDINGS: readonly MaterialResourceBindingLayout[] = Object.freeze([]);
/** Project reflected shader reads into the schema's physical ABI order. */
function selectShadowBindings(
  passes: readonly ShadowPass[],
  resources: readonly MaterialResourceBindingLayout[],
): readonly MaterialResourceBindingLayout[] {
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
function shadowContract(snapshot: MaterialSnapshot): ShadowPassContract {
  const declaration = ownedMaterialPassDeclaration(snapshot);
  const owner = declaration ?? snapshot;
  const existing = contracts.get(owner);
  if (existing !== undefined) return existing;
  const passes = materialPasses(snapshot)
    .filter((pass) => pass.tags.LightMode === 'ShadowCaster')
    .map((pass) => {
      const authored = snapshot.passes[pass.passIndex];
      const entries =
        authored === undefined
          ? undefined
          : snapshot.materialProgramInputs?.[authored.name]?.entryPoints;
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
  const schema = snapshot.materialParamSchema;
  const admitted =
    declaration === undefined || passes.length === 0
      ? undefined
      : getAdmittedParamSchemaInterface(schema ?? STANDARD_PIPELINE_PARAM_SCHEMA);
  const contract = {
    passes,
    schema,
    bindings:
      admitted === undefined ? undefined : selectShadowBindings(passes, admitted.resourceBindings),
  };
  contracts.set(owner, contract);
  return contract;
}

const LIVE_ATLAS_SOURCE = Symbol('live-shadow-atlas-source');

function shadowBindingVersions(
  snapshot: MaterialSnapshot,
  bindings: readonly MaterialResourceBindingLayout[],
  scope: RenderResourceScope,
  preparedMaterialTexture: RenderSystemRuntime['preparedMaterialTexture'],
  atlasOnly: boolean,
): unknown[] | typeof LIVE_ATLAS_SOURCE | undefined {
  let resources: unknown[] | undefined;
  for (const binding of bindings) {
    const name = binding.parameter ?? binding.name;
    const prepared =
      preparedMaterialTexture?.parameters?.has(name) === false
        ? undefined
        : preparedMaterialTexture?.(snapshot, name);
    if (prepared !== undefined) {
      resources ??= [];
      resources.push(prepared);
      continue;
    }
    const handle =
      binding.kind === 'sampler'
        ? snapshot.samplerHandles?.get(name)
        : snapshot.textureHandles?.get(name);
    if (handle !== undefined) {
      resources ??= [];
      resources.push(renderAssetRevision(scope, handle));
    }
    // Host/target/video sources have their own frame publication. Without a
    // fixed source witness, this shared depth work is deliberately not retained.
    if (snapshot.textureSources?.has(name) || snapshot.videoTextureFields?.has(name)) {
      if (atlasOnly) return LIVE_ATLAS_SOURCE;
      resources ??= [];
      resources.push({});
    }
  }
  return resources;
}

function sameShadowUniformRead(
  a: MaterialSnapshot,
  b: MaterialSnapshot,
  layout: ReturnType<typeof derive>,
  read: ShaderBindingReads,
): boolean {
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

function sameRead(a: MaterialSnapshot, b: MaterialSnapshot, read: ShaderBindingReads): boolean {
  if (read.group !== 1) return true;
  const layout = derive(a.materialParamSchema ?? STANDARD_PIPELINE_PARAM_SCHEMA);
  const next = derive(b.materialParamSchema ?? STANDARD_PIPELINE_PARAM_SCHEMA);
  if (layout.layoutIdentity !== next.layoutIdentity) return false;
  if (read.binding === 0 && layout.resourceBindings[0]?.binding !== 0) {
    return sameShadowUniformRead(a, b, layout, read);
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
  const before = a === undefined ? [] : shadowContract(a).passes,
    after = b === undefined ? [] : shadowContract(b).passes;
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
  observed?: ReadonlySet<MaterialResource>,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  let cache = comparisons.get(a);
  const previous = observed === undefined ? cache?.get(b) : undefined;
  if (previous !== undefined) return previous;
  let same = true;
  b.changesSince(a, (before, after) => {
    const resource = after?.resource ?? before?.resource;
    if (observed !== undefined && (resource === undefined || !observed.has(resource))) return;
    if (same && !sameShadowMaterial(before?.snapshot, after?.snapshot)) same = false;
  });
  if (observed !== undefined) return same;
  if (cache === undefined) {
    cache = new WeakMap();
    comparisons.set(a, cache);
  }
  cache.set(b, same);
  return same;
}

interface ShadowMaterialState {
  readonly snapshot: MaterialSnapshot;
  /** Native AcceptedMaterial leaves already own their fixed snapshot; no wrapper is needed. */
  readonly resources?: readonly unknown[];
}

const NO_SHADOW_RESOURCE_VERSIONS: readonly unknown[] = Object.freeze([]);
interface ShadowScopeContent {
  readonly worldId: number | undefined;
  readonly materials: Map<MaterialResource, ShadowMaterialState | undefined>;
}

/**
 * Captured while preparing shared shadow work; contains no instance or
 * reverse-consumer index. Row-material batches bind one material per class
 * while each member casts with its own row. The native caster dispatch retains
 * every consumed material root, including the other members of row batches.
 */
export class ShadowMaterialContent {
  private readonly entries = new Map<RenderResourceScope, ShadowScopeContent>();
  private observed: ReadonlySet<MaterialResource> | undefined;
  private selections:
    | WeakMap<
        SubmissionPlan,
        {
          readonly source: Pick<PersistentGpuDrivenState, 'slotAt'>;
          readonly content: ShadowMaterialContent;
        }
      >
    | undefined;
  /** Members whose shadow reads are witnessed by the owned frame instead of an entry. */
  private readonly framed = new Map<MaterialResource, MaterialSnapshot>();

  private liveAtlas = false;

  constructor(
    private readonly materials?: MaterialFrame,
    private readonly domain: 'view' | 'whole-atlas' = 'view',
  ) {}

  /** One unfenced source prevents retaining the entire directional atlas. */
  get requiresAtlasRedraw(): boolean {
    return this.liveAtlas;
  }

  /** Capture a material from an admitted frame once per resource scope, even across submeshes. */
  addFromFrame(
    resource: MaterialResource,
    frame: MaterialFrame,
    scope: RenderResourceScope,
    preparedMaterialTexture: RenderSystemRuntime['preparedMaterialTexture'],
    worldId: number,
  ): void {
    const materials = this.entries.get(scope)?.materials;
    if (materials?.has(resource)) return;
    const accepted = frame.get(resource);
    if (accepted !== undefined)
      this.capture(
        resource,
        accepted.snapshot,
        scope,
        preparedMaterialTexture,
        worldId,
        materials,
        frame === this.materials,
      );
  }

  add(
    resource: MaterialResource,
    snapshot: MaterialSnapshot,
    scope: RenderResourceScope,
    preparedMaterialTexture?: RenderSystemRuntime['preparedMaterialTexture'],
    worldId?: number,
  ): void {
    const materials = this.entries.get(scope)?.materials;
    if (materials?.has(resource)) return;
    this.capture(resource, snapshot, scope, preparedMaterialTexture, worldId, materials, false);
  }

  private capture(
    resource: MaterialResource,
    snapshot: MaterialSnapshot,
    scope: RenderResourceScope,
    preparedMaterialTexture: RenderSystemRuntime['preparedMaterialTexture'],
    worldId: number | undefined,
    materials: ShadowScopeContent['materials'] | undefined,
    fromOwnedFrame: boolean,
  ): void {
    const contract = shadowContract(snapshot);
    if (contract.passes.length === 0) return;
    const captured =
      contract.schema === snapshot.materialParamSchema ? contract.bindings : undefined;
    // Borrowed schemas and reads may change in place. Only an owned shader
    // declaration with an admitted schema supplies fixed binding numbers.
    const bindings =
      captured ??
      selectShadowBindings(
        contract.passes,
        derive(snapshot.materialParamSchema ?? STANDARD_PIPELINE_PARAM_SCHEMA).resourceBindings,
      );
    if (materials === undefined) {
      materials = new Map();
      this.entries.set(scope, { worldId, materials });
    }
    if (
      bindings.length === 0 &&
      snapshot.immutableValues === true &&
      (fromOwnedFrame ||
        this.framed.get(resource) === snapshot ||
        this.materials?.get(resource)?.snapshot === snapshot)
    ) {
      materials.set(resource, undefined);
      this.framed.set(resource, snapshot);
    } else {
      const resources = shadowBindingVersions(
        snapshot,
        bindings,
        scope,
        preparedMaterialTexture,
        this.domain === 'whole-atlas',
      );
      if (resources === LIVE_ATLAS_SOURCE) {
        this.liveAtlas = true;
        this.entries.clear();
        this.framed.clear();
        return;
      }
      materials.set(resource, resources === undefined ? { snapshot } : { snapshot, resources });
    }
    // A later scope can add dependencies even when a prior selection covered every material.
    this.selections = undefined;
  }

  /** Row-material batches read every member's numeric row, including non-representatives. */
  addRows(
    resources: Iterable<MaterialResource>,
    scope: RenderResourceScope,
    preparedMaterialTexture: RenderSystemRuntime['preparedMaterialTexture'],
    worldId: number,
  ): void {
    if (this.materials === undefined) return;
    for (const resource of resources)
      this.addFromFrame(resource, this.materials, scope, preparedMaterialTexture, worldId);
  }

  /** Exact privately selected plans retain only the materials their selected rows read. */
  select(
    plan: SubmissionPlan,
    source: Pick<PersistentGpuDrivenState, 'slotAt'>,
  ): ShadowMaterialContent {
    const retained = this.selections?.get(plan);
    if (retained?.source === source) return retained.content;
    const observed = new Set<MaterialResource>();
    for (const batch of plan.batches) {
      if (batch.candidates.length === 0) continue;
      const binding = batch.binding;
      if (binding === undefined) return this;
      if (batch.key.rowMaterial !== true) {
        observed.add(binding.material);
        continue;
      }
      for (const candidate of batch.candidates) {
        const row = source.slotAt(candidate.primitiveIndex);
        if (row?.generation !== candidate.generation) return this;
        const resource = rowMaterialResource(row.snapshot);
        if (resource === undefined) return this;
        observed.add(resource);
      }
    }
    const content = new ShadowMaterialContent(this.materials);
    content.observed = observed;
    // Plan rows address renderer-local World 0. Multiple scopes can witness the same resource.
    const sharedCoverage = this.entries.size > 1 ? new Set<MaterialResource>() : undefined;
    let covered = 0;
    for (const [scope, entry] of this.entries) {
      if (entry.worldId === undefined) return this;
      if (entry.worldId !== 0) continue;
      let materials: ShadowScopeContent['materials'] | undefined;
      for (const resource of observed) {
        const state = entry.materials.get(resource);
        if (state === undefined && !entry.materials.has(resource)) continue;
        materials ??= new Map();
        materials.set(resource, state);
        if (state === undefined)
          content.framed.set(resource, this.framed.get(resource) as MaterialSnapshot);
        sharedCoverage?.add(resource);
      }
      if (materials !== undefined) {
        content.entries.set(scope, { worldId: entry.worldId, materials });
        covered += materials.size;
      }
    }
    if ((sharedCoverage?.size ?? covered) !== observed.size) return this;
    this.selections ??= new WeakMap();
    this.selections.set(plan, { source, content });
    return content;
  }

  sameMaterialFrames(a: MaterialFrame | undefined, b: MaterialFrame | undefined): boolean {
    return sameShadowMaterialFrames(a, b, this.observed);
  }

  same(previous: ShadowMaterialContent | undefined): boolean {
    if (this.liveAtlas || previous?.liveAtlas) return false;
    if (previous === this) return true;
    if (previous === undefined || previous.entries.size !== this.entries.size) return false;
    if (
      (previous.materials === undefined) !== (this.materials === undefined) ||
      !this.sameFramed(previous)
    )
      return false;
    // Runs for every shadow cache probe each frame: key iteration plus lookup
    // and indexed resource loops allocate no entry tuples or callbacks.
    for (const scope of this.entries.keys()) {
      const materials = this.entries.get(scope)?.materials as Map<
        MaterialResource,
        ShadowMaterialState | undefined
      >;
      const old = previous.entries.get(scope)?.materials;
      if (old === undefined) return false;
      for (const material of materials.keys()) {
        const state = materials.get(material);
        if (state === undefined) continue;
        const before = old.get(material);
        const resources = state.resources ?? NO_SHADOW_RESOURCE_VERSIONS;
        const oldResources = before?.resources ?? NO_SHADOW_RESOURCE_VERSIONS;
        if (
          before === undefined ||
          !sameShadowMaterial(before.snapshot, state.snapshot) ||
          oldResources.length !== resources.length
        )
          return false;
        for (let index = 0; index < resources.length; index++)
          if (resources[index] !== oldResources[index]) return false;
      }
      for (const [material, state] of old)
        if (state !== undefined && materials.get(material) === undefined) return false;
    }
    return true;
  }

  /**
   * Caster membership is witnessed by candidates, and views that share this
   * depth work may batch different subsets. Only edits to a material either
   * side witnessed matter; any other material may change freely.
   */
  private sameFramed(previous: ShadowMaterialContent): boolean {
    const before = previous.materials,
      after = this.materials;
    if (before === after || before === undefined || after === undefined) return true;
    if (this.entries.size === 0) return sameShadowMaterialFrames(before, after, this.observed);
    if (this.framed.size === 0 && previous.framed.size === 0) return true;
    let same = true;
    after.changesSince(before, (a, b) => {
      const resource = (b ?? a)?.resource;
      if (
        same &&
        resource !== undefined &&
        (this.framed.has(resource) || previous.framed.has(resource))
      )
        same = sameShadowMaterial(a?.snapshot, b?.snapshot);
    });
    return same;
  }
}
