import { readFile, realpath, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export async function bundlePhoneDiagnostic(probe, engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')) {
  if (!['gl-link', 'startup'].includes(probe)) throw new Error('Unknown phone diagnostic: ' + probe);
  const filename = probe === 'startup' ? 'phone_startup_report_prefix.js' : 'phone_gl_link_prefix.js';
  const { build } = createRequire(await realpath(join(engineRoot, 'node_modules/tsup/dist/index.js')))('esbuild');
  const hostRequire = createRequire(join(engineRoot, 'packages/platform-wechat/package.json'));
  const result = await build({
    stdin: { contents: await readFile(new URL(filename, import.meta.url), 'utf8'),
      sourcefile: filename, resolveDir: dirname(fileURLToPath(import.meta.url)) },
    alias: {
      '@noble/hashes/sha2.js': hostRequire.resolve('@noble/hashes/sha2.js'),
      '@exodus/bytes/utf8.js': join(dirname(hostRequire.resolve('@exodus/bytes/utf8.js')), 'utf8.js'),
    },
    // Browser shortcuts assume TextEncoder already exists; this runs before bootstrap.
    bundle: true, write: false, format: 'iife', platform: 'neutral', target: 'chrome70',
  });
  return result.outputFiles[0].text;
}

export async function bundlePhoneGlLink(engineRoot) { return bundlePhoneDiagnostic('gl-link', engineRoot); }

// Static publication evidence only; it cannot establish native module admission.
export async function inspectNativeModuleClosure(source, engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')) {
  const root = await realpath(source);
  const ts = createRequire(join(engineRoot, 'package.json'))('typescript');
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Publication module closure refuses symlinks');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk(root);
  const known = new Set(files), references = [], unresolved = [], deferred = [], dynamic = [];
  let dynamicCount = 0;
  for (const file of files.filter(path => /\.[cm]?js$/.test(path)).sort()) {
    const ast = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function visit(node) {
      let argument, lazy = false;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        argument = node.arguments[0];
        lazy = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        if (!argument || !ts.isStringLiteralLike(argument)) {
          dynamicCount++;
          if (dynamic.length < 32) dynamic.push({ from: relative(root, file), offset: node.pos });
        }
      } else if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) argument = node.moduleSpecifier;
      if (argument && ts.isStringLiteralLike(argument)) {
        const request = argument.text;
        const target = resolve(dirname(file), request);
        const path = relative(root, target);
        const inside = path !== '..' && !path.startsWith('..' + sep) && target !== root;
        const resolved = request.startsWith('.') && inside
          ? [target, target + '.js', join(target, 'index.js')].find(path => known.has(path)) : undefined;
        const row = { from: relative(root, file), request, ...(resolved ? { target: relative(root, resolved) } : {}) };
        references.push(row);
        if (lazy) deferred.push({ ...row, resolved: resolved !== undefined });
        else if (!resolved) unresolved.push(row);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return { qualification: 'static-files-only', jsFiles: files.filter(path => /\.[cm]?js$/.test(path)).length,
    references, unresolved, deferred, dynamic: { count: dynamicCount, recent: dynamic },
    maxPathBytes: files.reduce((max, path) => Math.max(max, Buffer.byteLength(relative(root, path))), 0) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { 'engine-root': { type: 'string' }, source: { type: 'string' }, probe: { type: 'string', default: 'gl-link' } } });
  process.stdout.write(values.source ? JSON.stringify(await inspectNativeModuleClosure(values.source, values['engine-root']))
    : await bundlePhoneDiagnostic(values.probe, values['engine-root']));
}
