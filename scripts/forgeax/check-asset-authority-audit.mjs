#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_CATEGORIES = Object.freeze([
  'material',
  'shader-render-pipeline',
  'scene',
  'ui',
  'game-config',
  'glb',
  'fbx',
  'mesh-interchange',
  'image',
  'font',
  'audio',
  'plugin',
  'navigation-mesh',
]);

const REQUIRED_CHANNELS = Object.freeze(['ts', 'scripts', 'json']);
const SCHEMA_VERSION = 'asset-authority-audit/1';

function failure(code, expected, hint, detail = {}) {
  return { ok: false, error: { code, expected, hint, detail } };
}

function rootPath(root) {
  return resolve(typeof root === 'string' ? root : process.cwd());
}

function pathExists(root, path) {
  return typeof path === 'string' && path.length > 0 && existsSync(resolve(root, path));
}

function addInput(inputs, path) {
  if (typeof path !== 'string' || path.length === 0) return;
  const extension = extname(path).toLowerCase();
  const channel =
    extension === '.json'
      ? 'json'
      : extension === '.mjs' || extension === '.cjs' || path.startsWith('scripts/')
        ? 'scripts'
        : 'ts';
  if (!inputs[channel].includes(path)) inputs[channel].push(path);
}

function validateCategory(category, index, categoryIds, producerIds, root) {
  if (category === null || typeof category !== 'object') {
    return failure(
      'category-invalid',
      'each category must be an object',
      'add the complete authority conclusion for the category',
      { index },
    );
  }
  const required = [
    'id',
    'subject',
    'execution',
    'authority',
    'runtimeSource',
    'lifecycle',
    'owner',
    'catalog',
    'sourceKeyPolicy',
    'producerIds',
  ];
  for (const field of required) {
    if (category[field] === undefined || category[field] === null || category[field] === '') {
      return failure(
        `category-${field}-missing`,
        `category ${category.id ?? index} declares ${field}`,
        `add ${field} to the authority conclusion; do not infer it from kind or path`,
        { category: category.id ?? index },
      );
    }
  }
  if (!REQUIRED_CATEGORIES.includes(category.id)) {
    return failure(
      'unknown-category',
      `category id in {${REQUIRED_CATEGORIES.join(', ')}}`,
      'name the asset category explicitly instead of absorbing it into an other bucket',
      { category: category.id },
    );
  }
  if (categoryIds.has(category.id)) {
    return failure(
      'duplicate-category',
      'one audit row per named asset category',
      'merge the category conclusions into one row with one authority',
      { category: category.id },
    );
  }
  categoryIds.add(category.id);
  if (!category.authority || typeof category.authority !== 'object') {
    return failure(
      'authority-missing',
      `${category.id} has one authority object`,
      'declare the writer-owned authority and its source files',
      { category: category.id },
    );
  }
  if (typeof category.authority.id !== 'string' || category.authority.id.length === 0) {
    return failure(
      'authority-id-missing',
      `${category.id} has a stable authority id`,
      'give the author authority a stable id',
      { category: category.id },
    );
  }
  if (!Array.isArray(category.authority.sources) || category.authority.sources.length === 0) {
    return failure(
      'authority-source-missing',
      `${category.id} authority lists at least one source`,
      'link the schema or owner descriptor that holds the author fact',
      { category: category.id },
    );
  }
  for (const source of category.authority.sources) {
    if (!pathExists(root, source)) {
      return failure(
        'authority-source-unreadable',
        `authority source exists: ${source}`,
        'point the audit row at the current owner schema or descriptor',
        { category: category.id, source },
      );
    }
  }
  if (!Array.isArray(category.runtimeSource) || category.runtimeSource.length === 0) {
    return failure(
      'runtime-source-missing',
      `${category.id} declares at least one runtime source`,
      'link the runtime loader or projection; cache paths are not runtime sources',
      { category: category.id },
    );
  }
  for (const source of category.runtimeSource) {
    if (!pathExists(root, source)) {
      return failure(
        'runtime-source-unreadable',
        `runtime source exists: ${source}`,
        'point the audit row at the current runtime owner',
        { category: category.id, source },
      );
    }
  }
  if (!Array.isArray(category.producerIds) || category.producerIds.length === 0) {
    return failure(
      'producer-missing',
      `${category.id} names its registered producers`,
      'register every producer explicitly; do not scan only rows with sourceKey',
      { category: category.id },
    );
  }
  for (const producerId of category.producerIds) {
    if (!producerIds.has(producerId)) {
      return failure(
        'unknown-producer',
        `${producerId} is registered in the producer descriptor set`,
        'add the producer descriptor before publishing the audit manifest',
        { category: category.id, producerId },
      );
    }
  }
  return null;
}

