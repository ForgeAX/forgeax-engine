import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { EngineWorkspacePreview } from '@forgeax/engine-app';
import { type CatalogSource, createCatalogSource } from '@forgeax/engine-assets-runtime';
import type { RuntimePackContent } from '@forgeax/engine-import';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { AssetGuid, definePackageId, type PackDraftReply } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { afterEach, expect, it } from 'vitest';
import { createWorkspacePackAuthoring } from '../workspace-pack-authoring';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('waits for saved source publication before completing Save', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-pack-save-')));
  roots.push(root);
  await mkdir(resolve(root, 'assets'));
  const sourcePath = 'assets/scene.pack.ts';
  await writeFile(
    resolve(root, sourcePath),
    `export default definePack({
    schemaVersion: '2.0.0', packageId: '01900000-0000-7000-8000-000000000023',
    parameters: [{ name: 'sunIntensity', type: 'f32', default: 3.2,
      apply: { asset: 'scene/main', path: ['entities','sun','components','DirectionalLight','intensity'] } }],
    build() { throw new Error('draft saving does not generate a preview'); }
  });`,
  );
  let begin!: () => void;
  let complete!: () => void;
  const publishing = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const published = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const owner = createWorkspacePackAuthoring({
    root,
    sourceRoots: ['assets'],
    preview: () => undefined,
    async publishSource(path) {
      expect(path).toBe(resolve(root, sourcePath));
      expect(await readFile(path, 'utf8')).toContain('default: 1');
      begin();
      await published;
    },
  });
  const execute = (request: Parameters<typeof owner.execute>[0]['request']) =>
    owner.execute({ project: { id: 'save', root }, request });
  try {
    const opened = await execute({ action: 'open', sourcePath });
    if (!('id' in opened)) throw new Error('Missing draft');
    await execute({ action: 'edit', draftId: opened.id, field: 'sunIntensity', value: 1 });
    let finished = false;
    const saving = execute({ action: 'save', draftId: opened.id }).then((result) => {
      finished = true;
      return result;
    });
    await publishing;
    expect(finished).toBe(false);
    complete();
    expect(await saving).toMatchObject({ unsaved: false, values: { sunIntensity: 1 } });
  } finally {
    complete();
    owner.dispose();
  }
});

it('discovers literal parameters after a failed legacy-source open without generating or replacing the preview', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-pack-repair-')));
  roots.push(root);
  await mkdir(resolve(root, 'assets'));
  const sourcePath = 'assets/scene.pack.ts';
  const source = `export default definePack({schemaVersion:'2.0.0',packageId:PACKAGE_IDS.scene,build(){throw new Error('must not build');}});`;
  await writeFile(resolve(root, sourcePath), source);
  const replies: PackDraftReply[] = [];
  const writes: unknown[] = [];
  const preview = {
    target: { targetId: 'preview' },
    asset: { path: sourcePath },
    writeAssetField: async (field: unknown) => {
      writes.push(field);
    },
  } as unknown as EngineWorkspacePreview;
  let current: EngineWorkspacePreview | undefined = preview;
  const owner = createWorkspacePackAuthoring({
    root,
    sourceRoots: ['assets'],
    preview: () => current,
    catalog: () => {
      throw new Error('must not enumerate the Catalog');
    },
    changed: (reply) => replies.push(reply),
  });
  try {
    await expect(
      owner.execute({
        project: { id: 'proof', root },
        previewTargetId: 'preview',
        request: { action: 'open', sourcePath },
      }),
    ).rejects.toMatchObject({ code: 'pack-source-mutation-unsupported' });
    expect(await owner.sourceChanged(sourcePath)).toBe(false);
    expect(replies).toEqual([]);
    const repaired = source
      .replace('PACKAGE_IDS.scene', "definePackageId('01900000-0000-7000-8000-000000000022')")
      .replace(
        'build(){',
        "parameters:[{name:'sunIntensity',type:'f32',default:3.2,apply:{asset:'scene/main',path:['entities','sun','components','DirectionalLight','intensity']}}],build(){",
      );
    await writeFile(resolve(root, sourcePath), repaired);
    current = undefined;
    expect(await owner.sourceChanged(sourcePath)).toBe(false);
    expect(replies).toEqual([]);
    current = preview;
    expect(await owner.sourceChanged(resolve(root, sourcePath))).toBe(true);
    expect(replies.at(-1)).toMatchObject({
      sourcePath,
      values: { sunIntensity: 3.2 },
      preview: 'ready',
      generating: false,
      unsaved: false,
    });
    expect(writes).toEqual([
      {
        guid: AssetGuid.format(
          AssetGuid.derive(definePackageId('01900000-0000-7000-8000-000000000022'), 'scene/main'),
        ),
        path: ['entities', 'sun', 'components', 'DirectionalLight', 'intensity'],
        value: 3.2,
      },
    ]);
    expect(await readFile(resolve(root, sourcePath), 'utf8')).toBe(repaired);
    const draft = replies.at(-1);
    if (!draft || !('id' in draft)) throw new Error('Missing repaired draft');
    await owner.execute({
      project: { id: 'proof', root },
      request: { action: 'close', draftId: draft.id },
    });
    expect(await owner.sourceChanged(sourcePath)).toBe(false);
  } finally {
    owner.dispose();
  }
});

