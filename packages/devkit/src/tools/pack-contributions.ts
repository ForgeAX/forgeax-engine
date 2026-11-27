import { randomUUID } from 'node:crypto';
import {
  PACK_AUTHORING_OPERATION_DESCRIPTORS,
  type PackAuthoringOperation,
  type PackAuthoringOperationResult,
} from '@forgeax/engine-pack/source';
import {
  defineTool,
  operationCommandPath,
  type ToolContribution,
  type ToolDescriptor,
  type ToolJsonSchema,
  type ToolSchema,
} from '@forgeax/engine-tool-runtime';
import { type CommandResult, toolCommandValue } from '../types.js';

const string = { type: 'string' } as const satisfies ToolJsonSchema;
const boolean = { type: 'boolean' } as const satisfies ToolJsonSchema;
const object = { type: 'object' } as const satisfies ToolJsonSchema;
const uuid = { ...string, format: 'uuid' };
const resolveRequirements = ['identity', 'present', 'ready'] as const;

const mutationFields = {
  requestId: { ...string, minLength: 1 },
  expectedRevision: string,
  subject: string,
  sourcePath: string,
  sourceRoot: string,
  targetPath: string,
  packageId: uuid,
  parentPackageId: uuid,
  parent: uuid,
  sourceKey: { ...string, pattern: '^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$' },
  format: { enum: ['pack.ts', 'pack.json'] },
  require: { enum: resolveRequirements },
  values: object,
  initialAssets: object,
  parameters: { type: 'array', minItems: 1 },
  draft: { ...object, description: 'Pack-owned draft request with its action and draft identity.' },
};

function parsePackRequest(value: unknown, readOnly = false) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { ok: false as const, error: 'expected a Pack authoring operation object' };
  const input = (
    readOnly ? { requestId: randomUUID(), ...value } : value
  ) as PackAuthoringOperation;
  if (typeof input.requestId !== 'string' || input.requestId.trim().length === 0)
    return { ok: false as const, error: 'requestId must be a non-empty caller-minted string' };
  return { ok: true as const, value: input };
}

function packOperationArgsSchema(
  operation: (typeof PACK_AUTHORING_OPERATION_DESCRIPTORS)[number],
): ToolSchema<PackAuthoringOperation> {
  const required = [
    'requestId',
    ...(operation.requiresRevision ? ['expectedRevision'] : []),
    ...('requiredFields' in operation ? operation.requiredFields : []),
  ];
  return {
    describe: JSON.stringify({ type: 'object', required, properties: mutationFields }),
    parse(value) {
      const parsed = parsePackRequest(value);
      if (!parsed.ok) return parsed;
      const args = value as Record<string, unknown>;
      for (const field of required) {
        if (args[field] === undefined || args[field] === null || args[field] === '')
          return { ok: false, error: `${field} is required for ${operation.id}` };
      }
      return parsed;
    },
  };
}

const packAuthoringResultSchema: ToolSchema<PackAuthoringOperationResult> = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'expected a Pack authoring result object' };
    }
    return { ok: true, value: value as PackAuthoringOperationResult };
  },
  describe: '{"type":"object"}',
};

/**
 * The public asset read paths use the same schema in the command tree and
 * in their Pack domain descriptors. Keeping these JSON shapes here prevents
 * help from advertising the lower-level request envelope to CLI callers.
 */
export const assetListInputSchema: ToolJsonSchema = {
  type: 'object',
  properties: {
    root: string,
    type: {
      type: 'string',
      description:
        'Asset kind filter, e.g. scene, material or mesh. A listed scene renders through its authored camera, without playing, with asset preview --kind scene --guid <guid>.',
    },
    limit: { type: 'integer', minimum: 1, maximum: 256 },
    cursor: string,
    json: boolean,
  },
  additionalProperties: false,
};

export const assetInspectInputSchema: ToolJsonSchema = {
  type: 'object',
  properties: {
    root: string,
    subject: string,
    json: boolean,
    catalog: {
      type: 'string',
      description:
        'Read offline evidence for a GUID from this Catalog, relative to the project root.',
    },
    parametersOnly: {
      type: 'boolean',
      description:
        'Read and validate only .pack.ts parameter declarations, with generation/runtime mode, bindings and source locations. No module execution, project scan, generation or runtime target validation.',
    },
  },
  required: ['subject'],
  additionalProperties: false,
};

export const assetResolveInputSchema: ToolJsonSchema = {
  type: 'object',
  properties: {
    root: string,
    subject: string,
    packageId: string,
    sourceKey: string,
    require: { enum: resolveRequirements },
    json: boolean,
  },
  additionalProperties: false,
};

export const assetVerifyInputSchema: ToolJsonSchema = {
  type: 'object',
  properties: { root: string, json: boolean },
  additionalProperties: false,
};

function packReadArgsSchemaFor(inputSchema: ToolJsonSchema): ToolSchema<PackAuthoringOperation> {
  // Read-only requests need correlation, but have no mutation replay/CAS
  // identity. Derive that correlation at the adapter instead of making CLI
  // callers mint it.
  return {
    parse: (value) => parsePackRequest(value, true),
    describe: JSON.stringify(inputSchema),
  };
}

type PackOperation = (typeof PACK_AUTHORING_OPERATION_DESCRIPTORS)[number];
type PackReadId = Extract<PackOperation, { readonly readOnly: true }>['id'];
type AssetCommands = typeof import('../assets.js');

