import { expect, it, vi } from 'vitest';
import { err, ok, ShaderError } from '../errors.js';
import {
  admitShaderProgramTemplate,
  publishShaderProgramTemplates,
  readShaderProgramTemplates,
  type ShaderProgramCompiler,
  type ShaderProgramTemplate,
} from '../program-template.js';
import { ShaderRegistry } from '../ShaderRegistry.js';

const profile = {
  id: 'test-template',
  language: 'wgsl',
  profileVersion: '1',
  adapterVersion: '1',
  compilerVersion: '1',
  nagaVersion: '1',
} as const;
function template(): ShaderProgramTemplate {
  return {
    schemaVersion: 'shader-program-template/1',
    compilerProfile: profile,
    source: '#if TINT == true\nconst tint = 1u;\n#else\nconst tint = 2u;\n#endif',
    imports: {},
    axes: ['TINT'],
  };
}
function setup() {
  const compile = vi.fn<ShaderProgramCompiler['compile']>((_template, defines) =>
    ok({
      manifestEntry: {
        hash: `${defines.TINT}`,
        wgsl: `@compute @workgroup_size(1) fn main() { let tint = ${defines.TINT ? 1 : 2}u; }`,
        glsl: '',
        bindings: '[]',
      },
      uvSetCount: 0,
    }),
  );
  const registry = new ShaderRegistry({
    manifestUrl: undefined,
    programCompiler: { profile, compile },
  });
  return { registry, compile };
}

it('stores only source at admission and reuses exactly selected programs across aliases and devices', () => {
  const { registry, compile } = setup();
  registry.installProgramTemplate('root', template()).unwrap();
  registry.installProgramTemplate('alias', template()).unwrap();
  expect(compile).not.toHaveBeenCalled();
  expect(registry.sourceInspection().sources).toBe(0);
  const red = registry.resolveProgramTemplate('root', { TINT: true }).unwrap();
  expect(registry.resolveProgramTemplate('alias', { TINT: true }).unwrap()).toBe(red);
  const child = registry.forkForDevice({ createShaderModule: vi.fn() });
  expect(child.resolveProgramTemplate('root', { TINT: true }).unwrap()).toBe(red);
  const green = child.resolveProgramTemplate('root', { TINT: false }).unwrap();
  expect(registry.resolveProgramTemplate('root', { TINT: false }).unwrap()).toBe(green);
  expect(green.program.source).not.toBe(red.program.source);
  expect(compile).toHaveBeenCalledTimes(2);
  expect(registry.programTemplateInspection()).not.toHaveProperty('programs');
  const detailed = registry.programTemplateInspection({ includePrograms: true });
  expect(detailed.programs).toEqual([
    { identifier: 'alias', definesKey: 'TINT=true' },
    { identifier: 'alias', definesKey: 'TINT=false' },
  ]);
  expect(compile).toHaveBeenCalledTimes(2);

  expect(Object.isFrozen(red.manifestEntry)).toBe(true);
  expect(registry.programTemplateInspection()).toMatchObject({
    templates: 2,
    selections: 2,
    requests: 3,
    cacheHits: 2,
  });
});

it('rejects incomplete, extra, illegal and mismatched selections before invoking the compiler', () => {
  const { registry, compile } = setup();
  registry.installProgramTemplate('root', template()).unwrap();
  for (const selection of [{}, { TINT: true, EXTRA: false }]) {
    expect(registry.resolveProgramTemplate('root', selection).ok).toBe(false);
  }
  const illegal = { ...template(), axes: ['STORAGE_BUFFER_AVAILABLE', 'ATMOSPHERE_AVAILABLE'] };
  registry.installProgramTemplate('illegal', illegal).unwrap();
  expect(
    registry.resolveProgramTemplate('illegal', {
      STORAGE_BUFFER_AVAILABLE: false,
      ATMOSPHERE_AVAILABLE: true,
    }).ok,
  ).toBe(false);
  const mismatch = { ...template(), compilerProfile: { ...profile, compilerVersion: '2' } };
  registry.installProgramTemplate('mismatch', mismatch).unwrap();
  expect(registry.resolveProgramTemplate('mismatch', { TINT: true }).ok).toBe(false);
  expect(compile).not.toHaveBeenCalled();
});