it('publishes a bound draft source refresh before suppressing Pack hot reload', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-pack-refresh-'));
  roots.push(root);
  await mkdir(resolve(root, 'assets'));
  const sourcePath = 'assets/scene.pack.ts';
  const source = `export default definePack({schemaVersion:'2.0.0',packageId:definePackageId('01900000-0000-7000-8000-000000000044'),parameters:[{name:'radius',type:'f32',default:1}],build(){throw new Error('must not build');}});`;
  await writeFile(resolve(root, sourcePath), source);
  const replies: PackDraftReply[] = [];
  const preview = {
    target: { targetId: 'preview' },
    asset: { path: sourcePath },
  } as unknown as EngineWorkspacePreview;
  const owner = createWorkspacePackAuthoring({
    root,
    sourceRoots: ['assets'],
    preview: () => preview,
    changed: (reply) => replies.push(reply),
  });
  try {
    await owner.execute({
      project: { id: 'proof', root },
      previewTargetId: 'preview',
      request: { action: 'open', sourcePath },
    });
    const runtimeOnly = source.replace("parameters:[{name:'radius',type:'f32',default:1}],", '');
    await writeFile(resolve(root, sourcePath), runtimeOnly);

    expect(await owner.sourceChanged(sourcePath)).toBe(true);
    expect(replies.at(-1)).toMatchObject({ fields: [] });
  } finally {
    owner.dispose();
  }
});

it('matches a source refresh through a canonical path when the project root is a symlink', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-pack-refresh-root-'));
  const aliasDirectory = await mkdtemp(resolve(tmpdir(), 'forgeax-pack-refresh-alias-'));
  const alias = resolve(aliasDirectory, 'project');
  roots.push(root, aliasDirectory);
  await mkdir(resolve(root, 'assets'));
  await symlink(root, alias, 'dir');
  const sourcePath = 'assets/scene.pack.ts';
  const source = `export default definePack({schemaVersion:'2.0.0',packageId:definePackageId('01900000-0000-7000-8000-000000000046'),build(){throw new Error('must not build');}});`;
  const refreshed = source.replace(
    'build(){',
    "parameters:[{name:'bodyColor',type:'color',default:[1,1,1,1],apply:{asset:'material/box',path:['values','baseColor']}}],build(){",
  );
  await writeFile(resolve(root, sourcePath), source);
  const replies: PackDraftReply[] = [];
  const preview = {
    target: { targetId: 'preview' },
    asset: { path: sourcePath },
    writeAssetField: async () => {},
  } as unknown as EngineWorkspacePreview;
  const owner = createWorkspacePackAuthoring({
    root: alias,
    sourceRoots: ['assets'],
    preview: () => preview,
    changed: (reply) => replies.push(reply),
  });
  try {
    await owner.execute({
      project: { id: 'proof', root: alias },
      previewTargetId: 'preview',
      request: { action: 'open', sourcePath },
    });
    await writeFile(resolve(root, sourcePath), refreshed);

    expect(await owner.sourceChanged(resolve(root, sourcePath))).toBe(true);
    expect(replies.at(-1)).toMatchObject({ fields: [{ name: 'bodyColor' }], preview: 'ready' });
  } finally {
    owner.dispose();
  }
});

