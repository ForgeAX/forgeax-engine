import { isToolCommandContract } from '@forgeax/engine-tool-runtime';
import {
  type AssetPublicationEnvelope,
  type AssetPublicationExternalEvidence,
  assetPublicationReceiptMatches,
  type CatalogEntry,
  canonicalJson,
  err,
  ok,
  type PackV2Error,
  type PluginBuildTarget,
  type Result,
  validateCatalogDelta,
} from '@forgeax/engine-types';
import { validateArtifactPath } from './artifact-path.js';
import { validatePackBlob } from './blob.js';
import { runtimeArtifactDescriptorIssue } from './bundle.js';
import { type PackProgramError, verifyPackProgram } from './program.js';
import type { FixedPackExecution, FixedPackPublication } from './runtime-publication.js';
import { validatePackV2 } from './schema-compiled.js';

function text(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}
function digest(value: unknown): boolean {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/i.test(value);
}
function record(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

type FixedAsset = FixedPackPublication['pack']['assets'][number];

function assertFixedEnvelope(input: FixedPackPublication): void {
  const { pack, executions = {} } = input;
  if (!record(executions)) throw new TypeError('invalid fixed executions');
  if (Object.keys(input).some((key) => !['pack', 'rows', 'blobs', 'executions'].includes(key)))
    throw new TypeError('unknown fixed publication field');
  const { scopeId, generation, digest: packDigest, outputSetDigest, ...semantic } = pack;
  if (
    !validatePackV2(semantic) ||
    !text(scopeId) ||
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    !digest(packDigest) ||
    !digest(outputSetDigest)
  )
    throw new TypeError('invalid fixed Pack envelope');
}

/** The first row's publication is the evidence every sibling must repeat. */
function currentPublicationOf(row: CatalogEntry): AssetPublicationEnvelope {
  const publication = row.publication;
  if (
    !publication ||
    publication.schemaVersion !== 'asset-publication/1' ||
    publication.failure ||
    publication.failureStage ||
    !text(publication.sourcePath) ||
    !text(publication.sourceRevision)
  )
    throw new TypeError('missing current publication evidence');
  return publication;
}

function assertPublicationTuple(
  pack: FixedPackPublication['pack'],
  publication: AssetPublicationEnvelope,
  packageUrl: string,
): void {
  if (
    publication.generation !== pack.generation ||
    publication.digest !== pack.digest ||
    publication.outputSetDigest !== pack.outputSetDigest
  )
    throw new TypeError('fixed publication tuple differs');
  const receipt = publication.receipt;
  if (
    !assetPublicationReceiptMatches(publication) ||
    !text(receipt.inputFingerprint) ||
    canonicalJson(receipt.externalEvidence) !== canonicalJson(publication.externalEvidence)
  )
    throw new TypeError('fixed publication receipt differs');
  const current = publication.current;
  if (
    current &&
    (current.generation !== pack.generation ||
      current.digest !== pack.digest ||
      current.outputSetDigest !== pack.outputSetDigest ||
      current.packageUrl !== packageUrl ||
      current.receiptKey !== receipt.inputFingerprint)
  )
    throw new TypeError('fixed current locator differs');
}

function assertSiblingRow(
  row: CatalogEntry,
  first: CatalogEntry,
  publication: AssetPublicationEnvelope,
  asset: FixedAsset,
  output: AssetPublicationEnvelope['outputs'][number],
): void {
  if (
    row.packageUrl !== first.packageUrl ||
    row.packageId !== first.packageId ||
    row.sourcePath !== publication.sourcePath ||
    row.kind !== asset.kind ||
    output.kind !== asset.kind ||
    !text(output.sourceKey) ||
    (row.sourceKey !== undefined && row.sourceKey !== output.sourceKey) ||
    !digest(output.digest) ||
    canonicalJson(output.refs) !== canonicalJson(asset.refs) ||
    (row.publication !== publication &&
      canonicalJson(row.publication) !== canonicalJson(publication)) ||
    (row.lifecycle !== undefined && row.lifecycle !== 'current')
  )
    throw new TypeError('fixed sibling evidence differs');
}

/** Validate the complete sibling and artifact closure using GUID indexes. */
function validateFixedSiblings(
  input: FixedPackPublication,
  first: CatalogEntry,
  publication: AssetPublicationEnvelope,
) {
  const { pack, rows, blobs } = input;
  const assets = new Map(pack.assets.map((asset) => [asset.guid, asset]));
  const outputs = new Map(publication.outputs.map((output) => [output.guid, output]));
  if (
    !assets.size ||
    assets.size !== pack.assets.length ||
    rows.length !== assets.size ||
    new Set(rows.map((row) => row.guid)).size !== assets.size ||
    outputs.size !== assets.size ||
    outputs.size !== publication.outputs.length
  )
    throw new TypeError('fixed publication must retain every unique sibling');
  const paths = new Set<string>();
  const pluginPrograms = new Map<string, string>();
  for (const row of rows) {
    const asset = assets.get(row.guid);
    const output = outputs.get(row.guid);
    if (!asset || !output) throw new TypeError('fixed sibling evidence differs');
    assertSiblingRow(row, first, publication, asset, output);
    if (asset.kind === 'plugin') {
      const name = (asset.payload as { readonly program?: unknown })?.program;
      if (typeof name !== 'string') throw new TypeError('missing plugin program');
      pluginPrograms.set(asset.guid, name);
    }
    for (const [artifactKey, artifact] of Object.entries(asset.artifacts)) {
      if (
        !validateArtifactPath(artifact.path, {
          packageRoot: first.packageUrl,
          guid: asset.guid,
          artifactKey,
        }).ok ||
        runtimeArtifactDescriptorIssue(artifact) !== undefined
      )
        throw new TypeError('invalid fixed artifact descriptor');
      paths.add(artifact.path);
      validatePackBlob(blobs[artifact.path]);
    }
  }
  if (Object.keys(blobs).some((path) => !paths.has(path)))
    throw new TypeError('unreferenced fixed content');
  return { pluginPrograms, assets };
}

const FIXED_TARGETS = { host: true, engine: true, build: true, frontend: true } satisfies Record<
  PluginBuildTarget,
  true
>;

/** Returns the program names one target's tool contracts reference, recording covered plugins. */
function fixedToolProgramNames(
  target: string,
  tools: FixedPackExecution['tools'],
  pluginPrograms: ReadonlyMap<string, string>,
  covered: Set<string>,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const [guid, contract] of Object.entries(tools)) {
    const name = pluginPrograms.get(guid);
    if (!name || !isToolCommandContract(contract))
      throw new TypeError(`unknown plugin or invalid fixed tool contract: ${target}/${guid}`);
    covered.add(guid);
    names.add(name);
    for (const declaration of contract.commands) {
      if (declaration.realm !== target)
        throw new TypeError(`fixed tool target mismatch: ${target}/${guid}`);
      if (declaration.exportName !== undefined)
        throw new TypeError('fixed tool export must already be selected by its program');
      if (declaration.executor !== undefined) names.add(declaration.executor);
    }
  }
  return names;
}

