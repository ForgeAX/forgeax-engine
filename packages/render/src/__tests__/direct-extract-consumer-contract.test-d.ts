import type { World } from '@forgeax/engine-ecs';
import type { CatalogDelta } from '@forgeax/engine-types';
import { expectTypeOf } from 'vitest';
import type { PreparedExtractContext } from '../render-system-extract';
import { extractFrame, extractFrames } from '../render-system-extract-tail';

declare const delta: CatalogDelta;

expectTypeOf(delta.scopeId).toEqualTypeOf<string | undefined>();
expectTypeOf(delta.generation).toEqualTypeOf<number | undefined>();

declare const world: World;
declare const prepared: PreparedExtractContext;

extractFrames([world], 0);
extractFrame(world, prepared);

// Freshness belongs to extractFrames. A per-world kernel call must not compile
// without the context produced by the preparation seam.
// @ts-expect-error extractFrame requires prepared context
extractFrame(world);
// @ts-expect-error null is not a prepared context
extractFrame(world, null);
