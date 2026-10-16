#!/usr/bin/env node
// verify-build-artifact-input.mjs — consumer input verifier (t6)
//
// Each consumer job runs this before its main logic. Reads the contract JSON,
// takes --consumer and --root flags, and verifies that all declared required
// file classes for that consumer exist on disk under the given root.
//
// Usage:
//   node scripts/ci/verify-build-artifact-input.mjs --consumer vitest-dawn --root .
//   node scripts/ci/verify-build-artifact-input.mjs --consumer primary-pnpm --root .

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Minimatch-like glob test: checks if a path matches a glob pattern.
 * Supports * (including within a single segment) and ** (any depth) wildcards.
 */
function _pathMatchesGlob(path, glob) {
  const pathParts = path.split('/').filter(Boolean);
  const globParts = glob.split('/').filter(Boolean);

  let pi = 0;
  let gi = 0;

  while (pi < pathParts.length && gi < globParts.length) {
    const g = globParts[gi];
    if (g === '**') {
      // ** matches zero or more segments
      if (gi === globParts.length - 1) {
        return true; // ** at end matches everything
      }
      const nextGlob = globParts[gi + 1];
      // Find the next matching segment
      for (let k = pi; k < pathParts.length; k++) {
        if (segmentMatches(pathParts[k], nextGlob)) {
          pi = k + 1;
          gi += 2;
          break;
        }
        if (k === pathParts.length - 1) return false;
      }
      continue;
    }
    if (!segmentMatches(pathParts[pi], g)) return false;
    pi++;
    gi++;
  }

  return gi === globParts.length && pi === pathParts.length;
}

function segmentMatches(pathSegment, globSegment) {
  if (globSegment === '*') return true;
  if (!globSegment.includes('*')) return pathSegment === globSegment;
  const escaped = globSegment.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(pathSegment);
}

/**
 * Check if any file exists matching the given glob patterns under root.
 * Uses simple existence check for globs ending in specific file patterns
 * and directory existence for globs that are directory patterns.
 */
function globExists(root, glob) {
  // For patterns like 'packages/*/dist', check if any directory matches
  const parts = glob.split('/').filter(Boolean);
  if (parts.length === 0) return false;

  // Walk the glob parts to find matching directories
  function walk(dir, globIdx) {
    if (globIdx >= parts.length) {
      return existsSync(dir);
    }
    const segment = parts[globIdx];
    if (segment === '**') {
      return walkDeep(dir, globIdx + 1);
    }
    if (segment.includes('*')) {
      if (!existsSync(dir)) return false;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.name.startsWith('.') && segmentMatches(entry.name, segment)) {
            if (walk(join(dir, entry.name), globIdx + 1)) return true;
          }
        }
      } catch {
        return false;
      }
      return false;
    }
    return walk(join(dir, segment), globIdx + 1);
  }

  function walkDeep(dir, globIdx) {
    if (!existsSync(dir)) return false;
    // First try from current level
    if (walk(dir, globIdx)) return true;
    // Then recurse into subdirectories
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          if (walkDeep(join(dir, entry.name), globIdx)) return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  return walk(root, 0);
}

/**
 * Parse command-line arguments.
 */