function validateFixedExecution(
  target: string,
  execution: FixedPackExecution,
  pluginPrograms: ReadonlyMap<string, string>,
  covered: Set<string>,
): Result<void, PackProgramError> {
  if (
    !Object.hasOwn(FIXED_TARGETS, target) ||
    !record(execution) ||
    Object.keys(execution).some((key) => !['programs', 'tools'].includes(key))
  )
    throw new TypeError(`invalid fixed execution target or fields: ${target}`);
  const { programs, tools } = execution;
  if (!record(programs) || !record(tools))
    throw new TypeError(`invalid fixed execution tables: ${target}`);
  if (!Object.keys(tools).length) throw new TypeError('empty fixed execution projection');
  const names = fixedToolProgramNames(target, tools, pluginPrograms, covered);
  if ([...names].some((name) => !Object.hasOwn(programs, name)))
    throw new TypeError('missing portable plugin program or tool executor');
  if (Object.keys(programs).some((name) => !names.has(name)))
    throw new TypeError('unreferenced fixed program');
  for (const program of Object.values(programs)) {
    const verified = verifyPackProgram(program);
    if (!verified.ok) return verified;
  }
  return ok(undefined);
}

/** Fixed recipes retain deliverable references, including independent version evidence. */
export function fixedPublicationDependencies(publication: AssetPublicationEnvelope) {
  const own = new Set(publication.outputs.map((output) => output.guid));
  const dependencies = new Map<string, AssetPublicationExternalEvidence | undefined>();
  for (const output of publication.outputs)
    for (const guid of output.refs) if (!own.has(guid)) dependencies.set(guid, undefined);
  for (const edge of publication.externalEvidence)
    if (edge.usage !== 'content' && !own.has(edge.guid)) dependencies.set(edge.guid, edge);
  return dependencies;
}

