import {
  copyPackData,
  type FixedPackPublication,
  validateFixedPackPublication,
} from '@forgeax/engine-pack/runtime';
import type { PackInstanceJson } from '@forgeax/engine-pack/source';
import type { Asset, AssetPublicationOutput, CatalogEntry } from '@forgeax/engine-types';
import type { RuntimePackContent, RuntimePackSnapshot } from './runtime-pack.js';
import { parseRuntimePackSnapshot } from './runtime-pack-content.js';
import { encodeRuntimePackData } from './runtime-pack-data.js';
import {
  scriptablePackFingerprint as fingerprint,
  scriptablePackFingerprintAsync as fingerprintAsync,
} from './scriptable-pack-fingerprint.js';

/** The immutable production inputs retained by a pinned dependency, never a runtime registry. */
export type RuntimePackRecipe = (
  | { readonly content: RuntimePackContent; readonly instance?: PackInstanceJson }
  | { readonly fixed: FixedPackPublication }
) & {
  readonly dependencies: ReadonlyMap<string, RuntimePackPinnedAsset>;
  readonly outputs: readonly AssetPublicationOutput[];
  readonly assets: ReadonlyMap<string, Asset | (() => Promise<Asset>)>;
};

export interface RuntimePackPinnedAsset {
  readonly asset: Asset | (() => Promise<Asset>);
  readonly digest: string;
  readonly generation: number;
  readonly row: CatalogEntry;
  readonly recipe?: RuntimePackRecipe;
}

export function matchesRuntimePackPin(
  row: CatalogEntry,
  pin: Pick<RuntimePackPinnedAsset, 'row' | 'generation' | 'digest'>,
): boolean {
  const publication = row.publication;
  return (
    publication !== undefined &&
    publication.generation === pin.generation &&
    publication.digest === pin.row.publication?.digest &&
    publication.outputSetDigest === pin.row.publication?.outputSetDigest &&
    publication.outputs.find((output) => output.guid === row.guid)?.digest === pin.digest
  );
}

export type RuntimePackSavedRecipe = (
  | { readonly content: string; readonly instance?: PackInstanceJson }
  | { readonly fixed: FixedPackPublication }
) & {
  readonly outputs: readonly AssetPublicationOutput[];
  readonly dependencies: Readonly<Record<string, string>>;
};

/** Only consumer references are flattened; historical computation recipes remain separate. */
export function collectRuntimePackDependencies(
  dependencies: ReadonlyMap<string, RuntimePackPinnedAsset>,
  roots: Iterable<string>,
): ReadonlyMap<string, RuntimePackPinnedAsset> {
  const pins = new Map<string, RuntimePackPinnedAsset>();
  const visited = new Map<RuntimePackRecipe, Set<string>>();
  const collect = (guid: string, pin: RuntimePackPinnedAsset | undefined) => {
    if (!pin?.recipe) throw new TypeError(`missing reference source ${guid}`);
    const prior = pins.get(guid);
    if (prior && !matchesRuntimePackPin(prior.row, pin))
      throw new TypeError(`reference closure has conflicting versions ${guid}`);
    if (!prior) pins.set(guid, pin);
    const recipe = pin.recipe;
    const seen = visited.get(recipe) ?? new Set<string>();
    if (seen.has(guid)) return;
    seen.add(guid);
    visited.set(recipe, seen);
    const output = recipe.outputs.find((output) => output.guid === guid);
    if (!output) throw new TypeError(`missing reference output ${guid}`);
    for (const ref of output.refs) {
      const sibling = recipe.outputs.find((output) => output.guid === ref);
      const asset = recipe.assets.get(ref);
      if (sibling && !asset) throw new TypeError(`missing sibling snapshot ${ref}`);
      collect(
        ref,
        sibling && asset
          ? {
              ...pin,
              asset,
              digest: sibling.digest,
              row: { ...pin.row, guid: ref, kind: sibling.kind, sourceKey: sibling.sourceKey },
            }
          : recipe.dependencies.get(ref),
      );
    }
  };
  for (const guid of roots) collect(guid, dependencies.get(guid));
  return pins;
}

