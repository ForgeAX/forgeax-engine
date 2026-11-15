import type { World } from '@forgeax/engine-ecs';
import type { CatalogDelta } from '@forgeax/engine-types';
import { expectTypeOf } from 'vitest';
import type { PreparedExtractContext } from '../render-system-extract';
import { extractFrame, extractSource } from '../render-system-extract-tail';

declare const delta: CatalogDelta;

expectTypeOf(delta.scopeId).toEqualTypeOf<string | undefined>();
expectTypeOf(delta.generation).toEqualTypeOf<number | undefined>();

declare const world: World;
declare const prepared: PreparedExtractContext;
extractSource(world);
extractFrame(world, prepared);
// Freshness belongs to extractSource. A direct kernel call must not compile
// without the context produced by the preparation seam.
// @ts-expect-error extractFrame requires prepared context
extractFrame(world);
// @ts-expect-error null is not a prepared context
extractFrame(world, null);