function parseArgs(argv) {
  const args = {
    consumer: null,
    root: null,
    contract: null,
    sharedInputManifest: null,
    inputFingerprint: null,
    sharedInputMode: null,
    transferArtifact: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--consumer' && i + 1 < argv.length) {
      args.consumer = argv[++i];
    } else if (argv[i] === '--root' && i + 1 < argv.length) {
      args.root = argv[++i];
    } else if (argv[i] === '--contract' && i + 1 < argv.length) {
      args.contract = argv[++i];
    } else if (argv[i] === '--shared-input-manifest' && i + 1 < argv.length) {
      args.sharedInputManifest = argv[++i];
    } else if (argv[i] === '--input-fingerprint' && i + 1 < argv.length) {
      args.inputFingerprint = argv[++i];
    } else if (argv[i] === '--shared-input-mode' && i + 1 < argv.length) {
      args.sharedInputMode = argv[++i];
    } else if (argv[i] === '--transfer-artifact' && i + 1 < argv.length) {
      args.transferArtifact = argv[++i];
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.consumer) {
    process.stderr.write('Error: --consumer flag is required\n');
    process.exit(2);
  }
  if (!args.root) {
    process.stderr.write('Error: --root flag is required\n');
    process.exit(2);
  }
  const sharedInputMode = args.sharedInputMode ?? 'catalog-only';
  if (!['catalog-only', 'full'].includes(sharedInputMode)) {
    process.stdout.write(
      `${JSON.stringify({
        code: 'ci-shared-input-mode-invalid',
        expected: ['catalog-only', 'full'],
        actual: sharedInputMode,
        hint: 'Use catalog-only for app-shard projections or full for browser consumers that execute the serialized payload.',
      })}\n`,
    );
    process.exit(2);
  }

  const root = resolve(args.root);

  // Locate the contract JSON
  const contractPath = args.contract
    ? resolve(args.contract)
    : resolve(join(__dirname, 'build-artifact-contract.json'));

  let contract;
  try {
    contract = JSON.parse(readFileSync(contractPath, 'utf-8'));
  } catch (err) {
    const result = {
      code: 'ci-artifact-contract-parse-error',
      consumer: args.consumer,
      error: `Cannot parse contract at ${contractPath}: ${err.message}`,
      hint: 'Verify build-artifact-contract.json exists and is valid JSON.',
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(1);
  }

  // Check consumer exists
  const consumerConfig = contract.consumers?.[args.consumer];
  if (!consumerConfig) {
    const known = contract.consumers ? Object.keys(contract.consumers).join(', ') : 'none';
    const result = {
      code: 'ci-artifact-unknown-consumer',
      consumer: args.consumer,
      actual: 'unknown consumer',
      expected: `one of: ${known}`,
      hint: `Consumer "${args.consumer}" is not declared in the contract. Known consumers: ${known}`,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(1);
  }

  const requiredClasses = (consumerConfig.requiredArtifactClasses || []).filter(
    (name) =>
      !args.transferArtifact ||
      // Unknown classes must still reach the contract validation below.
      !contract.artifactClasses?.[name] ||
      contract.artifactClasses[name].transferArtifact === args.transferArtifact,
  );
  if (args.transferArtifact && requiredClasses.length === 0) {
    process.stdout.write(
      `${JSON.stringify({
        code: 'ci-artifact-transfer-not-consumed',
        consumer: args.consumer,
        actual: args.transferArtifact,
        hint: 'Select a transfer artifact declared by this consumer in build-artifact-contract.json.',
      })}\n`,
    );
    process.exit(1);
  }
  const missingPaths = [];

  for (const className of requiredClasses) {
    const classDef = contract.artifactClasses?.[className];
    if (!classDef) {
      const result = {
        code: 'ci-artifact-contract-class-unknown',
        consumer: args.consumer,
        expected: className,
        error: `Artifact class "${className}" is not declared in the contract`,
        hint: 'Verify the contract declares all artifact classes referenced by consumers.',
      };
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exit(1);
    }

    const fileClasses = classDef.fileClasses || [];
    for (const glob of fileClasses) {
      if (!globExists(root, glob)) {
        missingPaths.push({ className, glob });
      }
    }
  }

  if (missingPaths.length > 0) {
    const firstMissing = missingPaths[0];
    const result = {
      code: 'ci-artifact-required-path-missing',
      consumer: args.consumer,
      expected: `${firstMissing.className}: ${firstMissing.glob}`,
      actual: 'path not found on disk',
      hint:
        `Missing required artifact path. Expected files matching "${firstMissing.glob}" ` +
        `(artifact class "${firstMissing.className}") under "${root}". ` +
        `Verify the download-artifact step extracted to the correct root. ` +
        `All missing paths: ${missingPaths.map((p) => `${p.className}: ${p.glob}`).join(', ')}`,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(1);
  }

  const shared =
    contract.sharedInputs ??
    (requiredClasses.includes('shared-asset-pack') &&
    requiredClasses.includes('shared-engine-shaders')
      ? {
          producer: 'shared-app-inputs',
          consumer: args.consumer,
          schemaVersion: 1,
          manifestPath: 'shared-app-inputs/manifest.json',
          payloadClasses: ['shared-asset-pack', 'shared-engine-shaders'],
        }
      : null);
  const consumesSharedInputs =
    shared?.payloadClasses?.every((className) => requiredClasses.includes(className)) === true;
  if (consumesSharedInputs) {
    const manifestPath = resolve(args.sharedInputManifest ?? join(root, shared.manifestPath));
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      const result = {
        code: 'ci-shared-input-inventory-missing',
        expected: manifestPath,
        actual: 'manifest not readable',
        hint: `Download the ${shared.producer} artifact and rerun its producer before this consumer.`,
      };
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exit(1);
    }
    const failShared = (code, expected, actual, hint) => {
      process.stdout.write(`${JSON.stringify({ code, expected, actual, hint })}\n`);
      process.exit(1);
    };
    if (manifest.schemaVersion !== shared.schemaVersion) {
      failShared(
        'ci-shared-input-schema-mismatch',
        String(shared.schemaVersion),
        manifest.schemaVersion,
        'Rebuild shared-app-inputs with the contract schema version.',
      );
    }
    if (manifest.producer !== shared.producer) {
      failShared(
        'ci-shared-input-producer-mismatch',
        shared.producer,
        manifest.producer,
        'Download the artifact produced by shared-app-inputs.',
      );
    }
    if (!Array.isArray(manifest.inventory)) {
      failShared(
        'ci-shared-input-inventory-missing',
        'an inventory array',
        typeof manifest.inventory,
        'Rebuild shared-app-inputs so it writes a complete inventory.',
      );
    }
    const inventoryMissing = shared.payloadClasses.some((className) => {
      const paths = contract.artifactClasses[className]?.fileClasses ?? [];
      return paths.some((path) => !manifest.inventory.includes(path));
    });
    if (inventoryMissing) {
      failShared(
        'ci-shared-input-inventory-mismatch',
        'inventory entries for every declared shared payload',
        manifest.inventory,
        'Rebuild shared-app-inputs from the declared extraction root.',
      );
    }
    if (!manifest.inputFingerprint || manifest.inputFingerprint !== args.inputFingerprint) {
      failShared(
        'ci-shared-input-fingerprint-mismatch',
        args.inputFingerprint ?? 'a consumer input fingerprint',
        manifest.inputFingerprint,
        'Rebuild shared-app-inputs after its declared source inputs change.',
      );
    }
    const expectedPayload = sharedInputMode === 'full' ? shared.fullPayload : shared.payload;
    if (sharedInputMode === 'full' && expectedPayload === undefined) {
      failShared(
        'ci-shared-input-payload-contract-missing',
        'sharedInputs.fullPayload',
        undefined,
        'Declare the full serialized shared-input payload in build-artifact-contract.json before a full consumer downloads it.',
      );
    }
    if (expectedPayload !== undefined) {
      if (JSON.stringify(manifest.payload) !== JSON.stringify(expectedPayload)) {
        failShared(
          'ci-shared-input-payload-mismatch',
          expectedPayload,
          manifest.payload,
          'Rebuild shared-app-inputs so its serialized pack and compiled engine shader payload match the contract.',
        );
      }
      if (
        expectedPayload.assetPayloadRoot !== undefined &&
        !Array.isArray(manifest.payloadInventory)
      ) {
        failShared(
          'ci-shared-input-payload-inventory-missing',
          'a serialized payload inventory array',
          typeof manifest.payloadInventory,
          'Rebuild shared-app-inputs so consumers can project payloads without source rescans or shader compilation.',
        );
      }
      const missingPayload =
        expectedPayload.assetPayloadRoot === undefined
          ? undefined
          : manifest.payloadInventory.find((path) => !existsSync(join(root, path)));
      if (missingPayload !== undefined) {
        failShared(
          'ci-shared-input-payload-missing',
          missingPayload,
          'payload path not found on disk',
          'Download the complete shared-app-inputs artifact before the app shard consumes it.',
        );
      }
    }
  }

  const checked = requiredClasses.length;
  process.stdout.write(
    `ok: consumer "${args.consumer}" verified — ${checked} artifact class(es) present under "${root}"\n`,
  );
  process.exit(0);
}

main();
