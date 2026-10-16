/**
 * Normalize the small set of SceneAsset fields emitted by the 0.1.27
 * ScriptablePack template before the current keyed runtime validates them.
 *
 * This is deliberately a boundary migration. Current authoring and runtime
 * types stay keyed and use `shadowFilter`; only old payloads carry numeric
 * ChildOf addresses or `pcfKernelSize`.
 */
export function migrateLegacySceneComponentFields(
  componentName: string,
  source: Record<string, unknown>,
  addressByLocalId?: ReadonlyMap<number, string>,
): Record<string, unknown> {
  const fields = { ...source };
  const address = (value: unknown): unknown =>
    Number.isSafeInteger(value) ? (addressByLocalId?.get(value as number) ?? String(value)) : value;
  if (componentName === 'DirectionalLight' && Object.hasOwn(fields, 'pcfKernelSize')) {
    const kernel = fields.pcfKernelSize;
    const shadowFilter = kernel === 1 ? 1 : kernel === 3 ? 2 : kernel === 5 ? 3 : undefined;
    if (shadowFilter !== undefined && !Object.hasOwn(fields, 'shadowFilter')) {
      delete fields.pcfKernelSize;
      fields.shadowFilter = shadowFilter;
    }
  }
  if (componentName === 'ChildOf' && Number.isSafeInteger(fields.parent)) {
    fields.parent = address(fields.parent);
  }
  if (componentName === 'Children' && Array.isArray(fields.entities)) {
    fields.entities = fields.entities.map(address);
  }
  return fields;
}

interface LegacySceneEntity {
  readonly localId?: unknown;
  readonly bindingKey?: unknown;
  readonly components?: unknown;
  readonly instance?: unknown;
}

/**
 * Lift the pre-keyed SceneAsset array into the current keyed shape.
 *
 * The 0.1.27 template used `localId` for storage and `bindingKey` for the
 * gameplay-facing names. Keeping the binding key is essential: the runtime
 * resolves `player`, `camera`, and joints by that name, not by the old number.
 * This function is intentionally structural and accepts `unknown` only at the
 * compatibility boundary; current authoring types remain keyed.
 */
export function normalizeLegacySceneAsset(
  scene: unknown,
): import('@forgeax/engine-types').SceneAsset {
  if (scene === null || typeof scene !== 'object') return scene as never;
  const candidate = scene as { readonly entities?: unknown };
  if (!Array.isArray(candidate.entities))
    return scene as import('@forgeax/engine-types').SceneAsset;

  const rows = candidate.entities as readonly LegacySceneEntity[];
  const addressByLocalId = new Map<number, string>();
  const rowKeys: string[] = [];
  const used = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const localId = Number.isSafeInteger(row?.localId) ? (row.localId as number) : index;
    const bindingKey =
      typeof row?.bindingKey === 'string' && row.bindingKey.length > 0
        ? row.bindingKey
        : String(localId);
    const key = used.has(bindingKey) ? String(localId) : bindingKey;
    used.add(key);
    addressByLocalId.set(localId, key);
    rowKeys.push(key);
  }

  const entities: Record<
    string,
    { readonly components: Record<string, Record<string, unknown>>; readonly instance?: unknown }
  > = {};
  for (const [index, row] of rows.entries()) {
    const key = rowKeys[index] as string;
    const rawComponents = row?.components;
    const components: Record<string, Record<string, unknown>> = {};
    if (
      rawComponents !== null &&
      typeof rawComponents === 'object' &&
      !Array.isArray(rawComponents)
    ) {
      for (const [componentName, rawFields] of Object.entries(
        rawComponents as Record<string, unknown>,
      )) {
        if (rawFields === null || typeof rawFields !== 'object' || Array.isArray(rawFields))
          continue;
        components[componentName] = migrateLegacySceneComponentFields(
          componentName,
          rawFields as Record<string, unknown>,
          addressByLocalId,
        );
      }
    }
    entities[key] = {
      components,
      ...(row?.instance === undefined ? {} : { instance: row.instance }),
    };
  }
  return {
    ...(scene as Record<string, unknown>),
    entities,
  } as import('@forgeax/engine-types').SceneAsset;
}
