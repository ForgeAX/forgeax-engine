import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createHostTransport } from '@forgeax/engine-host/transport';

import { ViewWorkspaceBroker } from '../packages/view-workspace-core/src/broker.ts';
import { VIEW_FILE_GET_SERVICE } from '../packages/view-workspace-core/src/contract.ts';
import {
  classifyFile,
  listWorkspaceHtmlFiles,
  MAX_BINARY_PREVIEW_BYTES,
  readFilePreview,
  readWorkspaceFilePreview,
  resolveProjectFilePath,
} from '../packages/view-workspace-core/src/file-preview.ts';

const cleanup = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

describe('content-browser source file preview', () => {
  it('classifies pack/json/ts as text the way scene /api/files does', () => {
    assert.equal(classifyFile('assets/materials.pack.json').kind, 'text');
    assert.equal(classifyFile('assets/world.pack.ts').kind, 'text');
    assert.equal(classifyFile('src/index.ts').kind, 'text');
    assert.equal(classifyFile('src/boot.js').kind, 'text');
    assert.equal(classifyFile('assets/model.glb').kind, 'model');
  });

  it('keeps resolved paths inside the open project', () => {
    const root = resolve('/tmp/view-project');
    assert.equal(resolveProjectFilePath(root, 'assets/materials.pack.json').rel, 'assets/materials.pack.json');
    assert.equal(resolveProjectFilePath(root, join(root, 'assets/world.pack.ts')).rel, 'assets/world.pack.ts');
    assert.equal(resolveProjectFilePath(root, '../secret.json'), null);
    assert.equal(resolveProjectFilePath(root, '.forgeax/ddc/cache.bin'), null);
  });

  it('returns utf8 content for source files and omits bytes for binaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'view-file-preview-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const pack = join(root, 'materials.pack.json');
    await writeFile(pack, '{\n  "assets": [{ "kind": "material" }]\n}\n');
    await writeFile(join(root, 'mesh.glb'), Buffer.from([0x67, 0x6c, 0x54, 0x46]));

    const text = await readFilePreview(pack, 'materials.pack.json');
    assert.equal(text.kind, 'text');
    assert.match(text.content, /"material"/);

    const binary = await readFilePreview(join(root, 'mesh.glb'), 'mesh.glb');
    assert.equal(binary.kind, 'model');
    assert.equal(binary.content, undefined);
    assert.equal(binary.dataUrl, undefined);

    await writeFile(join(root, 'icon.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ));
    const image = await readFilePreview(join(root, 'icon.png'), 'icon.png');
    assert.equal(image.kind, 'image');
    assert.match(image.dataUrl, /^data:image\/png;base64,/);

    const huge = join(root, 'huge.png');
    await writeFile(huge, Buffer.alloc(MAX_BINARY_PREVIEW_BYTES + 1));
    const skipped = await readFilePreview(huge, 'huge.png');
    assert.equal(skipped.kind, 'image');
    assert.equal(skipped.dataUrl, undefined);
  });

  it('reads source through the host file.get service after a project is open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'view-file-preview-host-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'world.pack.ts'), 'export const scene = { kind: "scene" };\n');

    const closed = new ViewWorkspaceBroker({ engine: {}, accessToken: 'file-preview-token' });
    await assert.rejects(
      readWorkspaceFilePreview(closed, { path: 'assets/world.pack.ts' }),
      (error) => error.code === 'view-workspace-project-closed',
    );

    const transport = createHostTransport();
    const broker = new ViewWorkspaceBroker({
      engine: { project: { project: { id: root, root } } },
      accessToken: 'file-preview-token',
    });
    const unregister = broker.registerTransport(transport);
    cleanup.push(async () => {
      unregister();
      transport.close();
      await broker.dispose();
      await closed.dispose();
    });

    const client = transport.connect({ kind: 'cli', sourceId: 'file-preview-test' });
    const preview = await client.request(VIEW_FILE_GET_SERVICE, { path: 'assets/world.pack.ts' });
    assert.equal(preview.kind, 'text');
    assert.match(preview.content, /export const scene/);

    const viaAbsolute = await readWorkspaceFilePreview(broker, {
      path: join(root, 'assets', 'world.pack.ts'),
    });
    assert.equal(viaAbsolute.content, preview.content);

    await assert.rejects(
      client.request(VIEW_FILE_GET_SERVICE, { path: '../outside.ts' }),
      (error) => error.detail?.remoteCode === 'view-workspace-invalid-args' || /path/.test(error.message),
    );
  });
});

it('lists HTML only beneath configured asset directories, including non-default roots', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'view-html-roots-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['content/ui', 'shared', 'assets', 'src']) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, 'guide.html'), '<main>Guide</main>');
  }
  await writeFile(join(root, 'index.html'), '<main>Entry</main>');
  const result = await listWorkspaceHtmlFiles({ project: { id: 'p', root, assetRoots: ['content', 'content/ui', 'shared', 'missing'] } });
  assert.deepEqual(result.files.sort(), ['content/ui/guide.html', 'shared/guide.html']);
  assert.equal(result.hasMore, false);
  assert.deepEqual((await listWorkspaceHtmlFiles({ project: { id: 'p', root, assetRoots: [] } })).files, []);
});
