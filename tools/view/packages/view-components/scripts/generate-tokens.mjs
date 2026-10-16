import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(
  await readFile(resolve(root, 'src/tokens/forgeax.tokens.json'), 'utf8'),
);

const aliasNames = {
  foundation: 'fx-ref',
  semantic: 'fx',
  component: 'fx-component',
};

function aliasToVariable(alias) {
  const parts = alias.slice(1, -1).split('.');
  const namespace = aliasNames[parts.shift()];
  if (!namespace) throw new Error(`Unknown token alias: ${alias}`);
  if (namespace === 'fx' && parts[0] === 'shared') parts.shift();
  return `var(--${namespace}-${parts.map(kebab).join('-')})`;
}

function scalar(value, type) {
  if (typeof value === 'string') {
    return value.startsWith('{') && value.endsWith('}')
      ? aliasToVariable(value)
      : value;
  }
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    if (type === 'fontFamily') {
      return value
        .map((font) => (font.includes(' ') ? `"${font}"` : font))
        .join(', ');
    }
    return `cubic-bezier(${value.join(', ')})`;
  }
  if (value && typeof value === 'object' && 'value' in value && 'unit' in value) {
    return `${value.value}${value.unit}`;
  }
  throw new Error(`Unsupported scalar token value: ${JSON.stringify(value)}`);
}

function shadow(value) {
  return [
    scalar(value.offsetX),
    scalar(value.offsetY),
    scalar(value.blur),
    scalar(value.spread),
    scalar(value.color),
  ].join(' ');
}

function emitLeaf(lines, name, token) {
  if (token.$type === 'typography') {
    for (const [property, value] of Object.entries(token.$value)) {
      lines.push(`  --${name}-${kebab(property)}: ${scalar(value)};`);
    }
    return;
  }
  lines.push(`  --${name}: ${
    token.$type === 'shadow' ? shadow(token.$value) : scalar(token.$value, token.$type)
  };`);
}

function kebab(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function walk(lines, node, prefix) {
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('$')) continue;
    const name = `${prefix}-${kebab(key)}`;
    if (value && typeof value === 'object' && '$value' in value) {
      emitLeaf(lines, name, value);
    } else {
      walk(lines, value, name);
    }
  }
}

const foundation = [];
walk(foundation, source.foundation, 'fx-ref');

const shared = [];
walk(shared, source.semantic.shared, 'fx');
walk(shared, source.component, 'fx-component');

function themeBlock(name) {
  const lines = [];
  walk(lines, source.semantic[name], 'fx');
  return `${name === 'light' ? ':root, [data-theme=\"light\"]' : '[data-theme=\"dark\"]'} {\n  color-scheme: ${name};\n${lines.join('\n')}\n}`;
}

const output = `/* Generated from src/tokens/forgeax.tokens.json. Do not edit. */
:root {
${foundation.join('\n')}
${shared.join('\n')}
}

${themeBlock('light')}

${themeBlock('dark')}

@media (prefers-reduced-motion: reduce) {
  :root, [data-theme] {
    --fx-motion-feedback: 0ms;
    --fx-motion-hover: 0ms;
    --fx-motion-expand: 0ms;
    --fx-motion-panel: 0ms;
  }
}
`;

await writeFile(resolve(root, 'src/styles/tokens.css'), output, 'utf8');
