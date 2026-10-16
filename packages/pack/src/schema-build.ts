// Node-only schema factories. Runtime envelopes use precompiled validators.
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
export function buildSceneAssetValidator(
  componentSchemas: Readonly<Record<string, object>>,
): ValidateFunction {
  // Use a separate ajv instance so the dynamically registered closed map of
  // component sub-schemas does not pollute the module-top-level validators
  // above (they may be re-built across test fixtures with different
  // component sets).
  const localAjv = new Ajv({ strict: true, allErrors: false });
  addFormats(localAjv, ['uuid']);

  const componentsProperties: Record<string, object> = {};
  for (const [name, sub] of Object.entries(componentSchemas)) {
    componentsProperties[name] = sub;
  }

  const componentsSchema = {
    type: 'object',
    additionalProperties: false,
    properties: componentsProperties,
  };
  const instanceSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['source'],
    properties: {
      // Authored scenes use a GUID string. Pack output may carry a refs[]
      // index, which is resolved by the Scene decoder before instantiation.
      source: {
        oneOf: [
          { type: 'string', minLength: 1 },
          { type: 'integer', minimum: 0 },
        ],
      },
      overrides: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['target', 'components'],
          properties: {
            target: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
            components: componentsSchema,
          },
        },
      },
    },
  };
  const entitySchema = {
    type: 'object',
    additionalProperties: false,
    required: ['components'],
    properties: {
      components: componentsSchema,
      instance: instanceSchema,
    },
  };
  const sceneSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'entities'],
    properties: {
      kind: { type: 'string', const: 'scene' },
      // Skin assets are explicit scene dependencies so async catalog loading
      // can finish the joint-wiring path before the Scene is instantiated.
      // Authored producers use GUID strings; Pack output may use refs[] indices.
      skinGuids: {
        type: 'array',
        items: {
          oneOf: [
            { type: 'string', minLength: 1 },
            { type: 'integer', minimum: 0 },
          ],
        },
      },
      entities: {
        type: 'object',
        propertyNames: { type: 'string', minLength: 1 },
        additionalProperties: entitySchema,
      },
    },
  };

  return localAjv.compile(sceneSchema);
}

export function buildMaterialAssetValidator(
  paramTypeWhitelist: ReadonlySet<string>,
): ValidateFunction {
  const localAjv = new Ajv({ strict: true, allErrors: false });

  const whitelistEnum = Array.from(paramTypeWhitelist);

  const paramSchemaEntry = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'type'],
    properties: {
      name: { type: 'string', minLength: 1 },
      type: { type: 'string', enum: whitelistEnum },
      default: {},
    },
  };

  const materialSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['materialShader', 'paramSchema', 'values'],
    properties: {
      materialShader: { type: 'string', minLength: 1 },
      paramSchema: {
        type: 'array',
        items: paramSchemaEntry,
      },
      values: { type: 'object' },
    },
  };

  return localAjv.compile(materialSchema);
}
