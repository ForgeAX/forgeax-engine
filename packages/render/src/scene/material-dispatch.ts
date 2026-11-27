import type { EntityHandle } from '@forgeax/engine-ecs';
import {
  DEFAULT_STANDARD_SURFACE_MODULE,
  isEngineMaterialModule,
  STANDARD_ORM_REUSE_BIT,
} from '@forgeax/engine-shader';
import {
  assertRenderResidencySelection,
  type RenderResidencyGroup,
  type RenderResidencySelection,
} from '../gpu-driven/batch-residency';
import { materialAlphaMask } from '../material-alpha-mask';
import {
  type MaterialDispatchPass,
  MaterialResource,
  materialUsesSpriteGeometry,
  ownedMaterialBounds,
  ownedMaterialPassDeclaration,
  ownedMaterialValues,
} from '../material-resource';
import type { MaterialSourceSnapshot } from '../material-source';
import { SHADOW_CASTER_SHADER_ID } from '../pbr-pipeline';
import { renderStateHash } from '../pipeline-spec';
import { type ForwardShadowCoverage, forwardShadowPassCoverage } from '../predepth-coverage';
import { getOpaqueResourceIdentity, type ValidatedRenderable } from '../record/frame-snapshot';
import { isMediumMaterial, matchesRecordMode } from '../record/material-pass-selection';
import {
  appendMaterialDispatchEntries,
  type DispatchEntry,
  type MaterialSnapshot,
  type RenderableSnapshot,
} from '../render-system-extract';
import { sameMaterialCullingBounds } from '../standard-displacement-bounds';
import { dispatchEntry } from './dispatch-entry';
import { type FrameList, FrameListBase, ProjectionIterator } from './frame-list';
import {
  at,
  changes,
  type Node,
  nodes,
  put,
  range,
  remove,
  visitUnorderedValues,
} from './frame-tree';
import type { MeshFrame, MeshGeometry } from './mesh-frame';
import {
  captureMaterialOverrides,
  effectiveMeshMaterials,
  type MeshMaterialBindingWrite,
  type MeshMaterialGeometry,
  type MeshMaterialResolver,
  meshMaterialGeometry,
  meshMaterialSourceHandle,
  prepareMeshMaterialBindings,
  retainMeshMaterialBindings,
} from './mesh-materials';
import { SceneSlotFrame } from './scene-slots';
import {
  type Roster,
  RosterCursor,
  type RosterPage,
  rosterLastKey,
  rosterMerge,
  rosterRankBefore,
  rosterRemove,
} from './slot-roster';

/** Ordered frame work; arrays and shared execution groups have the same consumption surface. */
export type DispatchList = FrameList<DispatchEntry>;

export type { MaterialDispatchPass } from '../material-resource';

const ownedShadowCoverage = Symbol('ownedShadowCoverage');
type Pass = MaterialDispatchPass & { readonly [ownedShadowCoverage]?: ForwardShadowCoverage };
const snapshotPasses = new WeakMap<MaterialSnapshot, readonly Pass[]>();

export function materialPasses(snapshot: MaterialSnapshot): readonly MaterialDispatchPass[] {
  const declaration = ownedMaterialPassDeclaration(snapshot);
  const cached = declaration === undefined ? snapshotPasses.get(snapshot) : declaration.prepared;
  if (cached !== undefined) return cached;
  const entries: DispatchEntry[] = [];
  appendMaterialDispatchEntries(
    entries,
    snapshot.passes,
    0 as EntityHandle,
    snapshot.materialHandle ?? 0,
    0,
    0,
    0,
    snapshot.materialProgramKeys,
  );
  const prepared = entries.map(
    ({ entityIndex: _entity, renderableIndex: _index, layer: _layer, ...pass }) => {
      if (pass.materialShaderId === undefined)
        throw new Error('Accepted material Pass has no program identity');
      const result = { ...pass, materialShaderId: pass.materialShaderId };
      if (declaration !== undefined) {
        Object.freeze(result.tags);
        Object.freeze(result);
      }
      return result;
    },
  );
  if (declaration === undefined) snapshotPasses.set(snapshot, prepared);
  else declaration.prepared = Object.freeze(prepared);
  return prepared;
}

/** Binding membership facts, one numeric bit per flag. */
const VISIBLE = 1;
const CASTER = 2;
const PREPARED = 4;

/**
 * Per-slot binding facts as numeric columns: member trees hold the slot
 * address only, so a binding allocates no object of its own.
 */
const BINDING_PAGE_SIZE = 64;
const bindingPageId = (slot: number) => Math.floor(slot / BINDING_PAGE_SIZE);
const bindingOffset = (slot: number) => (slot % BINDING_PAGE_SIZE) * 2;

interface BindingPage {
  data: Float64Array;
  live: number;
}

class BindingColumns {
  groups: (BindingGroup | undefined)[] = [];
  flags = new Uint8Array(64);
  count = 0;
  private readonly pages: (BindingPage | undefined)[] = [];
  private readonly changedPages = new Set<number>();
  private root: Node<Float64Array> | undefined;

  entity(slot: number): number {
    return this.pages[bindingPageId(slot)]?.data[bindingOffset(slot)] ?? 0;
  }
  layer(slot: number): number {
    return this.pages[bindingPageId(slot)]?.data[bindingOffset(slot) + 1] ?? 0;
  }
  add(slot: number, entity: number, layer: number): void {
    if (slot >= this.flags.length) {
      const flags = new Uint8Array(2 ** Math.ceil(Math.log2(slot + 1)));
      flags.set(this.flags);
      this.flags = flags;
    }
    const id = bindingPageId(slot);
    let page = this.pages[id];
    if (page === undefined) {
      page = { data: new Float64Array(BINDING_PAGE_SIZE * 2), live: 0 };
      this.pages[id] = page;
    } else if (!this.changedPages.has(id)) page.data = page.data.slice();
    page.live++;
    this.changedPages.add(id);
    const offset = bindingOffset(slot);
    page.data[offset] = entity;
    page.data[offset + 1] = layer;
  }
  remove(slot: number): void {
    const id = bindingPageId(slot);
    const page = this.pages[id];
    // Absent lanes are unreachable from the captured pass membership. No
    // numeric copy is needed to release a member while its page is still live.
    if (page !== undefined && --page.live === 0) {
      this.pages[id] = undefined;
      this.changedPages.add(id);
    }
  }
  clear(): void {
    this.groups.length = 0;
    this.pages.length = 0;
    if (this.flags.length > 64) this.flags = new Uint8Array(64);
    this.root = undefined;
    this.changedPages.clear();
  }
  capture(): Node<Float64Array> | undefined {
    for (const id of this.changedPages) {
      const page = this.pages[id];
      this.root =
        page === undefined ? remove(this.root, 0, id) : put(this.root, page.data, 0, id, 1);
    }
    this.changedPages.clear();
    return this.root;
  }
}
/** The binding group key; equal keys select the same held materials and members. */
function materialBindingKey(
  snapshot: RenderableSnapshot,
  overrides = snapshot.materialOverrides === undefined
    ? undefined
    : captureMaterialOverrides(snapshot.materialOverrides),
  direct = [...new Set(snapshot.materials.length === 0 ? [snapshot.material] : snapshot.materials)],
  geometry = meshMaterialGeometry(snapshot),
): string {
  const key =
    overrides === undefined || snapshot.assetHandle === undefined
      ? `${direct.some((resource) => resource.snapshot.sourceAssets !== undefined) ? `source:${0}:` : ''}direct:${direct.map(getOpaqueResourceIdentity).join(',')}`
      : `mesh:${0}:${snapshot.assetHandle}:${geometry}:${getOpaqueResourceIdentity(overrides)}`;
  return residencyBindingKey(snapshot.residencyGroup, key);
}

function residencyBindingKey(group: RenderResidencyGroup | undefined, key: string): string {
  return group === undefined ? key : `residency:${getOpaqueResourceIdentity(group)}:${key}`;
}

function assertResidencySelection(
  selection: RenderResidencySelection | undefined,
  phase: RenderResidencySelection['phase'] = 'active',
): void {
  if (selection !== undefined) assertRenderResidencySelection(selection, phase);
}

/** An unreadable source takes the ordinary replacement path, which retires the old binding. */
function tryMaterialBindingKey(snapshot: RenderableSnapshot): string | undefined {
  try {
    return materialBindingKey(snapshot);
  } catch {
    return undefined;
  }
}

interface Work {
  readonly pass: Pass;
  /** The accepted resource whose Pass this is; Passes are owned per resource. */
  readonly resource: MaterialResource;
  readonly groups: Node<Roster>;
}

/** One Pass's work in dispatch order; its member entries are visited only on demand. */
export interface DispatchPassWork {
  readonly pass: MaterialDispatchPass;
  readonly resource: MaterialResource;
  /** Member entries, equal to the length of `entries()`. */
  readonly count: number;
  entries(): Iterable<DispatchEntry>;
  /** Captured physical addresses, before materializing entries or deriving frame ranks. */
  visitSlots?(visit: (slot: number) => void): void;
}
interface QueryWork {
  members: Node<Roster> | undefined;
  casters: Node<Roster> | undefined;
  /** Pipeline-preparation demand: accepted materials without Pass work. */
  prepared: Node<Roster> | undefined;
  passes: readonly Pass[];
}

/** Executable pass lists in declaration order, shared by raster lanes and light views. */
export interface MaterialPrograms {
  readonly spriteGeometry: boolean;
  readonly passes: readonly Pass[];
  readonly snapshot: MaterialSnapshot;
  readonly materialHandle: number;
  readonly forward: readonly Pass[];
  readonly shadow: readonly Pass[];
  readonly prepareShadow: readonly Pass[];
  readonly stockShadow?: StockShadowProgram;
}

/** The physical inputs from one published material version used by stock shadow preparation. */
export interface StockShadowProgram {
  readonly state: string | null;
  readonly alphaMask: boolean;
  readonly textureMask: number | undefined;
}

export interface AcceptedMaterial {
  readonly resource: MaterialResource;
  readonly snapshot: MaterialSnapshot;
  readonly passes: readonly MaterialDispatchPass[];
  readonly bindings: number;
  readonly programs?: MaterialPrograms;
}

/** Follow authored module ownership even for content-addressed cooked keys. */
export function shadowDispatchRequiresPreparation(
  material: MaterialSnapshot,
  pass: MaterialDispatchPass,
): boolean {
  if (pass.tags.LightMode !== 'ShadowCaster') return false;
  if (
    pass.materialShaderId === 'forgeax::default-standard-pbr' ||
    pass.materialShaderId === SHADOW_CASTER_SHADER_ID
  )
    return true;
  const program = material.passes[pass.passIndex]?.program;
  return (
    program === undefined ||
    !isEngineMaterialModule(program.module) ||
    (program.moduleSlots?.surface !== undefined &&
      program.moduleSlots.surface !== DEFAULT_STANDARD_SURFACE_MODULE)
  );
}

function stockShadowProgram(
  snapshot: MaterialSnapshot,
  state: string | null,
  previous?: StockShadowProgram,
): StockShadowProgram {
  const alphaMask = materialAlphaMask(snapshot.paramSnapshot);
  const mask = snapshot.standardTextureMask;
  const textureMask = mask === undefined ? undefined : mask % STANDARD_ORM_REUSE_BIT;
  if (
    previous !== undefined &&
    previous.alphaMask === alphaMask &&
    Object.is(previous.textureMask, textureMask)
  )
    return previous;
  return Object.freeze({ state, alphaMask, textureMask });
}

export function selectMaterialPrograms(
  snapshot: MaterialSnapshot,
  passes: readonly Pass[],
): MaterialPrograms {
  const forward: Pass[] = [];
  const shadow: Pass[] = [];
  const prepareShadow: Pass[] = [];
  const medium = isMediumMaterial(snapshot);
  for (const pass of passes) {
    if (pass.materialShaderId === undefined) continue;
    if (pass.tags.LightMode === 'ShadowCaster') {
      shadow.push(pass);
      if (shadowDispatchRequiresPreparation(snapshot, pass)) prepareShadow.push(pass);
    } else if (medium || pass.tags.LightMode === 'Forward') forward.push(pass);
  }
  const caster = prepareShadow.length === 1 ? prepareShadow[0] : undefined;
  const stock =
    caster?.materialShaderId === SHADOW_CASTER_SHADER_ID ||
    caster?.materialShaderId === 'forgeax::default-standard-pbr';
  return Object.freeze({
    snapshot,
    materialHandle: snapshot.materialHandle ?? -1,
    passes,
    spriteGeometry: materialUsesSpriteGeometry(snapshot),
    forward: Object.freeze(forward),
    shadow: Object.freeze(shadow),
    prepareShadow: Object.freeze(prepareShadow),
    ...(stock && caster !== undefined && ownedMaterialPassDeclaration(snapshot) !== undefined
      ? {
          stockShadow: stockShadowProgram(
            snapshot,
            caster.renderState === undefined ? null : renderStateHash(caster.renderState),
          ),
        }
      : {}),
  });
}

