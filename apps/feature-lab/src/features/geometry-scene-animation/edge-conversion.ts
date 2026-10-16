import {
  createBoxGeometry,
  createEdgesGeometry,
  createTorusGeometry,
  createWireframeGeometry,
} from '@forgeax/engine/geometry';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import type { MeshAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { lookRotation, spawnCamera, spawnMesh, spawnSun, standard, unlit } from '../../lab/stage';

export default defineFeature({
  title: 'Wireframe and edges conversion',
  catalog: 'Edge conversion factories',
  kind: 'visual',
  summary:
    'createWireframeGeometry emits every triangle edge and createEdgesGeometry only crease edges above a threshold angle, both as non-indexed line-list MeshAssets.',
  expect:
    'ON: a cyan full wireframe torus (left) and an orange box outline with only its 12 crease edges (right). OFF: the same shapes drawn as solid shaded source meshes.',
  setup({ world, hud }) {
    spawnCamera(world, {
      eye: [0, 1.2, 5],
      target: [0, 0, 0],
      data: { clearColor: [0.02, 0.02, 0.04, 1] },
    });
    spawnSun(world);
    const torus = createTorusGeometry(0.7, 0.25, 18, 10);
    const box = createBoxGeometry(1.3, 1.3, 1.3);
    if (!torus.ok || !box.ok) return {};
    const wire = createWireframeGeometry(torus.value);
    const edges = createEdgesGeometry(box.value, 1);
    if (!wire.ok || !edges.ok) {
      hud.status(
        `edge conversion failed: ${wire.ok ? (edges.ok ? '' : edges.error.code) : wire.error.code}`,
      );
      return {};
    }
    hud.status(
      `wireframe ${wire.value.submeshes[0]?.vertexCount ?? 0} vertices, edges ${edges.value.submeshes[0]?.vertexCount ?? 0} vertices`,
    );
    const alloc = (mesh: MeshAsset) =>
      world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', mesh);
    const rotation = lookRotation([0, 0, 0], [0.4, -0.5, -1]);
    const rows = [
      {
        source: alloc(torus.value),
        lines: alloc(wire.value),
        color: [0.1, 0.9, 1, 1] as const,
        x: -1.2,
      },
      {
        source: alloc(box.value),
        lines: alloc(edges.value),
        color: [1, 0.6, 0.1, 1] as const,
        x: 1.2,
      },
    ].map((row) => ({
      ...row,
      line: unlit(world, row.color),
      solid: standard(world, { baseColor: row.color, roughness: 0.5 }),
      entity: spawnMesh(world, row.lines, unlit(world, row.color), {
        pos: [row.x, 0, 0],
        rotation,
      }),
    }));
    return {
      toggle(on) {
        for (const row of rows) {
          world.set(row.entity, MeshFilter, { assetHandle: on ? row.lines : row.source } as never);
          world.set(row.entity, MeshRenderer, { materials: [on ? row.line : row.solid] } as never);
        }
      },
    };
  },
});
