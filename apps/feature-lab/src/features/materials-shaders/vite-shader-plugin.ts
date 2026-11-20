import { admitShaderTemplateManifest } from '@forgeax/engine-shader';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';

export default defineFeature({
  title: 'Vite Shader plugin manifest',
  catalog: 'Vite Shader plugin',
  kind: 'probe',
  summary:
    'forgeaxShader() serves the Engine source templates and material declarations from /shaders/manifest.json.',
  expect:
    'The runtime accepts the source templates and finds the published Standard, Unlit and shadow caster materials.',
  setup({ world }) {
    spawnStage(world);
    return {
      async checks() {
        const checks = new CheckList();
        let publication: unknown;
        await checks.run('GET /shaders/manifest.json', async () => {
          const response = await fetch('/shaders/manifest.json');
          if (!response.ok) return false;
          publication = await response.json();
          return `status ${response.status}`;
        });
        const admitted = admitShaderTemplateManifest(publication);
        checks.ok(
          'shader templates are valid',
          admitted.ok,
          admitted.ok ? admitted.value.wire.schemaVersion : admitted.error.message,
        );
        if (!admitted.ok) return checks.items;
        const {
          wire: { entries, materialShaders },
          programs,
        } = admitted.value;
        checks.ok('entries published', entries.length > 0, `${entries.length} entries`);
        const hashes = new Set(entries.map((e) => e.hash));
        checks.equal('entry hashes are unique', hashes.size, entries.length);
        const ids = new Set(materialShaders.map(({ identifier }) => identifier));
        for (const id of [
          'forgeax::default-standard-pbr',
          'forgeax::default-unlit',
          'forgeax::default-shadow-caster',
        ]) {
          checks.ok(`material shader ${id}`, ids.has(id));
        }
        checks.ok(
          'material shaders carry a paramSchema',
          materialShaders.every(
            ({ program, paramSchema }) =>
              paramSchema !== undefined ||
              Array.isArray(programs.get(program)?.template.engine?.paramSchema),
          ),
        );
        return checks.items;
      },
    };
  },
});