/** The selected geometry follows the accepted shader declaration. Borrowed programs remain live. */
export function usesAcceptedSpriteGeometry(material: AcceptedMaterial): boolean {
  return material.programs?.spriteGeometry ?? materialUsesSpriteGeometry(material.snapshot);
}

/** Borrowed declarations read live tags without materializing a filtered array per draw. */
export function hasShadowPasses(material: AcceptedMaterial): boolean {
  return material.programs === undefined
    ? material.passes.some((pass) => pass.tags.LightMode === 'ShadowCaster')
    : material.programs.shadow.length > 0;
}

interface MaterialDemandCounts {
  readonly water: number;
  readonly transmission: number;
  readonly rough: number;
  readonly backs: number;
  readonly medium: number;
  readonly unfogged: number;
  readonly borrowed: number;
  readonly foldableSprites: number;
  readonly shadowPreparation: number;
}
const EMPTY_DEMAND: MaterialDemandCounts = {
  water: 0,
  transmission: 0,
  rough: 0,
  backs: 0,
  medium: 0,
  unfogged: 0,
  borrowed: 0,
  foldableSprites: 0,
  shadowPreparation: 0,
};

function demandCounts(material: AcceptedMaterial | undefined): MaterialDemandCounts {
  if (material === undefined) return EMPTY_DEMAND;
  const snapshot = material.snapshot;
  const owned = ownedMaterialValues(snapshot);
  const transmission = matchesRecordMode(snapshot, 'transmission');
  const roughness = snapshot.paramSnapshot?.roughness ?? snapshot.roughness;
  return {
    water: snapshot.surfaceModel === 'single-layer-water' ? material.bindings : 0,
    transmission: transmission ? material.bindings : 0,
    rough: transmission && typeof roughness === 'number' && roughness > 0 ? material.bindings : 0,
    backs:
      transmission && material.passes.some((pass) => pass.tags.LightMode === 'TransmissionBack')
        ? material.bindings
        : 0,
    medium:
      isMediumMaterial(snapshot) && snapshot.surfaceModel !== 'single-layer-water'
        ? material.bindings
        : 0,
    unfogged:
      snapshot.renderState?.fog === false && matchesRecordMode(snapshot, 'opaque-unfogged')
        ? material.bindings
        : 0,
    borrowed: owned ? 0 : 1,
    // Zero-binding accepted entries can still be consumed by actual Pass queries.
    foldableSprites:
      owned && snapshot.transparent === true && usesAcceptedSpriteGeometry(material) ? 1 : 0,
    shadowPreparation:
      owned &&
      (material.programs === undefined
        ? material.passes.some((pass) => shadowDispatchRequiresPreparation(snapshot, pass))
        : material.programs.prepareShadow.length > 0)
        ? 1
        : 0,
  };
}

function replaceDemand(
  counts: MaterialDemandCounts,
  previous: AcceptedMaterial | undefined,
  next: AcceptedMaterial | undefined,
): MaterialDemandCounts {
  const old = demandCounts(previous);
  const current = demandCounts(next);
  return {
    water: counts.water - old.water + current.water,
    transmission: counts.transmission - old.transmission + current.transmission,
    rough: counts.rough - old.rough + current.rough,
    medium: counts.medium - old.medium + current.medium,
    backs: counts.backs - old.backs + current.backs,
    unfogged: counts.unfogged - old.unfogged + current.unfogged,
    borrowed: counts.borrowed - old.borrowed + current.borrowed,
    foldableSprites: counts.foldableSprites - old.foldableSprites + current.foldableSprites,
    shadowPreparation: counts.shadowPreparation - old.shadowPreparation + current.shadowPreparation,
  };
}

const passDefinitions = new WeakMap<MaterialSnapshot['passes'], string>();
function passDefinition(passes: MaterialSnapshot['passes']): string {
  let definition = passDefinitions.get(passes);
  if (definition === undefined) {
    definition = JSON.stringify(passes);
    passDefinitions.set(passes, definition);
  }
  return definition;
}

function sameMaterialPasses(previous: MaterialSnapshot, next: MaterialSnapshot): boolean {
  if ((previous.materialHandle ?? 0) !== (next.materialHandle ?? 0)) return false;
  // Worker transport changes object identity without changing the accepted program contract.
  if (
    previous.passes !== next.passes &&
    passDefinition(previous.passes) !== passDefinition(next.passes)
  )
    return false;
  const before = previous.materialProgramKeys;
  const after = next.materialProgramKeys;
  return (
    before === after ||
    (before !== undefined &&
      after !== undefined &&
      Object.keys(before).length === Object.keys(after).length &&
      Object.keys(before).every((key) => before[key] === after[key]))
  );
}

const MATERIAL_PAGE_WIDTH = 16;
const MATERIAL_BLOCK_WIDTH = MATERIAL_PAGE_WIDTH * MATERIAL_PAGE_WIDTH;
type MaterialPage = readonly (AcceptedMaterial | undefined)[];
type MaterialBlock = readonly (MaterialPage | undefined)[];

/** Only occupied blocks have a tree node. Their page and row lanes are direct addresses. */
function visitChangedMaterialPages(
  previous: Node<MaterialBlock> | undefined,
  current: Node<MaterialBlock> | undefined,
  visit: (before: MaterialPage | undefined, after: MaterialPage | undefined) => void,
): void {
  changes(previous, current, (left, right) => {
    const count = Math.max(left?.length ?? 0, right?.length ?? 0);
    for (let index = 0; index < count; index++) {
      const before = left?.[index];
      const after = right?.[index];
      if (before !== after) visit(before, after);
    }
  });
}

function mayReadSource(material: AcceptedMaterial | undefined): boolean {
  return (
    material !== undefined &&
    (!ownedMaterialValues(material.snapshot) || material.snapshot.sourceAssets !== undefined)
  );
}

interface PublishedMaterialChanges {
  /** Both frames share only the lane masks. Each owns references to its own pages. */
  readonly masks: number[];
  readonly pages: (MaterialPage | undefined)[];
}

/** Fixed shared material roots; capturing or adopting a version never copies bindings. */
export class MaterialFrame {
  readonly #programRoot = true;
  static #nextCullRevision = 1;
  #cullRevision = 0;

