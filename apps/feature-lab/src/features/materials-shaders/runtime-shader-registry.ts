import type { ShaderModule } from '@forgeax/engine/rhi';
import { ShaderRegistry, type ShaderRegistryDevice } from '@forgeax/engine/shader';
import { defineFeature } from '../../lab/feature';

const MANIFEST = {
  entries: [
    {
      hash: 'lab12345',
      wgsl: '@compute @workgroup_size(1) fn main() {}',
      glsl: undefined,
      bindings: '[]',
    },
  ],
  materialShaders: [],
};

export default defineFeature({
  title: 'Runtime Shader Registry',
  catalog: 'Runtime Shader Registry',
  kind: 'headless',
  summary:
    'The player-side ShaderRegistry loads a content-addressed manifest and creates shader modules by hash, with no Naga or compiler dependency.',
  expect:
    'All checks pass: the manifest loads, a known hash creates exactly one module (cached on the second get), and an unknown hash returns shader-not-found.',
  async run(checks) {
    const created: string[] = [];
    const device: ShaderRegistryDevice = {
      createShaderModule({ code }) {
        created.push(code);
        return { ok: true, value: {} as ShaderModule } as ReturnType<
          ShaderRegistryDevice['createShaderModule']
        >;
      },
    };
    const registry = new ShaderRegistry({
      device,
      manifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify(MANIFEST))}`,
    });
    const loaded = await registry.loadManifest();
    checks.ok('manifest loads', loaded.ok, loaded.ok ? undefined : loaded.error.code);
    checks.equal(
      'entry hashes',
      Array.from(registry.entries(), (entry) => entry.hash),
      ['lab12345'],
    );
    checks.ok('known hash creates a module', registry.get('lab12345').ok);
    checks.ok(
      'second get hits the cache',
      registry.get('lab12345').ok && created.length === 1,
      `created=${created.length}`,
    );
    const miss = registry.get('deadbeef');
    checks.equal('unknown hash code', miss.ok ? 'ok' : miss.error.code, 'shader-not-found');

    const empty = new ShaderRegistry({ manifestUrl: undefined });
    checks.ok(
      'zero-entry mode loads without fetch',
      (await empty.loadManifest()).ok && Array.from(empty.entries()).length === 0,
    );
  },
});
