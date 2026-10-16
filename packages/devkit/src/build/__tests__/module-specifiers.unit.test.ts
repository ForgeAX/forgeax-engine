import { expect, it } from 'vitest';
import { rewriteModuleSpecifiers } from '../module-specifiers.js';

it('relocates real ESM edges while preserving strings, comments, regex and import.meta', () => {
  const source = [
    'import x from "./x.js" with { type: "json" };',
    'export { x } from "./reexport.js";',
    'export * from "./star.js";',
    'const data = "import(\'fake\')";',
    '// import "./comment.js";',
    'const pattern = /import("fake")/;',
    'const asset = new URL("./asset.png", import.meta.url);',
    'const load = () => import("./dynamic.js", { with: { type: "json" } });',
  ].join('\n');
  const edges: [string, string][] = [];
  const output = rewriteModuleSpecifiers(source, 'delivery.mjs', (specifier, kind) => {
    edges.push([specifier, kind]);
    return specifier.replace('./', '/published/');
  });
  expect(edges).toEqual([
    ['./x.js', 'static'],
    ['./reexport.js', 'static'],
    ['./star.js', 'static'],
    ['./dynamic.js', 'dynamic'],
  ]);
  expect(output).toBe(
    source
      .replaceAll('"./x.js"', '"/published/x.js"')
      .replaceAll('"./reexport.js"', '"/published/reexport.js"')
      .replaceAll('"./star.js"', '"/published/star.js"')
      .replaceAll('"./dynamic.js"', '"/published/dynamic.js"'),
  );
});

it('decodes escaped specifiers and no-substitution templates without evaluating expressions', () => {
  const source =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: unevaluated input source
    "import './\\u0061.js'; const a = import(`./b\\u002ejs`); const b = import(`./${name}.js`);";
  const seen: string[] = [];
  const output = rewriteModuleSpecifiers(source, 'delivery.mjs', (specifier) => {
    seen.push(specifier);
    return `/published/${specifier.slice(2)}`;
  });
  expect(seen).toEqual(['./a.js', './b.js']);
  expect(output).toBe(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: unevaluated expected source
    'import "/published/a.js"; const a = import("/published/b.js"); const b = import(`./${name}.js`);',
  );
});

it('preserves untouched edges byte for byte and finds imports nested in expressions', () => {
  const source = "import './stable.js'; const p = import(select(import('./inner.js')));";
  const seen: string[] = [];
  const output = rewriteModuleSpecifiers(source, 'delivery.mjs', (specifier) => {
    seen.push(specifier);
    return specifier === './inner.js' ? './next.js' : undefined;
  });
  expect(seen).toEqual(['./stable.js', './inner.js']);
  expect(output).toBe('import \'./stable.js\'; const p = import(select(import("./next.js")));');
});

it('does not discover module edges inside a large generated shader payload', () => {
  const payload = 'import("not-an-edge"); export * from "neither";\n'.repeat(100_000);
  const source = `export const shader = ${JSON.stringify(payload)};\nimport './owner.js';`;
  const seen: string[] = [];
  const output = rewriteModuleSpecifiers(source, 'shaders.mjs', (specifier) => {
    seen.push(specifier);
    return '/owner.js';
  });
  expect(seen).toEqual(['./owner.js']);
  expect(output).toBe(`export const shader = ${JSON.stringify(payload)};\nimport "/owner.js";`);
});
