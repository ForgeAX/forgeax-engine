import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { readRoster, resolveRunnableEntries } from '../run-dawn-smoke-roster.mjs';

const require = createRequire(import.meta.url);
const typescript = require('typescript');
const root = resolve(import.meta.dirname, '..', '..', '..');
const legacyTextureFields = new Set(['width', 'height', 'mipmap']);

function propertyName(property) {
  if (!typescript.isPropertyAssignment(property)) return null;
  if (typescript.isIdentifier(property.name) || typescript.isStringLiteral(property.name)) {
    return property.name.text;
  }
  return null;
}

function textureObject(node) {
  if (!typescript.isObjectLiteralExpression(node)) return false;
  const kind = node.properties.find((property) => propertyName(property) === 'kind');
  return (
    kind &&
    typescript.isPropertyAssignment(kind) &&
    typescript.isStringLiteral(kind.initializer) &&
    kind.initializer.text === 'texture'
  );
}

function directProperties(node) {
  return new Map(
    node.properties
      .map((property) => [propertyName(property), property])
      .filter(([name]) => name !== null),
  );
}

function directStringProperty(node, name) {
  const property = directProperties(node).get(name);
  return property && typescript.isStringLiteral(property.initializer)
    ? property.initializer.text
    : null;
}

function smokeDawnScripts() {
  const roster = readRoster();
  const resolved = resolveRunnableEntries({ repoRoot: root, roster });
  const rosterByPath = new Map(roster.entries.map((entry) => [entry.path, entry]));
  return resolved.runnable
    .filter((entry) => {
      const rosterEntry = rosterByPath.get(entry.path);
      return rosterEntry?.gates.some(
        (gate) => gate.gateId === entry.gateId && gate.oracle === 'frameReceipt',
      );
    })
    .map((entry) => {
      const packagePath = resolve(root, entry.path);
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
      return {
        entry,
        packagePath,
        smokeScript: packageJson.scripts?.smoke,
      };
    })
    .filter(({ smokeScript }) => smokeScript === 'node scripts/smoke-dawn.mjs')
    .map(({ entry, packagePath, smokeScript }) => {
      assert.equal(
        smokeScript,
        'node scripts/smoke-dawn.mjs',
        `${entry.path} must expose its direct-Dawn fixture through the package smoke script`,
      );
      return resolve(dirname(packagePath), smokeScript.slice('node '.length));
    });
}

test('roster-owned direct-Dawn TextureAsset fixtures use the canonical shape and mips fields', () => {
  const scripts = smokeDawnScripts();
  assert.ok(scripts.length > 0, 'roster must resolve direct-Dawn frameReceipt fixtures');

  for (const scriptPath of scripts) {
    const source = readFileSync(scriptPath, 'utf8');
    const sourceFile = typescript.createSourceFile(
      scriptPath,
      source,
      typescript.ScriptTarget.Latest,
      true,
      typescript.ScriptKind.JS,
    );
    function visit(node) {
      if (textureObject(node)) {
        const properties = directProperties(node);
        for (const field of legacyTextureFields) {
          assert.equal(
            properties.has(field),
            false,
            `${scriptPath}:${sourceFile.getLineAndCharacterOfPosition(node.pos).line + 1} uses legacy TextureAsset field ${field}`,
          );
        }
        assert.ok(
          properties.has('shape'),
          `${scriptPath}:${sourceFile.getLineAndCharacterOfPosition(node.pos).line + 1} is missing TextureAsset.shape`,
        );
        assert.ok(
          properties.has('mips'),
          `${scriptPath}:${sourceFile.getLineAndCharacterOfPosition(node.pos).line + 1} is missing TextureAsset.mips`,
        );
        const mips = properties.get('mips');
        if (
          typescript.isPropertyAssignment(mips) &&
          typescript.isObjectLiteralExpression(mips.initializer) &&
          directStringProperty(mips.initializer, 'kind') === 'packed'
        ) {
          assert.ok(
            directProperties(mips.initializer).has('levelCount'),
            `${scriptPath}:${sourceFile.getLineAndCharacterOfPosition(mips.pos).line + 1} packed mips must declare levelCount`,
          );
        }
      }
      typescript.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
});