  /** Identity of the admitted material-to-bounds relation. Zero requires a fresh read. */
  static cullingRevision(frame: MaterialFrame | undefined): number {
    if (
      frame === undefined ||
      !(#cullRevision in frame) ||
      frame.get !== MATERIAL_FRAME_GET ||
      frame.hasBorrowedValues
    )
      return 0;
    if (frame.#cullRevision === 0) frame.#cullRevision = MaterialFrame.#nextCullRevision++;
    return frame.#cullRevision;
  }

  private incoming?: PublishedMaterialChanges;
  private outgoing?: PublishedMaterialChanges;

  static provesNoShadowPreparation(frame: unknown): boolean {
    return MaterialFrame.fixedProgramRoot(frame)?.counts.shadowPreparation === 0;
  }

  /** Native fixed program root; proxies and borrowed/custom read protocols stay observable. */
  static fixedProgramRoot(frame: unknown): MaterialFrame | undefined {
    if (typeof frame !== 'object' || frame === null || !(#programRoot in frame)) return undefined;
    if (
      Object.getPrototypeOf(frame) !== MaterialFrame.prototype ||
      Object.hasOwn(frame, 'get') ||
      Object.hasOwn(frame, 'hasBorrowedValues') ||
      Object.getOwnPropertyDescriptor(MaterialFrame.prototype, 'get')?.value !==
        MATERIAL_FRAME_GET ||
      Object.getOwnPropertyDescriptor(MaterialFrame.prototype, 'hasBorrowedValues')?.get !==
        MATERIAL_FRAME_BORROWED ||
      frame.hasBorrowedValues
    )
      return undefined;
    return frame;
  }

  readonly transmissionDemand: import('../transmission/projection').TransmissionDemand;
  constructor(
    private readonly root: Node<MaterialBlock> | undefined,
    private readonly counts: MaterialDemandCounts = EMPTY_DEMAND,
    private readonly sourceReaders?: Node<MaterialResource>,
  ) {
    this.transmissionDemand = Object.freeze({
      activeCount: counts.transmission,
      needsRoughMips: counts.rough > 0,
      ...(counts.backs > 0 ? { needsBackPass: true } : {}),
    });
  }
  get hasMedium(): boolean {
    return this.counts.medium > 0;
  }
  get hasWater(): boolean {
    return this.counts.water > 0;
  }
  /** Accepted owned Sprite materials that can participate in folding. */
  get hasFoldableSprites(): boolean {
    return this.counts.foldableSprites > 0;
  }
  /** Raw snapshots cannot prove cross-capture reuse from value or program identity. */
  get hasBorrowedValues(): boolean {
    return this.counts.borrowed > 0;
  }
  /** An opaque material opts out of scene fog (`renderState.fog: false`). */
  get hasUnfoggedOpaque(): boolean {
    return this.counts.unfogged > 0;
  }
  /** Capture a newly generated view material at its producer, preserving this frame's root. */
  with(material: MaterialResource, bindings?: number, snapshot = material.snapshot): MaterialFrame {
    const previous = this.get(material);
    const count = bindings ?? previous?.bindings ?? 1;
    if (previous?.snapshot === snapshot && previous.bindings === count) return this;
    // Each resource owns its execution order, even if two resources started
    // with the same payload. Parameter-only adoption retains the same Passes.
    const fixedPrograms = ownedMaterialPassDeclaration(snapshot) !== undefined;
    const passes =
      previous !== undefined &&
      (!fixedPrograms || previous.programs !== undefined) &&
      sameMaterialPasses(previous.snapshot, snapshot)
        ? previous.passes
        : materialPasses(snapshot).map((pass) => {
            const owned = { ...pass };
            getOpaqueResourceIdentity(owned);
            if (!fixedPrograms) return owned;
            Object.defineProperty(owned, ownedShadowCoverage, {
              value: forwardShadowPassCoverage(pass),
            });
            return Object.freeze(owned);
          });
    const programs = !fixedPrograms
      ? undefined
      : previous?.programs !== undefined &&
          previous.passes === passes &&
          isMediumMaterial(previous.snapshot) === isMediumMaterial(snapshot)
        ? Object.freeze({
            ...previous.programs,
            ...(previous.programs.stockShadow === undefined
              ? {}
              : {
                  stockShadow: stockShadowProgram(
                    snapshot,
                    previous.programs.stockShadow.state,
                    previous.programs.stockShadow,
                  ),
                }),
            snapshot,
            materialHandle: snapshot.materialHandle ?? -1,
          })
        : selectMaterialPrograms(snapshot, Object.freeze(passes));
    const captured = {
      resource: material,
      snapshot,
      passes,
      bindings: count,
      ...(programs === undefined ? {} : { programs }),
    };
    return this.replaceMaterial(material, previous, captured);
  }
  /** Adopt already fixed input during actual Pass assembly, without a live read. */
  withAccepted(accepted: AcceptedMaterial, bindings = accepted.bindings): MaterialFrame {
    const previous = this.get(accepted.resource);
    if (
      previous?.snapshot === accepted.snapshot &&
      previous.passes === accepted.passes &&
      previous.bindings === bindings
    )
      return this;
    // A producer may spread an old leaf before replacing its snapshot or pass list.
    const programs = accepted.programs;
    const next =
      programs !== undefined &&
      (programs.snapshot !== accepted.snapshot || programs.passes !== accepted.passes)
        ? {
            resource: accepted.resource,
            snapshot: accepted.snapshot,
            passes: accepted.passes,
            bindings,
          }
        : accepted.bindings === bindings
          ? accepted
          : { ...accepted, bindings };
    return this.replaceMaterial(accepted.resource, previous, next);
  }
  without(material: MaterialResource): MaterialFrame {
    const previous = this.get(material);
    return previous === undefined ? this : this.replaceMaterial(material, previous, undefined);
  }

  private block(key: number): Node<MaterialBlock> | undefined {
    let node = this.root;
    while (node !== undefined && node.key !== key) node = key < node.key ? node.left : node.right;
    return node;
  }

  private replaceMaterial(
    material: MaterialResource,
    previous: AcceptedMaterial | undefined,
    next: AcceptedMaterial | undefined,
  ): MaterialFrame {
    const address = MaterialResource._frameAddress(material);
    const key = Math.floor(address / MATERIAL_BLOCK_WIDTH);
    const block = this.block(key);
    const weight =
      (block?.weight ?? 0) + Number(next !== undefined) - Number(previous !== undefined);
    let root: Node<MaterialBlock> | undefined;
    if (weight === 0) root = remove(this.root, 0, key);
    else {
      const index = Math.floor((address % MATERIAL_BLOCK_WIDTH) / MATERIAL_PAGE_WIDTH);
      const pages = block?.value.slice() ?? [];
      const values = pages[index]?.slice() ?? [];
      values[address % MATERIAL_PAGE_WIDTH] = next;
      pages[index] =
        next === undefined && values.every((row) => row === undefined) ? undefined : values;
      root = put<MaterialBlock>(this.root, pages, 0, key, weight);
    }
    let readers = this.sourceReaders;
    if (previous?.snapshot !== next?.snapshot) {
      const after = mayReadSource(next);
      if (after !== mayReadSource(previous))
        readers = after ? put(readers, material, 0, address, 1) : remove(readers, 0, address);
    }
    return new MaterialFrame(root, replaceDemand(this.counts, previous, next), readers);
  }

  /** Enumerate eligible resources at their highest-priority accepted version. */
  visitSources(
    selected: (resource: MaterialResource) => boolean,
    visit: (source: MaterialSourceSnapshot) => void,
    first?: MaterialFrame,
    second?: MaterialFrame,
  ): void {
    const readers = this.sourceReaders;
    if (
      readers === undefined ||
      readers === first?.sourceReaders ||
      readers === second?.sourceReaders
    )
      return;
    visitUnorderedValues(readers, (resource) => {
      if (
        !selected(resource) ||
        first?.get(resource) !== undefined ||
        second?.get(resource) !== undefined
      )
        return;
      const source = this.get(resource)?.snapshot.sourceAssets;
      if (source !== undefined) visit(source);
    });
  }

  /** Project actual draw work from this fixed frame, independent of current Scene bindings. */
  project(
    draws: readonly {
      readonly source: RenderableSnapshot;
      readonly renderableIndex: number;
      readonly materials?: readonly MaterialResource[];
    }[],
  ): readonly DispatchEntry[] {
    const entries: {
      readonly pass: number;
      readonly identity: number;
      readonly entry: DispatchEntry;
    }[] = [];
    for (const draw of draws) {
      const identity = draw.source.entityKey;
      const selection =
        draw.materials ??
        (draw.source.materials.length === 0 ? [draw.source.material] : draw.source.materials);
      this.drawEntries(draw.source, draw.renderableIndex, selection, (entry, pass) =>
        entries.push({ pass, identity, entry }),
      );
    }
    entries.sort(
      (a, b) =>
        a.entry.queue - b.entry.queue ||
        a.pass - b.pass ||
        a.identity - b.identity ||
        a.entry.renderableIndex - b.entry.renderableIndex,
    );
    return entries.map(({ entry }) => entry);
  }

  /**
   * One draw's entries with their Pass identities, in material and Pass order.
   * Draw order is (queue, Pass identity, entity identity, draw index).
   */
  drawEntries(
    source: RenderableSnapshot,
    renderableIndex: number,
    selection: readonly MaterialResource[] | Pick<ValidatedRenderable, 'mesh' | 'submeshIndices'>,
    visit: (entry: DispatchEntry, pass: number) => void,
  ): void {
    const bySubmesh = 'mesh' in selection;
    const count = bySubmesh
      ? (selection.submeshIndices?.length ?? selection.mesh.submeshes.length)
      : selection.length;
    let first: MaterialResource | undefined;
    let others: Set<MaterialResource> | undefined;
    for (let index = 0; index < count; index++) {
      let resource: MaterialResource;
      if (bySubmesh) {
        const submesh = selection.mesh.submeshes[selection.submeshIndices?.[index] ?? index];
        if (submesh === undefined) throw new Error('Direct draw has no selected submesh');
        resource = source.materials[submesh.materialSlot] ?? source.material;
      } else {
        resource = selection[index] as MaterialResource;
      }
      if (resource === first) continue;
      if (first === undefined) first = resource;
      else {
        others ??= new Set();
        if (others.has(resource)) continue;
        others.add(resource);
      }
      const accepted = this.get(resource);
      if (accepted === undefined) throw new Error('Direct draw has no accepted material version');
      for (const pass of accepted.passes) {
        if (pass.tags.LightMode === 'ShadowCaster' && source.shadowCaster === false) continue;
        visit(
          {
            ...pass,
            entityIndex: source.entityKey as EntityHandle,
            renderableIndex,
            layer: source.layer ?? 0,
          },
          getOpaqueResourceIdentity(pass),
        );
      }
    }
  }

  get(material: MaterialResource): AcceptedMaterial | undefined {
    const address = MaterialResource._frameAddress(material);
    const pages = this.block(Math.floor(address / MATERIAL_BLOCK_WIDTH))?.value;
    return pages?.[Math.floor((address % MATERIAL_BLOCK_WIDTH) / MATERIAL_PAGE_WIDTH)]?.[
      address % MATERIAL_PAGE_WIDTH
    ];
  }

  /** Seal the changed lanes once for all readers of these two issued versions. */
  publishChangesSince(previous: MaterialFrame): void {
    if (previous === this) return;
    const masks: number[] = [];
    const beforePages: (MaterialPage | undefined)[] = [];
    const afterPages: (MaterialPage | undefined)[] = [];
    // Only a culling reader needs this projection. Inspect changed lanes while publishing their masks.
    let retainedCullRevision =
      #cullRevision in previous && !this.hasBorrowedValues && !previous.hasBorrowedValues
        ? previous.#cullRevision
        : 0;
    visitChangedMaterialPages(previous.root, this.root, (before, after) => {
      let mask = 0;
      const length = Math.max(before?.length ?? 0, after?.length ?? 0);
      for (let lane = 0; lane < length; lane++) {
        const left = before?.[lane],
          right = after?.[lane];
        if (left === right) continue;
        mask |= 1 << lane;
        if (
          retainedCullRevision !== 0 &&
          left?.snapshot !== right?.snapshot &&
          (left === undefined ||
            right === undefined ||
            ownedMaterialBounds(left.snapshot) === undefined ||
            ownedMaterialBounds(right.snapshot) === undefined ||
            !sameMaterialCullingBounds(left.snapshot, right.snapshot))
        )
          retainedCullRevision = 0;
      }
      if (mask !== 0) {
        masks.push(mask);
        beforePages.push(before);
        afterPages.push(after);
      }
    });
    if (retainedCullRevision !== 0) this.#cullRevision = retainedCullRevision;
    previous.outgoing = { masks, pages: beforePages };
    this.incoming = { masks, pages: afterPages };
  }

  /** Shared subtrees are identical evidence; only changed asset paths are visited. */
  changesSince(
    previous: MaterialFrame,
    visit: (before: AcceptedMaterial | undefined, after: AcceptedMaterial | undefined) => void,
  ): void {
    if (this === previous) return;
    const after = this.incoming;
    const before = previous.outgoing;
    if (after !== undefined && before?.masks === after.masks) {
      for (let page = 0; page < after.masks.length; page++) {
        let mask = after.masks[page] as number;
        const left = before.pages[page];
        const right = after.pages[page];
        while (mask !== 0) {
          const lane = 31 - Math.clz32(mask & -mask);
          visit(left?.[lane], right?.[lane]);
          mask &= mask - 1;
        }
      }
      return;
    }
    visitChangedMaterialPages(previous.root, this.root, (before, after) => {
      const length = Math.max(before?.length ?? 0, after?.length ?? 0);
      for (let lane = 0; lane < length; lane++) {
        const prior = before?.[lane];
        const next = after?.[lane];
        if (prior !== next) visit(prior, next);
      }
    });
  }
}

const MATERIAL_FRAME_GET = MaterialFrame.prototype.get;
const MATERIAL_FRAME_BORROWED = Object.getOwnPropertyDescriptor(
  MaterialFrame.prototype,
  'hasBorrowedValues',
)?.get;

/** The immutable binding groups contain the actual order. Each reader holds only its page cursors. */
function workSlots(work: Work, rank = 0): RosterCursor | MergedBindings {
  return work.groups.size === 1
    ? new RosterCursor(work.groups.value, rank)
    : new MergedBindings(work, rank);
}

/** Walk the physical page values without retaining a flattened copy of the pass. */
function visitWorkBindings(work: Work, visit: (slot: number) => void): void {
  if (work.groups.size === 1) {
    for (const { value: page } of nodes(work.groups.value)) {
      const values = page.values;
      for (let i = 0; i < values.length; i++) visit(values[i] as number);
    }
    return;
  }
  const merged = new MergedBindings(work);
  while (merged.next()) visit(merged.value);
}

/** Seek a deep slice by the group page counts, without merging and discarding its entire prefix. */
function mergedStartKey(groups: Node<Roster>, rank: number): number | undefined {
  if (rank <= groups.size) return undefined;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const { value } of nodes(groups)) {
    let first = value;
    while (first.left !== undefined) first = first.left;
    low = Math.min(low, first.key);
    high = Math.max(high, rosterLastKey(value));
  }
  // Engine entities have safe integer identities. Foreign numeric rosters can still walk in order.
  if (
    !Number.isSafeInteger(low) ||
    !Number.isSafeInteger(high) ||
    !Number.isSafeInteger(high - low)
  )
    return undefined;
  while (low < high) {
    const pivot = low + Math.ceil((high - low) / 2);
    let before = 0;
    for (const { value } of nodes(groups)) {
      before += rosterRankBefore(value, pivot);
      if (before > rank) break;
    }
    if (before > rank) high = pivot - 1;
    else low = pivot;
  }
  return low;
}

/** One page cursor per material binding group, merged in the original entity order. */
class MergedBindings {
  private readonly heap: RosterCursor[] = [];
  value = 0;

  constructor(work: Work, rank = 0) {
    const startKey = mergedStartKey(work.groups, rank);
    let remaining = rank;
    for (const { value: root } of nodes(work.groups)) {
      const start = startKey === undefined ? 0 : rosterRankBefore(root, startKey);
      remaining -= start;
      const cursor = new RosterCursor(root, start);
      if (cursor.next()) this.push(cursor);
    }
    for (let i = 0; i < remaining; i++) this.next();
  }

  private push(cursor: RosterCursor): void {
    let i = this.heap.length;
    this.heap.push(cursor);
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      const prior = this.heap[parent] as RosterCursor;
      if (prior.key <= cursor.key) break;
      this.heap[i] = prior;
      i = parent;
    }
    this.heap[i] = cursor;
  }

  next(): boolean {
    const heap = this.heap;
    const first = heap[0];
    if (first === undefined) return false;
    this.value = first.value;
    const next = first.next() ? first : (heap.pop() as RosterCursor);
    if (heap.length === 0) return true;
    let i = 0;
    for (let child = 1; child < heap.length; child = i * 2 + 1) {
      if (
        child + 1 < heap.length &&
        (heap[child + 1] as RosterCursor).key < (heap[child] as RosterCursor).key
      )
        child++;
      const smaller = heap[child] as RosterCursor;
      if (smaller.key >= next.key) break;
      heap[i] = smaller;
      i = child;
    }
    heap[i] = next;
    return true;
  }
}

/** Publicly materialized entries have one owner per 32 physical slots of a Pass.
 * A sparse page keeps its one entry inline. Most rendering consumers read only numeric slots. */
class ObservedPassPage {
  used = 0;
  previous = 0;
  address = 0;
  proven = 0;
  currentNext: ObservedPassPage | undefined;
  previousNext: ObservedPassPage | undefined;
  private singleLane = -1;
  private single: DispatchEntry | undefined;
  private many: (DispatchEntry | undefined)[] | undefined;

  constructor(
    readonly pass: Pass,
    readonly id: number,
  ) {}

  read(lane: number): DispatchEntry | undefined {
    return this.singleLane === lane ? this.single : this.many?.[lane];
  }
  write(lane: number, entry: DispatchEntry): void {
    if (this.many !== undefined) this.many[lane] = entry;
    else if (this.singleLane === -1 || this.singleLane === lane) {
      this.singleLane = lane;
      this.single = entry;
    } else {
      this.many = [];
      this.many[this.singleLane] = this.single;
      this.many[lane] = entry;
      this.singleLane = -1;
      this.single = undefined;
    }
  }
  retirePrevious(): void {
    this.proven &= this.used;
    const rows = this.many;
    if (rows === undefined) return;
    if ((this.used & (this.used - 1)) === 0) {
      this.singleLane = 31 - Math.clz32(this.used);
      this.single = rows[this.singleLane];
      this.many = undefined;
      return;
    }
    let expired = this.previous & ~this.used;
    while (expired !== 0) {
      rows[31 - Math.clz32(expired & -expired)] = undefined;
      expired &= expired - 1;
    }
  }
}

class DispatchEntries {
  private nextAddress = 0;
  private readonly passes = new Map<Pass, Map<number, ObservedPassPage>>();
  private current: ObservedPassPage | undefined;
  private previous: ObservedPassPage | undefined;
  private pass: Pass | undefined;
  private pages: Map<number, ObservedPassPage> | undefined;

  issueAddress(): number {
    return ++this.nextAddress;
  }

  private pagesOf(pass: Pass): Map<number, ObservedPassPage> | undefined {
    if (this.pass !== pass) {
      this.pass = pass;
      this.pages = this.passes.get(pass);
    }
    return this.pages;
  }

  rotate(): void {
    let page = this.previous;
    while (page !== undefined) {
      const next = page.previousNext;
      page.previousNext = undefined;
      if (page.used === 0) {
        const pages = this.passes.get(page.pass);
        pages?.delete(page.id);
        if (pages?.size === 0) this.passes.delete(page.pass);
      } else page.retirePrevious();
      page = next;
    }
    page = this.current;
    this.previous = page;
    this.current = undefined;
    this.pass = undefined;
    this.pages = undefined;
    while (page !== undefined) {
      page.previous = page.used;
      page.used = 0;
      page.previousNext = page.currentNext;
      page.currentNext = undefined;
      page = page.previousNext;
    }
  }

  /** An observed row already carries its rank for this particular issuing frame. */
  rank(frame: FrameDispatch, pass: Pass, slot: number): number | undefined {
    const page = this.pagesOf(pass)?.get(Math.floor(slot / 32));
    const lane = slot & 31;
    return page?.address === frame.address && (page.proven & (1 << lane)) !== 0
      ? page.read(lane)?.renderableIndex
      : frame.slots.indexOfSlot(slot);
  }

  get(frame: FrameDispatch, pass: Pass, slot: number): DispatchEntry {
    const id = Math.floor(slot / 32);
    const lane = slot & 31;
    const bit = 1 << lane;
    let page = this.pagesOf(pass)?.get(id);
    let entry = page?.read(lane);
    if (
      page === undefined ||
      page.address !== frame.address ||
      (page.proven & bit) === 0 ||
      entry === undefined
    ) {
      entry = frame.resolveEntry(pass, slot, entry);
      // Resolve can throw or re-enter through a foreign slot accessor. Publish only after it returns.
      let pages = this.pagesOf(pass);
      if (pages === undefined) {
        pages = new Map();
        this.pages = pages;
        this.passes.set(pass, pages);
      }
      page = pages.get(id);
      if (page === undefined) {
        page = new ObservedPassPage(pass, id);
        pages.set(id, page);
      }
      if (page.address !== frame.address) {
        page.address = frame.address;
        page.proven = 0;
      }
      page.write(lane, entry);
      page.proven |= bit;
    }
    if (page.used === 0) {
      page.currentNext = this.current;
      this.current = page;
    }
    page.used |= bit;
    return entry;
  }

  clear(): void {
    this.passes.clear();
    this.current = undefined;
    this.previous = undefined;
    this.pass = undefined;
    this.pages = undefined;
  }
}

class FrameDispatch extends FrameListBase<DispatchEntry> {
  readonly address: number;
  readonly length: number;
  constructor(
    private readonly root: Node<Work> | undefined,
    readonly slots: SceneSlotFrame,
    private readonly dispatchEntries: DispatchEntries,
    private readonly bindingRoot: Node<Float64Array> | undefined,
  ) {
    super();
    this.address = dispatchEntries.issueAddress();
    this.length = root?.count ?? 0;
  }
  private pageId = -1;
  private addresses: Float64Array | undefined;
  entry(pass: Pass, slot: number): DispatchEntry {
    return this.dispatchEntries.get(this, pass, slot);
  }

  resolveEntry(pass: Pass, slot: number, prior?: DispatchEntry): DispatchEntry {
    const rank = this.slots.indexOfSlot(slot);
    if (rank === undefined) throw new Error('Missing material binding frame address');
    const page = this.bindingPage(slot);
    const offset = bindingOffset(slot);
    const entity = page[offset] as number;
    const layer = page[offset + 1] as number;
    return prior?.entityIndex === entity && prior.renderableIndex === rank && prior.layer === layer
      ? prior
      : dispatchEntry(pass, entity, rank, layer);
  }

  private bindingPage(slot: number): Float64Array {
    const id = bindingPageId(slot);
    if (this.pageId !== id) {
      let node = this.bindingRoot;
      while (node !== undefined && node.key !== id) node = id < node.key ? node.left : node.right;
      this.addresses = node?.value;
      this.pageId = id;
    }
    const page = this.addresses;
    if (page === undefined) throw new Error('Missing captured material binding page');
    return page;
  }
  /** Complete synchronous consumers need no cursor for each already captured Pass roster. */
  override forEach(consume: (value: DispatchEntry, index: number) => void): void {
    const iterator = this[Symbol.iterator];
    if (iterator !== nativeDispatchIterator) {
      forEachCustomDispatch(this, iterator, consume);
      return;
    }
    let index = 0;
    let pass: Pass;
    const read = (slot: number) => consume(this.entry(pass, slot), index++);
    for (const { value: work } of nodes(this.root)) {
      pass = work.pass;
      visitWorkBindings(work, read);
    }
  }
  [Symbol.iterator](): IterableIterator<DispatchEntry> {
    return new FrameDispatchIterator(this, this.root);
  }
  /** Cull each physical member before issuing an entry. Preserve pass ranges in the
   * compact rank domain so view consumers can classify a whole output pass. */
  projectView(
    projectRank: (rank: number, shadow: boolean) => number,
    directLimit: number,
    previous?: PreviousViewDispatch,
    domain?: symbol,
  ): CulledDispatch {
    const output: (DispatchEntry | number)[] = [];
    const bindings: ViewBindingSpan[] = [];
    let binding: ViewBindingSpan | undefined;
    const ranges: CulledPassRange[] = [];
    const programs = new Set<string>();
    let shadowCoverage: ForwardShadowCoverage = 'empty';
    let fixed = true;
    let pass: Pass;
    let shadow = false;
    const prior = previous?.dispatch;
    const priorRanges = prior && isCulledDispatch(prior) ? prior.ranges : undefined;
    const sameSource = priorRanges !== undefined && previous?.sourceDispatch === this;
    let priorRange = 0;
    let priorOutput = 0;
    const visit = (slot: number) => {
      const sourceRank = slot < directLimit ? slot : this.memberRank(pass, slot);
      const rank = projectRank(sourceRank, shadow);
      const oldRank =
        previous && sourceRank < previous.rowCount
          ? previous.projection.address(sourceRank, shadow)
          : -1;
      const oldIndex = sameSource && oldRank >= 0 ? priorOutput++ : output.length;
      if (rank < 0) return;
      if (rank === sourceRank) {
        output.push(this.entry(pass, slot));
        return;
      }
      // An unchanged input sequence identifies the prior draw exactly. Across
      // publications also prove the Pass, source address, entity and layer.
      let candidate: DispatchEntry | undefined;
      if (rank === oldRank && prior !== undefined) {
        if (sameSource) {
          output.push(prior.at(oldIndex) as DispatchEntry);
          return;
        }
        if (priorRanges !== undefined) {
          while (
            priorRange < priorRanges.length &&
            oldIndex >= (priorRanges[priorRange] as CulledPassRange).end
          )
            priorRange++;
          if (priorRanges[priorRange]?.pass === pass) candidate = prior.at(oldIndex);
        }
      }
      const page = this.bindingPage(slot);
      const at = bindingOffset(slot);
      const entity = page[at] as number;
      const layer = page[at + 1] as number;
      if (
        candidate?.renderableIndex === rank &&
        candidate.entityIndex === entity &&
        candidate.layer === layer
      ) {
        output.push(candidate);
      } else if (pass[ownedShadowCoverage] === undefined) {
        output.push(dispatchEntry(pass, entity, rank, layer));
      } else {
        if (binding?.page !== page || binding.pass !== pass) {
          binding = { start: output.length, page, pass };
          bindings.push(binding);
        }
        output.push(rank * BINDING_PAGE_SIZE + (slot % BINDING_PAGE_SIZE));
      }
    };
    for (const { value: work } of nodes(this.root)) {
      pass = work.pass;
      shadow = pass.tags.LightMode === 'ShadowCaster';
      const start = output.length;
      visitWorkBindings(work, visit);
      if (output.length === start) continue;
      ranges.push({ pass, resource: work.resource, end: output.length });
      if (!fixed) continue;
      const coverage = pass[ownedShadowCoverage];
      if (coverage === undefined) {
        fixed = false;
        continue;
      }
      programs.add(pass.materialShaderId);
      if (coverage !== 'empty' && shadowCoverage !== 'incompatible') shadowCoverage = coverage;
    }
    return new CulledDispatch(
      output,
      bindings,
      ranges,
      fixed ? { programs, shadow: shadowCoverage } : undefined,
      domain,
    );
  }

  /** Membership consumers need each physical rank, independent of draw order. */
  visitPassRanks(lane: 'display' | 'shadow', visit: (index: number) => void): void {
    const shadow = lane === 'shadow';
    const limit = SceneSlotFrame.directRankLimit(this.slots);
    let pass: Pass;
    const visitPage = (page: RosterPage): void => {
      const slots = page.values;
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i] as number;
        visit(limit !== undefined && slot < limit ? slot : this.memberRank(pass, slot));
      }
    };
    const visitRoster = (roster: Roster): void => visitUnorderedValues(roster, visitPage);
    let lastGroups: Node<Roster> | undefined;
    for (const { value: work } of nodes(this.root)) {
      if ((work.pass.tags.LightMode === 'ShadowCaster') !== shadow) continue;
      if (limit === undefined) {
        // An authored indexed reader observes the original Pass and entity order.
        visitWorkBindings(work, (slot) => visit(this.memberRank(work.pass, slot)));
        continue;
      }
      if (work.groups === lastGroups) continue;
      lastGroups = work.groups;
      pass = work.pass;
      visitUnorderedValues(work.groups, visitRoster);
    }
  }

