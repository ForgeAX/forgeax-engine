import { describe, expect, it } from 'vitest';
import { resolvePostColorDomainContract } from '../render-pipeline';

describe('Standard forward post color-domain order', () => {
  it('declares the required linear-to-encoded stage sequence', () => {
    expect(resolvePostColorDomainContract('linear-ldr')).toEqual([
      ['transparent-blend', 'linear-ldr', 'linear-ldr'],
      ['bloom', 'linear-hdr', 'linear-hdr'],
      ['output-transform', 'linear-ldr', 'display-encoded'],
      ['fxaa', 'display-encoded', 'display-encoded'],
      ['post-effect', 'display-encoded', 'display-encoded'],
      ['present', 'display-encoded', 'display-encoded'],
    ]);
  });
});
