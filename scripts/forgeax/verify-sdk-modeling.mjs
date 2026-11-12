import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { sha256 } from './sdk-lib.mjs';

const sourceText = `import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { model, sel } from '@forgeax/engine/modeling';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c1041'),
  parameters: [{ name: 'depth', type: 'f32', default: 0.03, minimum: 0.01, maximum: 0.08 }],
  build: ({ values }) => {
    const m = model();
    m.box({ size: [0.4, 0.3, 0.3], tag: 'body' });
    m.inset(sel.facing('+z').one(), { thickness: 0.05, region: 'merged', label: 'panel' });
    m.extrude(sel.createdBy('panel', 'inner'), { distance: -(values.depth as number), region: 'merged', label: 'recess' });
    m.uv.project({ mode: 'box', scale: 0.2 });
    return m.finish({ key: 'sdk-model' });
  },
});
`;

async function imageEvidence(view, project, output) {
  assert.ok(view.coverage > 0.01 && view.coverage < 1, `sdk-modeling-coverage:${view.view}`);
  const image = resolve(project, view.image);
  const bytes = await readFile(image);
  const png = PNG.sync.read(bytes);
  assert.equal(png.width, 128);
  assert.equal(png.height, 128);
  let low = 255;
  let high = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    low = Math.min(low, png.data[index], png.data[index + 1], png.data[index + 2]);
    high = Math.max(high, png.data[index], png.data[index + 1], png.data[index + 2]);
  }
  assert.ok(high - low > 8, `sdk-modeling-flat-image:${view.view}`);
  const path = resolve(output, `${view.view}.png`);
  await copyFile(image, path);
  return { view: view.view, coverage: view.coverage, path, sha256: sha256(bytes) };
}

/** Real CLI capture and GPU consumption from an installed production SDK. */
export async function verifySdkModeling({ sdkRoot, project, evidenceRoot, env, run }) {
  const source = 'assets/sdk-modeling-qualification.pack.ts';
  const path = resolve(project, source);
  await writeFile(path, sourceText, { flag: 'wx' });
  const command = async (args, expectedError) => {
    let stdout;
    try {
      ({ stdout } = await run(
        process.execPath,
        [
          resolve(sdkRoot, 'bin/forgeax.mjs'),
          'model',
          ...args,
          '--source',
          source,
          '--json',
          '--detail',
        ],
        { cwd: project, env, maxBuffer: 64 * 1024 * 1024 },
      ));
    } catch (cause) {
      if (expectedError === undefined || typeof cause.stdout !== 'string') throw cause;
      stdout = cause.stdout;
    }
    const result = JSON.parse(stdout.trim());
    if (expectedError !== undefined) {
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, expectedError);
    } else assert.equal(result.ok, true, JSON.stringify(result.error));
    return result.value;
  };
  try {
    const inspected = await command(['inspect']);
    assert.equal(inspected.build.ok, true);
    assert.deepEqual(inspected.build.outputs, ['mesh/sdk-model']);
    const validated = await command(['validate']);
    const mesh = validated.sessions[0].mesh;
    assert.equal(mesh.closed, true);
    assert.equal(mesh.boundaryEdges, 0);
    assert.ok(mesh.volume > 0);
    const deeper = await command(['validate', '--values', '{"depth":0.08}']);
    assert.equal(deeper.sessions[0].mesh.closed, true);
    assert.ok(deeper.sessions[0].mesh.volume < mesh.volume);
    await command(['select', '--selector', 'sel.notAnOperation()'], 'tool-invalid-args');
    const recovered = await command(['select', '--selector', "sel.tag('body')"]);
    assert.ok(recovered.selected.count > 6);
    const rendered = await command([
      'render',
      '--views',
      '["front","iso"]',
      '--width',
      '128',
      '--height',
      '128',
      '--annotate',
      'false',
    ]);
    assert.deepEqual(
      rendered.views.map(({ view }) => view),
      ['front', 'iso'],
    );
    await mkdir(evidenceRoot, { recursive: true });
    const images = [];
    for (const view of rendered.views)
      images.push(await imageEvidence(view, project, evidenceRoot));
    const report = {
      source,
      output: 'mesh/sdk-model',
      mesh,
      recoveredFaces: recovered.selected.count,
      images,
    };
    await writeFile(resolve(evidenceRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    await rm(path, { force: true });
  }
}