  private memberRank(pass: Pass, slot: number): number {
    const rank = this.dispatchEntries.rank(this, pass, slot);
    if (rank === undefined) throw new Error('Missing material binding frame address');
    return rank;
  }

  somePass(matches: (pass: MaterialDispatchPass, material: MaterialResource) => boolean): boolean {
    for (const { value } of nodes(this.root))
      if (value.groups.count > 0 && matches(value.pass, value.resource)) return true;
    return false;
  }

  visitCasterMaterials(visit: (material: MaterialResource) => void): void {
    for (const { value: work } of nodes(this.root))
      if (work.pass.tags.LightMode === 'ShadowCaster' && work.groups.count > 0)
        visit(work.resource);
  }

  /** Pass-level work without visiting members; a pass fact classifies all of its entries. */
  *passWork(): Generator<DispatchPassWork> {
    for (const { value: work } of nodes(this.root)) yield this.passWorkOf(work);
  }
  get lineage(): object {
    return this.dispatchEntries;
  }
  private passWorkOf(work: Work): DispatchPassWork {
    const dispatch = this;
    return {
      pass: work.pass,
      resource: work.resource,
      count: work.groups.count,
      visitSlots: (visit) => visitWorkBindings(work, visit),
      *entries() {
        const slots = workSlots(work);
        while (slots.next()) yield dispatch.entry(work.pass, slots.value);
      },
    };
  }
  /**
   * Pass work that differs from `previous` of the same dispatch owner, keyed by
   * its stable work identity; false when `previous` is unrelated. Shared
   * subtrees are not visited.
   */
  passWorkChangesSince(
    previous: DispatchList,
    visit: (id: string, after: DispatchPassWork | undefined) => void,
  ): boolean {
    if (!(previous instanceof FrameDispatch) || previous.dispatchEntries !== this.dispatchEntries)
      return false;
    changes(previous.root, this.root, (_before, after, key, queue) =>
      visit(`${queue}:${key}`, after === undefined ? undefined : this.passWorkOf(after)),
    );
    return true;
  }
  /** Every Pass work with the identity `passWorkChangesSince` reports. */
  *identifiedPassWork(): Generator<readonly [id: string, work: DispatchPassWork]> {
    for (const { value, key, queue } of nodes(this.root))
      yield [`${queue}:${key}`, this.passWorkOf(value)];
  }
  /** Number of ordinary commands before a producer appended at the end of this queue. */
  endOfQueue(queue: number): number {
    let rank = 0;
    for (let node = this.root; node !== undefined; ) {
      if (node.queue > queue) node = node.left;
      else {
        rank += (node.left?.count ?? 0) + node.weight;
        node = node.right;
      }
    }
    return rank;
  }
  at(index: number): DispatchEntry | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    const work = at(this.root, index);
    if (work === undefined) return undefined;
    const current = work.node.value;
    if (current.groups.size === 1) {
      const row = at(current.groups.value, work.offset);
      const slot = row?.node.value.values[row.offset];
      return slot === undefined ? undefined : this.entry(current.pass, slot);
    }
    const slots = new MergedBindings(current, work.offset);
    return slots.next() ? this.entry(current.pass, slots.value) : undefined;
  }
  override slice(start = 0, end = this.length): DispatchEntry[] {
    start = Math.trunc(start) || 0;
    end = Math.trunc(end) || 0;
    start = start < 0 ? Math.max(0, this.length + start) : Math.min(start, this.length);
    end = end < 0 ? Math.max(0, this.length + end) : Math.min(end, this.length);
    const result: DispatchEntry[] = [];
    for (const { value, start: first, end: last } of range(this.root, start, end)) {
      const slots = workSlots(value, first);
      for (let i = first; i < last && slots.next(); i++)
        result.push(this.entry(value.pass, slots.value));
    }
    return result;
  }
}

