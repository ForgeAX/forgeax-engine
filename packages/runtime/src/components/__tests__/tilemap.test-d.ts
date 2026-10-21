import type { SchemaOf } from '@forgeax/engine-ecs';
import type { Tilemap } from '@forgeax/engine-render/authoring';
import { expectTypeOf, it } from 'vitest';

it('Tilemap carries its complete author layer and managed Tileset reference', () => {
  type Schema = SchemaOf<typeof Tilemap>;
  expectTypeOf<keyof Schema>().toEqualTypeOf<
    'cols' | 'rows' | 'tileSize' | 'chunkSize' | 'tileset' | 'tiles' | 'layerOrder' | 'sortScope'
  >();
  expectTypeOf<Schema['tileset']>().toEqualTypeOf<'asset<tileset>'>();
  expectTypeOf<Schema['tiles']>().toEqualTypeOf<'array<u32>'>();
  expectTypeOf<Schema['sortScope']>().toEqualTypeOf<'u8'>();
});
