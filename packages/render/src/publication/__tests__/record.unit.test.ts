import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Time, World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import { Camera, MeshFilter, MeshRenderer } from '../../components';
import { Materials } from '../../materials';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';
import {
  decodeRenderPublication,
  encodeRenderPublication,
  RENDER_PUBLICATION_PROTOCOL,
  type RenderPublicationMessage,
  renderPublicationRecordLength,
  renderPublicationTiming,
  renderPublicationTransfers,
} from '../record';
import { RenderPublicationTargetOwner } from '../targets';

const HEADER_BYTES = 128;

function session(epoch: number, count = 4, targets?: RenderPublicationTargetOwner) {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const cube = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  const material = assets.create(Materials.standard({ baseColor: [1, 1, 1, 1] })).unwrap();
  const identity = { source: 'record-test', epoch };
  const publisher = createRenderPublisher(world, assets, identity, undefined, [], targets);
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { fov: Math.PI / 3 } },
    )
    .unwrap();
  const entities = Array.from({ length: count }, (_, index) =>
    world
      .spawn(
        { component: Transform, data: { pos: [index, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: cube } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap(),
  );
  world.update(1 / 60).unwrap();
  const receiver = new RenderPublicationReceiver(identity);
  /** One Worker crossing: transfer the record, decode/apply, return the record with the completion. */
  const frame = () => {
    const candidate = publisher.prepare(world.getResource(Time).elapsed).unwrap();
    const sent = structuredClone(candidate.message, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    const accepted = receiver.accept(sent);
    // The record returns to the publisher below; keep what the assertions read.
    const head = header(sent).slice();
    const length = renderPublicationRecordLength(sent);
    const transforms = accepted.ok ? accepted.value.packet.transforms.slice() : undefined;
    if (accepted.ok) {
      const returned = structuredClone(renderPublicationTransfers(sent), {
        transfer: renderPublicationTransfers(sent),
      });
      publisher.recycle(sent.revision, returned).unwrap();
    }
    return { sent, accepted, head, length, transforms };
  };
  const move = (index: number, x: number) => {
    const entity = entities[index];
    if (entity === undefined) throw new Error('missing entity');
    world.set(entity, Transform, { pos: [x, 1, 0] }).unwrap();
    world.update(1 / 60).unwrap();
  };
  return {
    world,
    camera,
    publisher,
    receiver,
    frame,
    move,
    dispose() {
      publisher.dispose();
      receiver.dispose();
    },
  };
}

function header(message: RenderPublicationMessage): Float64Array {
  return new Float64Array(message.record, 0, 16);
}

describe('render publication record protocol', () => {
  it('sends an unchanged frame as one header-only record and no side rows', () => {
    const s = session(1);
    try {
      // The baseline, then the first culled frame's statistics, settle the metadata.
      for (let index = 0; index < 2; index++) {
        expect(s.frame().accepted.ok).toBe(true);
        s.world.update(1 / 60).unwrap();
      }
      const { sent, accepted, length } = s.frame();
      expect(accepted.ok).toBe(true);
      expect(sent.side).toBeUndefined();
      expect(length).toBe(HEADER_BYTES);
      expect(Object.keys(sent).sort()).toEqual(['epoch', 'record', 'revision', 'source']);
    } finally {
      s.dispose();
    }
  });

  it('carries a pose change only in the record columns and decodes it exactly', () => {
    const s = session(1, 8);
    try {
      for (let index = 0; index < 2; index++) {
        s.frame();
        s.world.update(1 / 60).unwrap();
      }
      s.move(3, 7);
      const { sent, accepted, head, length, transforms } = s.frame();
      expect(accepted.ok).toBe(true);
      expect(sent.side).toBeUndefined();
      expect(head[11]).toBe(1);
      expect(length).toBe(HEADER_BYTES + 4 + 64);
      expect(transforms?.[12]).toBe(7);
    } finally {
      s.dispose();
    }
  });

  it('round-trips header, columns and complete metadata through encode/decode', () => {
    const s = session(1);
    try {
      const candidate = s.publisher.prepare(0).unwrap();
      const packet = candidate.packet;
      const message = encodeRenderPublication(packet);
      expect(header(message)[0]).toBe(RENDER_PUBLICATION_PROTOCOL);
      const decoded = decodeRenderPublication(message, undefined).unwrap();
      expect(decoded.baseline).toBe(true);
      expect(decoded.base).toBe(packet.base);
      expect(decoded.time).toEqual(packet.time);
      expect(decoded.transparentSort).toEqual(packet.transparentSort);
      expect(decoded.sampleTimeSeconds).toBe(packet.sampleTimeSeconds);
      expect([...decoded.upserts]).toEqual([...packet.upserts]);
      expect([...decoded.transformEntities]).toEqual([...packet.transformEntities]);
      expect([...decoded.transforms]).toEqual([...packet.transforms]);
      expect(decoded.metadata).toEqual(packet.metadata);
      expect(renderPublicationTiming(message)).toEqual({
        sampleTimeSeconds: packet.sampleTimeSeconds,
        temporalReset: packet.temporalReset,
      });
      candidate.discard();
    } finally {
      s.dispose();
    }
  });

  it('sends only changed metadata entries and completes them from the accepted publication', () => {
    const s = session(1);
    try {
      const first = s.frame();
      const before = first.accepted.ok ? first.accepted.value.packet.metadata : undefined;
      s.world.set(s.camera, Camera, { fov: Math.PI / 4 }).unwrap();
      s.world.update(1 / 60).unwrap();
      const { sent, accepted } = s.frame();
      expect(accepted.ok).toBe(true);
      const changed = Object.keys(sent.side?.metadata ?? {});
      expect(changed).toContain('cameras');
      expect(changed).not.toContain('lights');
      expect(sent.side?.retiredMetadata).toBeUndefined();
      const metadata = accepted.ok ? accepted.value.packet.metadata : undefined;
      expect(metadata?.lights).toBe(before?.lights);
      expect(metadata?.cameras).not.toEqual(before?.cameras);
    } finally {
      s.dispose();
    }
  });

  it('removes retired metadata keys and replaces metadata marked complete', () => {
    const s = session(1);
    try {
      const packet = s.publisher.prepare(0).unwrap().packet;
      const complete = encodeRenderPublication(packet);
      const accepted = decodeRenderPublication(complete, undefined).unwrap().metadata;
      const reduced = { ...accepted } as Record<string, unknown>;
      const retiredKey = Object.keys(reduced)[0] as string;
      delete reduced[retiredKey];
      const successor = { ...packet, baseline: false, base: 1, revision: 2, metadata: reduced };
      const delta = encodeRenderPublication(successor as typeof packet, accepted);
      expect(delta.side?.retiredMetadata).toEqual([retiredKey]);
      expect(delta.side?.metadata).toBeUndefined();
      const decoded = decodeRenderPublication(delta, accepted).unwrap();
      expect(Object.hasOwn(decoded.metadata, retiredKey)).toBe(false);
      // Encoded without accepted metadata, a successor replaces rather than amends.
      const whole = encodeRenderPublication(successor as typeof packet);
      const replaced = decodeRenderPublication(whole, { ...accepted, extra: 1 } as never).unwrap();
      expect(Object.hasOwn(replaced.metadata, 'extra')).toBe(false);
    } finally {
      s.dispose();
    }
  });

  it('rejects malformed records with structured shape errors', () => {
    const s = session(1);
    try {
      const packet = s.publisher.prepare(0).unwrap().packet;
      const good = encodeRenderPublication(packet);
      const reason = (message: unknown) => {
        const result = decodeRenderPublication(message as RenderPublicationMessage, undefined);
        return result.ok ? 'ok' : result.error.detail.subject;
      };
      expect(reason({ ...good, record: new ArrayBuffer(64) })).toBe('publication record');
      const wrongProtocol = good.record.slice(0);
      new Float64Array(wrongProtocol)[0] = 3;
      expect(reason({ ...good, record: wrongProtocol })).toBe('publication protocol');
      const truncated = good.record.slice(0, HEADER_BYTES);
      new Float64Array(truncated)[11] = 1000;
      expect(reason({ ...good, record: truncated })).toBe('publication record columns');
      const badFlags = good.record.slice(0);
      new Float64Array(badFlags)[2] = 64;
      expect(reason({ ...good, record: badFlags })).toBe('publication record columns');
      const noMetadata = good.record.slice(0);
      new Float64Array(noMetadata)[2] = 0;
      expect(reason({ source: good.source, epoch: 1, revision: 1, record: noMetadata })).toBe(
        'publication metadata',
      );
      expect(() =>
        encodeRenderPublication({ ...packet, transforms: new Float32Array(15) }),
      ).toThrow(/transform columns/);
    } finally {
      s.dispose();
    }
  });

  it('fences revision order and epoch at the receiver', () => {
    const s = session(1);
    try {
      s.frame();
      s.world.update(1 / 60).unwrap();
      const candidate = s.publisher.prepare(1).unwrap();
      const message = candidate.message;
      candidate.accept();
      const skipped = { ...message, revision: message.revision + 1 };
      const wrongEpoch = { ...message, epoch: 9 };
      const reason = (input: RenderPublicationMessage) => {
        const result = s.receiver.accept(input);
        return result.ok ? 'ok' : result.error.detail.reason;
      };
      expect(reason(skipped)).toBe('revision');
      expect(reason(wrongEpoch)).toBe('identity');
      expect(reason(message)).toBe('ok');
      // A replayed revision no longer matches the accepted base.
      expect(reason(message)).toBe('base');
    } finally {
      s.dispose();
    }
  });

  it('recovers through a new epoch whose baseline carries complete metadata', () => {
    const before = session(1);
    before.frame();
    before.dispose();
    const after = session(2);
    try {
      const { sent, accepted, head } = after.frame();
      expect(accepted.ok).toBe(true);
      const flags = head[2] as number;
      expect(flags & 1).toBe(1);
      expect(flags & 4).toBe(4);
      expect(sent.side?.metadata).toBeDefined();
    } finally {
      after.dispose();
    }
  });

  it('returns exactly the one record to the publisher', () => {
    const s = session(1);
    try {
      const candidate = s.publisher.prepare(0).unwrap();
      const sent = structuredClone(candidate.message, {
        transfer: renderPublicationTransfers(candidate.message),
      });
      candidate.accept();
      s.receiver.accept(sent).unwrap();
      const reason = (buffers: ArrayBuffer[]) => {
        const result = s.publisher.recycle(sent.revision, buffers);
        return result.ok ? 'ok' : result.error.detail.reason;
      };
      expect(reason([])).toBe('shape');
      expect(reason([sent.record, new ArrayBuffer(8)])).toBe('shape');
      expect(reason([sent.record])).toBe('ok');
    } finally {
      s.dispose();
    }
  });

  it('keeps every target-naming camera in the same crossing as the targets it names', () => {
    // Structured clone preserves object identity only within one message: a
    // camera's target token from an earlier crossing never equals this
    // crossing's target rows, so steady frames must still resolve.
    const targets = new RenderPublicationTargetOwner();
    const s = session(1, 4, targets);
    try {
      const target = targets.authoring.createRenderTarget({
        shape: '2d',
        width: 16,
        height: 16,
        format: 'rgba8unorm',
        mipLevels: 1,
        sampleCount: 1,
        sampled: true,
        readback: false,
      });
      if (!target.ok) throw target.error;
      s.world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 3] } },
          {
            component: Camera,
            data: { fov: 1, target: s.world.allocSharedRef('RenderTarget', target.value) },
          },
        )
        .unwrap();
      s.world.update(1 / 60).unwrap();
      for (let index = 0; index < 4; index++) {
        const { accepted } = s.frame();
        if (!accepted.ok) throw accepted.error;
        const auxiliary = accepted.value.packet.metadata.auxiliaryCameras;
        expect(auxiliary).toHaveLength(1);
        expect(accepted.value.packet.targets.map((row) => row.token)).toContain(
          auxiliary[0]?.target,
        );
        s.world.update(1 / 60).unwrap();
      }
    } finally {
      s.dispose();
      targets.dispose();
    }
  });
});