/** Each walk owns its cursor and reads the issuing frame. */
const nativeDispatchIterator = FrameDispatch.prototype[Symbol.iterator];
const nativeDispatchAt = FrameDispatch.prototype.at;

/** One generated queue inserted into the captured material commands at its stable tie boundary. */
class GeneratedQueue extends FrameListBase<DispatchEntry> {
  readonly length: number;
  constructor(
    private readonly base: FrameDispatch,
    private readonly offset: number,
    private readonly added: readonly DispatchEntry[],
  ) {
    super();
    this.length = base.length + added.length;
  }
  at(index: number): DispatchEntry | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    if (index < this.offset) return this.base.at(index);
    if (index < this.offset + this.added.length) return this.added[index - this.offset];
    return this.base.at(index - this.added.length);
  }
  *[Symbol.iterator](): IterableIterator<DispatchEntry> {
    let rank = 0;
    for (const entry of this.base) {
      if (rank++ === this.offset) yield* this.added;
      yield entry;
    }
    if (rank === this.offset) yield* this.added;
  }
}

/** A custom traversal publishes its original draw rows before the view producer runs. */
export function captureGeneratedQueueSource(base: DispatchList): DispatchList {
  return base instanceof FrameDispatch &&
    nativePassRoster(base) !== undefined &&
    !Object.hasOwn(base, 'at') &&
    Object.getOwnPropertyDescriptor(FrameDispatch.prototype, 'at')?.value === nativeDispatchAt
    ? base
    : [...base];
}

/** Keep the source pass order and append equal-queue generated commands after existing ties. */
export function appendGeneratedQueue(
  base: DispatchList,
  added: readonly DispatchEntry[],
): DispatchList {
  const queue = added[0]?.queue;
  if (base instanceof FrameDispatch) {
    if (queue === undefined) return base;
    if (Number.isFinite(queue) && added.every((entry) => entry.queue === queue))
      return new GeneratedQueue(base, base.endOfQueue(queue), added);
  }
  return [...base, ...added].sort((a, b) => a.queue - b.queue);
}

/** A captured root with the native walk: one identity always lists the same Pass members. */
export function isCapturedDispatch(list: DispatchList): boolean {
  return list instanceof FrameDispatch && list[Symbol.iterator] === nativeDispatchIterator;
}

/** Classify the occupied pass rows without expanding their member instances. */
export function someCapturedMaterialPass(
  list: Iterable<DispatchEntry>,
  matches: (pass: MaterialDispatchPass, material: MaterialResource) => boolean,
): boolean | undefined {
  if (list instanceof FrameDispatch && list[Symbol.iterator] === nativeDispatchIterator)
    return list.somePass(matches);
  if (!isCulledDispatch(list)) return undefined;
  const { ranges } = list;
  for (const { pass, resource } of ranges) if (matches(pass, resource)) return true;
  return false;
}

/** Native pass ranks address this exact captured physical row roster. */
export function capturedDispatchAddresses(list: DispatchList, slots: SceneSlotFrame): boolean {
  const roster = nativePassRoster(list);
  return (
    roster !== undefined && roster.identities === slots.identities && roster.length === slots.length
  );
}

function nativePassRoster(list: DispatchList): SceneSlotFrame | undefined {
  if (
    !(list instanceof FrameDispatch) ||
    Object.getPrototypeOf(list) !== FrameDispatch.prototype ||
    Object.hasOwn(list, Symbol.iterator) ||
    Object.getOwnPropertyDescriptor(FrameDispatch.prototype, Symbol.iterator)?.value !==
      nativeDispatchIterator
  )
    return undefined;
  return list.slots;
}

interface CulledPassRange {
  readonly pass: Pass;
  readonly resource: MaterialResource;
  readonly end: number;
}

interface CulledViewDemand {
  readonly programs: ReadonlySet<string>;
  readonly shadow: ForwardShadowCoverage;
}

interface ViewBindingSpan {
  readonly start: number;
  readonly page: Float64Array;
  readonly pass: Pass;
}

/** Pass classification and membership need only numeric view ranks. A public draw
 * receives its ordinary own fields on first observation. Adjacent draws share the immutable
 * binding page. An in-flight view holds neither earlier views nor the source scene. */
class CulledDispatch extends FrameListBase<DispatchEntry> {
  constructor(
    private readonly rows: (number | DispatchEntry)[],
    private readonly bindings: readonly ViewBindingSpan[],
    readonly ranges: readonly CulledPassRange[],
    readonly demand: CulledViewDemand | undefined,
    readonly domain: symbol | undefined,
  ) {
    super();
  }

  get length(): number {
    return this.rows.length;
  }

  rankAt(index: number): number {
    const row = this.rows[index] as DispatchEntry | number;
    return typeof row === 'number' ? Math.floor(row / BINDING_PAGE_SIZE) : row.renderableIndex;
  }

  private issue(index: number, span: ViewBindingSpan, address: number): DispatchEntry {
    const offset = (address % BINDING_PAGE_SIZE) * 2;
    const draw = dispatchEntry(
      span.pass,
      span.page[offset] as number,
      Math.floor(address / BINDING_PAGE_SIZE),
      span.page[offset + 1] as number,
    );
    this.rows[index] = draw;
    return draw;
  }

  at(index: number): DispatchEntry | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    const row = this.rows[index];
    if (typeof row !== 'number') return row;
    let lo = 0;
    let hi = this.bindings.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if ((this.bindings[mid] as ViewBindingSpan).start <= index) lo = mid;
      else hi = mid - 1;
    }
    return this.issue(index, this.bindings[lo] as ViewBindingSpan, row);
  }

  [Symbol.iterator](): IterableIterator<DispatchEntry> {
    let index = 0;
    let span = 0;
    const result: { done: boolean; value: DispatchEntry | undefined } = {
      done: false,
      value: undefined,
    };
    let view: CulledDispatch | undefined = this;
    const close = (): IteratorResult<DispatchEntry> => {
      view = undefined;
      result.done = true;
      result.value = undefined;
      return result as IteratorResult<DispatchEntry>;
    };
    return {
      [Symbol.iterator]() {
        return this;
      },
      next: () => {
        if (view === undefined || index >= view.length) return close();
        const row = view.rows[index] as number | DispatchEntry;
        if (typeof row === 'number') {
          const bindings = view.bindings;
          while (
            span + 1 < bindings.length &&
            (bindings[span + 1] as ViewBindingSpan).start <= index
          )
            span++;
          result.value = view.issue(index, bindings[span] as ViewBindingSpan, row);
        } else result.value = row;
        index++;
        return result as IteratorResult<DispatchEntry>;
      },
      return: close,
    };
  }
}

const culledIterator = CulledDispatch.prototype[Symbol.iterator];

/** Only detached pass declarations can publish demand with their projected membership. */
export function culledViewDemand(list: Iterable<DispatchEntry>): CulledViewDemand | undefined {
  return isCulledDispatch(list) ? list.demand : undefined;
}

/** A caller-defined iterator owns its reads. */
function isCulledDispatch(list: Iterable<DispatchEntry>): list is CulledDispatch {
  return (
    list instanceof CulledDispatch &&
    Object.getPrototypeOf(list) === CulledDispatch.prototype &&
    !Object.hasOwn(list, Symbol.iterator) &&
    list[Symbol.iterator] === culledIterator
  );
}

interface PreviousViewDispatch {
  readonly sourceDispatch: DispatchList;
  readonly dispatch: DispatchList;
  readonly rowCount: number;
  readonly projection: { address(index: number, shadow: boolean): number };
}

/** Capture only the actual members of each occupied Pass at this view's ranks. */
export function projectCapturedViewDispatch(
  list: DispatchList,
  projectRank: (rank: number, shadow: boolean) => number,
  previous?: PreviousViewDispatch,
  domain?: symbol,
): DispatchList | undefined {
  const roster = nativePassRoster(list);
  if (roster === undefined || !(list instanceof FrameDispatch)) return undefined;
  const limit = SceneSlotFrame.directRankLimit(roster);
  return limit === undefined ? undefined : list.projectView(projectRank, limit, previous, domain);
}

/** The sort phase can select occupied intervals without reading per-instance fields. */
export function culledMaterialPassRanges(
  list: DispatchList,
): readonly CulledPassRange[] | undefined {
  return isCulledDispatch(list) ? list.ranges : undefined;
}

/** The sorted view owns only the moved positions. Its source still owns all
 * draws and the original material membership used by order-independent plans. */
class OrderedCulledDraws extends FrameListBase<DispatchEntry> {
  constructor(
    readonly source: CulledDispatch,
    private readonly moves: readonly number[],
  ) {
    super();
  }
  get length(): number {
    return this.source.length;
  }
  at(index: number): DispatchEntry | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    let lo = 0,
      hi = this.moves.length / 2;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((this.moves[mid * 2] as number) < index) lo = mid + 1;
      else hi = mid;
    }
    return this.source.at(
      this.moves[lo * 2] === index ? (this.moves[lo * 2 + 1] as number) : index,
    );
  }
  [Symbol.iterator](): IterableIterator<DispatchEntry> {
    let cursor = 0;
    return new ProjectionIterator(this.source[Symbol.iterator](), (entry, index) => {
      if (this.moves[cursor] !== index) return entry;
      const from = this.moves[cursor + 1] as number;
      cursor += 2;
      return this.source.at(from) as DispatchEntry;
    });
  }
}
const orderedIterator = OrderedCulledDraws.prototype[Symbol.iterator];

/** Publish one permutation. Foreign arrays keep their ordinary indexed contract. */
export function orderMaterialDraws(
  dispatch: DispatchList,
  positions: ArrayLike<number>,
  count: number,
  from: (ordinal: number) => number,
): DispatchList {
  if (!isCulledDispatch(dispatch)) {
    const result = dispatch.slice();
    for (let i = 0; i < count; i++) {
      const source = from(i);
      result[positions[i] as number] = Array.isArray(dispatch)
        ? dispatch[source]
        : (dispatch.at(source) as DispatchEntry);
    }
    return result;
  }
  let moves: number[] | undefined;
  for (let i = 0; i < count; i++) {
    const target = positions[i] as number,
      source = from(i);
    if (target !== source) {
      moves ??= [];
      moves.push(target, source);
    }
  }
  return moves === undefined ? dispatch : Object.freeze(new OrderedCulledDraws(dispatch, moves));
}

/** Aggregate only the bindings that culling issued in this renderable address domain. */
export function culledPassMembership(
  list: DispatchList,
  domain: symbol,
): Pick<CulledDispatch, 'ranges' | 'rankAt'> | undefined {
  const source =
    list instanceof OrderedCulledDraws &&
    Object.getPrototypeOf(list) === OrderedCulledDraws.prototype &&
    list[Symbol.iterator] === orderedIterator
      ? list.source
      : list;
  return isCulledDispatch(source) && source.domain === domain ? source : undefined;
}

export function visitCulledPassRanks(
  list: DispatchList,
  select: (pass: Pass, resource: MaterialResource) => boolean,
  visit: (rank: number) => void,
): boolean {
  if (!isCulledDispatch(list)) return false;
  const { ranges } = list;
  let start = 0;
  for (const { pass, resource, end } of ranges) {
    if (select(pass, resource)) for (let i = start; i < end; i++) visit(list.rankAt(i));
    start = end;
  }
  return true;
}

/** A borrowed or overridden iterator keeps its own observable traversal. */
export function visitCapturedPassRanks(
  list: DispatchList,
  lane: 'display' | 'shadow',
  visit: (index: number) => void,
): boolean {
  if (list instanceof CulledDispatch)
    return visitCulledPassRanks(
      list,
      (pass) => (pass.tags.LightMode === 'ShadowCaster') === (lane === 'shadow'),
      visit,
    );
  if (!(list instanceof FrameDispatch) || nativePassRoster(list) === undefined) return false;
  list.visitPassRanks(lane, visit);
  return true;
}

/** Set caster bits in caller-owned storage. Custom dispatches keep their iterator semantics. */
export function writeCapturedCasterRanks(
  list: DispatchList,
  words: Uint32Array,
  count: number,
): boolean {
  if (!(list instanceof FrameDispatch) || nativePassRoster(list) === undefined) return false;
  list.visitPassRanks('shadow', (rank) => {
    if (rank >= 0 && rank < count) {
      const word = rank >>> 5;
      words[word] = (words[word] ?? 0) | (1 << (rank & 31));
    }
  });
  return true;
}

/** Preserve a custom iterator's single lookup, receiver and IteratorClose. */
function forEachCustomDispatch(
  frame: FrameDispatch,
  iterator: FrameDispatch[typeof Symbol.iterator],
  consume: (value: DispatchEntry, index: number) => void,
): void {
  const values = { [Symbol.iterator]: () => iterator.call(frame) };
  let index = 0;
  for (const value of values) consume(value, index++);
}