type PackReader = {
  title: string;
  schema: ToolJsonSchema;
  execute(
    assets: AssetCommands,
    root: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<CommandResult<unknown>>;
};

const packReads = {
  'asset.list': {
    title: 'List Pack assets',
    schema: assetListInputSchema,
    execute(assets, root, input) {
      return assets.assetListCommand({
        root,
        ...(typeof input.type === 'string' ? { type: input.type } : {}),
        ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
        ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
      });
    },
  },
  'asset.inspect': {
    title: 'Inspect Pack subject',
    schema: assetInspectInputSchema,
    execute(assets, root, input) {
      return assets.assetInspectCommand({
        root,
        subject: String(input.subject ?? ''),
        ...(typeof input.catalog === 'string' ? { catalog: input.catalog } : {}),
        ...(input.parametersOnly === true ? { parametersOnly: true } : {}),
      });
    },
  },
  'asset.resolve': {
    title: 'Resolve Pack asset identity',
    schema: assetResolveInputSchema,
    execute(assets, root, input) {
      const { subject, packageId, sourceKey } = input;
      const require = resolveRequirements.find((entry) => entry === input.require);
      return assets.assetResolveCommand({
        root,
        ...(typeof subject === 'string' ? { subject } : {}),
        ...(typeof packageId === 'string' ? { packageId } : {}),
        ...(typeof sourceKey === 'string' ? { sourceKey } : {}),
        ...(require === undefined ? {} : { require }),
      });
    },
  },
  'asset.verify': {
    title: 'Verify Pack authoring',
    schema: assetVerifyInputSchema,
    execute: (assets, root) => assets.assetVerifyCommand({ root }),
  },
} satisfies Record<PackReadId, PackReader>;

const mutationTitles: Record<Exclude<PackOperation['id'], PackReadId>, string> = {
  'asset.source.create': 'Create Pack source',
  'asset.source.clone': 'Clone Pack source closure',
  'asset.source.import': 'Import Pack source closure',
  'asset.source.instance.create': 'Create Pack instance',
  'asset.source.values.apply': 'Apply Pack instance values',
  'asset.source.rebuild': 'Rebuild Pack source',
  'asset.source.cold-cook': 'Cold-cook Pack source',
  'asset.source.draft': 'Edit Pack source draft',
};

function packDescriptor(operation: PackOperation): ToolDescriptor<PackAuthoringOperation> {
  return {
    id: operation.id,
    path: operationCommandPath(operation.id),
    title: operation.readOnly ? packReads[operation.id].title : mutationTitles[operation.id],
    summary: operation.readOnly
      ? 'Reads Pack identity, topology, inheritance, or current readiness without building or writing.'
      : operation.requiresRevision
        ? 'Runs Pack source mutation with requestId and expectedRevision CAS; inspect the source revision first.'
        : 'Runs Pack source authoring with requestId and operation-owned write and identity semantics.',
    realm: 'build',
    argsSchema: operation.readOnly
      ? packReadArgsSchemaFor(packReads[operation.id].schema)
      : packOperationArgsSchema(operation),
    resultSchema: packAuthoringResultSchema,
    evidence: [],
  };
}

const packOperations = PACK_AUTHORING_OPERATION_DESCRIPTORS.map((operation) => ({
  operation,
  descriptor: packDescriptor(operation),
}));

export const packAuthoringToolDescriptors: readonly ToolDescriptor<PackAuthoringOperation>[] =
  packOperations.map(({ descriptor }) => descriptor);

export function createPackAuthoringContributions(
  projectRoot = process.cwd(),
): readonly ToolContribution<unknown, unknown>[] {
  // Retain the gateway's request-id deduplication for this client, but activate
  // its producer only when an authoring operation executes.
  type PackGateway = ReturnType<
    typeof import('@forgeax/engine-pack/build').createFileSystemPackAuthoringGateway
  >;
  let gateway: Promise<CommandResult<PackGateway>> | undefined;
  async function getGateway() {
    if (gateway === undefined)
      gateway = (async () => {
        const { readProjectFacts } = await import('../project.js');
        const facts = await readProjectFacts(projectRoot);
        if (!facts.ok) return facts;
        const { createFileSystemPackAuthoringGateway } = await import('@forgeax/engine-pack/build');
        return {
          ok: true as const,
          value: createFileSystemPackAuthoringGateway({
            gameRoot: facts.value.root,
            scanRoots: facts.value.assetRoots,
            transfer: async (operation) =>
              (await import('../source-transfer.js')).transferPackOperation(projectRoot, operation),
          }),
        };
      })();
    const pending = gateway;
    const initialized = await pending;
    if (!initialized.ok && gateway === pending) gateway = undefined;
    return initialized;
  }
  return packOperations.map(
    ({ operation, descriptor }) =>
      defineTool(descriptor, async (input) => {
        if (operation.readOnly) {
          const reader = packReads[operation.id];
          return toolCommandValue(
            await reader.execute(
              await import('../assets.js'),
              projectRoot,
              input as unknown as Readonly<Record<string, unknown>>,
            ),
          );
        }
        const initialized = await getGateway();
        return toolCommandValue(
          initialized.ok
            ? await initialized.value.execute({ ...input, operation: operation.id })
            : initialized,
        );
      }) as unknown as ToolContribution<unknown, unknown>,
  );
}
