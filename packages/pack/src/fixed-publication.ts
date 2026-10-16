import { isToolCommandContract } from '@forgeax/engine-tool-runtime';
import {
  type CatalogEntry,
  err,
  ok,
  type PackV2Error,
  type PluginBuildTarget,
  type Result,
  validateCatalogDelta,
} from '@forgeax/engine-types';
import { validateArtifactPath } from './artifact-path.js';
import { validatePackBlob } from './blob.js';
import { type PackProgramError, verifyPackProgram } from './program.js';
import type { FixedPackPublication } from './runtime-publication.js';
import { validatePackV2 } from './schema-compiled.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
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

/** Shared capture/replay validation. Producer digests are preserved, never re-derived. */
export function validateFixedPackPublication(
  input: FixedPackPublication,
  selected?: CatalogEntry,
): Result<FixedPackPublication, PackV2Error | PackProgramError> {
  try {
    const { pack, rows, blobs, executions = {} } = input;
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
    if (!validateCatalogDelta({ added: rows, changed: [], removed: [] }).ok)
      throw new TypeError('invalid fixed Catalog rows');
    if (
      selected &&
      canonical(selected) !== canonical(rows.find((row) => row.guid === selected.guid))
    )
      throw new TypeError('selected fixed row differs from the captured Catalog');
    const first = rows[0];
    const publication = first?.publication;
    if (
      !first ||
      !publication ||
      publication.schemaVersion !== 'asset-publication/1' ||
      publication.failure ||
      publication.failureStage ||
      !text(publication.sourcePath) ||
      !text(publication.sourceRevision)
    )
      throw new TypeError('missing current publication evidence');
    if (
      publication.generation !== generation ||
      publication.digest !== packDigest ||
      publication.outputSetDigest !== outputSetDigest
    )
      throw new TypeError('fixed publication tuple differs');
    const receipt = publication.receipt;
    if (
      !receipt ||
      receipt.schemaVersion !== 'asset-publication-receipt/1' ||
      receipt.sourcePath !== publication.sourcePath ||
      receipt.sourceRevision !== publication.sourceRevision ||
      receipt.outputDigest !== packDigest ||
      receipt.outputSetDigest !== outputSetDigest ||
      !text(receipt.inputFingerprint) ||
      canonical(receipt.externalEvidence) !== canonical(publication.externalEvidence)
    )
      throw new TypeError('fixed publication receipt differs');
    const current = publication.current;
    if (
      current &&
      (current.generation !== generation ||
        current.digest !== packDigest ||
        current.outputSetDigest !== outputSetDigest ||
        current.packageUrl !== first.packageUrl ||
        current.receiptKey !== receipt.inputFingerprint)
    )
      throw new TypeError('fixed current locator differs');
    const own = new Set(pack.assets.map((asset) => asset.guid));
    if (
      !own.size ||
      own.size !== pack.assets.length ||
      rows.length !== own.size ||
      new Set(rows.map((row) => row.guid)).size !== own.size ||
      publication.outputs.length !== own.size ||
      new Set(publication.outputs.map((output) => output.guid)).size !== own.size
    )
      throw new TypeError('fixed publication must retain every unique sibling');
    const paths = new Set<string>();
    const pluginPrograms = new Map<string, string>();
    for (const row of rows) {
      const asset = pack.assets.find((asset) => asset.guid === row.guid);
      const output = publication.outputs.find((output) => output.guid === row.guid);
      if (
        !asset ||
        !output ||
        row.packageUrl !== first.packageUrl ||
        row.packageId !== first.packageId ||
        row.sourcePath !== publication.sourcePath ||
        row.kind !== asset.kind ||
        output.kind !== asset.kind ||
        !text(output.sourceKey) ||
        (row.sourceKey !== undefined && row.sourceKey !== output.sourceKey) ||
        !digest(output.digest) ||
        canonical(output.refs) !== canonical(asset.refs) ||
        canonical(row.publication) !== canonical(publication) ||
        (row.lifecycle !== undefined && row.lifecycle !== 'current')
      )
        throw new TypeError('fixed sibling evidence differs');
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
          !text(artifact.mediaType) ||
          !['identity', 'zstd'].includes(artifact.contentEncoding) ||
          !Number.isSafeInteger(artifact.byteLength) ||
          artifact.byteLength < 0 ||
          artifact.integrity?.algorithm !== 'sha256' ||
          !digest(artifact.integrity.digest)
        )
          throw new TypeError('invalid fixed artifact descriptor');
        paths.add(artifact.path);
        const bytes = blobs[artifact.path];
        validatePackBlob(bytes);
      }
    }
    if (Object.keys(blobs).some((path) => !paths.has(path)))
      throw new TypeError('unreferenced fixed content');
    const targets = { host: true, engine: true, build: true, frontend: true } satisfies Record<
      PluginBuildTarget,
      true
    >;
    const covered = new Set<string>();
    for (const [target, execution] of Object.entries(executions)) {
      if (
        !Object.hasOwn(targets, target) ||
        !record(execution) ||
        Object.keys(execution).some((key) => !['programs', 'tools'].includes(key))
      )
        throw new TypeError(`invalid fixed execution target or fields: ${target}`);
      const { programs, tools } = execution;
      if (!record(programs) || !record(tools))
        throw new TypeError(`invalid fixed execution tables: ${target}`);
      if (!Object.keys(tools).length) throw new TypeError('empty fixed execution projection');
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
      if ([...names].some((name) => !Object.hasOwn(programs, name)))
        throw new TypeError('missing portable plugin program or tool executor');
      if (Object.keys(programs).some((name) => !names.has(name)))
        throw new TypeError('unreferenced fixed program');
      for (const program of Object.values(programs)) {
        const verified = verifyPackProgram(program);
        if (!verified.ok) return verified;
      }
    }
    for (const guid of pluginPrograms.keys())
      if (!covered.has(guid))
        throw new TypeError(`missing fixed execution coverage for plugin sibling: ${guid}`);
    const external = new Map<string, (typeof publication.externalEvidence)[number]>();
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
      external.set(evidence.guid, evidence);
    }
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