class FrameDispatchIterator implements IterableIterator<DispatchEntry> {
  private works: IterableIterator<Node<Work>> | undefined;
  private pass: Pass | undefined;
  private slots: RosterCursor | MergedBindings | undefined;
  private readonly result: { value: DispatchEntry | undefined; done: boolean } = {
    value: undefined,
    done: false,
  };
  constructor(
    private frame: FrameDispatch | undefined,
    root: Node<Work> | undefined,
  ) {
    this.works = nodes(root);
  }
  next(): IteratorResult<DispatchEntry> {
    if (this.works === undefined) return this.result as IteratorResult<DispatchEntry>;
    try {
      while (this.slots === undefined || !this.slots.next()) {
        const next = this.works.next();
        if (next.done) return this.return();
        const work = next.value.value;
        this.pass = work.pass;
        this.slots = workSlots(work);
      }
      this.result.value = (this.frame as FrameDispatch).entry(this.pass as Pass, this.slots.value);
      return this.result as IteratorResult<DispatchEntry>;
    } catch (cause) {
      this.return();
      throw cause;
    }
  }
  return(): IteratorResult<DispatchEntry> {
    this.frame = undefined;
    this.works = undefined;
    this.slots = undefined;
    this.pass = undefined;
    this.result.value = undefined;
    this.result.done = true;
    return this.result as IteratorResult<DispatchEntry>;
  }
  [Symbol.iterator](): IterableIterator<DispatchEntry> {
    return this;
  }
}

/**
 * Pass-level work of a material query result, with the slot roster its entry
 * addresses rank into; `undefined` for any other (already flat) list.
 */
export function dispatchPassWork(list: DispatchList):
  | {
      readonly slots: number;
      readonly source: SceneSlotFrame;
      readonly work: Iterable<DispatchPassWork>;
      readonly dispatch: DispatchList &
        Pick<FrameDispatch, 'passWorkChangesSince' | 'identifiedPassWork'>;
      /** The dispatch owner; its successive frames diff against each other. */
      readonly lineage: object;
    }
  | undefined {
  return list instanceof FrameDispatch
    ? {
        slots: list.slots.length,
        source: list.slots,
        work: list.passWork(),
        dispatch: list,
        lineage: list.lineage,
      }
    : undefined;
}

/** Visit occupied caster passes in order, including casters retained by view culling. */
export function visitCapturedCasterMaterials(
  list: DispatchList,
  visit: (material: MaterialResource) => void,
): boolean {
  if (list instanceof FrameDispatch) {
    list.visitCasterMaterials(visit);
    return true;
  }
  if (!isCulledDispatch(list)) return false;
  const { ranges } = list;
  for (const { pass, resource } of ranges)
    if (pass.tags.LightMode === 'ShadowCaster') visit(resource);
  return true;
}

type MaterialBinding = Pick<
  RenderableSnapshot,
  'material' | 'materials' | 'materialBindingSources' | 'materialOverrides'
>;
interface BindingGroup {
  readonly residencyGroup: RenderResidencyGroup | undefined;
  readonly source: MaterialBinding;
  readonly worldId: number;
  readonly identity: number;
  readonly meshHandle: number | undefined;
  sourceHandles: ReadonlySet<number> | undefined;
  readonly held: readonly MaterialResource[];
  readonly key: string;
  readonly geometry: MeshMaterialGeometry;
  holders: number;
  members: Roster | undefined;
  /**
   * Visible members that cast no shadow. While none exist the caster set is
   * `members` itself; the first one forks `ownCasters` from the persistent
   * member tree, so all-caster groups keep one tree instead of two.
   */
  nonCasters: number;
  ownCasters: Roster | undefined;
  // Hidden preparation rows draw nothing but validate against the accepted
  // frame, so their effective (Mesh-default) materials must be resolved too.
  prepared: Roster | undefined;
  /** Ascending joins not yet appended to each roster; see {@link stageJoin}. */
  readonly staged: Record<GroupRoster, number[]>;
}
function attachGroup(
  index: Map<number, Set<BindingGroup>>,
  key: number,
  group: BindingGroup,
): void {
  let groups = index.get(key);
  if (groups === undefined) {
    groups = new Set();
    index.set(key, groups);
  }
  groups.add(group);
}

function detachGroup(
  index: Map<number, Set<BindingGroup>>,
  key: number,
  group: BindingGroup,
): void {
  const groups = index.get(key);
  groups?.delete(group);
  if (groups?.size === 0) index.delete(key);
}

type GroupRoster = 'members' | 'ownCasters' | 'prepared';
const GROUP_ROSTERS: readonly GroupRoster[] = ['members', 'ownCasters', 'prepared'];
/**
 * Joins are staged and merged in bulk on the next read of the group, so bulk
 * admission fills roster pages once instead of copying one page per member.
 */
function stageJoin(group: BindingGroup, roster: GroupRoster, identity: number, slot: number): void {
  group.staged[roster].push(identity, slot);
}
function flushGroupRoster(group: BindingGroup, roster: GroupRoster): void {
  const pending = group.staged[roster];
  if (pending.length === 0) return;
  group[roster] = rosterMerge(group[roster], pending);
  pending.length = 0;
}
function flushGroup(group: BindingGroup): BindingGroup {
  for (const roster of GROUP_ROSTERS) flushGroupRoster(group, roster);
  return group;
}
function joinGroup(group: BindingGroup, slot: number, flags: number, identity: number): void {
  if ((flags & VISIBLE) !== 0) {
    if ((flags & CASTER) === 0) {
      if (group.nonCasters++ === 0) {
        flushGroupRoster(group, 'members');
        group.ownCasters = group.members;
      }
    } else if (group.nonCasters > 0) {
      stageJoin(group, 'ownCasters', identity, slot);
    }
    stageJoin(group, 'members', identity, slot);
  }
  if ((flags & PREPARED) !== 0) stageJoin(group, 'prepared', identity, slot);
}
function leaveGroup(group: BindingGroup, flags: number, identity: number): void {
  flushGroup(group);
  group.members = rosterRemove(group.members, identity);
  if ((flags & VISIBLE) !== 0) {
    if ((flags & CASTER) === 0) {
      if (--group.nonCasters === 0) group.ownCasters = undefined;
    } else if (group.nonCasters > 0) {
      group.ownCasters = rosterRemove(group.ownCasters, identity);
    }
  }
  if ((flags & PREPARED) !== 0) group.prepared = rosterRemove(group.prepared, identity);
}
function groupCasters(group: BindingGroup): Roster | undefined {
  flushGroup(group);
  return group.nonCasters === 0 ? group.members : group.ownCasters;
}
/** Draw members or pipeline preparation both need the group's effective materials. */
function groupHasDemand(group: BindingGroup): boolean {
  flushGroup(group);
  return group.members !== undefined || group.prepared !== undefined;
}
function addRoot(
  roots: Node<Roster> | undefined,
  members: Roster | undefined,
  identity: number,
): Node<Roster> | undefined {
  return members === undefined ? roots : put(roots, members, 0, identity, members.count);
}
function addGroupWork(value: QueryWork, group: BindingGroup): QueryWork {
  flushGroup(group);
  return {
    ...value,
    members: addRoot(value.members, group.members, group.identity),
    casters: addRoot(value.casters, groupCasters(group), group.identity),
    prepared: addRoot(value.prepared, group.prepared, group.identity),
  };
}
function removeGroupWork(value: QueryWork, identity: number): QueryWork {
  return {
    ...value,
    members: remove(value.members, 0, identity),
    casters: remove(value.casters, 0, identity),
    prepared: remove(value.prepared, 0, identity),
  };
}
function workIsEmpty(value: QueryWork): boolean {
  return value.members === undefined && value.casters === undefined && value.prepared === undefined;
}
const EMPTY_WORK: QueryWork = Object.freeze({
  members: undefined,
  casters: undefined,
  prepared: undefined,
  passes: [],
});

/** Rebuild only changed material Pass roots; existing issued roots remain immutable. */
function projectAffectedMaterialWork(
  previousRoot: Node<Work> | undefined,
  work: Map<MaterialResource, QueryWork>,
  materials: MaterialFrame,
  sources: MaterialFrame,
  affected: ReadonlyMap<MaterialResource, readonly Pass[]>,
): { root: Node<Work> | undefined; materials: MaterialFrame } {
  let root = previousRoot;
  for (const [resource, previousPasses] of affected) {
    for (const pass of previousPasses)
      root = remove(root, pass.queue, getOpaqueResourceIdentity(pass));
    const value = work.get(resource);
    if (value === undefined) continue;
    if (workIsEmpty(value)) {
      work.delete(resource);
      const source = sources.get(resource);
      materials =
        source === undefined ? materials.without(resource) : materials.withAccepted(source, 0);
      continue;
    }
    const accepted = materials.get(resource);
    if (accepted === undefined) throw new Error('Pass query has no accepted material');
    materials = materials.withAccepted(accepted, value.members?.count ?? 0);
    work.set(resource, { ...value, passes: accepted.passes });
    for (const pass of accepted.passes) {
      const members = pass.tags.LightMode === 'ShadowCaster' ? value.casters : value.members;
      if (members !== undefined)
        root = put(
          root,
          { pass, resource, groups: members },
          pass.queue,
          getOpaqueResourceIdentity(pass),
          members.count,
        );
    }
  }
  return { root, materials };
}

