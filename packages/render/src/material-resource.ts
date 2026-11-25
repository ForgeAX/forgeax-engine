import { runtimeMaterialShaderId } from '@forgeax/engine-assets-runtime';
import { freezeJson, isDeepFrozenJson, type MaterialPass } from '@forgeax/engine-types';
import { materialAlphaMask } from './material-alpha-mask';
import { prepareMaterialLayoutIdentity } from './material-layout-facts';
import type { DispatchEntry, MaterialSnapshot } from './render-system-extract';
import type { StandardSceneDataContributorProgramFact } from './temporal/scene-data';
import { standardTransmissionValue } from './transmission/projection';

// A fixed value fact belongs to the snapshot, independently of its latest resource.
// Borrowed snapshots keep the original direct resource entry.
interface MaterialProgramObservation {
  readonly fact: StandardSceneDataContributorProgramFact;
  readonly candidates: readonly StandardSceneDataContributorProgramFact[];
  readonly publication: string;
  readonly selectedProgram: string;
  readonly identity: object | undefined;
}

type ProgramObservations = Map<MaterialPass, MaterialProgramObservation>;
export type MaterialDispatchPass = Omit<
  DispatchEntry,
  'entityIndex' | 'renderableIndex' | 'layer' | 'materialShaderId'
> & { readonly materialShaderId: string };
interface MaterialPassDeclaration {
  prepared?: readonly MaterialDispatchPass[];
}
type SnapshotEntry =
  | MaterialResource
  | {
      resource: MaterialResource | undefined;
      readonly valuesOwned: boolean;
      temporalDisplacement?: boolean;
      readonly programDataCaptured?: true;
      readonly rasterFlags?: number;
      programs?: ProgramObservations;
      dispatch?: MaterialPassDeclaration;
    };
const resources = new WeakMap<MaterialSnapshot, SnapshotEntry>();

/** Scalar pipeline inputs belong to this value version, including derived parameter versions. */
export const MATERIAL_RASTER_ALPHA_MASK = 1;
function rasterFlags(snapshot: MaterialSnapshot): number {
  return (
    (materialAlphaMask(snapshot.paramSnapshot) ? MATERIAL_RASTER_ALPHA_MASK : 0) |
    (snapshot.transparent === true ? 2 : 0) |
    (standardTransmissionValue(snapshot) !== undefined ? 4 : 0)
  );
}

/** Only the producer of detached pass data and owned parameter values issues these flags. */
export function ownedMaterialRasterFlags(snapshot: MaterialSnapshot): number | undefined {
  const entry = resources.get(snapshot);
  return entry === undefined || entry instanceof MaterialResource ? undefined : entry.rasterFlags;
}

/** One declaration for a captured material and its producer-owned parameter projections. */
export function ownedMaterialPassDeclaration(
  snapshot: MaterialSnapshot,
): MaterialPassDeclaration | undefined {
  const entry = resources.get(snapshot);
  if (entry === undefined || entry instanceof MaterialResource) return undefined;
  if (entry.dispatch !== undefined) return entry.dispatch;
  if (!entry.valuesOwned || entry.programDataCaptured !== true) return undefined;
  entry.dispatch = {};
  return entry.dispatch;
}
// Only detached, frozen metadata is compared as the previous value. Retain its
// key order on first comparison so value edits do not enumerate it again.
const previousProgramKeys = new WeakMap<object, readonly string[]>();

/** Attach the exact program data to a fresh preparation before it can escape. */
export function prepareMaterialProgramSnapshot(
  snapshot: MaterialSnapshot,
  previous?: MaterialSnapshot,
): MaterialSnapshot {
  const entry = previous === undefined ? undefined : resources.get(previous);
  const unchanged =
    previous !== undefined &&
    entry !== undefined &&
    !(entry instanceof MaterialResource) &&
    entry.programDataCaptured === true &&
    sameProgramData(snapshot, previous);
  const prepared = Object.freeze(
    Object.assign(snapshot, unchanged ? programData(previous) : captureProgramData(snapshot)),
  );
  prepareMaterialLayoutIdentity(
    prepared.materialShaderId ?? 'forgeax::default-standard-pbr',
    prepared.materialParamSchema,
  );
  resources.set(prepared, {
    resource: undefined,
    valuesOwned: false,
    programDataCaptured: true,
    programs: (unchanged ? entry.programs : undefined) ?? new Map(),
  });
  return prepared;
}

