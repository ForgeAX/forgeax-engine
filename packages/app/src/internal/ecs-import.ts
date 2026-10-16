// @forgeax/engine-app/internal/ecs-import — host-owned capability projection.
//
// The remote transport deliberately has no engine-package vocabulary. Hosts
// that expose ECS to eval inject this narrow projection at the transport seam,
// keeping the ECS wire surface and its dependency ownership in one place.

import type { World } from '@forgeax/engine-ecs';

const ECS_MODULE_SPECIFIER = '@forgeax/engine-ecs';

export const ECS_PUBLIC_SYMBOLS = Object.freeze([
  'World',
  'Entity',
  'Update',
  'FixedUpdate',
  'Time',
  'FixedTime',
] as const);

export type EcsPublicSymbol = (typeof ECS_PUBLIC_SYMBOLS)[number];
export type EcsPublicModule = Readonly<Partial<Record<EcsPublicSymbol, unknown>>>;

type ComponentLike = { readonly name: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export function projectEcsPublicModule(value: unknown): EcsPublicModule {
  if (!isRecord(value)) return {};
  const projected: Record<string, unknown> = {};
  for (const symbol of ECS_PUBLIC_SYMBOLS) {
    if (symbol in value) projected[symbol] = value[symbol];
  }
  return projected;
}

export function createEcsImportModule(
  importModule: (specifier: string) => Promise<unknown>,
): (specifier: string) => Promise<unknown> {
  return async (specifier: string): Promise<unknown> => {
    const moduleValue = await importModule(specifier);
    return specifier === ECS_MODULE_SPECIFIER ? projectEcsPublicModule(moduleValue) : moduleValue;
  };
}

/**
 * Rebind component exports to the tokens already registered by one World.
 * Vite can evaluate an Engine package through more than one module-graph URL;
 * component identity is process-local, so the World catalog remains the
 * authority for values crossing the eval boundary.
 */
export function canonicalRuntimeModule(moduleValue: unknown, world: World): unknown {
  if (moduleValue === null || typeof moduleValue !== 'object') return moduleValue;
  const componentsByName = new Map<string, ComponentLike>();
  for (const [name, component] of world.components.entries()) {
    if (!componentsByName.has(name)) componentsByName.set(name, component);
  }
  const projected: Record<string, unknown> = { ...(moduleValue as Record<string, unknown>) };
  for (const [key, value] of Object.entries(projected)) {
    if (value === null || typeof value !== 'object' || !('name' in value)) continue;
    const canonical = componentsByName.get((value as ComponentLike).name);
    if (canonical !== undefined) projected[key] = canonical;
  }
  return projected;
}

/**
 * Build the one browser-side module resolver shared by main and Worker eval.
 * The caller supplies only the realm-specific import transport; ECS projection
 * and component canonicalization stay identical on both sides.
 */
export function createCanonicalEcsImportModule(
  world: World,
  importModule: (specifier: string) => Promise<unknown>,
): (specifier: string) => Promise<unknown> {
  return createEcsImportModule(async (specifier: string) =>
    canonicalRuntimeModule(await importModule(specifier), world),
  );
}