it('snapshots immutable semantic inputs, rejects executable properties and preserves conflicting identities', () => {
  const input = template();
  const { registry } = setup();
  registry.installProgramTemplate('root', input).unwrap();
  (input as { source: string }).source = 'corrupted';
  const result = registry.resolveProgramTemplate('root', { TINT: true }).unwrap();
  expect(result.program.source).toContain('1u');
  expect(registry.installProgramTemplate('root', input).ok).toBe(false);
  let reads = 0;
  const executable = {
    ...template(),
    get source() {
      reads++;
      return 'body';
    },
  };
  expect(admitShaderProgramTemplate(executable).ok).toBe(false);
  expect(reads).toBe(0);
  expect(admitShaderProgramTemplate({ ...template(), axes: new Array(1) }).ok).toBe(false);
  expect(admitShaderProgramTemplate({ ...template(), axes: [undefined] }).ok).toBe(false);

  const a = template();
  const b = {
    axes: a.axes,
    imports: a.imports,
    source: a.source,
    compilerProfile: a.compilerProfile,
    schemaVersion: a.schemaVersion,
  };
  expect(admitShaderProgramTemplate(a).unwrap().identity).toBe(
    admitShaderProgramTemplate(b).unwrap().identity,
  );
});

it('preserves structured compiler failures without publishing a failed program or poisoning other selections', () => {
  const failure = new ShaderError({
    code: 'shader-compile-failed',
    expected: 'valid template',
    hint: 'repair source',
    message: 'invalid true branch',
  });
  const compile = vi.fn<ShaderProgramCompiler['compile']>((_template, defines) =>
    defines.TINT
      ? err(failure)
      : ok({
          manifestEntry: {
            hash: 'valid',
            wgsl: '@compute @workgroup_size(1) fn main() {}',
            glsl: '',
            bindings: '[]',
          },
          uvSetCount: 0,
        }),
  );
  const registry = new ShaderRegistry({
    manifestUrl: undefined,
    programCompiler: { profile, compile },
  });
  registry.installProgramTemplate('root', template()).unwrap();
  const result = registry.resolveProgramTemplate('root', { TINT: true });
  if (result.ok) throw new Error('Expected native preparation failure');
  expect(result.error).toBe(failure);
  expect(registry.programTemplateInspection().selections).toBe(0);
  expect(registry.sourceInspection().sources).toBe(0);
  expect(registry.resolveProgramTemplate('root', { TINT: false }).ok).toBe(true);
});

it('round-trips a compact source library, shares module references and rejects tampered or partial publications atomically', () => {
  const first = {
    ...template(),
    imports: { 'test::shared': '#define_import_path test::shared\nfn shared() {}' },
  };
  const second = { ...first, source: `${first.source}\n// second root` };
  const library = publishShaderProgramTemplates(
    new Map([
      ['first', first],
      ['second', second],
    ]),
  ).unwrap();
  expect(Object.keys(library.sources)).toHaveLength(3);
  expect(library.programs.first?.imports['test::shared']).toBe(
    library.programs.second?.imports['test::shared'],
  );
  const wire = JSON.parse(JSON.stringify(library));
  const admitted = readShaderProgramTemplates(wire).unwrap();
  const firstProgram = admitted.get('first');
  const secondProgram = admitted.get('second');
  expect(firstProgram?.identity).toBe(admitShaderProgramTemplate(first).unwrap().identity);
  expect(firstProgram?.template.compilerProfile).toBe(secondProgram?.template.compilerProfile);
  expect(Object.isFrozen(firstProgram?.template.compilerProfile)).toBe(true);
  wire.compilerProfile.compilerVersion = 'other-version';
  expect(firstProgram?.template.compilerProfile.compilerVersion).toBe('1');
  wire.compilerProfile.compilerVersion = '1';
  const { registry, compile } = setup();
  registry.installProgramTemplates(wire).unwrap();
  expect(registry.programTemplateInspection()).toMatchObject({ templates: 2, selections: 0 });
  expect(compile).not.toHaveBeenCalled();
  const tampered = JSON.parse(JSON.stringify(library));
  const firstKey = Object.keys(tampered.sources)[0];
  if (firstKey === undefined) throw new Error('Expected source library entries');
  tampered.sources[firstKey] += 'corruption';
  expect(registry.installProgramTemplates(tampered).ok).toBe(false);
  const partial = JSON.parse(JSON.stringify(library));
  partial.programs.third = { ...partial.programs.first, source: 'missing' };
  expect(registry.installProgramTemplates(partial).ok).toBe(false);
  expect(registry.programTemplateInspection().templates).toBe(2);
});
