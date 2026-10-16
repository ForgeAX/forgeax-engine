// tilemap.test-d - type-level shape assertions for the Tilemap component schema
// (feat-20260608 M0 baseline rebuild).
//
// Anchors: plan-tasks m0-t3; plan-strategy §M0 targetFiles (tilemap.ts);
// AGENTS.md §Component naming (single-semantic component drops Component suffix).

import { type SchemaOf, World } from '@forgeax/engine-ecs';
import { Tilemap } from '@forgeax/engine-render/authoring';
import { ChildOf } from '@forgeax/engine-scene';
import { describe, expectTypeOf, it } from 'vitest';

describe('Tilemap component schema (M0 baseline)', () => {
  it('type-level: 5 schema fields (cols / rows / tileSize / tileset / chunkSize)', () => {
    type Schema = SchemaOf<typeof Tilemap>;
    const schema: Schema = {
      cols: 'u32',
      rows: 'u32',
      tileSize: 'array<f32, 2>',
      chunkSize: 'u32',
      tileset: 'string',
    };
    expectTypeOf(schema.cols).toEqualTypeOf<'u32'>();
    expectTypeOf(schema.rows).toEqualTypeOf<'u32'>();
    // feat-20260709 M3: tileSizeX/tileSizeY collapsed into one inline
    // array<f32,2> column (tileSize).
    expectTypeOf(schema.tileSize).toEqualTypeOf<'array<f32, 2>'>();
    expectTypeOf(schema.chunkSize).toEqualTypeOf<'u32'>();
    expectTypeOf(schema.tileset).toEqualTypeOf<'string'>();
  });

  it('type-level: Tilemap is consumable by world.query({ read: [...] })', () => {
    const query = new World().query({ read: [Tilemap, ChildOf] });
    expectTypeOf(query).not.toBeNever();
  });
});