export function captureMaterialSnapshot(
  snapshot: MaterialSnapshot,
  sourceAssets = snapshot.sourceAssets,
): MaterialSnapshot {
  const entry = resources.get(snapshot);
  const programs =
    entry !== undefined &&
    !(entry instanceof MaterialResource) &&
    entry.programDataCaptured === true
      ? undefined
      : captureProgramData(snapshot);
  return recordOwnedMaterialSnapshot(
    { ...snapshot, ...programs, ...(sourceAssets === undefined ? {} : { sourceAssets }) },
    programs === undefined && !(entry instanceof MaterialResource) ? entry?.programs : undefined,
  );
}

/** Takes a fresh snapshot record whose value and program data are already detached. */
export function ownDetachedMaterialSnapshot(snapshot: MaterialSnapshot): MaterialSnapshot {
  freezeProgramData(snapshot.passes);
  freezeProgramData(snapshot.materialContext);
  freezeProgramData(snapshot.materialProgramKeys);
  freezeProgramData(snapshot.materialProgramInputs);
  freezeProgramData(snapshot.materialPublication);
  return recordOwnedMaterialSnapshot(snapshot);
}

function recordOwnedMaterialSnapshot(
  snapshot: MaterialSnapshot,
  programs: ProgramObservations = new Map(),
): MaterialSnapshot {
  const captured = Object.freeze(Object.assign(snapshot, { immutableValues: true as const }));
  resources.set(captured, {
    rasterFlags: rasterFlags(captured),
    resource: undefined,
    valuesOwned: true,
    programDataCaptured: true,
    programs,
  });
  return captured;
}

function programData(snapshot: MaterialSnapshot) {
  return {
    passes: snapshot.passes,
    ...(snapshot.materialContext === undefined
      ? {}
      : { materialContext: snapshot.materialContext }),
    ...(snapshot.materialProgramKeys === undefined
      ? {}
      : { materialProgramKeys: snapshot.materialProgramKeys }),
    ...(snapshot.materialProgramInputs === undefined
      ? {}
      : { materialProgramInputs: snapshot.materialProgramInputs }),
    ...(snapshot.materialPublication === undefined
      ? {}
      : { materialPublication: snapshot.materialPublication }),
  };
}

const programFields = [
  'passes',
  'materialContext',
  'materialProgramKeys',
  'materialProgramInputs',
  'materialPublication',
] as const;

function captureProgramData(snapshot: MaterialSnapshot) {
  const programs = programData(snapshot);
  let borrowed: Partial<Record<(typeof programFields)[number], object>> | undefined;
  for (const field of programFields) {
    const value = programs[field];
    if (value !== undefined && !isDeepFrozenJson(value)) {
      borrowed ??= {};
      borrowed[field] = value;
    }
  }
  // Clone borrowed roots in one operation to preserve their shared mutable descendants.
  // Proven immutable program inputs retain the issuing shader's array and publication identities.
  if (borrowed !== undefined) Object.assign(programs, freezeJson(structuredClone(borrowed)));
  return programs;
}

function sameProgramData(current: MaterialSnapshot, previous: MaterialSnapshot): boolean {
  return (
    sameProgramValue(current.passes, previous.passes) &&
    sameProgramValue(current.materialContext, previous.materialContext) &&
    sameProgramValue(current.materialProgramKeys, previous.materialProgramKeys) &&
    sameProgramValue(current.materialProgramInputs, previous.materialProgramInputs) &&
    sameProgramValue(current.materialPublication, previous.materialPublication)
  );
}

