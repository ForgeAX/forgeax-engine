import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const sourceExtensions = /\.(?:cjs|js|mjs|ts|tsx|yml|yaml)$/;
const sandboxDisablingArgument = /--(?:no-sandbox|disable-setuid-sandbox|single-process)\b/;
const inertArgumentFixtures = new Set([
  'scripts/ci/__tests__/chromium-sandbox-contract.test.mjs',
  'scripts/ci/__tests__/run-with-runner-cpu-affinity.test.mjs',
]);
const launchMethods = new Set(['launch', 'launchServer', 'launchPersistentContext']);

function propertyName(property, source) {
  if (!property.name) return undefined;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    return property.name.text;
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
  const index = properties.findIndex(
    (property) => propertyName(property, source) === 'chromiumSandbox',
  );
  if (index < 0 || index !== properties.length - 1) return false;
  const sandbox = properties[index];
  return ts.isPropertyAssignment(sandbox) && sandbox.initializer.kind === ts.SyntaxKind.TrueKeyword;
}

test('tracked execution sources keep Chromium sandboxing enabled', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((path) => sourceExtensions.test(path));
  const unsafeArguments = files.filter(
    (path) =>
      !inertArgumentFixtures.has(path) && sandboxDisablingArgument.test(readFileSync(path, 'utf8')),
  );
  const launchViolations = [];
  for (const path of files) {
    const sourceText = readFileSync(path, 'utf8');
    const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (isChromiumLaunch(node, source)) {
        const optionIndex = node.expression.name.text === 'launchPersistentContext' ? 1 : 0;
        if (!hasSandboxEnabled(node.arguments[optionIndex], source)) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          launchViolations.push(`${path}:${line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  assert.deepEqual(
    unsafeArguments,
    [],
    `Remove sandbox-disabling Chromium flags from executable sources:\n${unsafeArguments.join('\n')}`,
  );
  assert.deepEqual(
    launchViolations,
    [],
    `Every Playwright Chromium launch must set chromiumSandbox: true:\n${launchViolations.join('\n')}`,
  );
});

test('shared Playwright browser configs enable Chromium sandboxing', () => {
  const browserLaunch = JSON.parse(readFileSync('scripts/ci/browser-launch.json', 'utf8'));
  const cliConfig = JSON.parse(readFileSync('playwright-cli.config.json', 'utf8'));
  assert.equal(browserLaunch.chromiumSandbox, true);
  assert.equal(cliConfig.browser.launchOptions.chromiumSandbox, true);
  assert.match(readFileSync('vitest.config.ts', 'utf8'), /chromiumSandbox:\s*true/);
});
