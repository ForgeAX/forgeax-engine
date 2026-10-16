import type { AnyScriptablePackDefinition } from '@forgeax/engine/pack/source';

export interface BuildOutcome {
  readonly ok: boolean;
  readonly value?: Readonly<Record<string, unknown>>;
  readonly error?: { readonly code?: string; readonly detail?: Readonly<Record<string, unknown>> };
}

export async function invokeBuild(
  definition: Readonly<AnyScriptablePackDefinition>,
  values?: Readonly<Record<string, unknown>>,
): Promise<BuildOutcome> {
  const build = definition.build as unknown as (context: unknown) => Promise<BuildOutcome>;
  return build({
    packageId: definition.packageId,
    ...(values === undefined ? {} : { values }),
    readByGuid: async () => ({ ok: false, error: { code: 'feature-lab-no-reads' } }),
  });
}

export const GENERATOR_PACK_ID = '0190a1b2-0000-7000-8000-00000000d001';

export const GENERATOR_SOURCE = `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('${GENERATOR_PACK_ID}'),
  parameters: [{ name: 'count', type: 'u32', default: 2, minimum: 1, maximum: 8 }],
  build: ({ values }) => {
    const out = {};
    for (let i = 0; i < values.count; i++) out['samplers/s' + i] = { kind: 'sampler', payload: {} };
    return { ok: true, value: out };
  },
});
`;
