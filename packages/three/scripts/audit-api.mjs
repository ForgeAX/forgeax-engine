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
function acceptsCalls(candidate, source, construct = false) {
  // TypeScript intentionally permits bivariant method assignment. A method
  // accepting only Scene can therefore appear assignable to render(Object3D),
  // although an unchanged caller cannot pass Group. Check admitted arguments
  // in the caller-to-callee direction for every upstream overload as well.
  const rest = signature => signature.parameters.at(-1)?.declarations?.some(
    declaration => ts.isParameter(declaration) && declaration.dotDotDotToken !== undefined,
  ) ?? false;
  const signatures = type => construct ? type.getConstructSignatures() : type.getCallSignatures();
  return signatures(source).every(expected => signatures(candidate).some(actual => {
    // Generic methods need caller-specific instantiation (e.g. Object3D events
    // carrying polymorphic `this`). Ordinary assignability above checks those;
    // comparing two unrelated signature type variables rejects valid callers.
    if (expected.typeParameters?.length && actual.typeParameters?.length) return true;
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
  if (isClass && (!checker.isTypeAssignableTo(valueType(target), valueType(source)) ||
    !acceptsCalls(valueType(target), valueType(source), true)))
    mismatches.push({ name, reason: 'incompatible-constructor-or-static-members' });
}
const upstream = await import('three/src/Three.WebGPU.js');
const facade = await import('../dist/index.mjs');
// A type-only class export cannot satisfy a runtime constructor import.
for (const [name] of expected)
  if (name in upstream && actual.has(name) && !(name in facade))
    mismatches.push({ name, reason: 'missing-runtime-value' });
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const addonPaths = (await readdir(resolve(upstreamRoot, 'examples/jsm'), { recursive: true }))
  .filter(path => path.endsWith('.js')).map(path => `./addons/${path.replaceAll('\\', '/')}`).sort();
const report = {
  revision: upstream.REVISION,
  scope: {
    renderer: `Three r${upstream.REVISION} WebGPURenderer / WebGPU`,
    excludedWebGL: Object.keys(upstream).filter(name => /^(WebGL|GLSLNodeBuilder)/.test(name)),
    deferredAddons: true,
    removedUpstreamRendererMembers: [...publicMembers(checker.getDeclaredTypeOfSymbol(expected.get('WebGPURenderer'))).keys()].filter(name => name === 'waitForGPU' && /has been removed/.test(String(upstream.WebGPURenderer.prototype[name]))),
    upstreamDeclarationDrift: { init: 'r187 runtime resolves init() with the renderer on initial and repeated calls; the pinned declaration says Promise<void>. Preserve the runtime result and raw mismatch.', StructNode: 'r187 stores structTypeNode and accepts named values as well as arrays; the pinned declaration only admits arrays and omits the source layout reference.', FunctionOverloadingNode: 'r187 stores parametersNodes and function definitions; the pinned declaration calls the field parameterNodes and types definitions as Node arrays. Preserve actual CPU data and raw differences.', EventNode: 'r187 has nine event phases; @types EventNodeType admits only OBJECT and MATERIAL. Preserve actual phase values and raw differences.', MemberNode: 'r187 stores structNode, not the declared node field. Preserve the actual reference and raw differences.', SetNode: 'r187 uses string components; the prior array form is also readable by the implementation. Preserve both actual forms and their raw declaration differences.', NodeFrame: 'The facade adds the real updateAfterNode method; inherited historical bookkeeping declarations have not been exhaustively corrected.', RendererUtils: 'r187 combined state functions take renderer, scene and optional state; @types swaps the save renderer parameter for RendererState and omits the scene parameter on reset/restore. Keep actual calls and raw differences.', getMRT: 'r187 getMRT returns null for the default state; @types declares MRTNode only. The native facade retains null and rejects non-null MRT overrides.', NodeFunctionInput: 'r187 has type/name instance fields and a static isNodeFunctionInput flag; @types omits those fields and places the flag on instances. Preserve the raw differences.', StackTrace: 'r187 runtime calls split() on the input; the declared Error constructor overload fails. The facade admits string/null and includes the real formatting methods.', NodeLoaders: 'r187 instantiates registry constructors and NodeLoader loads one Node, while pinned declarations describe instances and NodeLoaderResult. The facade corrects registries, the load result and inherited fluent this types; raw differences remain visible.', ComputeNode: 'r187 stores mutable count/dispatchSize; setCount and getCount do not exist. The facade omits those declared-only methods.', StorageBufferNode: 'r187 has setAtomic, not setAtmoic, and no bufferObject field; the facade keeps original runtime identity and corrects storage element node references.', TSL: 'compute/computeKernel return the corrected ComputeNode; storage/storageElement preserve actual BufferAttribute inputs, fluent storage types and element references. Original function identities remain unchanged; four pinned declaration differences stay in the raw inventory.', NodeMaterialInstance: 'r187 copies own model data and getter-only node fields while retaining shader methods on nodeMaterial. The facade preserves original constructor/static identity and types copied data plus fluent results; Physical prototype accessors are not copied, and native Physical instances remain rejected.', Sprite: 'The original Sprite constructor accepts a supported Sprite NodeMaterialInstance; the facade adds this call overload without a runtime wrapper. Raw generic fluent-this differences remain visible; strict consumer calls qualify the source methods separately.', ShadowNode: 'r187 shadow constructors default their second argument and expose shadow/shadowMap/depthLayer CPU references. The facade retains original constructors and corrects these declarations without native shadow-node execution.', onError: 'r187 runtime passes { api, type, message, originalEvent }; @types/three declares string. Keep the raw signature mismatch.' },
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
