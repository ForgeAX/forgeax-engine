import { describe, expect, it } from 'vitest';
import { type NativeCookDraft, NativeCookerRegistry } from '../native-cooker-registry.js';

describe('NativeCookerRegistry artifact boundary', () => {
  it('keeps native artifact bytes available before converting to CookProduct descriptors', async () => {
    const bytes = new TextEncoder().encode('{"program":true}');
    const registry = new NativeCookerRegistry();
    registry.register({
      key: 'test-effect',
      cook: () => ({
        guid: '019e9c00-0000-7000-8000-000000000000',
        payload: { kind: 'test-effect' },
        refs: ['019e9c00-0000-7000-8000-000000000001'],
        artifacts: {
          'test-effect/program.json': { mediaType: 'application/json', bytes },
        },
        inputFingerprint: 'sha256:test-input',
      }),
    });

    const draft = await registry.runDraft('test-effect', {});
    expect(draft.ok).toBe(true);
    if (!draft.ok) throw new Error(draft.error.hint);
    expect(draft.value.artifacts['test-effect/program.json']?.bytes).toEqual(bytes);

    const product = await registry.run('test-effect', {});
    expect(product.ok).toBe(true);
    if (!product.ok) throw new Error(product.error.hint);
    expect(product.value.artifacts['test-effect/program.json']).toMatchObject({
      path: 'test-effect/program.json',
      mediaType: 'application/json',
      byteLength: bytes.byteLength,
    });
  });

  it('discovers a typed producer input before cooking and preserves the typed output contract', async () => {
    const registry = new NativeCookerRegistry();
    registry.register({
      key: 'typed-effect',
      discover: (input) => {
        if (typeof input !== 'object' || input === null || !('source' in input)) {
          throw new Error('source is required');
        }
        return { source: String(input.source), revision: 3 };
      },
      cook: (input: { readonly source: string; readonly revision: number }) => ({
        guid: '019e9c00-0000-7000-8000-000000000010',
        payload: { source: input.source, revision: input.revision },
        refs: [],
        artifacts: {
          'typed-effect/program.json': {
            mediaType: 'application/json',
            bytes: new TextEncoder().encode(JSON.stringify(input)),
          },
        },
        inputFingerprint: `sha256:${input.source}`,
      }),
    });

    const result = await registry.runDraft('typed-effect', { source: 'module.wgsl' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.payload).toEqual({ source: 'module.wgsl', revision: 3 });
  });

  it('passes each cooker the host store of its own key and none without a factory', async () => {
    const stores = new Map<string, Map<string, Uint8Array>>();
    const registry = new NativeCookerRegistry({
      cache: (key) => {
        const entries = stores.get(key) ?? new Map<string, Uint8Array>();
        stores.set(key, entries);
        return { get: (k) => entries.get(k), put: (k, bytes) => void entries.set(k, bytes) };
      },
    });
    const seen: (number | undefined)[] = [];
    for (const key of ['a', 'b'])
      registry.register({
        key,
        cook(_input, context) {
          seen.push(context?.cache?.get('k')?.[0]);
          context?.cache?.put('k', new Uint8Array([key.charCodeAt(0)]));
          return { guid: key, payload: {}, refs: [], artifacts: {}, inputFingerprint: key };
        },
      });
    for (const key of ['a', 'b', 'a']) expect((await registry.runDraft(key, {})).ok).toBe(true);
    expect(seen).toEqual([undefined, undefined, 97]);
    expect([...stores.keys()]).toEqual(['a', 'b']);
    const bare = new NativeCookerRegistry();
    let context: unknown;
    bare.register({
      key: 'a',
      cook(_input, received) {
        context = received;
        return { guid: 'a', payload: {}, refs: [], artifacts: {}, inputFingerprint: 'a' };
      },
    });
    await bare.runDraft('a', {});
    expect(context).toEqual({});
  });

  it('retains structured diagnostics when a producer throws a non-Error value', async () => {
    const registry = new NativeCookerRegistry();
    registry.register({
      key: 'structured-failure',
      cook: () => {
        throw { code: 'producer-schema-invalid', stage: 'cook', detail: 'missing field' };
      },
    });

    const result = await registry.runDraft('structured-failure', {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected producer failure');
    expect(result.error.detail.producer).toContain('producer-schema-invalid');
    expect(result.error.detail.producer).not.toContain('[object Object]');
  });
});

const validDraft = (): NativeCookDraft => ({
  guid: 'draft',
  payload: {},
  refs: [],
  artifacts: {},
  inputFingerprint: 'input',
});

it.each([
  undefined,
  null,
  {},
  { ...validDraft(), guid: 5 },
  { ...validDraft(), refs: [2] },
])('reports malformed producer output through every entry point: %j', async (output) => {
  const registry = new NativeCookerRegistry();
  registry.register({ key: 'broken', cook: () => output as NativeCookDraft });
  await expect(registry.runDraft('broken', {})).resolves.toMatchObject({
    ok: false,
    error: { code: 'native-cook-failed' },
  });
  await expect(registry.run('broken', {})).resolves.toMatchObject({
    ok: false,
    error: { code: 'native-cook-failed' },
  });
  await expect(registry.runTransaction({ key: 'broken', input: {} })).resolves.toMatchObject({
    ok: false,
    error: { code: 'native-cook-failed' },
  });
  const previous = { draft: validDraft(), generation: 3 };
  const recovered = await registry.runTransaction({ key: 'broken', input: {}, previous });
  expect(recovered).toMatchObject({ ok: true, value: { ...previous, status: 'recovered' } });
  if (recovered.ok) expect(recovered.value.draft).toBe(previous.draft);
});

it('uses the accepted snapshot when validation throws without publishing the candidate', async () => {
  const registry = new NativeCookerRegistry();
  registry.register({ key: 'test', cook: validDraft });
  const first = await registry.runTransaction({ key: 'test', input: {} });
  if (!first.ok) throw new Error(first.error.hint);
  let published = false;
  const options = {
    key: 'test',
    input: {},
    validate: () => {
      throw new Error('invalid payload');
    },
    publish: () => {
      published = true;
    },
  };
  await expect(registry.runTransaction(options)).resolves.toMatchObject({
    ok: false,
    error: { code: 'native-cook-failed', detail: { producer: 'invalid payload' } },
  });
  await expect(
    registry.runTransaction({ ...options, previous: first.value }),
  ).resolves.toMatchObject({
    ok: true,
    value: { generation: 1, draft: first.value.draft, status: 'recovered' },
  });
  expect(published).toBe(false);
});

describe('NativeCookerRegistry admission', () => {
  const draft = (guid: string) => ({
    guid,
    payload: { kind: 'test-effect' },
    refs: [],
    artifacts: {},
    inputFingerprint: `sha256:${guid}`,
  });
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('admits concurrent callers of a serial cooker one at a time in call order', async () => {
    const registry = new NativeCookerRegistry();
    let active = 0;
    let peak = 0;
    const started: string[] = [];
    registry.register({
      key: 'serial-effect',
      async cook(input: unknown) {
        const guid = (input as { guid: string }).guid;
        started.push(guid);
        peak = Math.max(peak, ++active);
        // Later calls finish faster; serial admission must not let them overtake.
        await delay(guid === 'a' ? 20 : guid === 'b' ? 10 : 1);
        active--;
        if (guid === 'b') throw new Error('b failed');
        return draft(guid);
      },
    });
    const results = await Promise.all(
      ['a', 'b', 'c'].map((guid) => registry.runDraft('serial-effect', { guid })),
    );
    expect(peak).toBe(1);
    expect(started).toEqual(['a', 'b', 'c']);
    // A failed cook releases admission for the next caller.
    expect(results.map((result) => result.ok)).toEqual([true, false, true]);
  });

  it('serializes separately constructed instances of one cooker key across registries', async () => {
    let active = 0;
    let peak = 0;
    // Each registry constructs its own instance, as a per-Pack or per-project load would.
    const instance = () => ({
      key: 'shared-effect',
      async cook(input: unknown) {
        peak = Math.max(peak, ++active);
        await delay(5);
        active--;
        return draft((input as { guid: string }).guid);
      },
    });
    const registries = [new NativeCookerRegistry(), new NativeCookerRegistry()];
    for (const registry of registries) registry.register(instance());
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((guid, index) =>
        registries[index % 2]?.runDraft('shared-effect', { guid }),
      ),
    );
    expect(peak).toBe(1);
    expect(results.every((result) => result?.ok)).toBe(true);
  });

  it('lets a parallel cooker overlap its calls', async () => {
    const registry = new NativeCookerRegistry();
    let active = 0;
    let peak = 0;
    registry.register({
      key: 'parallel-effect',
      concurrency: 'parallel',
      async cook(input: unknown) {
        peak = Math.max(peak, ++active);
        await delay(5);
        active--;
        return draft((input as { guid: string }).guid);
      },
    });
    const results = await Promise.all(
      ['a', 'b', 'c'].map((guid) => registry.runDraft('parallel-effect', { guid })),
    );
    expect(peak).toBe(3);
    expect(results.every((result) => result.ok)).toBe(true);
  });
});