function validateProducer(producer, index, producerIds, allowedCategories, root) {
  if (producer === null || typeof producer !== 'object') {
    return failure(
      'producer-invalid',
      'each producer must be an object',
      'declare the producer owner, sources, categories, and outputs',
      { index },
    );
  }
  for (const field of ['id', 'owner', 'sourceFiles', 'categories', 'outputs', 'sourceKeyPolicy']) {
    if (producer[field] === undefined || producer[field] === null || producer[field] === '') {
      return failure(
        `producer-${field}-missing`,
        `producer ${producer.id ?? index} declares ${field}`,
        'complete the producer descriptor before generating the manifest',
        { producer: producer.id ?? index },
      );
    }
  }
  if (producerIds.has(producer.id)) {
    return failure(
      'duplicate-producer',
      'one descriptor per registered producer',
      'merge duplicate producer declarations instead of publishing two authorities',
      { producer: producer.id },
    );
  }
  producerIds.add(producer.id);
  if (!Array.isArray(producer.sourceFiles) || producer.sourceFiles.length === 0) {
    return failure(
      'producer-source-missing',
      `${producer.id} lists source files`,
      'add the TS, script, or schema source that proves the producer exists',
      { producer: producer.id },
    );
  }
  for (const source of producer.sourceFiles) {
    if (!pathExists(root, source)) {
      return failure(
        'producer-source-unreadable',
        `producer source exists: ${source}`,
        'update the descriptor to the current producer owner',
        { producer: producer.id, source },
      );
    }
  }
  if (!Array.isArray(producer.categories) || producer.categories.length === 0) {
    return failure(
      'producer-category-missing',
      `${producer.id} names an explicit category`,
      'do not hide producer output under an unnamed category',
      { producer: producer.id },
    );
  }
  for (const category of producer.categories) {
    if (!allowedCategories.has(category)) {
      return failure(
        'unknown-category',
        `${category} is an allowed audit category`,
        'name the category or the explicit supporting-producer scope',
        { producer: producer.id, category },
      );
    }
  }
  if (!Array.isArray(producer.outputs) || producer.outputs.length === 0) {
    return failure(
      'producer-output-missing',
      `${producer.id} enumerates every output`,
      'list all outputs, including outputs without sourceKey',
      { producer: producer.id },
    );
  }
  const sourceKeys = new Set();
  for (const output of producer.outputs) {
    if (!output || typeof output !== 'object' || typeof output.name !== 'string') {
      return failure(
        'producer-output-invalid',
        `${producer.id} output has a name and category`,
        'declare each output explicitly',
        { producer: producer.id },
      );
    }
    if (!allowedCategories.has(output.category)) {
      return failure(
        'unknown-category',
        `${output.category} is an allowed output category`,
        'classify the output explicitly; do not use other or unclassified',
        { producer: producer.id, output: output.name, category: output.category },
      );
    }
    if (producer.sourceKeyPolicy === 'required') {
      if (typeof output.sourceKey !== 'string' || output.sourceKey.trim().length === 0) {
        return failure(
          'source-key-required',
          `${producer.id}/${output.name} has a non-empty stable sourceKey`,
          'derive identity from producer semantics; sourceIndex is only diagnostic evidence',
          { producer: producer.id, output: output.name },
        );
      }
      if (sourceKeys.has(output.sourceKey)) {
        return failure(
          'source-key-duplicate',
          `${producer.id} output sourceKeys are unique`,
          'rename the duplicate semantic output before publishing Meta',
          { producer: producer.id, sourceKey: output.sourceKey },
        );
      }
      sourceKeys.add(output.sourceKey);
    }
  }
  return null;
}