/** Source bindings and asset roots; Pass work is produced only by an actual query. */
function sameElements(
  a: readonly unknown[] | undefined,
  b: readonly unknown[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}
interface BindingInputs {
  readonly residencyGroup: RenderResidencyGroup | undefined;
  readonly materials: RenderableSnapshot['materials'];
  readonly material: MaterialResource;
  readonly materialOverrides: RenderableSnapshot['materialOverrides'];
  readonly assetHandle: number | undefined;
  readonly geometry: MeshMaterialGeometry;
  readonly overrides: readonly (MaterialResource | undefined)[] | undefined;
  readonly direct: readonly MaterialResource[];
  readonly key: string;
}
/** A derived phase over the one binding authority; it owns no bindings or holds. */
class MaterialDemandProjection {
  readonly entries = new DispatchEntries();
  queryRoot: Node<Work> | undefined;
  queryDirty = true;
  queryWork = new Map<MaterialResource, QueryWork>();
  groupResources = new Map<BindingGroup, readonly MaterialResource[]>();
  readonly dirtyGroups = new Set<BindingGroup>();
  readonly dirtyPasses = new Set<MaterialResource>();
  fullQuery = true;
  previous: FrameDispatch | undefined;
  selection: RenderResidencySelection | undefined;

  private lastIssued?: WeakRef<MaterialFrame>;

  constructor(
    readonly phase: RenderResidencySelection['phase'],
    public materialFrame: MaterialFrame,
  ) {}

  issueMaterials(): MaterialFrame {
    const current = this.materialFrame;
    const previous = this.lastIssued?.deref();
    if (previous !== current) {
      if (previous !== undefined) current.publishChangesSince(previous);
      this.lastIssued = new WeakRef(current);
    }
    return current;
  }

  invalidate(): void {
    this.queryDirty = true;
    this.queryRoot = undefined;
    this.previous = undefined;
    this.fullQuery = true;
    this.dirtyGroups.clear();
    this.dirtyPasses.clear();
  }
  invalidatePasses(resource: MaterialResource): void {
    if (this.fullQuery || !this.queryWork.has(resource)) return;
    this.queryDirty = true;
    this.previous = undefined;
    this.dirtyPasses.add(resource);
  }
  invalidateGroup(group: BindingGroup): void {
    this.queryDirty = true;
    this.previous = undefined;
    if (!this.fullQuery) this.dirtyGroups.add(group);
  }
  /** Drop a dead group's own contribution without invoking material resolvers or querying. */
  retireGroup(group: BindingGroup, sources: MaterialFrame): void {
    const affected = new Map<MaterialResource, readonly Pass[]>();
    for (const resource of this.groupResources.get(group) ?? []) {
      const value = this.queryWork.get(resource);
      if (value === undefined) continue;
      affected.set(resource, value.passes);
      this.queryWork.set(resource, removeGroupWork(value, group.identity));
    }
    const updated = projectAffectedMaterialWork(
      this.queryRoot,
      this.queryWork,
      this.materialFrame,
      sources,
      affected,
    );
    this.queryRoot = updated.root;
    this.materialFrame = updated.materials;
    this.groupResources.delete(group);
    this.dirtyGroups.delete(group);
    for (const resource of affected.keys())
      if (!this.queryWork.has(resource)) this.dirtyPasses.delete(resource);
    this.previous = undefined;
  }
  clear(): void {
    this.invalidate();
    this.queryWork.clear();
    this.groupResources.clear();
    this.entries.clear();
    this.materialFrame = new MaterialFrame(undefined);
    this.selection = undefined;
  }
}

export interface ResidentMaterialDemand {
  readonly dispatch: DispatchList;
  readonly materials: MaterialFrame;
  /** Binding qualification only; World/content guards and native leases stay with the caller. */
  readonly isCurrent: () => boolean;
}

export class MaterialDispatch {
  private querying = false;
  private recentBinding: BindingInputs | undefined;

  constructor(private readonly resolveMaterial?: MeshMaterialResolver) {}

  private assertSourceWritable(): void {
    if (this.querying) throw new Error('Pass sources changed during material query');
  }
  private readonly groups = new Map<string, BindingGroup>();
  private readonly meshGroups = new Map<number, Set<BindingGroup>>();
  private readonly materialSourceGroups = new Map<number, Set<BindingGroup>>();
  private readonly bindings = new BindingColumns();
  private readonly holds = new Map<MaterialResource, number>();
  private readonly unpublished = new Set<MaterialResource>();
  private meshFrame: MeshFrame | undefined;
  private revision = 0;
  private sourceMaterials = new MaterialFrame(undefined);
  private readonly active = new MaterialDemandProjection('active', this.sourceMaterials);
  private resident: MaterialDemandProjection | undefined;

  private select(
    projection: MaterialDemandProjection,
    selection: RenderResidencySelection | undefined,
  ): void {
    if (projection.selection !== selection) projection.invalidate();
  }

  private hasDemand(group: BindingGroup, selection: RenderResidencySelection | undefined): boolean {
    if (group.residencyGroup !== undefined && selection === undefined)
      throw new Error('Grouped material demand requires its owning residency selection');
    return (
      (selection === undefined || selection.includes(group.residencyGroup)) && groupHasDemand(group)
    );
  }

  private invalidateQuery(): void {
    this.active.invalidate();
    this.resident?.invalidate();
  }

  /** Source membership invalidates both derived demand phases. */
  private invalidateGroup(group: BindingGroup): void {
    if (group.holders === 0) {
      this.active.retireGroup(group, this.sourceMaterials);
      this.resident?.retireGroup(group, this.sourceMaterials);
      if (this.recentBinding?.key === group.key) this.recentBinding = undefined;
    } else {
      this.active.invalidateGroup(group);
      this.resident?.invalidateGroup(group);
    }
  }

  /** Does the last query give this slot a display (non-ShadowCaster) Pass entry? */
  displays(slot: number): boolean {
    const group = this.bindings.groups[slot];
    if (group === undefined || ((this.bindings.flags[slot] ?? 0) & VISIBLE) === 0) return false;
    for (const resource of this.active.groupResources.get(group) ?? [])
      if (
        this.active.queryWork
          .get(resource)
          ?.passes.some((pass) => pass.tags.LightMode !== 'ShadowCaster')
      )
        return true;
    return false;
  }

  materials(): MaterialFrame {
    return this.active.issueMaterials();
  }

  // Holds already count direct bindings. Only resolved Mesh substitutions need a correction.
  private readonly sourceBindingDelta = new Map<MaterialResource, number>();
  private readonly selectsSource = (resource: MaterialResource): boolean =>
    (this.holds.get(resource) ?? 0) + (this.sourceBindingDelta.get(resource) ?? 0) > 0;

  /** Exact sources of the current accepted bindings, including hidden preparation. */
  visitMaterialSources(visit: (source: MaterialSourceSnapshot) => void): void {
    const active = this.active.materialFrame;
    const resident = this.resident?.materialFrame;
    active.visitSources(this.selectsSource, visit);
    resident?.visitSources(this.selectsSource, visit, active);
    this.sourceMaterials.visitSources(this.selectsSource, visit, active, resident);
  }

  private changeSourceSelection(
    before: readonly MaterialResource[],
    after: readonly MaterialResource[],
  ): void {
    if (before === after || sameElements(before, after)) return;
    for (const resource of before) this.adjustSourceBinding(resource, -1);
    for (const resource of after) this.adjustSourceBinding(resource, 1);
  }

  private adjustSourceBinding(resource: MaterialResource, change: number): void {
    const next = (this.sourceBindingDelta.get(resource) ?? 0) + change;
    if (next === 0) this.sourceBindingDelta.delete(resource);
    else this.sourceBindingDelta.set(resource, next);
  }

  private publishSourceSelection(
    projection: MaterialDemandProjection,
    group: BindingGroup,
    resources: readonly MaterialResource[] | undefined,
  ): void {
    const active = this.active.groupResources.get(group);
    const resident = this.resident?.groupResources.get(group);
    const before = active ?? resident ?? group.held;
    const after =
      projection === this.active
        ? (resources ?? resident ?? group.held)
        : (active ?? resources ?? group.held);
    this.changeSourceSelection(before, after);
  }

  /** Mesh topology changes reach the live binding expressions that consume that Mesh. */
  prepare(meshes: MeshFrame): void {
    this.assertSourceWritable();
    const changed = (
      before: import('./mesh-frame').MeshGeometry | undefined,
      after: import('./mesh-frame').MeshGeometry | undefined,
    ) => {
      const source = after ?? before;
      if (source === undefined) return;
      const groups = this.meshGroups.get(source.handle);
      if (groups === undefined) return;
      if (after === undefined) throw new Error('Bound Mesh has no accepted geometry version');
      if (
        before?.materials === after.materials &&
        before.materialSlots === after.materialSlots &&
        before.layout.digest === after.layout.digest
      ) {
        retainMeshMaterialBindings(before, after);
        return;
      }
      for (const group of groups) {
        this.updateSourceHandles(group, after);
        this.invalidateGroup(group);
      }
      this.revision++;
    };
    if (this.meshFrame === undefined) {
      if (this.meshGroups.size > 0) {
        if (this.resolveMaterial !== undefined)
          for (const [handle, groups] of this.meshGroups) {
            const mesh = meshes.get(handle);
            for (const group of groups) this.updateSourceHandles(group, mesh);
          }
        this.invalidateQuery();
        this.revision++;
      }
    } else if (this.meshFrame !== meshes) meshes.changesSince(this.meshFrame, changed);
    this.meshFrame = meshes;
    for (const resource of this.unpublished)
      if (!this.holds.has(resource)) {
        this.sourceMaterials = this.sourceMaterials.without(resource);
        this.retireUnheldMaterial(this.active, resource);
        if (this.resident !== undefined) this.retireUnheldMaterial(this.resident, resource);
      }
    this.unpublished.clear();
  }

  /** Index actual resolver inputs. Direct materials already have a resource-addressed Pass roster. */
  private updateSourceHandles(group: BindingGroup, mesh: MeshGeometry | undefined): void {
    if (this.resolveMaterial === undefined) return;
    const previous = group.sourceHandles;
    let next: Set<number> | undefined;
    if (mesh !== undefined) {
      for (let slot = 0; slot < mesh.materialSlots.length; slot++) {
        const handle = meshMaterialSourceHandle(mesh, slot, group.source.materialOverrides?.[slot]);
        if (handle === undefined) continue;
        next ??= new Set();
        next.add(handle);
        if (!previous?.has(handle)) attachGroup(this.materialSourceGroups, handle, group);
      }
    }
    if (previous !== undefined)
      for (const handle of previous)
        if (!next?.has(handle)) detachGroup(this.materialSourceGroups, handle, group);
    group.sourceHandles = next;
  }

  adopt(material: MaterialResource): void {
    this.assertSourceWritable();
    const active = this.active.materialFrame;
    const sources = this.sourceMaterials;
    const previous = active.get(material);
    this.active.materialFrame = active.with(material, previous?.bindings ?? 0);
    const current = this.active.materialFrame.get(material);
    if (current === undefined) throw new Error('Material adoption has no accepted version');
    // A projection with the source root has exactly its zero-binding roster.
    this.sourceMaterials =
      active === sources ? this.active.materialFrame : sources.withAccepted(current, 0);
    const resident = this.resident;
    const priorResident = resident?.materialFrame.get(material);
    if (resident !== undefined) {
      if (resident.materialFrame === sources) resident.materialFrame = this.sourceMaterials;
      else if (resident.materialFrame === active)
        resident.materialFrame = this.active.materialFrame;
      else
        resident.materialFrame = resident.materialFrame.withAccepted(
          current,
          priorResident?.bindings ?? 0,
        );
    }
    if (!this.holds.has(material)) this.unpublished.add(material);
    const previousHandle = (previous ?? priorResident)?.snapshot.materialHandle;
    const handle = current.snapshot.materialHandle;
    const passChanged =
      (previous !== undefined && previous.passes !== current.passes) ||
      (priorResident !== undefined && priorResident.passes !== current.passes);
    if (passChanged || previousHandle !== handle) {
      this.active.invalidatePasses(material);
      this.resident?.invalidatePasses(material);
      if (previousHandle !== undefined && previousHandle !== handle)
        for (const group of this.materialSourceGroups.get(previousHandle) ?? []) {
          this.updateSourceHandles(group, this.meshFrame?.get(group.meshHandle));
          this.invalidateGroup(group);
        }
      if (handle !== undefined)
        for (const group of this.materialSourceGroups.get(handle) ?? [])
          this.invalidateGroup(group);
      this.revision++;
    }
  }

  private adoptBinding(material: MaterialResource, previous: MaterialFrame): void {
    const accepted = previous.get(material);
    if (this.active.materialFrame.get(material) === undefined && accepted !== undefined)
      this.active.materialFrame = this.active.materialFrame.withAccepted(accepted, 0);
    this.adopt(material);
  }

  bind(slot: number, snapshot: RenderableSnapshot): void {
    this.assertSourceWritable();
    const columns = this.bindings;
    const current = columns.groups[slot];
    const identity = snapshot.entityKey;
    const flags =
      (snapshot.authorVisible !== false ? VISIBLE : 0) |
      (snapshot.shadowCaster !== false ? CASTER : 0) |
      (snapshot.pipelinePreparation !== undefined ? PREPARED : 0);
    if (current !== undefined) {
      const group = current;
      // Pose-only republication keeps every material and membership fact; the
      // retained query root, ranks and dispatch entries stay valid.
      if (
        columns.entity(slot) === identity &&
        columns.layer(slot) === (snapshot.layer ?? 0) &&
        columns.flags[slot] === flags &&
        group.key === tryMaterialBindingKey(snapshot)
      ) {
        for (const resource of group.held) this.adopt(resource);
        return;
      }
    }
    const accepted = this.active.materialFrame;
    this.remove(slot);
    // Re-admit only replacement inputs; retired member counts and unrelated old materials stay retired.
    try {
      const { overrides, direct, geometry, key } = this.bindingInputs(snapshot);
      let group = this.groups.get(key);
      if (group === undefined) {
        const createMaterialBindingGroup = (): BindingGroup => {
          const meshHandle = overrides === undefined ? undefined : snapshot.assetHandle;
          const source: MaterialBinding = {
            material: snapshot.material,
            materials: direct,
            materialBindingSources: snapshot.materialBindingSources,
            ...(overrides === undefined ? {} : { materialOverrides: overrides }),
          };
          const held =
            overrides === undefined || meshHandle === undefined
              ? direct
              : [
                  ...new Set(
                    overrides.filter((value): value is MaterialResource => value !== undefined),
                  ),
                ];
          for (const resource of held) this.adoptBinding(resource, accepted);
          for (const resource of held) this.hold(resource);
          const created: BindingGroup = {
            residencyGroup: snapshot.residencyGroup,
            source,
            worldId: 0,
            identity: getOpaqueResourceIdentity(source),
            meshHandle,
            sourceHandles: undefined,
            held,
            key,
            geometry,
            holders: 0,
            members: undefined,
            nonCasters: 0,
            ownCasters: undefined,
            prepared: undefined,
            staged: { members: [], ownCasters: [], prepared: [] },
          };
          this.groups.set(key, created);
          if (meshHandle !== undefined) {
            attachGroup(this.meshGroups, meshHandle, created);
            this.updateSourceHandles(created, this.meshFrame?.get(meshHandle));
          }
          return created;
        };
        group = createMaterialBindingGroup();
      } else {
        // Joining an existing group admits its current author overrides.
        for (const resource of group.held) this.adoptBinding(resource, accepted);
      }
      group.holders++;
      columns.add(slot, identity, snapshot.layer ?? 0);
      columns.flags[slot] = flags;
      columns.groups[slot] = group;
      columns.count++;
      joinGroup(group, slot, flags, identity);
      this.revision++;
      this.invalidateGroup(group);
    } catch (error) {
      this.clearEmptyMaterialRoots();
      throw error;
    }
  }

  /**
   * The binding key and its inputs. Bulk admission binds many rows of one
   * template whose material fields are the same references; they reuse the
   * previous row's derivation instead of re-deriving the key.
   */
  private bindingInputs(snapshot: RenderableSnapshot): BindingInputs {
    const recent = this.recentBinding;
    const geometry = meshMaterialGeometry(snapshot);
    // Element-wise: an admitted binding is captured, never borrowed.
    if (
      recent !== undefined &&
      recent.material === snapshot.material &&
      recent.assetHandle === snapshot.assetHandle &&
      recent.geometry === geometry &&
      recent.residencyGroup === snapshot.residencyGroup &&
      sameElements(recent.materials, snapshot.materials) &&
      sameElements(recent.materialOverrides, snapshot.materialOverrides)
    )
      return recent;
    const overrides =
      snapshot.materialOverrides === undefined
        ? undefined
        : captureMaterialOverrides(snapshot.materialOverrides);
    const direct = [
      ...new Set(snapshot.materials.length === 0 ? [snapshot.material] : snapshot.materials),
    ];
    const key = materialBindingKey(snapshot, overrides, direct, geometry);
    this.recentBinding = {
      residencyGroup: snapshot.residencyGroup,
      materials: [...snapshot.materials],
      material: snapshot.material,
      materialOverrides:
        snapshot.materialOverrides === undefined ? undefined : [...snapshot.materialOverrides],
      assetHandle: snapshot.assetHandle,
      geometry,
      overrides,
      direct,
      key,
    };
    return this.recentBinding;
  }

  remove(slot: number): void {
    this.assertSourceWritable();
    const columns = this.bindings;
    const group = columns.groups[slot];
    if (group === undefined) return;
    leaveGroup(group, columns.flags[slot] ?? 0, columns.entity(slot));
    columns.remove(slot);
    if (--group.holders === 0) {
      this.changeSourceSelection(
        this.active.groupResources.get(group) ??
          this.resident?.groupResources.get(group) ??
          group.held,
        group.held,
      );
      this.groups.delete(group.key);
      if (group.meshHandle !== undefined) {
        detachGroup(this.meshGroups, group.meshHandle, group);
        this.updateSourceHandles(group, undefined);
      }
      for (const resource of group.held) this.release(resource);
    }
    columns.groups[slot] = undefined;
    columns.count--;
    this.invalidateGroup(group);
    this.revision++;
    this.clearEmptyMaterialRoots();
  }

  private clearEmptyMaterialRoots(): void {
    if (this.bindings.count === 0) {
      this.bindings.clear();
      this.active.clear();
      this.resident = undefined;
      this.recentBinding = undefined;
      this.sourceMaterials = this.active.materialFrame;
      this.unpublished.clear();
    }
  }

  /**
   * Actual Pass demand, before resource capture. Resolving a variant uses the
   * current factory once; the returned work and MaterialFrame then retain its
   * accepted bytes independently of subsequent source adoption.
   */
  query(
    slots: SceneSlotFrame,
    meshes = this.meshFrame,
    validate?: () => void,
    selection?: RenderResidencySelection,
  ): DispatchList {
    return this.queryDemand(this.active, slots, meshes, validate, selection);
  }

  /** Resident metadata demand is independent from the current execution query. */
  queryResident(
    slots: SceneSlotFrame,
    selection: RenderResidencySelection,
    meshes = this.meshFrame,
    validate?: () => void,
  ): ResidentMaterialDemand {
    assertRenderResidencySelection(selection, 'resident');
    this.resident ??= new MaterialDemandProjection('resident', this.sourceMaterials);
    const projection = this.resident;
    const dispatch = this.queryDemand(projection, slots, meshes, validate, selection);
    const materials = projection.issueMaterials(),
      revision = this.revision;
    return Object.freeze({
      dispatch,
      materials,
      isCurrent: () =>
        this.resident !== undefined &&
        !this.resident.queryDirty &&
        selection.isCurrent() &&
        this.revision === revision &&
        this.meshFrame === meshes &&
        this.resident.materialFrame === materials,
    });
  }

  private queryDemand(
    projection: MaterialDemandProjection,
    slots: SceneSlotFrame,
    meshes = this.meshFrame,
    validate?: () => void,
    selection?: RenderResidencySelection,
  ): DispatchList {
    if (this.querying) throw new Error('Recursive material Pass query');
    assertResidencySelection(selection, projection.phase);
    this.querying = true;
    // One generation per query: entries the previous query read stay shared.
    projection.entries.rotate();
    try {
      const validateInputs = () => {
        validate?.();
        assertResidencySelection(selection, projection.phase);
      };
      validateInputs();
      this.select(projection, selection);
      if (meshes !== this.meshFrame)
        throw new Error('Pass query requires the current adopted MeshFrame');
      if (
        projection.queryDirty &&
        !projection.fullQuery &&
        this.queryIncrementally(projection, meshes, validateInputs, selection)
      )
        projection.queryDirty = false;
      if (projection.queryDirty) this.queryComplete(projection, meshes, validateInputs, selection);
      // Entry addresses are slot ranks. Pose-only frames replace slot records but
      // keep the identity roster, so ranks and the projected work are unchanged.
      if (
        projection.previous === undefined ||
        (projection.previous.slots !== slots &&
          projection.previous.slots.identities !== slots.identities)
      )
        projection.previous = new FrameDispatch(
          projection.queryRoot,
          slots,
          projection.entries,
          this.bindings.capture(),
        );
      assertResidencySelection(selection, projection.phase);
      projection.selection = selection;
      return projection.previous;
    } finally {
      this.querying = false;
    }
  }

  /** Cold or globally invalidated demand: build privately, guard, then publish. */
  private queryComplete(
    projection: MaterialDemandProjection,
    meshes: MeshFrame | undefined,
    validateInputs: () => void,
    selection: RenderResidencySelection | undefined,
  ): void {
    const revision = this.revision;
    const sources = this.sourceMaterials;
    const resolve = this.resolveMaterial;
    const pendingBindings: MeshMaterialBindingWrite[] = [];
    const work = new Map<MaterialResource, QueryWork>();
    const groupResources = new Map<BindingGroup, readonly MaterialResource[]>();
    let materials = this.sourceMaterials;
    for (const group of this.groups.values()) {
      if (!this.hasDemand(group, selection)) continue;
      const { mesh, resources } = this.effectiveResources(group, meshes, resolve, pendingBindings);
      groupResources.set(group, resources);
      for (const resource of resources) {
        const value = work.get(resource);
        if (value === undefined)
          materials = this.admit(projection, materials, resource, mesh, resolve);
        work.set(resource, addGroupWork(value ?? EMPTY_WORK, group));
      }
    }
    let root: Node<Work> | undefined;
    for (const [resource, value] of work) {
      const accepted = materials.get(resource);
      if (accepted === undefined) throw new Error('Pass query has no accepted material');
      materials = materials.withAccepted(accepted, value.members?.count ?? 0);
      value.passes = accepted.passes;
      for (const pass of accepted.passes) {
        const members = pass.tags.LightMode === 'ShadowCaster' ? value.casters : value.members;
        if (members !== undefined)
          root = put(
            root,
            { pass, resource, groups: members },
            pass.queue,
            getOpaqueResourceIdentity(pass),
            members.count,
          );
      }
    }
    if (
      this.revision !== revision ||
      this.sourceMaterials !== sources ||
      this.meshFrame !== meshes ||
      this.resolveMaterial !== resolve
    )
      throw new Error('Pass sources changed during material query');
    validateInputs();
    for (const { contexts, geometry, value } of pendingBindings) contexts[geometry] = value;
    projection.queryRoot = root;
    projection.materialFrame = materials;
    projection.queryWork = work;
    for (const groups of this.meshGroups.values())
      for (const group of groups)
        this.publishSourceSelection(projection, group, groupResources.get(group));
    projection.groupResources = groupResources;
    projection.dirtyGroups.clear();
    projection.dirtyPasses.clear();
    projection.fullQuery = false;
    projection.queryDirty = false;
    projection.previous = undefined;
  }

  /**
   * Re-project changed Passes and groups whose effective bindings or membership changed.
   * Equivalent to a complete query: same effective resources (including Mesh
   * expression bindings), member roots, Pass roots and binding counts.
   */
  private queryIncrementally(
    projection: MaterialDemandProjection,
    meshes: MeshFrame | undefined,
    validate?: () => void,
    selection?: RenderResidencySelection,
  ): boolean {
    const dirty = [...projection.dirtyGroups];
    const revision = this.revision;
    const sources = this.sourceMaterials;
    const resolve = this.resolveMaterial;
    const pendingBindings: MeshMaterialBindingWrite[] = [];
    // Stage only touched keys. Readers and a failed source fence keep observing the
    // last admitted association tables until this transaction publishes its roots.
    const work = new Map<MaterialResource, QueryWork>();
    const groupResources = new Map<BindingGroup, readonly MaterialResource[]>();
    const affected = new Map<MaterialResource, readonly Pass[]>();
    let materials = projection.materialFrame;
    for (const resource of projection.dirtyPasses) {
      const value = projection.queryWork.get(resource);
      if (value === undefined) continue;
      affected.set(resource, value.passes);
      work.set(resource, value);
    }
    for (const group of dirty) {
      for (const resource of projection.groupResources.get(group) ?? []) {
        const value = work.get(resource) ?? projection.queryWork.get(resource);
        if (value === undefined) continue;
        if (!affected.has(resource)) affected.set(resource, value.passes);
        work.set(resource, removeGroupWork(value, group.identity));
      }
      if (this.groups.get(group.key) !== group || !this.hasDemand(group, selection)) continue;
      const { mesh, resources } = this.effectiveResources(group, meshes, resolve, pendingBindings);
      groupResources.set(group, resources);
      for (const resource of resources) {
        const value = work.get(resource) ?? projection.queryWork.get(resource);
        if (value === undefined) {
          materials = this.admit(projection, materials, resource, mesh, resolve);
        } else if (
          mesh !== undefined &&
          resolve !== undefined &&
          materials.get(resource)?.snapshot !== resource.snapshot
        ) {
          materials = materials.with(resource);
        }
        if (!affected.has(resource)) affected.set(resource, value?.passes ?? []);
        work.set(resource, addGroupWork(value ?? EMPTY_WORK, group));
      }
    }
    const updated = projectAffectedMaterialWork(
      projection.queryRoot,
      work,
      materials,
      sources,
      affected,
    );
    const root = updated.root;
    materials = updated.materials;
    if (
      this.revision !== revision ||
      this.sourceMaterials !== sources ||
      this.meshFrame !== meshes ||
      this.resolveMaterial !== resolve
    )
      throw new Error('Pass sources changed during material query');
    validate?.();
    for (const { contexts, geometry, value } of pendingBindings) contexts[geometry] = value;
    for (const resource of affected.keys()) {
      const value = work.get(resource);
      if (value === undefined) projection.queryWork.delete(resource);
      else projection.queryWork.set(resource, value);
    }
    for (const group of dirty) {
      const resources = groupResources.get(group);
      this.publishSourceSelection(projection, group, resources);
      if (resources === undefined) projection.groupResources.delete(group);
      else projection.groupResources.set(group, resources);
    }
    projection.queryRoot = root;
    projection.materialFrame = materials;
    projection.dirtyGroups.clear();
    projection.dirtyPasses.clear();
    projection.previous = undefined;
    return true;
  }

  /** One binding group's effective resources against one fixed Mesh version. */
  private effectiveResources(
    group: BindingGroup,
    meshes: MeshFrame | undefined,
    resolve: MeshMaterialResolver | undefined,
    pending: MeshMaterialBindingWrite[],
  ): { mesh: MeshGeometry | undefined; resources: readonly MaterialResource[] } {
    if (group.meshHandle === undefined) return { mesh: undefined, resources: group.held };
    const mesh = meshes?.get(group.meshHandle);
    if (mesh === undefined) throw new Error('Mesh Pass query requires accepted geometry');
    const effective =
      resolve === undefined
        ? effectiveMeshMaterials(group.source, mesh, group.geometry)
        : prepareMeshMaterialBindings(group.source, mesh, group.geometry, resolve, pending);
    // One binding can repeat a material in several authored slots.
    const resources = [
      ...new Set(effective.materials.length === 0 ? [effective.material] : effective.materials),
    ];
    return { mesh, resources };
  }

  /** Admit a resource's accepted version; a resolved Mesh variant adopts its current bytes. */
  private admit(
    projection: MaterialDemandProjection,
    materials: MaterialFrame,
    resource: MaterialResource,
    mesh: MeshGeometry | undefined,
    resolve: MeshMaterialResolver | undefined,
  ): MaterialFrame {
    const accepted = projection.materialFrame.get(resource) ?? materials.get(resource);
    return accepted === undefined ||
      (mesh !== undefined && resolve !== undefined && accepted.snapshot !== resource.snapshot)
      ? materials.with(resource, 0)
      : materials.withAccepted(accepted, 0);
  }

  revisionValue(): number {
    return this.revision;
  }

  private retireUnheldMaterial(
    projection: MaterialDemandProjection,
    resource: MaterialResource,
  ): void {
    if (
      projection.materialFrame.get(resource)?.bindings === 0 &&
      projection.queryWork.get(resource)?.prepared === undefined
    )
      projection.materialFrame = projection.materialFrame.without(resource);
  }

  private hold(resource: MaterialResource): void {
    this.holds.set(resource, (this.holds.get(resource) ?? 0) + 1);
    this.unpublished.delete(resource);
  }
  private release(resource: MaterialResource): void {
    const count = (this.holds.get(resource) ?? 0) - 1;
    if (count > 0) {
      this.holds.set(resource, count);
      return;
    }
    this.holds.delete(resource);
    this.sourceMaterials = this.sourceMaterials.without(resource);
    this.retireUnheldMaterial(this.active, resource);
    if (this.resident !== undefined) this.retireUnheldMaterial(this.resident, resource);
  }
}
