import { expectTypeOf, test } from 'vitest';
import type { mat4, ray, ray2, vec3 } from '../index';
import type { Mat4 } from '../types';

test('output APIs require caller storage while retaining returned output identity types', () => {
  expectTypeOf<Parameters<typeof ray.create>[0]>().toEqualTypeOf<Float32Array>();
  expectTypeOf<Parameters<typeof ray2.create>[0]>().toEqualTypeOf<Float32Array>();
  expectTypeOf<Parameters<typeof mat4.invert>[0]>().toEqualTypeOf<Mat4>();
  expectTypeOf<ReturnType<typeof mat4.invert>>().toEqualTypeOf<Mat4>();
  expectTypeOf<ReturnType<typeof vec3.add>>().toEqualTypeOf<ReturnType<typeof vec3.create>>();
  // @ts-expect-error Ray initialization requires caller-owned output storage.
  ray.create();
  // @ts-expect-error Ray initialization requires caller-owned output storage.
  ray2.create();
});
