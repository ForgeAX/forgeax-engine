import { runtimeMaterialShaderId } from '@forgeax/engine-assets-runtime';
import type { MaterialPass } from '@forgeax/engine-types';
import { freezeJson, isDeepFrozenJson } from '@forgeax/engine-types';
import type { MaterialSnapshot } from './render-system-extract';
import type { StandardSceneDataContributorProgramFact } from './temporal/scene-data';

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
type SnapshotEntry =
  | MaterialResource
  | {
      resource: MaterialResource | undefined;
      readonly valuesOwned: boolean;
      programs?: ProgramObservations;
    };
const resources = new WeakMap<MaterialSnapshot, SnapshotEntry>();

export function captureMaterialSnapshot(snapshot: MaterialSnapshot): MaterialSnapshot {
  const programs = {
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
  // Prepared program facts are often shared by several material snapshots.
  // Only accept a shared graph when its entire contents are immutable.
  const fixed = Object.values(programs).every(
    (value) => value === undefined || isDeepFrozenJson(value),
  );
  return ownDetachedMaterialSnapshot({
    ...snapshot,
    ...(fixed ? programs : structuredClone(programs)),
  });
}

/** Takes a fresh snapshot record whose value and program data are already detached. */
export function ownDetachedMaterialSnapshot(snapshot: MaterialSnapshot): MaterialSnapshot {
  freezeProgramData(snapshot.passes);
  freezeProgramData(snapshot.materialContext);
  freezeProgramData(snapshot.materialProgramKeys);
  freezeProgramData(snapshot.materialProgramInputs);
  freezeProgramData(snapshot.materialPublication);
  const captured = Object.freeze(Object.assign(snapshot, { immutableValues: true as const }));
  resources.set(captured, { resource: undefined, valuesOwned: true, programs: new Map() });
  return captured;
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
    const selectedProgramKey = snapshot.materialProgramKeys?.[pass.name];
    const program = snapshot.materialPublication?.programs.find(
      (entry) => entry.pass === pass.name,
    );
    const fact: StandardSceneDataContributorProgramFact = Object.freeze({
      pass: pass.name,
      authoredModule: pass.program.module,
      authoredShaderId: runtimeMaterialShaderId(pass.program.module, pass.name),
      selectedProgramKey,
      registryLookupKey:
        selectedProgramKey ?? runtimeMaterialShaderId(pass.program.module, pass.name),
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
        snapshot.materialProgramKeys === undefined
          ? runtimeMaterialShaderId(pass.program.module, pass.name)
          : selectedProgramKey,
      ]),
      selectedProgram: JSON.stringify(fact.program ?? null),
      identity: this.fixedPrograms,
    });
    this.fixedPrograms?.set(pass, observation);
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
  resources.set(snapshot, {
    resource: undefined,
    valuesOwned: true,
    programs: sourceEntry.programs,
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
