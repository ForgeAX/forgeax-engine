import { initFbxWasm, isFbxWasmReady, parseFbxToObject } from '@forgeax/engine/fbx';
import { defineFeature } from '../../lab/feature';
import { TRIANGLE_FBX_BYTES } from './fixtures/fbx-source';

interface RawDocument {
  readonly meshes?: readonly unknown[];
  readonly nodes?: readonly { readonly name?: string }[];
  readonly materials?: readonly { readonly name?: string; readonly kind?: string }[];
}

export default defineFeature({
  title: 'FBX WASM parser',
  catalog: 'FBX WASM parser',
  kind: 'headless',
  summary:
    'The ufbx Emscripten module loads with initFbxWasm() and parses an ASCII FBX generated in code into the engine POD document, in the browser and in Node alike.',
  expect:
    'initFbxWasm resolves and is idempotent, the triangle FBX yields one mesh, a Tri node, and the Shiny (phong) plus Matte (lambert) materials; garbage bytes are rejected.',
  async run(checks) {
    await checks.run('initFbxWasm resolves', async () => {
      await initFbxWasm();
      await initFbxWasm();
      return isFbxWasmReady();
    });
    if (!isFbxWasmReady()) return;
    const doc = parseFbxToObject(TRIANGLE_FBX_BYTES) as RawDocument;
    checks.equal('one mesh', doc.meshes?.length, 1);
    checks.ok(
      'Tri node present',
      (doc.nodes ?? []).some((node) => node.name === 'Tri'),
      JSON.stringify(doc.nodes?.map((n) => n.name)),
    );
    checks.equal(
      'materials by name and shading model',
      (doc.materials ?? []).map((m) => [m.name, m.kind]),
      [
        ['Shiny', 'phong'],
        ['Matte', 'lambert'],
      ],
    );
    await checks.run('garbage bytes are rejected', () => {
      try {
        parseFbxToObject(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
        return false;
      } catch (error) {
        return (error as Error).message.slice(0, 80);
      }
    });
  },
});
