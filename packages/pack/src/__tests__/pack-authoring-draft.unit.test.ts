import { describe, expect, it, vi } from 'vitest';
import { readPackDraftSource } from '../pack-authoring-document.js';
import { PackAuthoringDraft, type PackDraftOwner } from '../pack-authoring-draft.js';
import { readPackAuthoringDeclaration } from '../pack-authoring-literals.js';

const source = `import { definePack, definePackageId } from '@forgeax/engine/pack/source';
throw new Error('opening the panel must not execute this');
export default definePack({
  schemaVersion: '2.0.0', packageId: definePackageId('01900000-0000-7000-8000-000000000077'),
  parameters: [
    { name: 'radius', type: 'f32', default: 1, minimum: 0.01 }, // preserve this comment
    { name: 'color', type: 'vec3', default: [1, 1, 1], apply: { asset: 'scene/main', path: ['entities', 'sun', 'components', 'DirectionalLight', 'color'] } },
  ],
  build: ({ values }) => makeScene(values.radius),
});\n`;

function setup(initial = source) {
  let disk = initial;
  let parsed = readPackDraftSource('scene.pack.ts', disk);
  const owner: PackDraftOwner<{ radius: unknown }> = {
    generate: vi.fn(async (input) => ({ radius: input.values.radius })),
    adopt: vi.fn(async () => {}),
    preview: vi.fn(async () => {}),
    release: vi.fn(),
    save: vi.fn(async (_document, changes) => {
      disk = parsed.write(changes);
      parsed = readPackDraftSource('scene.pack.ts', disk);
      return parsed.document;
    }),
  };
  const draft = new PackAuthoringDraft('draft', parsed.document, owner);
  return { draft, owner, disk: () => disk };
}

