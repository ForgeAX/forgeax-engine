import { createRequire } from 'node:module';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const upstreamRoot = resolve(dirname(require.resolve('three/src/Three.js')), '..');
const upstreamTypes = resolve(dirname(require.resolve('@types/three/package.json')), 'src/Three.WebGPU.d.ts');
const facadeTypes = resolve(root, 'src/index.ts');
const config = ts.readConfigFile(resolve(root, 'tsconfig.test.json'), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
const program = ts.createProgram([upstreamTypes, facadeTypes], { ...options, noEmit: true });
const checker = program.getTypeChecker();
const unwrap = symbol => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
function exportsOf(path) {
  const source = program.getSourceFile(path);
  if (source === undefined) throw new Error(`Missing declaration source ${path}`);
  return new Map(checker.getExportsOfModule(checker.getSymbolAtLocation(source)).map(symbol => [symbol.name, unwrap(symbol)]));
}
function publicMembers(type) {
  return new Map(type.getProperties().filter(symbol => !(symbol.declarations ?? []).some(declaration =>
    ts.canHaveModifiers(declaration) && ts.getModifiers(declaration)?.some(modifier =>
      modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword,
    ),
  )).map(symbol => [symbol.name, symbol]));
}
function valueType(symbol) {
  const location = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return checker.getTypeOfSymbolAtLocation(symbol, location);
}
function acceptsCalls(candidate, source) {
  // TypeScript intentionally permits bivariant method assignment. A method
  // accepting only Scene can therefore appear assignable to render(Object3D),
  // although an unchanged caller cannot pass Group. Check admitted arguments
  // in the caller-to-callee direction for every upstream overload as well.
  const rest = signature => signature.parameters.at(-1)?.declarations?.some(
    declaration => ts.isParameter(declaration) && declaration.dotDotDotToken !== undefined,
  ) ?? false;
  return source.getCallSignatures().every(expected => candidate.getCallSignatures().some(actual => {
    if (actual.minArgumentCount > expected.minArgumentCount) return false;
    if (rest(expected) && !rest(actual)) return false;
    return expected.parameters.every((parameter, index) => {
      const accepted = actual.parameters[index] ?? (rest(actual) ? actual.parameters.at(-1) : undefined);
      if (accepted === undefined) return false;
      let requiredType = valueType(parameter), acceptedType = valueType(accepted);
      const expectedRest = rest(expected) && index === expected.parameters.length - 1;
      const actualRest = rest(actual) && index >= actual.parameters.length - 1;
      if (expectedRest) requiredType = checker.getIndexTypeOfType(requiredType, ts.IndexKind.Number) ?? requiredType;
      if (actualRest) acceptedType = checker.getIndexTypeOfType(acceptedType, ts.IndexKind.Number) ?? acceptedType;
      const acceptsUndefined = accepted.declarations?.some(declaration =>
        ts.isParameter(declaration) && (declaration.questionToken !== undefined || declaration.initializer !== undefined),
      );
      // The symbol type of a defaulted parameter excludes undefined even
      // though an explicit undefined argument invokes that default.
      return (requiredType.isUnion() ? requiredType.types : [requiredType]).every(type =>
        (acceptsUndefined && (type.flags & ts.TypeFlags.Undefined)) || checker.isTypeAssignableTo(type, acceptedType),
      );
    });
  }));
}
const expected = exportsOf(upstreamTypes);
const actual = exportsOf(facadeTypes);
const mismatches = [];
for (const [name, source] of expected) {
  const target = actual.get(name);
  if (target === undefined) { mismatches.push({ name, reason: 'missing-export' }); continue; }
  if (source === target) continue;
  const isClass = Boolean(source.flags & ts.SymbolFlags.Class);
  const isType = isClass || Boolean(source.flags & ts.SymbolFlags.Type && !(source.flags & ts.SymbolFlags.Value));
  const type = isType ? checker.getDeclaredTypeOfSymbol(source) : valueType(source);
  const projected = isType ? checker.getDeclaredTypeOfSymbol(target) : valueType(target);
  const sourceMembers = publicMembers(type), targetMembers = publicMembers(projected);
  const missing = [], incompatible = [];
  for (const [member, symbol] of sourceMembers) {
    const candidate = targetMembers.get(member);
    if (candidate === undefined) missing.push(member);
    else if (!checker.isTypeAssignableTo(valueType(candidate), valueType(symbol)) ||
      !acceptsCalls(valueType(candidate), valueType(symbol))) incompatible.push(member);
  }
  if (!checker.isTypeAssignableTo(projected, type) || missing.length || incompatible.length)
    mismatches.push({ name, reason: 'incompatible-type', missingMembers: missing, incompatibleMembers: incompatible });
  if (isClass && !checker.isTypeAssignableTo(valueType(target), valueType(source)))
    mismatches.push({ name, reason: 'incompatible-constructor-or-static-members' });
}
const upstream = await import('three/src/Three.WebGPU.js');
const facade = await import('../dist/index.mjs');
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const addonPaths = (await readdir(resolve(upstreamRoot, 'examples/jsm'), { recursive: true }))
  .filter(path => path.endsWith('.js')).map(path => `./addons/${path.replaceAll('\\', '/')}`).sort();
const report = {
  revision: upstream.REVISION,
  scope: {
    renderer: 'Three r184 WebGPURenderer / WebGPU',
    excludedWebGL: Object.keys(upstream).filter(name => /^(WebGL|GLSLNodeBuilder)/.test(name)),
    deferredAddons: true,
    removedUpstreamRendererMembers: ['waitForGPU'],
    note: 'Keep the raw inventory complete. Excluded WebGL, deferred addons and removed upstream APIs do not establish native rendering work.',
  },
  runtimeExports: { expected: Object.keys(upstream).length, missing: Object.keys(upstream).filter(name => !(name in facade)) },
  declarationExports: { expected: expected.size, mismatches },
  addonModules: { expected: addonPaths.length, missing: addonPaths.filter(path => manifest.exports[path] === undefined) },
  meaning: 'Interface presence, TypeScript assignability and upstream call argument admission only. Rendering, side effects, timing and lifecycle require independent behavioral tests.',
};
const outputIndex = process.argv.indexOf('--output');
const text = `${JSON.stringify(report, null, 2)}\n`;
if (outputIndex !== -1) await writeFile(resolve(process.argv[outputIndex + 1]), text);
else process.stdout.write(text);
if (process.argv.includes('--check') && (report.runtimeExports.missing.length || mismatches.length || report.addonModules.missing.length)) process.exitCode = 1;
