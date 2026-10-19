import { createMaterialProgramSetDigest } from '@forgeax/engine-pack/material-cook';
import type { MaterialProgramAbi } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { cloneRetainedPackPayload } from '../internal/retained-material-facts.js';
import { parseRetainedPackJson, readRetainedPackJson } from '../internal/retained-pack-json.js';
import { createMaterialLoader } from '../material/loader.js';
import {
  materialPublicationFixture,
  materialRecordFixture,
} from './fixtures/material-publication.js';

const abi = {
  directEntry: 'vs_main',
  sceneIndexEntry: 'vs_scene_index',
  materialRow: { addressUnitBytes: 16, byteLength: 16, fields: [] },
  resourceSlots: [],
  uvSets: [],
  vertexInputs: [],
  alphaMask: { cutoff: 'alphaCutoff', source: 'baseColor.a' },
  reflection: { layoutIdentity: 'layout', resourceSlots: [], vertexInputs: [] },
  receiptIdentity: 'custom-layout',
  generation: 1,
} satisfies MaterialProgramAbi;

function publication(receipts: unknown[] = [abi, abi]) {
  return {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: receipts.map((receipt, index) => ({
      guid: `material-${index}`,
      kind: 'material',
      payload: {
        kind: 'material',
        values: { roughness: 0.5 },
        cooked: {
          schemaVersion: 'material-cook/4',
          programs: [{ selections: [{ abi: receipt }] }],
        },
      },
    })),
  };
}

type Publication = ReturnType<typeof publication>;
function parsed(text = JSON.stringify(publication())) {
  return parseRetainedPackJson(text) as Publication;
}

describe('retained material publication facts', () => {
  it('shares immutable ABI values while retaining each material record', () => {
    const pack = parsed();
    const first = pack.assets[0]?.payload;
    const second = pack.assets[1]?.payload;
    if (!first || !second) throw Error('Missing material');
    const a = first.cooked.programs[0]?.selections[0]?.abi;
    const b = second.cooked.programs[0]?.selections[0]?.abi;
    expect(a).toBe(b);
    expect(a).toEqual(abi);
    expect(first.cooked).not.toBe(second.cooked);
    expect(Object.isFrozen(first.cooked)).toBe(true);
    expect(Object.isFrozen((a as MaterialProgramAbi).materialRow.fields)).toBe(true);
    expect(Reflect.set(first, 'cooked', {})).toBe(false);
    expect(JSON.stringify(pack)).toBe(JSON.stringify(publication()));
  });

  it('compares complete ABI values instead of trusting a repeated receipt identity', () => {
    const changed = { ...abi, alphaMask: { ...abi.alphaMask, cutoff: 'otherCutoff' } };
    const pack = parsed(JSON.stringify(publication([abi, changed])));
    const a = pack.assets[0]?.payload.cooked.programs[0]?.selections[0]?.abi;
    const b = pack.assets[1]?.payload.cooked.programs[0]?.selections[0]?.abi;
    expect(a).not.toBe(b);
    expect(b).toEqual(changed);
  });

  it('retains numeric edge cases and invalid ABI data for the existing validator', () => {
    const text = JSON.stringify(publication([abi, abi])).replaceAll(
      '"generation":1',
      '"generation":1,"extension":-0,"overflow":1e400',
    );
    const pack = parsed(text);
    const a = pack.assets[0]?.payload.cooked.programs[0]?.selections[0]?.abi;
    const b = pack.assets[1]?.payload.cooked.programs[0]?.selections[0]?.abi;
    expect(a).not.toBe(b);
    expect(a).toMatchObject({ extension: -0, overflow: Infinity });
  });

  it('leaves custom JSON readers and caller-owned records mutable', async () => {
    const pack = publication();
    expect(await readRetainedPackJson({ json: async () => pack })).toBe(pack);
    expect(Object.isFrozen(pack.assets[0]?.payload.cooked)).toBe(false);
  });

  it('shares published cooked facts across detached decoder inputs', () => {
    const payload = parsed().assets[0]?.payload;
    if (!payload) throw Error('Missing material');
    const first = cloneRetainedPackPayload(payload) as typeof payload;
    const second = cloneRetainedPackPayload(payload) as typeof payload;
    expect(first).not.toBe(payload);
    expect(first.cooked).toBe(payload.cooked);
    expect(second.cooked).toBe(payload.cooked);
    first.values.roughness = 0.9;
    expect(second.values.roughness).toBe(0.5);
    expect(payload.values.roughness).toBe(0.5);
    expect(Reflect.set(first.cooked.programs, 'length', 0)).toBe(false);
  });

  it('keeps adapter getter reads and mutable caller snapshots on structuredClone', () => {
    let reads = 0;
    const source = {
      get cooked() {
        reads++;
        return { source: 'adapter', nested: { value: 1 } };
      },
    };
    const cloned = cloneRetainedPackPayload(source);
    expect(reads).toBe(1);
    expect(Object.isFrozen(cloned.cooked)).toBe(false);
    expect(cloned.cooked).toEqual({ source: 'adapter', nested: { value: 1 } });
  });

  it('preserves shared ABI facts through Ready validation while isolating program bytes', async () => {
    const original = materialRecordFixture();
    const program = original.programs[0];
    const selection = program?.selections[0];
    if (!program || !selection) throw Error('Missing program');
    const programs = [
      {
        ...program,
        selections: [
          { ...selection, address: 'direct' as const, entry: abi.directEntry, abi },
          { ...selection, address: 'scene-index' as const, entry: abi.sceneIndexEntry, abi },
        ],
      },
    ];
    const artifactDigest = createMaterialProgramSetDigest(programs, original.resolved.passes);
    const record = {
      ...original,
      programs,
      artifactDigest,
      receipt: {
        ...original.receipt,
        identity: { ...original.receipt.identity, artifactDigest },
      },
    };
    const serialized = {
      ...record,
      programs: programs.map((entry) => ({
        ...entry,
        artifact: { ...entry.artifact, bytes: Array.from(entry.artifact.bytes) },
      })),
    };
    const pack = parsed(
      JSON.stringify({
        kind: 'internal-text-package',
        assets: [{ kind: 'material', payload: { kind: 'material', cooked: serialized } }],
      }),
    );
    const retained = pack.assets[0]?.payload.cooked;
    const input = materialPublicationFixture(record);
    const loader = createMaterialLoader({
      loadPublication: async () => ({ ...input, record: retained }),
    });
    const request = { guid: record.guid, specializationKey: record.specializationKey };
    const first = await loader.load(request);
    const second = await loader.load(request);
    if (first.status !== 'Ready' || second.status !== 'Ready')
      throw Error(JSON.stringify({ first, second }));
    const a = first.record.programs[0];
    const b = second.record.programs[0];
    if (!a || !b) throw Error('Missing Ready program');
    expect(a.selections[0]?.abi).toBe(retained?.programs[0]?.selections[0]?.abi);
    expect(a.selections[0]?.abi).toBe(b.selections[0]?.abi);
    expect(a.artifact.bytes).not.toBe(b.artifact.bytes);
    const byte = b.artifact.bytes[0];
    a.artifact.bytes[0] = (byte ?? 0) ^ 255;
    expect(b.artifact.bytes[0]).toBe(byte);
    expect(program.artifact.bytes[0]).toBe(byte);
  });
});
