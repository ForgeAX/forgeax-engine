import type { BindGroup, BindGroupEntry, BindGroupLayout } from '@forgeax/engine-rhi';
import type { ParamSchemaEntry } from '@forgeax/engine-types';
import { preparedMaterialLayoutIdentity } from '../material-layout-facts';
import type { IblBindingEntryInspection, IblBindingInspection } from '../mesh-material-bindings';
import { getOpaqueResourceIdentity, type MaterialBgAssemblyCacheEntry } from './frame-snapshot';

type Material = NonNullable<IblBindingInspection['material']>;
type Pipeline = NonNullable<IblBindingInspection['pipeline']>;
type Writable<T> = { -readonly [K in keyof T]: T[K] };
interface MaterialRow extends Writable<Material> {
  entries: Writable<IblBindingEntryInspection>[];
  reflectionBindings: number[];
}

const NO_ERRORS: readonly string[] = Object.freeze([]);

function emptyMaterial(): MaterialRow {
  return {
    bindGroupIdentity: 0,
    materialBglIdentity: 0,
    cache: 'miss',
    skylightBindingStart: 0,
    entries: [],
    reflectionBindings: [],
  };
}

/** Capture numbers at bind time so later inspection holds no device resources. */
function writeMaterial(
  row: MaterialRow,
  layout: BindGroupLayout,
  group: BindGroup,
  entries: readonly BindGroupEntry[],
  start: number,
): boolean {
  let count = 0;
  for (const entry of entries) {
    const binding = entry.binding;
    if (binding < start || binding >= start + 6) continue;
    const resource = entry.resource;
    const kind = resource.kind;
    if (kind === 'externalTexture' || kind === 'accelerationStructure') continue;
    const value = kind === 'buffer' ? resource.value.buffer : resource.value;
    if (typeof value !== 'object' || value === null) continue;
    const resourceIdentity = getOpaqueResourceIdentity(value);
    const target = row.entries[count];
    if (target === undefined) row.entries.push({ binding, kind, resourceIdentity });
    else {
      target.binding = binding;
      target.kind = kind;
      target.resourceIdentity = resourceIdentity;
    }
    row.reflectionBindings[count++] = binding;
  }
  if (count === 0) return false;
  row.entries.length = row.reflectionBindings.length = count;
  row.materialBglIdentity = getOpaqueResourceIdentity(layout);
  row.bindGroupIdentity = getOpaqueResourceIdentity(group);
  row.skylightBindingStart = start;
  return true;
}

function bindingErrors(
  material: Material | undefined,
  layout: number,
  group: number,
  resources: IblBindingInspection['resources'],
): readonly string[] {
  if (material === undefined) return NO_ERRORS;
  let errors: string[] | undefined;
  if (material.materialBglIdentity !== layout) errors = ['material-pipeline-bgl-identity-mismatch'];
  if (material.bindGroupIdentity !== group) {
    errors ??= [];
    errors.push('material-bind-group-identity-mismatch');
  }
  if (!matchesResources(material, resources)) {
    errors ??= [];
    errors.push('material-ibl-resource-identity-mismatch');
  }
  return errors ?? NO_ERRORS;
}

function matchesResources(
  material: Material,
  resources: IblBindingInspection['resources'],
): boolean {
  const entries = material.entries;
  let index = 0;
  while (index < entries.length && (entries[index]?.binding ?? 0) < material.skylightBindingStart)
    index++;
  return (
    entries[index]?.resourceIdentity === resources.irradiance.viewIdentity &&
    entries[index + 1]?.resourceIdentity === resources.irradiance.samplerIdentity &&
    entries[index + 2]?.resourceIdentity === resources.prefilter.viewIdentity &&
    entries[index + 3]?.resourceIdentity === resources.prefilter.samplerIdentity &&
    entries[index + 4]?.resourceIdentity === resources.brdfLut.viewIdentity &&
    entries[index + 5]?.resourceIdentity === resources.intensityBufferIdentity
  );
}

/** One pass owns its latest binding. Reading detaches the published rows from subsequent writes. */
export class IblBindingObservation {
  private material: Material | undefined;
  private pipeline: Pipeline | undefined;
  private status: IblBindingInspection['status'];
  private errors: readonly string[];
  private lastShader: string | undefined;
  private lastSchema = 0;
  private currentPipeline = false;
  private materialRow: MaterialRow | undefined;
  private pipelineRow: Writable<Pipeline> | undefined;
  private published: IblBindingInspection | undefined;