it('keeps source refresh bound when the same preview target receives a new wrapper', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-pack-refresh-preview-'));
  roots.push(root);
  await mkdir(resolve(root, 'assets'));
  const sourcePath = 'assets/scene.pack.ts';
  const source = `export default definePack({schemaVersion:'2.0.0',packageId:definePackageId('01900000-0000-7000-8000-000000000047'),parameters:[{name:'radius',type:'f32',default:1}],build(){throw new Error('must not build');}});`;
  const refreshed = source.replace("parameters:[{name:'radius',type:'f32',default:1}],", '');
  await writeFile(resolve(root, sourcePath), source);
  const replies: PackDraftReply[] = [];
  const preview = (handle: string) =>
    ({
      handle,
      target: { targetId: 'preview', generation: 1 },
      asset: { path: sourcePath },
      writeAssetField: async () => {},
    }) as unknown as EngineWorkspacePreview;
  let current = preview('original');
  const owner = createWorkspacePackAuthoring({
    root,
    sourceRoots: ['assets'],
    preview: () => current,
    changed: (reply) => replies.push(reply),
  });
  try {
    await owner.execute({
      project: { id: 'proof', root },
      previewTargetId: 'preview',
      request: { action: 'open', sourcePath },
    });
    current = preview('renewed');
    await writeFile(resolve(root, sourcePath), refreshed);

    expect(await owner.sourceChanged(sourcePath)).toBe(true);
    expect(replies.at(-1)).toMatchObject({ fields: [] });
  } finally {
    owner.dispose();
  }
});

it('publishes refreshed Pack fields before waiting for their live preview writes', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-pack-preview-refresh-'));
  roots.push(root);
  await mkdir(resolve(root, 'assets'));
  const sourcePath = 'assets/scene.pack.ts';
  const packageId = "definePackageId('01900000-0000-7000-8000-000000000045')";
  const source = `export default definePack({schemaVersion:'2.0.0',packageId:${packageId},build(){throw new Error('must not build');}});`;
  const refreshed = source.replace(
    'build(){',
    "parameters:[{name:'bodyColor',type:'color',default:[1,1,1,1],apply:{asset:'material/box',path:['values','baseColor']}}],build(){",
  );
  await writeFile(resolve(root, sourcePath), source);
  const replies: PackDraftReply[] = [];
  let finishPreview: (() => void) | undefined;
  let previewStarted!: () => void;
  const previewStartedPromise = new Promise<void>((resolvePreview) => {
    previewStarted = resolvePreview;
  });
  const preview = {
    target: { targetId: 'preview' },
    asset: { path: sourcePath },
    writeAssetField: async () => {
      previewStarted();
      await new Promise<void>((resolvePreview) => {
        finishPreview = resolvePreview;
      });
    },
  } as unknown as EngineWorkspacePreview;
  const owner = createWorkspacePackAuthoring({
    root,
    sourceRoots: ['assets'],
    preview: () => preview,
    changed: (reply) => replies.push(reply),
  });
  try {
    await owner.execute({
      project: { id: 'proof', root },
      previewTargetId: 'preview',
      request: { action: 'open', sourcePath },
    });
    await writeFile(resolve(root, sourcePath), refreshed);

    let sourceChangeFinished = false;
    const sourceChange = owner.sourceChanged(sourcePath).then((result) => {
      sourceChangeFinished = true;
      return result;
    });
    await previewStartedPromise;
    expect(replies.at(-1)).toMatchObject({ fields: [{ name: 'bodyColor' }], preview: 'pending' });
    expect(sourceChangeFinished).toBe(false);
    finishPreview?.();
    expect(await sourceChange).toBe(true);
    expect(replies.at(-1)).toMatchObject({ fields: [{ name: 'bodyColor' }], preview: 'ready' });
  } finally {
    finishPreview?.();
    owner.dispose();
  }
});