describe('Pack authoring literals and memory drafts', () => {
  it('accepts a local constant package identity without evaluating or rewriting it', () => {
    const local = source
      .replace(
        "throw new Error('opening the panel must not execute this');",
        "const packageId = definePackageId('01900000-0000-7000-8000-000000000077');",
      )
      .replace("packageId: definePackageId('01900000-0000-7000-8000-000000000077')", 'packageId');
    const parsed = readPackDraftSource('scene.pack.ts', local);
    expect(parsed.document.packageId).toBe('01900000-0000-7000-8000-000000000077');
    expect(parsed.write(new Map([['radius', 2]]))).toBe(
      local.replace('default: 1,', 'default: 2,'),
    );
    expect(
      readPackAuthoringDeclaration(
        'scene.pack.ts',
        local.replace('const packageId', 'let packageId'),
      ),
    ).toMatchObject({ ok: false });
  });

  it.each([
    'const packageId = other; const other = packageId;',
    "import { packageId } from './identity.js';",
    'const packageId = computeIdentity();',
  ])('does not evaluate or follow unsupported identity declarations: %s', (identity) => {
    const dynamic = source
      .replace("throw new Error('opening the panel must not execute this');", identity)
      .replace("packageId: definePackageId('01900000-0000-7000-8000-000000000077')", 'packageId');
    expect(readPackAuthoringDeclaration('scene.pack.ts', dynamic)).toMatchObject({ ok: false });
  });

  it('reads declarations without evaluation and refuses dynamic editing without changing legacy source', () => {
    const parsed = readPackAuthoringDeclaration('scene.pack.ts', source).unwrap();
    expect(parsed.parameters.map((parameter) => parameter.name)).toEqual(['radius', 'color']);
    expect(parsed.generationSource).not.toContain("name: 'color'");
    expect(parsed.generationSource).toContain('values.radius');
    expect(
      readPackAuthoringDeclaration(
        'dynamic.pack.ts',
        source.replace('default: 1,', 'default: compute(),'),
      ),
    ).toMatchObject({ ok: false, error: { code: 'pack-source-mutation-unsupported' } });
  });

  it('previews 100 live edits without generating or writing, then saves only the literal', async () => {
    const { draft, owner, disk } = setup();
    await draft.generate();
    vi.mocked(owner.generate).mockClear();
    for (let index = 0; index < 100; index++)
      expect((await draft.edit('color', [index / 100, 0.4, 0.8])).ok).toBe(true);
    expect(disk()).toBe(source);
    expect(owner.generate).not.toHaveBeenCalled();
    expect(owner.save).not.toHaveBeenCalled();
    expect(owner.preview).toHaveBeenCalledTimes(100);
    expect(draft.snapshot()).toMatchObject({ unsaved: true, needsGeneration: false });
    expect(await draft.save()).toMatchObject({ unsaved: false, needsGeneration: false });
    expect(disk()).toBe(source.replace('default: [1, 1, 1]', 'default: [0.99,0.4,0.8]'));
    expect(readPackDraftSource('scene.pack.ts', disk()).document.fields[1]?.default).toEqual([
      0.99, 0.4, 0.8,
    ]);
  });

  it('keeps save and generation independent, including undo after saving', async () => {
    const { draft, owner } = setup();
    await draft.generate();
    await draft.edit('radius', 2);
    expect(await draft.save()).toMatchObject({ unsaved: false, needsGeneration: true });
    expect(owner.generate).toHaveBeenCalledTimes(1);
    expect(await draft.generate()).toMatchObject({ unsaved: false, needsGeneration: false });
    expect(await draft.undo()).toMatchObject({
      unsaved: true,
      needsGeneration: true,
      values: { radius: 1 },
    });
    expect(await draft.redo()).toMatchObject({
      unsaved: false,
      needsGeneration: false,
      values: { radius: 2 },
    });
  });

  it('adopts the latest live values and discards a stale generation result', async () => {
    const { draft, owner } = setup();
    let finish!: (value: { radius: unknown }) => void;
    vi.mocked(owner.generate).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = draft.generate();
    await draft.edit('color', [0.2, 0.4, 0.8]);
    finish({ radius: 1 });
    await pending;
    expect(owner.adopt).toHaveBeenLastCalledWith(
      { radius: 1 },
      { radius: 1, color: [0.2, 0.4, 0.8] },
      expect.any(AbortSignal),
      expect.any(Function),
    );
    await draft.edit('radius', 2);
    const stale = draft.generate();
    await draft.edit('radius', 5);
    finish({ radius: 2 });
    await stale;
    expect(owner.adopt).toHaveBeenCalledTimes(1);
    expect(draft.snapshot()).toMatchObject({
      generating: false,
      needsGeneration: true,
      unsaved: true,
    });
    expect(owner.release).toHaveBeenCalledWith({ radius: 2 });
  });

  it('prepares a generated output once while live edits continue during adoption', async () => {
    const { draft, owner } = setup();
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      vi.mocked(owner.adopt).mockImplementation(async () => {
        resolve();
        await new Promise<void>((done) => {
          finish = done;
        });
      });
    });
    const generating = draft.generate();
    await entered;
    const editing = draft.edit('color', [0.1, 0.3, 0.8]);
    finish();
    await Promise.all([generating, editing]);
    expect(owner.adopt).toHaveBeenCalledTimes(1);
    expect(owner.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'color' }),
      [0.1, 0.3, 0.8],
    );
    expect(draft.snapshot()).toMatchObject({
      values: { color: [0.1, 0.3, 0.8] },
      needsGeneration: false,
    });
  });

  it('merges unrelated external changes and reports same-field conflicts', async () => {
    const { draft } = setup();
    await draft.edit('color', [0.2, 0.4, 0.8]);
    await draft.refresh(
      readPackDraftSource('scene.pack.ts', source.replace('default: 1,', 'default: 3,')).document,
    );
    expect(draft.snapshot()).toMatchObject({
      conflicts: [],
      values: { radius: 3, color: [0.2, 0.4, 0.8] },
      unsaved: true,
    });
    await draft.refresh(
      readPackDraftSource('scene.pack.ts', source.replace('[1, 1, 1]', '[0, 0, 0]')).document,
    );
    expect(draft.snapshot().conflicts).toEqual(['color']);
    await expect(draft.save()).rejects.toMatchObject({ code: 'pack-source-revision-conflict' });
    expect(await draft.discard()).toMatchObject({
      unsaved: false,
      conflicts: [],
      values: { color: [0, 0, 0] },
    });
  });

  it('keeps a legal draft after preview failure and rejects invalid input before preview', async () => {
    const { draft, owner } = setup();
    if (!owner.preview) throw new Error('Missing fixture preview');
    vi.mocked(owner.preview).mockRejectedValue(new Error('target retired'));
    expect(await draft.edit('color', [0.2, 0.4, 0.8])).toMatchObject({
      ok: true,
      value: {
        unsaved: true,
        preview: 'unavailable',
        error: { detail: { reason: 'target retired' } },
      },
    });
    expect(await draft.edit('radius', -1)).toMatchObject({ ok: false });
    expect(draft.snapshot().values.radius).toBe(1);
  });

  it('edits direct JSON fields in place and preserves instance values as overrides', () => {
    const json =
      '{\n  "schemaVersion": "3.0.0", "packageId": "01900000-0000-7000-8000-000000000077",\n  "assets": {"scene/main": {"kind":"scene","payload":{"entities":{"sun":{"components":{"DirectionalLight":{"color":[1,1,1]}}}}},"refs":[]}}\n}\n';
    const direct = readPackDraftSource('scene.pack.json', json, { liveField: () => true });
    const color = direct.document.fields[0];
    if (!color) throw new Error('Missing fixture field');
    expect(color.apply).toEqual({
      asset: 'scene/main',
      path: ['entities', 'sun', 'components', 'DirectionalLight', 'color'],
    });
    expect(direct.write(new Map([[color.name, [0.1, 0.2, 0.3]]]))).toBe(
      json.replace('[1,1,1]', '[0.1,0.2,0.3]'),
    );
    const instance = readPackDraftSource(
      'instance.pack.json',
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: '01900000-0000-7000-8000-000000000078',
        parent: direct.document.packageId,
        values: {},
      }),
      { inherited: [{ name: 'radius', type: 'f32', default: 2 }] },
    );
    expect(JSON.parse(instance.write(new Map([['radius', 3]])))).toMatchObject({
      parent: direct.document.packageId,
      values: { radius: 3 },
    });
  });
});