/**
 * Check the M4 renderer/asset ownership seams that cannot be expressed by the
 * category manifest alone. This is deliberately source-level and narrow: it
 * proves the public Instances shape and the two single-owner projection
 * seams, without attempting to parse TypeScript or duplicate its schemas.
 */
function auditRenderOwnership(root) {
  const paths = {
    instances: 'packages/render/src/components/instances.ts',
    derivedBounds: 'packages/render/src/instances-derived-bounds.ts',
    extract: 'packages/render/src/render-system-extract-tail.ts',
    observation: 'packages/render/src/mesh-material-bindings.ts',
    render: 'packages/render/src/render-system.ts',
    materialInspection: 'packages/assets-runtime/src/material/inspection.ts',
  };
  if (!Object.values(paths).every((path) => pathExists(root, path))) return null;
  const source = Object.fromEntries(
    Object.entries(paths).map(([key, path]) => [key, readFileSync(resolve(root, path), 'utf8')]),
  );
  if (/\bbounds\s*:/.test(source.instances)) {
    return failure(
      'instances-author-schema-expanded',
      'Instances exposes only its packed transforms field',
      'keep derived union bounds in the renderer; do not add an author-facing bounds field',
      { source: paths.instances },
    );
  }
  const requiredSeams = [
    ['derived bounds helper', source.derivedBounds, 'deriveInstancesUnionBounds'],
    ['extract integration', source.extract, 'deriveInstancesUnionBounds'],
    ['resident observation projection', source.observation, 'residency'],
    ['render observation consumption', source.render, 'projectMeshMaterialBindingObservation'],
    ['producer material inspection', source.materialInspection, 'inspectMaterialRuntime'],
  ];
  for (const [name, text, token] of requiredSeams) {
    if (!text.includes(token)) {
      return failure(
        'render-owner-seam-missing',
        `${name} keeps the M4 single-owner seam`,
        `restore ${token} at its owning boundary instead of adding a parallel ledger`,
        { source: name, token },
      );
    }
  }
  return null;
}

