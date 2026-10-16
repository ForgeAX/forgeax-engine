import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';

interface Manifest {
  readonly schemaVersion?: string;
  readonly entries?: readonly {
    readonly hash?: string;
    readonly bindings?: string;
    readonly sourceDigest?: string;
  }[];
  readonly materialShaders?: readonly {
    readonly identifier?: string;
    readonly paramSchema?: string;
  }[];
}

export default defineFeature({
  title: 'Vite Shader plugin manifest',
  catalog: 'Vite Shader plugin',
  kind: 'probe',
  summary:
    'forgeaxShader() in vite.config serves /shaders/manifest.json in dev (and emits it in build): content-addressed entries with bindings and source digests plus the material shader list the runtime registry loads.',
  expect:
    'All checks pass: the dev manifest is served, entries are hashed with bindings, and the built-in Standard / Unlit / shadow-caster material shaders are published.',
  setup({ world }) {
    spawnStage(world);
    return {
      async checks() {
        const checks = new CheckList();
        let manifest: Manifest = {};
        await checks.run('GET /shaders/manifest.json', async () => {
          const response = await fetch('/shaders/manifest.json');
          if (!response.ok) return false;
          manifest = (await response.json()) as Manifest;
          return `status ${response.status}`;
        });
        checks.ok(
          'schemaVersion present',
          typeof manifest.schemaVersion === 'string',
          String(manifest.schemaVersion),
        );
        const entries = manifest.entries ?? [];
        checks.ok('entries published', entries.length > 0, `${entries.length} entries`);
        checks.ok(
          'every entry has a hash, bindings and source digest',
          entries.every(
            (e) =>
              typeof e.hash === 'string' &&
              typeof e.bindings === 'string' &&
              typeof e.sourceDigest === 'string',
          ),
        );
        const hashes = new Set(entries.map((e) => e.hash));
        checks.equal('entry hashes are unique', hashes.size, entries.length);
        const ids = (manifest.materialShaders ?? []).map((m) => m.identifier);
        for (const id of [
          'forgeax::default-standard-pbr',
          'forgeax::default-unlit',
          'forgeax::default-shadow-caster',
        ]) {
          checks.ok(`material shader ${id}`, ids.includes(id));
        }
        checks.ok(
          'material shaders carry a paramSchema',
          (manifest.materialShaders ?? []).every((m) => typeof m.paramSchema === 'string'),
        );
        return checks.items;
      },
    };
  },
});