/** Compare renderer-prepared program metadata against its detached JSON data. */
function sameProgramValue(current: unknown, previous: unknown): boolean {
  if (Object.is(current, previous)) return true;
  if (
    current === null ||
    previous === null ||
    typeof current !== 'object' ||
    typeof previous !== 'object'
  )
    return false;
  if (Array.isArray(current)) {
    if (!Array.isArray(previous) || current.length !== previous.length) return false;
  } else {
    const currentPrototype: unknown = Object.getPrototypeOf(current);
    const previousPrototype: unknown = Object.getPrototypeOf(previous);
    if (
      (currentPrototype !== Object.prototype && currentPrototype !== null) ||
      (previousPrototype !== Object.prototype && previousPrototype !== null)
    )
      return false;
  }
  const keys = Object.keys(current);
  let before = previousProgramKeys.get(previous);
  if (before === undefined) {
    before = Object.keys(previous);
    previousProgramKeys.set(previous, before);
  }
  if (keys.length !== before.length) return false;
  const nextValues = current as Record<string, unknown>;
  const previousValues = previous as Record<string, unknown>;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string;
    if (key !== before[i] || !sameProgramValue(nextValues[key], previousValues[key])) return false;
  }
  return true;
}

function freezeProgramData(value: unknown): void {
  if (value !== null && typeof value === 'object') freezeJson(value);
}

function sameProgramSource(a: MaterialSnapshot, b: MaterialSnapshot): boolean {
  return (
    a.passes === b.passes &&
    a.materialContext === b.materialContext &&
    a.materialProgramKeys === b.materialProgramKeys &&
    a.materialPublication === b.materialPublication
  );
}

/** One renderer's accepted shared material. Entity bindings retain this identity. */
export class MaterialResource {
  #frameAddress?: number;
  static #nextFrameAddress = 1;
  static readonly #wrapperAddresses = new WeakMap<MaterialResource, number>();

  /** @internal Only material identities consume lanes in the Scene material directory. */
  static _frameAddress(resource: MaterialResource): number {
    if (#frameAddress in resource) {
      resource.#frameAddress ??= MaterialResource.#nextFrameAddress++;
      return resource.#frameAddress;
    }
    const wrappers = MaterialResource.#wrapperAddresses;
    let address = wrappers.get(resource);
    if (address === undefined) {
      address = MaterialResource.#nextFrameAddress++;
      wrappers.set(resource, address);
    }
    return address;
  }

  private current: MaterialSnapshot;
  private fixedValues: MaterialSnapshot | undefined;
  private fixedPrograms: ProgramObservations | undefined;

  static from(snapshot: MaterialSnapshot): MaterialResource {
    return materialResource(snapshot) ?? new MaterialResource(snapshot);
  }

  constructor(snapshot: MaterialSnapshot) {
    this.current = snapshot;
    this.fixedValues = this.recordSnapshot(snapshot, false) ? snapshot : undefined;
    this.fixedPrograms = this.programsFor(snapshot);
  }

  get snapshot(): MaterialSnapshot {
    return this.current;
  }

  ownsValues(snapshot: MaterialSnapshot): boolean {
    return this.fixedValues === snapshot;
  }

  /** Parameter-only derivations retain captured programs; the new values remain borrowed. */
  withParameters(paramSnapshot: MaterialSnapshot['paramSnapshot']): MaterialResource {
    const { immutableValues: _immutableValues, ...snapshot } = this.current;
    snapshot.paramSnapshot = paramSnapshot;
    if (this.fixedPrograms !== undefined)
      resources.set(snapshot, {
        resource: undefined,
        valuesOwned: false,
        programs: this.fixedPrograms,
      });
    return new MaterialResource(snapshot);
  }

  /** Called by material preparation at the renderer's adoption boundary. */
  adopt(snapshot: MaterialSnapshot): void {
    this.replace(snapshot, false);
  }