export function auditAuthorityDefinition(definition, root = process.cwd()) {
  const audit = definition?.audit;
  const rootDir = rootPath(root);
  if (!audit || typeof audit !== 'object') {
    return failure(
      'audit-definition-missing',
      'schemas/asset-authority.schema.json contains x-forgeax-audit',
      'keep the audit input beside the manifest schema',
    );
  }
  if (audit.schemaVersion !== SCHEMA_VERSION) {
    return failure(
      'audit-schema-version',
      SCHEMA_VERSION,
      'use the current authority audit schema version',
      { actual: audit.schemaVersion },
    );
  }
  if (!Array.isArray(audit.categories) || audit.categories.length !== REQUIRED_CATEGORIES.length) {
    return failure(
      'category-set-incomplete',
      `exactly ${REQUIRED_CATEGORIES.length} named categories`,
      'add each named input category; do not add a generic other row',
      { actual: audit.categories?.length },
    );
  }
  const allowedCategories = new Set(audit.allowedOutputCategories);
  for (const category of [...REQUIRED_CATEGORIES, 'supporting-producer']) {
    if (!allowedCategories.has(category)) {
      return failure(
        'allowed-category-missing',
        `${category} is explicit in allowedOutputCategories`,
        'keep the output scope closed and machine enumerable',
        { category },
      );
    }
  }
  const categoryIds = new Set();
  const authorityIds = new Set();
  const provisionalProducerIds = new Set(
    Array.isArray(audit.producers)
      ? audit.producers.map((producer) => producer?.id).filter(Boolean)
      : [],
  );
  for (const [index, category] of audit.categories.entries()) {
    const categoryError = validateCategory(
      category,
      index,
      categoryIds,
      provisionalProducerIds,
      rootDir,
    );
    if (categoryError) return categoryError;
    if (authorityIds.has(category.authority.id)) {
      return failure(
        'duplicate-authority',
        'one author authority id per category',
        'keep author facts in one owner and make projections read-only',
        { authority: category.authority.id },
      );
    }
    authorityIds.add(category.authority.id);
  }
  if (REQUIRED_CATEGORIES.some((category) => !categoryIds.has(category))) {
    return failure(
      'category-set-incomplete',
      `all categories: ${REQUIRED_CATEGORIES.join(', ')}`,
      'add the missing named category row',
      { missing: REQUIRED_CATEGORIES.filter((category) => !categoryIds.has(category)) },
    );
  }
  if (!Array.isArray(audit.producers)) {
    return failure(
      'producer-set-missing',
      'producer descriptors are an array',
      'enumerate every registered producer and output',
    );
  }
  const producerIds = new Set();
  for (const [index, producer] of audit.producers.entries()) {
    const producerError = validateProducer(
      producer,
      index,
      producerIds,
      allowedCategories,
      rootDir,
    );
    if (producerError) return producerError;
  }
  const inputs = { ts: [], scripts: [], json: [] };
  for (const producer of audit.producers) {
    for (const source of producer.sourceFiles) addInput(inputs, source);
  }
  for (const source of audit.scriptInputs ?? []) addInput(inputs, source);
  for (const source of audit.jsonInputs ?? []) addInput(inputs, source);
  for (const channel of REQUIRED_CHANNELS) {
    if (inputs[channel].length === 0) {
      return failure(
        'input-channel-empty',
        `${channel} input channel has at least one source`,
        'enumerate the source channel instead of hiding it behind a generic producer',
        { channel },
      );
    }
  }
  const renderOwnershipError = auditRenderOwnership(rootDir);
  if (renderOwnershipError) return renderOwnershipError;
  return {
    ok: true,
    value: {
      schemaVersion: SCHEMA_VERSION,
      categories: audit.categories,
      producers: audit.producers,
      inputs,
    },
  };
}

export function buildAuthorityManifest(definition, root = process.cwd()) {
  const result = auditAuthorityDefinition(definition, root);
  if (!result.ok) {
    const error = new Error(`${result.error.code}: ${result.error.hint}`);
    error.code = result.error.code;
    error.detail = result.error.detail;
    throw error;
  }
  return result.value;
}

export async function loadAuthorityDefinition(root = process.cwd()) {
  const rootDir = rootPath(root);
  const schemaPath = resolve(rootDir, 'schemas/asset-authority.schema.json');
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  if (!schema['x-forgeax-audit']) {
    throw new Error('schemas/asset-authority.schema.json is missing x-forgeax-audit');
  }
  return { schema, audit: schema['x-forgeax-audit'] };
}

async function main() {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = rootIndex < 0 ? process.cwd() : args[rootIndex + 1];
  if (rootIndex >= 0 && root === undefined) {
    console.error(
      'usage: node scripts/forgeax/check-asset-authority-audit.mjs [--root <dir>] [--json]',
    );
    process.exitCode = 2;
    return;
  }
  try {
    const definition = await loadAuthorityDefinition(root);
    const result = auditAuthorityDefinition(definition, root);
    if (!result.ok) {
      console.error(JSON.stringify({ ...result.error, status: 'blocked' }));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(result.value, null, 2));
  } catch (error) {
    console.error(
      JSON.stringify({
        code: 'audit-read-failed',
        expected: 'a readable schemas/asset-authority.schema.json',
        hint: 'repair the authority schema and rerun the audit',
        detail: { reason: error instanceof Error ? error.message : String(error) },
        status: 'blocked',
      }),
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
