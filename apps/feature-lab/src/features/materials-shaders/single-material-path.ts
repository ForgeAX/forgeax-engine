import { Materials } from '@forgeax/engine/render';
import { isEngineMaterialModule } from '@forgeax/engine/shader';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, material, spawnMesh, spawnStage } from '../../lab/stage';

export default defineFeature({
  title: 'Single MaterialAsset path',
  catalog: 'Single MaterialAsset path',
  kind: 'probe',
  summary:
    'A MaterialAsset (paramSchema parameters + values + passes naming engine modules) goes straight from allocSharedRef to extract/record; the renderer reports a resident, ready binding with no compatibility material or runtime compiler.',
  expect:
    'All checks pass: Materials.standard emits parameters, values and engine-owned pass programs, the renderer observes the entity binding it and the residency is ready. The canvas shows a green sphere.',
  setup({ app, world, frames }) {
    spawnStage(world);
    const asset = Materials.standard({ baseColor: [0.2, 0.9, 0.3, 1], roughness: 0.4 });
    const handle = material(world, asset);
    spawnMesh(world, MESH.sphere, handle, { pos: [0, 0.8, 0], scale: [1.2, 1.2, 1.2] });
    return {
      async checks() {
        const checks = new CheckList();
        checks.equal('asset kind', asset.kind, 'material');
        checks.ok(
          'parameters declared',
          (asset.parameters?.length ?? 0) > 0,
          `${asset.parameters?.length ?? 0}`,
        );
        checks.ok('baseColor value authored', asset.values?.baseColor !== undefined);
        const modules = (asset.passes ?? []).map((p) => p.program.module);
        checks.ok(
          'every pass names an engine module',
          modules.every((m) => isEngineMaterialModule(m)),
          modules.join(','),
        );
        await frames(3);
        const bindings = app.renderer.inspect().meshMaterialBindings;
        const mine = bindings.find((o) =>
          o.bindings.some((b) => b.handle === (handle as unknown as number)),
        );
        checks.ok(
          'renderer observes the material binding',
          mine !== undefined,
          `${bindings.length} observations`,
        );
        const readiness = mine?.residency.map((r) => r.readiness) ?? [];
        checks.ok(
          'binding residency is ready',
          readiness.length > 0 && readiness.every((r) => r === 'ready'),
          readiness.join(','),
        );
        checks.equal('no binding diagnostics', mine?.diagnostics.length ?? -1, 0);
        return checks.items;
      },
    };
  },
});
