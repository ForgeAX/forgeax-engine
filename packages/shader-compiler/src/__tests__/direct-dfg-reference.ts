// Independent Three.js r184 DFGLUT.js (MIT) source texture, little-endian RG16F.
// SHA256 b41ba8e2bd29fa007dfbf034d4d58b853f378062183847846b1f6d228f2c7e79.
const encoded =
  'tTDROkwxTTrSMxw57zUoOPM3pjbRODk1eTkQNPg5UjJTOvAwlDrJL786NS7aOgUt6DofLO064CrqOtEp4Tr/KDg25DhKNs44mTZe' +
  'OE43LDc5OKQ13DhiNG45xDLeOTQxKzoDMFk6Oi5tOuEsbjq6K186MypJOgopLTomKAo66CaUONc2lzjJNqM4dTa8OKw17jicND45' +
  'MjOXOYYx4jk4MBM6dS4pOvUsLTqsKyE6/ykEOrwo3DmQJ605GiZ4OfokrDmoNKw5ozSuOYA0rjkjNLE5DjPCOakx4DljMPw5tS4M' +
  'Oh0tFDrPKwc6/ynpOaMovjk8J4k5syVKOYgkBzlFI3c6IzJ2Oh8yczoEMmo6szFYOhQxRTo7MDQ6ti4mOjEtHjrvKws6DSrsOaEo' +
  'wDkbJ4c5gCVEOUkk+ji9Iqw4VSEHO8ovBjvKLwA7uC/0Onwv2zrqLrQ6AC6FOuwsXjrFKzY6ACoNOpko3DkHJ6A5YiVaOSQkCzlo' +
  'Irc4/SBfONEfaTu5LGg7uyxiO7ssVjuuLDs7eCwNOwoszzrjKpI6mClUOmcoFzrQJtM5PCWJOQIkNTkmItw4vSB9OFQfHTizHak7' +
  'aymoO28pozt7KZg7hyl/O3YpTjsnKQ47lSjCOrcnczo7JiM65yTQOZsjdjnZIRc5fiCyOOceSzhTHcc3HhzSO8sl0TvTJc078CXC' +
  'Ox8mrTtFJn07LSY+O8Ql7DoPJZM6OiQyOs4i0DlbIWk5KiD+OG4ejzjxHB84mxtiN90Z6TurIek7tyHlO+Uh3TtBIsk7pyKgO+wi' +
  'YjvNIg87RyKuOnUhRDqIINQ5SR9gOb4d6Th3HHA46BrxN1MZCDcbGPY76hz2O/sc8zs4Hew7vR3aO3wetzslH307eR8sO0wfxjqm' +
  'HlU6ux3aOb0cWjmdG9g4ABpVOKwYqzc8F7c2mBX8OzYX/DtZF/k75xf0O5YY5DuXGcY7qBqRO4QbQzvSG946ihtlOs0a4jnTGVc5' +
  'zRjKOLMXPjgTFm03vxRvNl4T/zsbEP87ORD8O8gQ+TsmEuo7KBTPO4QVnzvFFlQ7mhfwOs4XdjpxF+o5pBZWOacVvzinFCk4eRM1' +
  'N+oRLTahEAA8GwYAPGoG/jscCPo7TArtOxYN1TuzD6k7TRFjO3wSATsvE4U6RBP0OdISVzkNErU4IhEXODwQAzfTDvA1bQ0APHoA' +
  'ADyJAP47HQH7O3wC8Dv6BNo7gQixO80KbzuXDBA7ew2TOvEN/jnvDVk5ig2vOOkMCDgxDNU28Aq5NaMJADwAAAA8AQD/OxUA+ztZ' +
  'API7/QDdO98BtzscA3k7fAQdO9QFoDrVBgg6WgddOV4Hqjj3BvQ3SAasNnYFhjWfBA==';

export const referenceBytes = Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0));

// Independent double-precision oracle for the UE Lazarov coefficients and the
// Engine nonnegative projection, with perceptual roughness (not roughness²).
export function referenceFit(roughness: number, cosine: number): readonly [number, number] {
  const r = Math.min(1, Math.max(0, roughness));
  const n = Math.min(1, Math.max(0, cosine));
  const x = 1 - r;
  const a004 = Math.min(x * x, 2 ** (-9.28 * n)) * x + 0.0425 - 0.0275 * r;
  const energy = 1 - 0.55 * r;
  const b = Math.min(energy, Math.max(0, 1.04 * a004 + 0.022 * r - 0.04));
  return [energy - b, b];
}

export const dfgTestReflectance = [
  [0, 0, 0],
  [0.04, 0.04, 0.04],
  [1, 1, 1],
  [0.8, 0.2, 0.05],
  [0.015, 0.003, 0],
  [1, 0, 0],
] as const;

export function referenceFitCompensation(
  r: number,
  nv: number,
  nl: number,
  f0: readonly number[],
): readonly number[] {
  const v = referenceFit(r, nv);
  const l = referenceFit(r, nl);
  const f90 = Math.min(1, Math.max(0, 50 * Math.max(...f0)));
  const loss = (1 - v[0] - v[1]) * (1 - l[0] - l[1]);
  return f0.map((f) => {
    const average = f + (f90 - f) * 0.047619;
    return (
      ((f * v[0] + f90 * v[1]) * (f * l[0] + f90 * l[1]) * average * loss) /
      (1 - loss * average * average + 1e-6)
    );
  });
}