it.each([
  false,
  true,
])('reads fixed generation dependencies without a browser (unpublished: %s)', async (unpublished) => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-pack-author-')));
  roots.push(root);
  await mkdir(resolve(root, 'assets'));
  await symlink(
    resolve(import.meta.dirname, '../../../..', 'node_modules'),
    resolve(root, 'node_modules'),
    'dir',
  );
  const guid = '01900000-0000-7000-8000-000000000011';
  const packageUrl = 'https://author.invalid/dependency.pack.json';
  const publication = createRuntimePackPublication({
    scopeId: 'author-test',
    sourcePath: 'assets/dependency.pack.json',
    sourceRevision: 'saved',
    packageUrl,
    pack: { assets: [{ guid, kind: 'scene', payload: { entities: {} }, refs: [], artifacts: {} }] },
  });
  const publishedCatalog = createCatalogSource({
    expectedScope: { scopeId: 'author-test', generation: 1 },
    entries: [
      {
        guid,
        kind: 'scene',
        sourcePath: 'assets/dependency.pack.json',
        packageUrl,
        refs: [],
        publication: publication.publication,
      },
    ],
    fetch: async () => new Response(JSON.stringify(publication.pack)),
  });
  let produced = !unpublished;
  let demands = 0;
  const catalog: CatalogSource = {
    ...publishedCatalog,
    async enumerate() {
      const rows = (await publishedCatalog.enumerate()).unwrap();
      return ok(produced ? rows : rows.map(({ publication: _publication, ...row }) => row));
    },
    async get(requested) {
      expect(requested).toBe(guid);
      demands++;
      produced = true;
      return publishedCatalog.enumerate();
    },
  };
  const source = `import { AssetGuid, definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
export default definePack({ schemaVersion: '2.0.0', packageId: definePackageId('01900000-0000-7000-8000-000000000022'),
parameters: [{ name: 'radius', type: 'f32', default: 1 }],
async build({ readByGuid }) { const parsed = AssetGuid.parse('${guid}'); if (!parsed.ok) return parsed; const result = await readByGuid(parsed.value); if (!result.ok) return result; return ok({ 'scene/generated': result.value }); }
});`;
  await writeFile(resolve(root, 'assets/generator.pack.ts'), source);
  const replies: unknown[] = [];
  const owner = createWorkspacePackAuthoring({
    root,
    sourceRoots: ['assets'],
    preview: () => undefined,
    catalog: () => catalog,
    changed: (reply) => replies.push(reply),
  });
  const execute = (request: Parameters<typeof owner.execute>[0]['request']) =>
    owner.execute({ project: { id: 'proof', root }, request });
  try {
    const opened = await execute({ action: 'open', sourcePath: 'assets/generator.pack.ts' });
    if (!('id' in opened)) throw new Error('Missing draft');
    const generated = await execute({ action: 'generate', draftId: opened.id });
    expect('error' in generated ? generated.error : undefined).toBeUndefined();
    expect(generated).toMatchObject({
      needsGeneration: false,
      generating: false,
      preview: 'pending',
    });
    expect(await readFile(resolve(root, 'assets/generator.pack.ts'), 'utf8')).toBe(source);
    expect(await owner.sourceChanged('assets/unrelated.pack.json')).toBe(false);
    expect(await execute({ action: 'get', draftId: opened.id })).toMatchObject({
      needsGeneration: false,
    });
    expect(await owner.sourceChanged('assets/dependency.pack.json')).toBe(false); // no bound preview to suppress
    expect(await execute({ action: 'get', draftId: opened.id })).toMatchObject({
      needsGeneration: true,
    });
    expect(replies.length).toBeGreaterThan(3);
    expect(demands).toBe(unpublished ? 1 : 0);
  } finally {
    owner.dispose();
  }
});