  /** The program owner changes schema/entry reads while retaining the same value subtree. */
  adoptProgramSnapshot(snapshot: MaterialSnapshot, fixedProgramInputs = false): void {
    const programsOwned =
      this.fixedPrograms !== undefined &&
      sameProgramSource(this.current, snapshot) &&
      (this.current.materialProgramInputs === snapshot.materialProgramInputs || fixedProgramInputs);
    this.replace(snapshot, this.fixedValues === this.current, programsOwned);
  }

  private replace(snapshot: MaterialSnapshot, valuesOwned: boolean, programsOwned = false): void {
    this.current = snapshot;
    this.fixedValues = this.recordSnapshot(snapshot, valuesOwned) ? snapshot : undefined;
    const entry = resources.get(snapshot);
    if (programsOwned && entry !== undefined) {
      if (entry instanceof MaterialResource)
        resources.set(snapshot, {
          resource: this,
          valuesOwned: this.fixedValues === snapshot,
          programs: new Map(),
        });
      else entry.programs ??= new Map();
    }
    this.fixedPrograms = this.programsFor(snapshot);
  }

  private programsFor(snapshot: MaterialSnapshot): ProgramObservations | undefined {
    const entry = resources.get(snapshot);
    return entry instanceof MaterialResource ? undefined : entry?.programs;
  }

  /** Captured program data is fixed independently of frame membership and material values. */
  programObservation(pass: MaterialPass): MaterialProgramObservation {
    const cached = this.fixedPrograms?.get(pass);
    if (cached !== undefined) return cached;
    const snapshot = this.current;
    // Callers can also supply a borrowed Pass. Only captured members belong to this program.
    const owner =
      this.fixedPrograms !== undefined && snapshot.passes.includes(pass)
        ? this.fixedPrograms
        : undefined;
    const authoredShaderId = runtimeMaterialShaderId(pass.program.module, pass.name);
    const selectedProgramKey = snapshot.materialProgramKeys?.[pass.name];
    const program = snapshot.materialPublication?.programs.find(
      (entry) => entry.pass === pass.name,
    );
    const fact: StandardSceneDataContributorProgramFact = Object.freeze({
      pass: pass.name,
      authoredModule: pass.program.module,
      authoredShaderId,
      selectedProgramKey,
      registryLookupKey: selectedProgramKey ?? authoredShaderId,
      fragmentEntryPoints: Object.freeze(
        (snapshot.materialProgramInputs?.[pass.name]?.entryPoints ?? [])
          .filter((entry) => entry.stage === 'fragment')
          .map((entry) => entry.name),
      ),
      publicationIdentity: snapshot.materialPublication?.identity,
      program:
        program === undefined
          ? undefined
          : Object.freeze({
              context: program.context,
              address: program.address,
              specializationKey: program.specializationKey,
              artifactHash: program.artifactHash,
            }),
    });
    const observation = Object.freeze({
      fact,
      candidates: Object.freeze([fact]),
      publication: JSON.stringify([
        snapshot.materialPublication?.identity ?? null,
        snapshot.materialProgramKeys === undefined ? authoredShaderId : selectedProgramKey,
      ]),
      selectedProgram: JSON.stringify(fact.program ?? null),
      identity: owner,
    });
    owner?.set(pass, observation);
    return observation;
  }

  private recordSnapshot(snapshot: MaterialSnapshot, valuesOwned: boolean): boolean {
    const entry = resources.get(snapshot);
    if (entry !== undefined && !(entry instanceof MaterialResource)) {
      entry.resource = this;
      return entry.valuesOwned;
    }
    resources.set(snapshot, valuesOwned ? { resource: this, valuesOwned: true } : this);
    return valuesOwned;
  }
}

/**
 * Capture a producer-owned parameter projection from one exact owned source.
 * This is an internal producer path; ordinary withParameters remains borrowed.
 */
