import { describe, expect, it } from 'vitest';
import { gpuDrivenMeshVariantKey, gpuDrivenSkinVariantKey } from '../main-pass';
import type { SkinTaskBinding } from '../skin-tasks';

describe('GPU-driven current variant keys', () => {
  it('preserves exact key bytes across current size changes and separate owners', () => {
    expect(gpuDrivenMeshVariantKey(256)).toBe('gpu-driven-hdrp:256');
    expect(gpuDrivenMeshVariantKey(256)).toBe('gpu-driven-hdrp:256');
    expect(gpuDrivenMeshVariantKey(512)).toBe('gpu-driven-hdrp:512');
    expect(gpuDrivenMeshVariantKey(256)).toBe('gpu-driven-hdrp:256');
    const task = { dataSize: 32, auxiliarySize: 64 } as SkinTaskBinding;
    expect(gpuDrivenSkinVariantKey(task, 256)).toBe('gpu-driven-hdrp-skin:256:32:64');
    task.dataSize = 48;
    expect(gpuDrivenSkinVariantKey(task, 256)).toBe('gpu-driven-hdrp-skin:256:48:64');
    expect(gpuDrivenSkinVariantKey({ dataSize: 1, auxiliarySize: 2 } as SkinTaskBinding, 8)).toBe(
      'gpu-driven-hdrp-skin:8:1:2',
    );
  });

  it('performs every original getter and string coercion in order on every call', () => {
    const calls: string[] = [];
    const part = (name: string, value: number) =>
      ({
        [Symbol.toPrimitive](hint: string) {
          calls.push(`${name}:${hint}`);
          return value;
        },
      }) as unknown as number;
    const bytes = part('mesh', 256);
    const task = {
      get dataSize() {
        calls.push('data:get');
        return part('data', 32);
      },
      get auxiliarySize() {
        calls.push('aux:get');
        return part('aux', 64);
      },
    } as SkinTaskBinding;
    for (let i = 0; i < 2; i++) {
      calls.length = 0;
      expect(gpuDrivenSkinVariantKey(task, bytes)).toBe('gpu-driven-hdrp-skin:256:32:64');
      expect(calls).toEqual(['mesh:string', 'data:get', 'data:string', 'aux:get', 'aux:string']);
    }
  });

  it('propagates coercion failures before later getters and permits later recovery', () => {
    const calls: string[] = [];
    let fails = true;
    const task = {
      get dataSize() {
        calls.push('data');
        return {
          [Symbol.toPrimitive]() {
            if (fails) throw new Error('coercion failed');
            return 32;
          },
        };
      },
      get auxiliarySize() {
        calls.push('aux');
        return 64;
      },
    } as unknown as SkinTaskBinding;
    expect(() => gpuDrivenSkinVariantKey(task, 256)).toThrow('coercion failed');
    expect(calls).toEqual(['data']);
    fails = false;
    expect(gpuDrivenSkinVariantKey(task, 256)).toBe('gpu-driven-hdrp-skin:256:32:64');
  });
});