  constructor(private readonly pass: IblBindingInspection) {
    this.material = pass.material;
    this.pipeline = pass.pipeline;
    this.status = pass.status;
    this.errors = pass.errors;
    this.published = pass;
  }

  private bind(material: Material): void {
    this.material = material;
    this.errors = NO_ERRORS;
    this.currentPipeline = false;
    this.published = undefined;
  }

  bindIssued(
    layout: BindGroupLayout,
    group: BindGroup,
    entries: readonly BindGroupEntry[],
    start: number,
  ): void {
    this.materialRow ??= emptyMaterial();
    if (writeMaterial(this.materialRow, layout, group, entries, start)) {
      this.materialRow.cache = 'miss';
      this.bind(this.materialRow);
    }
  }

  bindRetained(entry: MaterialBgAssemblyCacheEntry): void {
    let material = entry.iblMaterial;
    if (material === null) return;
    if (material === undefined) {
      // The installed descriptor is the authority for this physical group's
      // bindings. A replacement group establishes its own numeric receipt.
      this.materialRow ??= emptyMaterial();
      const row = this.materialRow;
      if (
        !writeMaterial(
          row,
          entry.materialBgl,
          entry.bindGroup,
          entry.descriptor.entries,
          entry.skylightBindingStart,
        )
      ) {
        entry.iblMaterial = null;
        return;
      }
      row.cache = 'hit';
      for (const item of row.entries) Object.freeze(item);
      Object.freeze(row.entries);
      Object.freeze(row.reflectionBindings);
      material = entry.iblMaterial = Object.freeze(row);
      this.materialRow = undefined;
    }
    if (
      this.material !== material ||
      this.status !== 'binding-chain-consistent' ||
      this.errors.length !== 0
    )
      this.bind(material);
  }

  draw(
    pipelineIdentity: number,
    materialBglIdentity: number,
    bindGroupIdentity: number,
    shader: string,
    schema: readonly ParamSchemaEntry[] | undefined,
    drawFrameId: number,
  ): void {
    const schemaId = schema === undefined ? 0 : getOpaqueResourceIdentity(schema);
    const last = this.pipeline;
    if (
      this.currentPipeline &&
      last?.pipelineIdentity === pipelineIdentity &&
      last.materialBglIdentity === materialBglIdentity &&
      last.bindGroupIdentity === bindGroupIdentity &&
      this.lastShader === shader &&
      this.lastSchema === schemaId &&
      last.drawFrameId === drawFrameId
    )
      return;
    this.lastShader = shader;
    this.lastSchema = schemaId;
    const effectiveMaterialLayoutIdentity = preparedMaterialLayoutIdentity(shader, schema);
    const row = this.pipelineRow;
    if (row === undefined)
      this.pipelineRow = {
        pipelineIdentity,
        materialBglIdentity,
        bindGroupIdentity,
        effectiveMaterialLayoutIdentity,
        drawFrameId,
      };
    else {
      row.pipelineIdentity = pipelineIdentity;
      row.materialBglIdentity = materialBglIdentity;
      row.bindGroupIdentity = bindGroupIdentity;
      row.effectiveMaterialLayoutIdentity = effectiveMaterialLayoutIdentity;
      row.drawFrameId = drawFrameId;
    }
    this.pipeline = this.pipelineRow;
    this.errors = bindingErrors(
      this.material,
      materialBglIdentity,
      bindGroupIdentity,
      this.pass.resources,
    );
    this.status = this.errors.length === 0 ? 'binding-chain-consistent' : 'binding-chain-mismatch';
    this.currentPipeline = true;
    this.published = undefined;
  }

  inspect(): IblBindingInspection {
    if (this.published === undefined) {
      this.published = {
        ...this.pass,
        ...(this.material === undefined ? {} : { material: this.material }),
        ...(this.pipeline === undefined ? {} : { pipeline: this.pipeline }),
        status: this.status,
        errors: this.errors,
      };
      // Only the reader now owns these mutable rows. A later draw takes fresh storage.
      this.materialRow = undefined;
      this.pipelineRow = undefined;
    }
    return this.published;
  }
}
