import { runtimeMaterialShaderId } from '@forgeax/engine-assets-runtime';
import { isDeepFrozenJson } from '@forgeax/engine-types';
import type { MaterialResource } from '../material-resource';
import type { MaterialSnapshot } from '../render-system-extract';
import { GenerationalWeakMap } from '../scene/generational-weak-map';
import type { StandardSceneDataContributorProgramFact } from './scene-data';

type Pass = MaterialSnapshot['passes'][number];
interface ProgramObservation {
  readonly fact: StandardSceneDataContributorProgramFact;
  readonly selectedProgram: string;
  readonly candidates: readonly StandardSceneDataContributorProgramFact[];
  publicationKey: string | undefined;
  publication: string;
}
const selections = new GenerationalWeakMap<
  MaterialSnapshot,
  Map<Pass, ProgramObservation> | false
>();
// A parameter write replaces the snapshot and keeps its program subtrees. The
// material remembers only the fixed program inputs, so retired parameter values
// are not retained when the next snapshot shares its program observations.
type ProgramInputs = {
  readonly [Name in (typeof PROGRAM_FIELDS)[number]]: MaterialSnapshot[Name];
};
const materialSelections = new WeakMap<
  MaterialResource,
  {
    inputs: ProgramInputs;
    entries: Map<Pass, ProgramObservation>;
  }
>();
const fixedTrees = new WeakSet<object>();
const PROGRAM_FIELDS = [
  'passes',
  'materialProgramKeys',
  'materialProgramInputs',
  'materialPublication',
  'materialContext',
] as const;

// Frozen sparse arrays can still observe inherited indexed properties.
function denseArrays(node: object): boolean {
  if (Array.isArray(node))
    for (let index = 0; index < node.length; index++) if (!Object.hasOwn(node, index)) return false;
  for (const child of Object.values(node))
    if (child !== null && typeof child === 'object' && !denseArrays(child)) return false;
  return true;
}
function fixedTree(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object') return typeof value !== 'function';
  if (fixedTrees.has(value)) return true;
  if (!isDeepFrozenJson(value) || !denseArrays(value)) return false;
  fixedTrees.add(value);
  return true;
}
function fixedProgramSnapshot(snapshot: MaterialSnapshot): boolean {
  try {
    if (!Object.isFrozen(snapshot)) return false;
    const prototype = Object.getPrototypeOf(snapshot);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const name of PROGRAM_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(snapshot, name);
      if (descriptor === undefined || !('value' in descriptor) || !fixedTree(descriptor.value))
        return false;
    }
    return true;
  } catch {
    // An observable/failed proof never changes the borrowed input route.
    return false;
  }
}

function sameProgramInputs(inputs: ProgramInputs, snapshot: MaterialSnapshot): boolean {
  for (const name of PROGRAM_FIELDS) if (inputs[name] !== snapshot[name]) return false;
  return true;
}

/** Both inputs passed the fixed proof; retain program facts without value payloads. */
function materialProgramObservations(
  material: MaterialResource,
  snapshot: MaterialSnapshot,
): Map<Pass, ProgramObservation> {
  const latest = materialSelections.get(material);
  if (latest !== undefined && sameProgramInputs(latest.inputs, snapshot)) return latest.entries;
  const entries = new Map<Pass, ProgramObservation>();
  materialSelections.set(material, {
    inputs: {
      passes: snapshot.passes,
      materialProgramKeys: snapshot.materialProgramKeys,
      materialProgramInputs: snapshot.materialProgramInputs,
      materialPublication: snapshot.materialPublication,
      materialContext: snapshot.materialContext,
    },
    entries,
  });
  return entries;
}

/** Only complete immutable observations can share serialization and selected facts. */
export function retainedMaterialProgramFacts(
  material: MaterialResource,
  snapshot: MaterialSnapshot,
  pass: Pass,
  fallbackProgramKey: string | undefined,
): ProgramObservation | undefined {
  let entries = selections.get(snapshot);
  if (entries === false) return undefined;
  if (entries === undefined) {
    if (!fixedProgramSnapshot(snapshot)) {
      // A miss only chooses the ordinary live route; it retains no mutable facts.
      // Later freezing can safely remain on that route until this memo forgets it.
      selections.set(snapshot, false);
      return undefined;
    }
    entries = materialProgramObservations(material, snapshot);
    selections.set(snapshot, entries);
  }
  const publicationKey = snapshot.materialProgramKeys?.[pass.name] ?? fallbackProgramKey;
  let selection = entries.get(pass);
  if (selection === undefined) {
    const fact = materialProgramFact(material, pass);
    selection = {
      fact,
      selectedProgram: JSON.stringify(fact.program ?? null),
      candidates: Object.freeze([fact]),
      publicationKey,
      publication: JSON.stringify([snapshot.materialPublication?.identity ?? null, publicationKey]),
    };
    entries.set(pass, selection);
  } else if (selection.publicationKey !== publicationKey) {
    selection.publicationKey = publicationKey;
    selection.publication = JSON.stringify([
      snapshot.materialPublication?.identity ?? null,
      publicationKey,
    ]);
  }
  return selection;
}

export function materialProgramFact(
  material: MaterialResource,
  pass: MaterialResource['snapshot']['passes'][number],
): StandardSceneDataContributorProgramFact {
  const snapshot = material.snapshot;
  const selectedProgramKey = snapshot.materialProgramKeys?.[pass.name];
  const registryLookupKey =
    selectedProgramKey ?? runtimeMaterialShaderId(pass.program.module, pass.name);
  const selectedProgram = snapshot.materialPublication?.programs.find(
    (program) => program.pass === pass.name,
  );
  return Object.freeze({
    pass: pass.name,
    authoredModule: pass.program.module,
    authoredShaderId: runtimeMaterialShaderId(pass.program.module, pass.name),
    selectedProgramKey,
    registryLookupKey,
    fragmentEntryPoints: Object.freeze(
      (snapshot.materialProgramInputs?.[pass.name]?.entryPoints ?? [])
        .filter((entry) => entry.stage === 'fragment')
        .map((entry) => entry.name),
    ),
    publicationIdentity: snapshot.materialPublication?.identity,
    program:
      selectedProgram === undefined
        ? undefined
        : Object.freeze({
            context: selectedProgram.context,
            address: selectedProgram.address,
            specializationKey: selectedProgram.specializationKey,
            artifactHash: selectedProgram.artifactHash,
          }),
  });
}