export function saveRuntimePackSnapshot(
  packs: readonly {
    readonly content: RuntimePackContent;
    readonly dependencies: ReadonlyMap<string, RuntimePackPinnedAsset>;
  }[],
  instances: readonly PackInstanceJson[],
  roots: readonly RuntimePackRecipe[] = [],
): RuntimePackSnapshot {
  const originals = new Set(packs.map((pack) => fingerprint(pack.content)));
  const contents: Record<string, RuntimePackContent> = {};
  const recipes: Record<string, RuntimePackSavedRecipe> = {};
  const bindings: Record<string, Readonly<Record<string, string>>> = {};
  const visited = new Map<RuntimePackRecipe, string>();
  const visiting = new Set<RuntimePackRecipe>();
  const visit = (guid: string, pin: RuntimePackPinnedAsset): string => {
    const recipe = pin.recipe;
    if (!recipe)
      throw new TypeError(`dependency ${guid}@${pin.digest} has no durable producer source`);
    return visitRecipe(recipe);
  };
  const visitRecipe = (recipe: RuntimePackRecipe): string => {
    const prior = visited.get(recipe);
    if (prior) return prior;
    if (visiting.has(recipe)) throw new TypeError('cyclic dependency source');
    visiting.add(recipe);
    const content = 'content' in recipe ? fingerprint(recipe.content) : undefined;
    if ('content' in recipe && content && !originals.has(content))
      contents[content] = recipe.content;
    const dependencies = Object.fromEntries(
      [...recipe.dependencies].map(([guid, dependency]) => [guid, visit(guid, dependency)]),
    );
    const saved = {
      ...('fixed' in recipe
        ? { fixed: recipe.fixed }
        : {
            content: fingerprint(recipe.content),
            ...(recipe.instance === undefined ? {} : { instance: recipe.instance }),
          }),
      outputs: recipe.outputs,
      dependencies,
    };
    const id = fingerprint(saved);
    recipes[id] = saved;
    visited.set(recipe, id);
    visiting.delete(recipe);
    return id;
  };
  for (const pack of packs)
    bindings[fingerprint(pack.content)] = Object.fromEntries(
      [...pack.dependencies].map(([guid, pin]) => [guid, visit(guid, pin)]),
    );
  const recipeRoots = roots.map(visitRecipe);
  return {
    schemaVersion: 'runtime-pack-source/2',
    packs: packs.map((pack) => pack.content),
    instances,
    ...(recipeRoots.length ? { recipeRoots } : {}),
    ...(Object.keys(recipes).length ? { closure: { contents, recipes, bindings } } : {}),
  };
}

/** Compare owned JSON nodes without re-encoding immutable artifact strings. */
function sameSourceData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) {
    if (
      !ArrayBuffer.isView(left) ||
      !ArrayBuffer.isView(right) ||
      Object.getPrototypeOf(left) !== Object.getPrototypeOf(right) ||
      left.byteLength !== right.byteLength
    )
      return false;
    const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    return a.every((byte, index) => byte === b[index]);
  }

  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  const entries = Object.entries(left);
  return (
    entries.length === Object.keys(right).length &&
    entries.every(
      ([key, value]) =>
        Object.hasOwn(right, key) && sameSourceData(value, (right as Record<string, unknown>)[key]),
    )
  );
}

function mergeSourceNodes<T>(
  target: Record<string, T>,
  source: Readonly<Record<string, T>> | undefined,
): void {
  for (const [id, value] of Object.entries(source ?? {})) {
    if (Object.hasOwn(target, id) && !sameSourceData(target[id], value))
      throw new TypeError(`conflicting source node ${id}`);
    Object.defineProperty(target, id, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
}

/** Package fixed dependencies into the same closure DAG used by authored recipes. */
export async function createFixedRuntimePackSnapshot(
  input: FixedPackPublication,
  sources: ReadonlyMap<string, RuntimePackSnapshot> = new Map(),
): Promise<RuntimePackSnapshot> {
  // The caller retains its objects while native hashing yields. Capture the
  // complete inputs before the first await so the returned closure stays fixed.
  const fixed = copyPackData(input) as FixedPackPublication;
  const capturedSources = new Map(
    [...sources].map(([guid, source]) => [guid, parseRuntimePackSnapshot(source)]),
  );
  validateFixedPackPublication(fixed).unwrap();
  const contents: Record<string, RuntimePackContent> = {};
  const recipes: Record<string, RuntimePackSavedRecipe> = {};
  const dependencies: Record<string, string> = {};
  const publication = fixed.rows[0]?.publication;
  if (!publication) throw new TypeError('missing fixed publication');
  const own = new Set(publication.outputs.map((output) => output.guid));
  const refs = new Set(
    publication.outputs.flatMap((output) => output.refs).filter((guid) => !own.has(guid)),
  );
  if (capturedSources.size !== refs.size)
    throw new TypeError('fixed source closure differs from runtime refs');
  for (const guid of refs) {
    const source = capturedSources.get(guid);
    if (!source) throw new TypeError(`missing fixed source ${guid}`);
    for (const content of source.packs)
      mergeSourceNodes(contents, { [await fingerprintAsync(content)]: content });
    mergeSourceNodes(contents, source.closure?.contents);
    mergeSourceNodes(recipes, source.closure?.recipes);
    const matching = (source.recipeRoots ?? []).filter((id) =>
      source.closure?.recipes[id]?.outputs.some((output) => output.guid === guid),
    );
    if (matching.length !== 1) throw new TypeError(`ambiguous fixed source ${guid}`);
    const root = matching[0];
    if (!root) throw new TypeError(`missing fixed source ${guid}`);
    dependencies[guid] = root;
  }
  const recipe: RuntimePackSavedRecipe = { fixed, outputs: publication.outputs, dependencies };
  const id = await fingerprintAsync(recipe);
  recipes[id] = recipe;
  return encodeRuntimePackData({
    schemaVersion: 'runtime-pack-source/2',
    packs: [],
    instances: [],
    recipeRoots: [id],
    closure: { contents, recipes, bindings: {} },
  });
}
