import { createMeshBuilder, deriveVertexBufferLayout } from '@forgeax/engine-geometry';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import type {
  MaterialAsset,
  MaterialValue,
  MeshAsset,
  VertexAttributeMap,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createMaterialPackCooker } from '../../../shader-compiler/src/material/pack-cooker';
import { Materials } from '../materials';

// A stock material's vertex stage rejects (WebGPU "vertex attribute slot N is
// not present") any mesh layout that omits one of its declared inputs. UV sets
// beyond the mesh's own are aliased by the renderer, so they are excluded here
// exactly as `deriveVertexBufferLayout({ shaderUvSetCount })` excludes them.
async function stockVertexLocations(source: MaterialAsset): Promise<Set<number>> {
  const output = await createMaterialPackCooker().cook({
    guid: '5d2f6a1e-8f4b-4c55-9a0e-2b9f1d7c3e41',
    source,
  });
  const record = validateCookedMaterialRecord(
    (output.payload as { cooked: unknown }).cooked,
  ).unwrap();
  const locations = new Set<number>();
  for (const program of record.programs)
    for (const selection of program.selections) {
      if (selection.pass !== 'forward' || selection.address !== 'direct') continue;
      for (const input of selection.abi?.vertexInputs ?? [])
        if (!['skinIndex', 'skinWeight', 'color'].includes(input.semantic))
          locations.add(input.location);
    }
  return locations;
}

// The renderer derives the material vertex state from the mesh attribute map
// plus UV-set aliases; it must address the uploaded interleaved stride exactly.
function meshVertexState(mesh: MeshAsset): { locations: Set<number>; stride: boolean } {
  const layout = deriveVertexBufferLayout(mesh.attributes, { shaderUvSetCount: 8 });
  const vertexCount = (mesh.attributes.position as Float32Array).length / 3;
  return {
    locations: new Set(layout.flatMap((buffer) => buffer.attributes.map((a) => a.shaderLocation))),
    stride: layout[0]?.arrayStride === mesh.vertices.byteLength / vertexCount,
  };
}

const quad = {
  position: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uv: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
};

const authored: readonly (readonly [string, VertexAttributeMap])[] = [
  ['position + normal + uv', quad],
  ['position + normal', { position: quad.position, normal: quad.normal }],
  ['position only', { position: quad.position }],
  // Degenerate UVs cannot define a UV tangent basis; the normal plane still can.
  ['zero uv', { ...quad, uv: new Float32Array(8) }],
];

describe('MeshBuilder triangle meshes satisfy stock material vertex inputs', () => {
  const texture = { texture: 'tex-guid', sampler: 'smp-guid' } as unknown as MaterialValue;
  for (const [name, material] of [
    ['unlit', Materials.unlit([1, 0.5, 0.2, 1])],
    ['standard', Materials.standard({ baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.5 })],
    // A tangent-space normal map is the one stock surface that reads the tangent.
    [
      'normal-mapped standard',
      Materials.standard({ baseColor: [1, 1, 1, 1], normalTexture: texture }),
    ],
  ] as const) {
    it.each(authored)(
      `${name}: %s`,
      async (_label, attributes) => {
        const required = await stockVertexLocations(material);
        // Plain triangles, triangles sharing the stream with a line submesh, and a strip.
        for (const [indices, submeshes] of [
          [[0, 1, 2, 0, 2, 3], []],
          [
            [0, 1, 2, 0, 2, 3, 0, 2],
            [
              { indexOffset: 0, indexCount: 6, topology: 'triangle-list', materialSlot: 0 },
              { indexOffset: 6, indexCount: 2, topology: 'line-list', materialSlot: 1 },
            ],
          ],
          [[0, 1, 3, 2], [{ topology: 'triangle-strip', materialSlot: 0 }]],
        ] as const) {
          const mesh = createMeshBuilder({
            attributes,
            indices,
            submeshes,
            materialSlots: [{ slotName: 'surface' }, { slotName: 'edges' }],
          })
            .build()
            .unwrap();
          const provided = meshVertexState(mesh);
          expect([...required].filter((location) => !provided.locations.has(location))).toEqual([]);
          expect(provided.stride, 'aliased layout addresses the uploaded stride').toBe(true);
        }
      },
      60_000,
    );
  }

  it('unlit never reads a tangent, so tangent-free meshes need no derivation', async () => {
    const required = await stockVertexLocations(Materials.unlit([1, 1, 1, 1]));
    expect([...required].sort((a, b) => a - b)).toEqual([0, 1, 2, 6, 7, 8, 9, 10, 11, 12]);
  }, 60_000);
});
