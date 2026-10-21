import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const launchMethods = new Set(['launch', 'launchServer', 'launchPersistentContext']);
const sourceExtensions = /\.(?:cjs|js|mjs|ts|tsx)$/;
const forbiddenFlags = /--(?:no-sandbox|disable-setuid-sandbox|single-process)\b/;

function propertyName(property, source) {
  if (!property.name) return undefined;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
  return property.name.getText(source).replace(/^['"]|['"]$/g, '');
}

function isChromiumLaunch(node, source) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  if (!launchMethods.has(node.expression.name.text)) return false;
  return /(?:^|\.)(?:chromium|browserType)$/.test(node.expression.expression.getText(source));
}

function hasSandboxEnabled(options, source) {
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  const properties = options.properties;
  const index = properties.findIndex(property => propertyName(property, source) === 'chromiumSandbox');
  if (index < 0 || index !== properties.length - 1) return false;
  const sandbox = properties[index];
  return ts.isPropertyAssignment(sandbox) && sandbox.initializer.kind === ts.SyntaxKind.TrueKeyword;
}

test('tracked View Chromium launches keep sandboxing enabled', () => {
  const deleted = new Set(execFileSync('git', ['ls-files', '--deleted', '-z'], { encoding: 'utf8' }).split('\0'));
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(path => sourceExtensions.test(path) && !deleted.has(path));
  const violations = [];

  for (const path of files) {
    const sourceText = readFileSync(path, 'utf8');
    if (path !== 'test/chromium-sandbox-contract.test.mjs' && forbiddenFlags.test(sourceText)) {
      violations.push(`${path}: sandbox-disabling flag`);
    }
    const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (isChromiumLaunch(node, source)) {
        const optionIndex = node.expression.name.text === 'launchPersistentContext' ? 1 : 0;
        if (!hasSandboxEnabled(node.arguments[optionIndex], source)) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          violations.push(`${path}:${line + 1}: missing chromiumSandbox: true`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  const config = JSON.parse(readFileSync('playwright-cli.config.json', 'utf8'));
  assert.equal(config.browser.launchOptions.chromiumSandbox, true);
  assert.deepEqual(violations, [], violations.join('\n'));
});
