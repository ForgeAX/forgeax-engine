import ts from 'typescript';
import {
  type PackAuthoringDeclaration,
  packSourceFailure,
  readPackAuthoringDeclaration,
} from './pack-authoring-literals.js';

// These entry points contain pure authoring vocabulary/factories, with no filesystem or module loader.
const imports = new Set([
  '@forgeax/engine/types',
  '@forgeax/engine/math',
  '@forgeax/engine/geometry',
  '@forgeax/engine/pack/source',
  '@forgeax/engine-types',
  '@forgeax/engine-math',
  '@forgeax/engine-geometry',
  '@forgeax/engine-pack/source',
  '@forgeax/engine/pack/guid',
  '@forgeax/engine-pack/guid',
]);
const namedImports: Readonly<Record<string, ReadonlySet<string>>> = {
  render: new Set([
    'Materials',
    'Camera',
    'CameraView',
    'DynamicResolution',
    'MeshFilter',
    'MeshRenderer',
    'DirectionalLight',
    'PointLight',
    'SpotLight',
    'perspective',
    'orthographic',
    'ANTIALIAS_FXAA',
    'ANTIALIAS_TAA',
    'SKYBOX_MODE_CUBEMAP',
    'SkyboxBackground',
    'Skylight',
    'TONEMAP_ACES_FILMIC',
  ]),
  scene: new Set(['Name', 'Transform', 'ChildOf', 'Children', 'Mobility']),
  physics: new Set([
    'CharacterController',
    'Collider',
    'ColliderShapeValue',
    'RigidBody',
    'RigidBodyTypeValue',
  ]),
  skinning: new Set(['Skin']),
};
const ambient = new Set([
  'process',
  'global',
  'globalThis',
  'window',
  'self',
  'document',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'Worker',
  'require',
  'eval',
  'Function',
  '__filename',
  '__dirname',
  'module',
  'Bun',
  'Deno',
  'Reflect',
  'Proxy',
]);
const reflection = new Set([
  'constructor',
  '__proto__',
  'prototype',
  'getPrototypeOf',
  'setPrototypeOf',
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
]);
const indexGuard = '__forgeaxGenerationIndex';

/** Opt-in source closure contract; old Packs retain their existing executable module surface. */
export function projectPackGenerationModules(
  entry: string,
  sources: Readonly<Record<string, string>>,
  declaration: PackAuthoringDeclaration,
): Readonly<Record<string, string>> {
  const projected: Record<string, string> = {};
  for (const [path, source] of Object.entries(sources)) {
    const parsed = readPackAuthoringDeclaration(path, source);
    const metadata = path === entry ? declaration : parsed.ok ? parsed.value : undefined;
    const executable = metadata?.generationSource ?? source;
    const file = ts.createSourceFile(path, executable, ts.ScriptTarget.Latest, true);
    const reject = (reason: string): never => {
      throw packSourceFailure(path, `live generation isolation: ${reason}`);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier;
        if (specifier && ts.isStringLiteral(specifier)) {
          const packageName = /^@forgeax\/engine(?:\/|-)([^/]+)$/.exec(specifier.text)?.[1];
          const allowed = packageName ? namedImports[packageName] : undefined;
          if (allowed) {
            const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
            const bindings = clause?.namedBindings;
            if (
              !bindings ||
              !ts.isNamedImports(bindings) ||
              clause?.name ||
              bindings.elements.some(
                (item) => !allowed.has(item.propertyName?.text ?? item.name.text),
              )
            )
              reject(`use supported named factories or schemas from ${specifier.text}`);
          } else if (
            specifier.text.includes('?') ||
            (!specifier.text.startsWith('.') && !imports.has(specifier.text))
          )
            reject(`import ${specifier.text} is not a pure generation dependency`);
        }
      }
      if (ts.isImportEqualsDeclaration(node) || ts.isMetaProperty(node))
        reject('module self-reading is unavailable');
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
        reject('declare dependencies with static imports or readByGuid');
      if (ts.isIdentifier(node) && ambient.has(node.text))
        reject(`ambient ${node.text} is unavailable`);
      if (ts.isIdentifier(node) && (reflection.has(node.text) || node.text === indexGuard))
        reject('reflection and reserved generation helpers are unavailable');
      if (ts.isStringLiteral(node) && reflection.has(node.text))
        reject('dynamic code construction is unavailable');
      ts.forEachChild(node, visit);
    };
    visit(file);
    // Dynamic indexing remains useful for generated arrays. A runtime number
    // guard closes computed-property escapes without attempting JS type inference.
    // Named object fields use explicit static keys in the opt-in generation surface.
    let guarded = false;
    const transformed = ts.transform(file, [
      (context) => (root) => {
        const rewrite: ts.Visitor = (node) => {
          const child = ts.visitEachChild(node, rewrite, context);
          if (
            !ts.isElementAccessExpression(child) ||
            ts.isStringLiteral(child.argumentExpression) ||
            ts.isNumericLiteral(child.argumentExpression)
          )
            return child;
          guarded = true;
          return context.factory.updateElementAccessExpression(
            child,
            child.expression,
            context.factory.createCallExpression(
              context.factory.createIdentifier(indexGuard),
              undefined,
              [child.argumentExpression],
            ),
          );
        };
        return ts.visitNode(root, rewrite) as ts.SourceFile;
      },
    ]);
    try {
      const transformedFile = transformed.transformed[0];
      if (!transformedFile) throw new TypeError('Missing generation source projection');
      projected[path] = guarded
        ? `function ${indexGuard}(value) { if (typeof value !== 'number') throw new TypeError('Live Pack generation permits numeric dynamic indices only; use static keys for objects'); return value; }\n${ts.createPrinter().printFile(transformedFile)}`
        : executable;
    } finally {
      transformed.dispose();
    }
  }
  return projected;
}
