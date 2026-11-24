import { createShaderModule } from '@forgeax/engine-rhi-null';
import { assert, expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { createSdfCardLookup, packCardLookupProjections } from '../../raytracing/card-lookup';
import { prepareCardSlotCapture } from './card-slot-reuse.fixture';
import { retiredDenseCardProjections } from './card-slot-reuse-control.fixture';
import { queryTestDevice } from './global-sdf-query-device.fixture';
import { prepareSdfCardsBaseFixture } from './sdf-cards.commands';

it('validates the actual slot-reuse factory shaders and its isolated wrong-upload controls', async () => {
  const base = await prepareSdfCardsBaseFixture();
  const device = await queryTestDevice();
  Object.assign(device.caps, { rgba16floatRenderable: true, maxColorAttachments: 4 });
  const modules = new Set<string>();
  const compile: Parameters<typeof prepareCardSlotCapture>[1] = async (owner, descriptor) => {
    (await compileShader(descriptor.code, { id: descriptor.label ?? 'card-slot-reuse' })).unwrap();
    modules.add(descriptor.label ?? 'unlabelled');
    return createShaderModule(owner, descriptor);
  };
  const { capture, query, expected, b, c } = await prepareCardSlotCapture(device, compile, base);
  const m = base.layout.cards.length;
  try {
    expect(m).toBe(6);
    expect(capture.allocatedTiles).toBe(m);
    expect(capture.add(b).unwrap()).toEqual({ first: m, count: m });
    for (const stage of ['initial', 'remove-only', 'reuse']) {
      if (stage === 'remove-only') capture.remove(0).unwrap();
      if (stage === 'reuse') capture.add(c).unwrap();
      const current = packCardLookupProjections(capture, query.sources, expected);
      const retired = retiredDenseCardProjections(capture, query.sources, expected);
      if (stage === 'initial') expect(current).toEqual(retired);
      else expect(current.bytes).not.toEqual(retired.bytes);
      expect(current.count).toBe(12);
      expect(capture.width).toBe(64);
      expect(capture.height).toBe(48);
      const bytes = new DataView(current.bytes.buffer);
      expect(bytes.getUint32(m * 80 + 64, true)).toBe(1);
      expect(bytes.getUint32(64, true)).toBe(
        stage === 'initial' ? 0 : stage === 'reuse' ? 2 : 0xffffffff,
      );
      const lookup = (
        await createSdfCardLookup(device, compile, query, capture, expected)
      ).unwrap();
      lookup.dispose();
    }
    expect(modules).toContain('cards.lookup');
    expect(modules.size).toBeGreaterThanOrEqual(3);
    assert(capture.entry(1)?.firstTile === m && capture.entry(2)?.firstTile === 0);
  } finally {
    capture.dispose();
    query.dispose();
  }
}, 30000);