export function deriveOwnedMaterialParameters(
  source: MaterialResource,
  sourceSnapshot: MaterialSnapshot,
  paramSnapshot: MaterialSnapshot['paramSnapshot'],
): MaterialResource | undefined {
  if (source.snapshot !== sourceSnapshot || !source.ownsValues(sourceSnapshot)) return undefined;
  const sourceEntry = resources.get(sourceSnapshot);
  if (
    sourceEntry === undefined ||
    sourceEntry instanceof MaterialResource ||
    sourceEntry.resource !== source ||
    !sourceEntry.valuesOwned ||
    sourceEntry.programs === undefined
  )
    return undefined;
  const parameters = captureParameterValues(paramSnapshot);
  if (paramSnapshot !== undefined && parameters === undefined) return undefined;
  const snapshot = Object.freeze({
    ...sourceSnapshot,
    paramSnapshot: parameters,
    immutableValues: true as const,
  });
  const dispatch = ownedMaterialPassDeclaration(sourceSnapshot);
  resources.set(snapshot, {
    resource: undefined,
    valuesOwned: true,
    programs: sourceEntry.programs,
    ...(dispatch === undefined ? {} : { dispatch, rasterFlags: rasterFlags(snapshot) }),
  });
  const derived = MaterialResource.from(snapshot);
  return source.snapshot === sourceSnapshot && source.ownsValues(sourceSnapshot)
    ? derived
    : undefined;
}

function captureParameterValues(
  values: MaterialSnapshot['paramSnapshot'],
): MaterialSnapshot['paramSnapshot'] | undefined {
  if (values === undefined) return undefined;
  const captured: Record<string, number | number[] | string> = {};
  for (const key of Object.keys(values)) {
    const value = values[key];
    if (value === undefined) return undefined;
    captured[key] = Array.isArray(value) ? (Object.freeze([...value]) as number[]) : value;
  }
  return Object.freeze(captured);
}

/** Temporal reactivity belongs to the chosen material version, including its texture bindings. */
export function materialHasTemporalDisplacement(snapshot: MaterialSnapshot): boolean {
  const entry = resources.get(snapshot);
  const owned =
    entry !== undefined && !(entry instanceof MaterialResource) && entry.valuesOwned
      ? entry
      : undefined;
  if (owned?.temporalDisplacement !== undefined) return owned.temporalDisplacement;
  const active =
    (snapshot.paramSnapshot?.displacementScale ?? 0) !== 0 &&
    (snapshot.textureSources?.has('displacementTexture') === true ||
      snapshot.videoTextureFields?.has('displacementTexture') === true);
  if (owned !== undefined) owned.temporalDisplacement = active;
  return active;
}

export function materialResource(snapshot: MaterialSnapshot): MaterialResource | undefined {
  const entry = resources.get(snapshot);
  return entry instanceof MaterialResource ? entry : entry?.resource;
}

/** Ownership inspection never invokes a borrowed getter or rejects a proxy's input. */
export function ownedMaterialValues(snapshot: MaterialSnapshot): boolean {
  try {
    return Object.getOwnPropertyDescriptor(snapshot, 'immutableValues')?.value === true;
  } catch {
    return false;
  }
}

export function runtimeMaterialShaderIdForMaterial(
  passes: readonly MaterialPass[],
  programs: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const pass =
    passes.find(
      (pass) =>
        !/shadow|depth/i.test(
          String(
            (pass.renderState?.tags as Record<string, unknown> | undefined)?.LightMode ?? pass.name,
          ),
        ),
    ) ?? passes[0];
  if (pass === undefined) return undefined;
  return programs === undefined
    ? runtimeMaterialShaderId(pass.program.module, pass.name)
    : programs[pass.name];
}

/** Sprite geometry follows the immutable author program, independent of cooked IDs. */
export function materialUsesSpriteGeometry(material: Pick<MaterialSnapshot, 'passes'>): boolean {
  const shader = runtimeMaterialShaderIdForMaterial(material.passes, undefined);
  return shader === 'forgeax::sprite' || shader === 'forgeax::sprite-lit';
}
