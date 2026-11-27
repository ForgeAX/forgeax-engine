import { expect, it } from 'vitest';
import { SDF_SURFACE_LOCAL_RAY_WGSL } from '../sdf-surface-intersection-wgsl';

// These structural gates justify omitting Raw only inside the closed helpers.
// Numerical qualification remains with the independent dyadic and GPU owners.
function functions(source: string) {
  const rows = new Map<string, string>();
  const text = source.replace(/\/\/[^\n]*/g, '');
  for (const match of text.matchAll(/\bfn\s+(\w+)\s*\(/g)) {
    const start = text.indexOf('{', match.index);
    let end = start + 1;
    let depth = 1;
    for (; depth > 0 && end < text.length; end++) {
      if (text[end] === '{') depth++;
      if (text[end] === '}') depth--;
    }
    rows.set(match[1] ?? '', text.slice(start, end).replace(/\s+/g, ''));
  }
  return rows;
}

function callers(rows: Map<string, string>, callee: string) {
  return Array.from(rows)
    .filter(([, body]) => body.includes(`${callee}(`))
    .map(([name]) => name)
    .sort();
}

function prerequisites(source: string) {
  const rows = functions(source);
  expect(callers(rows, 'sdfIntervalTryExactMagnitude')).toEqual(['sdfIntervalTryExactSum']);
  expect(callers(rows, 'sdfIntervalTryExactSum')).toEqual(['sdfIntervalSumEndpoint']);
  expect(callers(rows, 'sdfIntervalTryExactScale')).toEqual([
    'sdfIntervalProductEndpoint',
    'sdfIntervalQuotientEndpoint',
  ]);
  for (const [caller, callee] of [
    ['sdfIntervalSumEndpoint', 'sdfIntervalTryExactSum'],
    ['sdfIntervalTryExactSum', 'sdfIntervalTryExactMagnitude'],
    ['sdfIntervalProductEndpoint', 'sdfIntervalTryExactScale'],
    ['sdfIntervalQuotientEndpoint', 'sdfIntervalTryExactScale'],
  ]) {
    expect(rows.get(caller ?? '')?.split(`${callee}(`).length).toBe(2);
  }
  const sum = rows.get('sdfIntervalSumEndpoint') ?? '';
  const raw =
    'if(!sdfSurfaceBitsUsable(ab)||!sdfSurfaceBitsUsable(bb)){returnsdfIntervalInvalid();}';
  const overflow =
    'if((ab&0x7fffffffu)>0x7e800000u||(bb&0x7fffffffu)>0x7e800000u){returnsdfIntervalInvalid();}';
  expect(sum).toContain(`${raw}${overflow}letexact=sdfIntervalTryExactSum(ab,bb);`);
  const exact = rows.get('sdfIntervalTryExactSum') ?? '';
  expect(Array.from(exact.matchAll(/(?:var)?sign=([^;]+);/g), (row) => row[1])).toEqual([
    'a&0x80000000u',
    'b&0x80000000u',
  ]);
  expect(exact).toContain('returnsdfIntervalTryExactMagnitude(magnitude,minimumExponent,sign);');
  for (const name of ['sdfIntervalProductEndpoint', 'sdfIntervalQuotientEndpoint']) {
    const endpoint = rows.get(name) ?? '';
    expect(endpoint).toContain(raw);
    expect(endpoint.indexOf(raw)).toBeLessThan(endpoint.indexOf('sdfIntervalTryExactScale('));
    expect(endpoint).toContain('exponent,(ab^bb)&0x80000000u)');
  }
  expect(rows.get('sdfIntervalProductEndpoint')).toContain(
    'sdfIntervalTryExactScale(select(ab,bb,ap),exponent,(ab^bb)&0x80000000u)',
  );
  expect(rows.get('sdfIntervalQuotientEndpoint')).toContain(
    'sdfIntervalTryExactScale(ab,exponent,(ab^bb)&0x80000000u)',
  );
  for (const name of ['sdfIntervalTryExactMagnitude', 'sdfIntervalTryExactScale']) {
    const body = rows.get(name) ?? '';
    expect(body).toContain('if(exponent<1||exponent>254){return0x7f800000u;}');
    expect(body).toContain('&0x7fffffu)');
  }
}

it('locks the complete exact-helper callers and validated construction prerequisites', () => {
  prerequisites(SDF_SURFACE_LOCAL_RAY_WGSL);
});

it('keeps successful closed-helper point construction free of repeated raw validation', () => {
  const rows = functions(SDF_SURFACE_LOCAL_RAY_WGSL);
  for (const name of [
    'sdfIntervalTryExactMagnitude',
    'sdfIntervalTryExactScale',
    'sdfIntervalTryExactSum',
  ]) {
    expect(rows.get(name)).not.toContain('sdfIntervalPoint(');
    expect(rows.get(name)).not.toContain('sdfIntervalRaw(');
  }
  const sum = rows.get('sdfIntervalTryExactSum') ?? '';
  expect(sum).toContain('if((a&0x7fffffffu)==0u){returnb;}');
  expect(sum).toContain('if((b&0x7fffffffu)==0u){returna;}');
});

it('detects a new unchecked caller, lost raw gate, or widened sign provenance', () => {
  const source = SDF_SURFACE_LOCAL_RAY_WGSL;
  expect(() =>
    prerequisites(`${source}\nfn unchecked(){let x=sdfIntervalTryExactSum(0u,1u);}`),
  ).toThrow();
  expect(() =>
    prerequisites(
      source.replace(
        'if(!sdfSurfaceBitsUsable(ab) || !sdfSurfaceBitsUsable(bb)){return sdfIntervalInvalid();}',
        '',
      ),
    ),
  ).toThrow();
  expect(() => prerequisites(source.replace('var sign=a&0x80000000u;', 'var sign=a;'))).toThrow();
});

it('returns exact private bits and decodes only after rejecting the integer failure tag', () => {
  const source = SDF_SURFACE_LOCAL_RAY_WGSL;
  for (const name of [
    'sdfIntervalTryExactMagnitude',
    'sdfIntervalTryExactSum',
    'sdfIntervalTryExactScale',
  ]) {
    expect(source).toMatch(new RegExp(`fn ${name}\\([^)]*\\) -> u32`));
    const body = functions(source).get(name) ?? '';
    expect(body).not.toContain('SdfRealInterval(');
    expect(body).not.toContain('bitcast<f32>');
    expect(body).not.toContain('sdfIntervalInvalid(');
    expect(body).not.toContain('sign|0x7f800000u');
  }
  for (const name of [
    'sdfIntervalSumEndpoint',
    'sdfIntervalProductEndpoint',
    'sdfIntervalQuotientEndpoint',
  ]) {
    expect(functions(source).get(name)).toContain(
      'if(exact!=0x7f800000u){letvalue=bitcast<f32>(exact);returnSdfRealInterval(value,value,1u);}',
    );
  }
});

it('keeps every normal bit pattern and both signed zeros disjoint from the failure tag', () => {
  const failure = 0x7f800000;
  for (const sign of [0, 0x80000000]) {
    expect(sign).not.toBe(failure);
    for (let exponent = 1; exponent < 255; exponent++) {
      const lo = (sign | (exponent << 23)) >>> 0;
      const hi = (lo | 0x7fffff) >>> 0;
      expect(failure < lo || failure > hi).toBe(true);
    }
  }
  expect(0).not.toBe(failure);
  expect(0x80000000).not.toBe(failure);
  expect((failure | 0x80000000) >>> 0).not.toBe(failure);
});

function widePrerequisites(source: string) {
  const rows = functions(source);
  const body = rows.get('sdfIntervalTryExactSum') ?? '';
  expect(callers(rows, 'countTrailingZeros')).toEqual(['sdfIntervalTryExactSum']);
  expect(body.split('countTrailingZeros(')).toHaveLength(3);
  expect(body).toContain('varam=(a&0x7fffffu)|0x800000u;');
  expect(body).toContain('varbm=(b&0x7fffffu)|0x800000u;');
  expect(body).toContain('if(max(ae,be)-minimumExponent<=7u){');
  expect(body).toContain('am<<=ae-minimumExponent;bm<<=be-minimumExponent;');
  expect(body).toContain(
    'letaTrailing=countTrailingZeros(am);letbTrailing=countTrailingZeros(bm);',
  );
  const shiftGuard = 'if(aShift>=32u||bShift>=32u){return0x7f800000u;}';
  const capacityGuard =
    'if(am>(0xffffffffu>>aShift)||bm>(0xffffffffu>>bShift)){return0x7f800000u;}';
  expect(body).toContain(`${shiftGuard}${capacityGuard}am<<=aShift;bm<<=bShift;`);
  expect(body).toContain('if(((a^b)&0x80000000u)==0u&&am>0xffffffffu-bm){return0x7f800000u;}');
  expect(body).not.toMatch(/\b(?:for|while|loop)\b/);
  expect(body).toContain('returnsdfIntervalTryExactMagnitude(magnitude,minimumExponent,sign);');
}

it('keeps the narrow sum path and guards every normalized wide alignment before shifting', () => {
  widePrerequisites(SDF_SURFACE_LOCAL_RAY_WGSL);
});

it('rejects lost wide shift, capacity, overflow, or nonzero-significand prerequisites', () => {
  for (const guard of [
    'if(aShift>=32u || bShift>=32u){return 0x7f800000u;}',
    'if(am>(0xffffffffu>>aShift) || bm>(0xffffffffu>>bShift)){return 0x7f800000u;}',
    'if(((a^b)&0x80000000u)==0u && am>0xffffffffu-bm){return 0x7f800000u;}',
    'var am=(a&0x7fffffu)|0x800000u;',
  ])
    expect(() => widePrerequisites(SDF_SURFACE_LOCAL_RAY_WGSL.replace(guard, ''))).toThrow();
});
