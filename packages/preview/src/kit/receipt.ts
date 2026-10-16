export interface CanonicalKitReceipt {
  readonly schemaVersion: '1.0.0';
  readonly producer: 'packages/preview/scripts/build-canonical-kit.mjs';
  readonly source: {
    readonly sourceKey: string;
    readonly guid: string;
    readonly digest: string;
    readonly metaDigest: string;
  };
  readonly recipe: {
    readonly digest: string;
    readonly value: {
      readonly schemaVersion: '1.0.0';
      readonly rig: 'handle-sphere';
      readonly environment: 'engine-canonical';
      readonly skybox: 'engine-canonical';
      readonly skylight: 'engine-canonical';
      readonly directionalLight: 'engine-canonical';
      readonly stage: 'neutral-material-checker-unlit';
      readonly camera: 'bounds-derived';
    };
  };
  readonly cooked: {
    readonly importer: 'image';
    readonly kind: 'equirect';
    readonly sourceDigest: string;
    readonly metaDigest: string;
  };
  readonly package: {
    readonly name: '@forgeax/engine-preview';
    readonly root: 'assets/canonical-kit';
  };
  readonly transport: {
    readonly dev: 'pluginPack';
    readonly build: 'pluginPack';
    readonly sdk: 'files/assets/canonical-kit';
    readonly source: 'sky.hdr';
    readonly meta: 'sky.hdr.meta.json';
  };
}

export type CanonicalKitReceiptValidation =
  | { readonly ok: true; readonly value: CanonicalKitReceipt }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: 'preview-kit-receipt-invalid';
        readonly expected: string;
        readonly hint: string;
        readonly detail: { readonly field: string; readonly phase: 'receipt' };
      };
    };

const digestPattern = /^sha256:[0-9a-f]{64}$/;

function invalid(field: string): CanonicalKitReceiptValidation {
  return {
    ok: false,
    error: {
      code: 'preview-kit-receipt-invalid',
      expected: `canonical kit receipt field ${field} to be producer-owned and content-addressed`,
      hint: 'Run the canonical kit producer and consume its current receipt; do not derive identity from a path or project preset.',
      detail: { field, phase: 'receipt' },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function validateCanonicalKitReceipt(value: unknown): CanonicalKitReceiptValidation {
  if (!isRecord(value)) return invalid('root');
  if (value.schemaVersion !== '1.0.0') return invalid('schemaVersion');
  if (value.producer !== 'packages/preview/scripts/build-canonical-kit.mjs')
    return invalid('producer');
  const source = value.source;
  if (!isRecord(source)) return invalid('source');
  if (
    typeof source.sourceKey !== 'string' ||
    !source.sourceKey.endsWith('sky.hdr') ||
    typeof source.guid !== 'string' ||
    !digestPattern.test(String(source.digest)) ||
    !digestPattern.test(String(source.metaDigest))
  )
    return invalid('source');
  const recipe = value.recipe;
  if (!isRecord(recipe) || !digestPattern.test(String(recipe.digest)) || !isRecord(recipe.value))
    return invalid('recipe');
  const recipeValue = recipe.value;
  const recipeFields: Record<string, string> = {
    schemaVersion: '1.0.0',
    rig: 'handle-sphere',
    environment: 'engine-canonical',
    skybox: 'engine-canonical',
    skylight: 'engine-canonical',
    directionalLight: 'engine-canonical',
    stage: 'neutral-material-checker-unlit',
    camera: 'bounds-derived',
  };
  for (const [field, expected] of Object.entries(recipeFields)) {
    if (recipeValue[field] !== expected) return invalid(`recipe.value.${field}`);
  }
  const cooked = value.cooked;
  if (
    !isRecord(cooked) ||
    cooked.importer !== 'image' ||
    cooked.kind !== 'equirect' ||
    !digestPattern.test(String(cooked.sourceDigest)) ||
    !digestPattern.test(String(cooked.metaDigest)) ||
    cooked.sourceDigest !== source.digest ||
    cooked.metaDigest !== source.metaDigest
  )
    return invalid('cooked');
  const packageValue = value.package;
  if (
    !isRecord(packageValue) ||
    packageValue.name !== '@forgeax/engine-preview' ||
    packageValue.root !== 'assets/canonical-kit'
  )
    return invalid('package');
  const transport = value.transport;
  if (
    !isRecord(transport) ||
    transport.dev !== 'pluginPack' ||
    transport.build !== 'pluginPack' ||
    transport.sdk !== 'files/assets/canonical-kit' ||
    transport.source !== 'sky.hdr' ||
    transport.meta !== 'sky.hdr.meta.json'
  )
    return invalid('transport');
  return { ok: true, value: value as unknown as CanonicalKitReceipt };
}