export function matchesFixedDependency(
  evidence: AssetPublicationExternalEvidence | undefined,
  pin: { readonly digest: string; readonly generation?: number },
): boolean {
  return (
    (evidence?.digest === undefined || evidence.digest === pin.digest) &&
    (evidence?.generation === undefined || evidence.generation === pin.generation)
  );
}

function assertExternalEvidence(
  publication: AssetPublicationEnvelope,
  own: ReadonlyMap<string, FixedAsset>,
): void {
  const external = new Set<string>();
  for (const evidence of publication.externalEvidence) {
    if (
      external.has(evidence.guid) ||
      own.has(evidence.guid) ||
      !['reference', 'content', 'both'].includes(evidence.usage) ||
      (evidence.digest !== undefined && !digest(evidence.digest)) ||
      (evidence.generation !== undefined &&
        (!Number.isSafeInteger(evidence.generation) || evidence.generation <= 0))
    )
      throw new TypeError('invalid fixed external evidence');
    external.add(evidence.guid);
  }
}

/** Shared capture/replay validation. Producer digests are preserved, never re-derived. */
export function validateFixedPackPublication(
  input: FixedPackPublication,
  selected?: CatalogEntry,
): Result<FixedPackPublication, PackV2Error | PackProgramError> {
  try {
    const { pack, rows, executions = {} } = input;
    assertFixedEnvelope(input);
    if (!validateCatalogDelta({ added: rows, changed: [], removed: [] }).ok)
      throw new TypeError('invalid fixed Catalog rows');
    if (
      selected &&
      canonicalJson(selected) !== canonicalJson(rows.find((row) => row.guid === selected.guid))
    )
      throw new TypeError('selected fixed row differs from the captured Catalog');
    const first = rows[0];
    if (!first) throw new TypeError('missing current publication evidence');
    const publication = currentPublicationOf(first);
    assertPublicationTuple(pack, publication, first.packageUrl);
    const { pluginPrograms, assets } = validateFixedSiblings(input, first, publication);
    const covered = new Set<string>();
    for (const [target, execution] of Object.entries(executions)) {
      const verified = validateFixedExecution(target, execution, pluginPrograms, covered);
      if (!verified.ok) return verified;
    }
    for (const guid of pluginPrograms.keys())
      if (!covered.has(guid))
        throw new TypeError(`missing fixed execution coverage for plugin sibling: ${guid}`);
    assertExternalEvidence(publication, assets);
    return ok(input);
  } catch (cause) {
    return err({
      code: 'pack-v2-envelope-invalid',
      expected: 'one complete immutable Pack publication and its portable content',
      hint: 'restore the original publication evidence, sibling outputs, artifacts and program closure',
      detail: {
        observed: cause instanceof Error ? cause.message : String(cause),
        expected: 'matching Pack, Catalog and receipt',
      },
    });
  }
}