it('classifies direct JSON values using domain schemas without executing a producer', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-json-author-')));
  roots.push(root);
  await mkdir(resolve(root, 'assets'));
  await writeFile(
    resolve(root, 'assets/source.pack.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId: '01900000-0000-7000-8000-000000000033',
      assets: {
        'scene/main': {
          kind: 'scene',
          refs: ['01900000-0000-7000-8000-000000000034'],
          payload: {
            entities: {
              sun: { components: { DirectionalLight: { color: [1, 1, 1], intensity: 2 } } },
              mesh: {
                components: { MeshFilter: { assetHandle: '01900000-0000-7000-8000-000000000034' } },
              },
            },
          },
        },
      },
    }),
  );
  const owner = createWorkspacePackAuthoring({
    root,
    sourceRoots: ['assets'],
    preview: () => undefined,
  });
  try {
    const opened = await owner.execute({
      project: { id: 'proof', root },
      request: { action: 'open', sourcePath: 'assets/source.pack.json' },
    });
    if (!('fields' in opened)) throw new Error('Missing direct draft');
    expect(opened.fields.find((field) => field.path.at(-1) === 'color')?.apply).toEqual({
      asset: 'scene/main',
      path: ['entities', 'sun', 'components', 'DirectionalLight', 'color'],
    });
    expect(
      opened.fields.find((field) => field.path.at(-1) === 'assetHandle')?.apply,
    ).toBeUndefined();
  } finally {
    owner.dispose();
  }
});

it('generates direct JSON without losing its reference table or artifact bytes', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-json-generation-')));
  roots.push(root);
  await mkdir(resolve(root, 'assets'));
  const packageId = '01900000-0000-7000-8000-000000000035';
  const child = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'scene/child'));
  const source = {
    schemaVersion: '3.0.0',
    packageId,
    assets: {
      'scene/main': {
        kind: 'scene',
        refs: [child],
        payload: {
          entities: {
            room: { components: {}, instance: { source: 0 } },
          },
        },
      },
      'scene/child': {
        kind: 'scene',
        refs: [],
        payload: { entities: {} },
        artifacts: {
          proof: { path: 'proof.bin', byteLength: 3, mediaType: 'application/octet-stream' },
        },
      },
    },
  };
  await writeFile(resolve(root, 'assets/source.pack.json'), JSON.stringify(source));
  await writeFile(resolve(root, 'assets/proof.bin'), new Uint8Array([1, 2, 3]));
  let content: RuntimePackContent | undefined;
  const preview = {
    target: { targetId: 'preview' },
    asset: { path: 'assets/source.pack.json' },
    prepareAssetContent: async (value: RuntimePackContent) => {
      content = value;
      return 1;
    },
    commitAssetContent: async () => {},
  } as unknown as EngineWorkspacePreview;
  const owner = createWorkspacePackAuthoring({
    root,
    sourceRoots: ['assets'],
    preview: () => preview,
  });
  try {
    const opened = await owner.execute({
      project: { id: 'proof', root },
      previewTargetId: 'preview',
      request: { action: 'open', sourcePath: 'assets/source.pack.json' },
    });
    if (!('id' in opened)) throw new Error('Missing direct draft');
    const generated = await owner.execute({
      project: { id: 'proof', root },
      request: { action: 'generate', draftId: opened.id },
    });
    expect(generated).toMatchObject({ needsGeneration: false, preview: 'ready' });
    expect(content?.source).toEqual(source);
    expect(content?.blobs?.['proof.bin']).toEqual(new Uint8Array([1, 2, 3]));
  } finally {
    owner.dispose();
  }
});
