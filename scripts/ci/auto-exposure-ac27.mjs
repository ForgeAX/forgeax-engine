#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join as pathJoin, relative, resolve } from 'node:path';
import jiti from 'jiti';

function option(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

async function walk(root, directory = root, files = []) {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const path = pathJoin(directory, entry.name);
    if (entry.isDirectory()) await walk(root, path, files);
    else files.push(path);
  }
  return files;
}

async function buildDigest() {
  const root = resolve(option('dist', 'apps/hello/taa/dist'));
  const hash = createHash('sha256');
  for (const path of await walk(root)) {
    hash.update(relative(root, path).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(await readFile(path));
    hash.update('\0');
  }
  process.stdout.write(`${hash.digest('hex')}\n`);
}

async function receiver() {
  const outputDir = resolve(option('output-dir', '/tmp/auto-exposure-ac27'));
  const host = option('host', '0.0.0.0');
  const publicHost = option('public-host', '127.0.0.1');
  const port = Number(option('port', '0'));
  await mkdir(outputDir, { recursive: true });
  const routes = new Map([
    ['/three', pathJoin(outputDir, 'three-browser.json')],
    ['/forgeax', pathJoin(outputDir, 'forgeax-browser.json')],
  ]);
  const server = createServer(async (request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    response.setHeader('access-control-allow-headers', 'content-type');
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }
    const output = routes.get(request.url ?? '');
    if (request.method !== 'POST' || output === undefined) {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 64 * 1024 * 1024) {
        response.statusCode = 413;
        response.end('artifact too large');
        return;
      }
    }
    try {
      JSON.parse(body);
      await writeFile(output, `${body}\n`, 'utf8');
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}\n');
    } catch {
      response.statusCode = 400;
      response.end('artifact must be JSON');
    }
  });
  await new Promise((resolveServer) => server.listen(port, host, resolveServer));
  const address = server.address();
  const selectedPort = typeof address === 'object' && address !== null ? address.port : port;
  process.stdout.write(
    `${JSON.stringify({
      host,
      port: selectedPort,
      threeUrl: `http://${publicHost}:${selectedPort}/three`,
      forgeaxUrl: `http://${publicHost}:${selectedPort}/forgeax`,
      outputDir,
    })}\n`,
  );
  await new Promise((resolveServer) => {
    const stop = () => server.close(resolveServer);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function join() {
  const threePath = option('three');
  const forgeaxPath = option('forgeax');
  const outputPath = option('output');
  if (threePath === undefined || forgeaxPath === undefined || outputPath === undefined) {
    throw new Error('join requires --three, --forgeax, and --output');
  }
  const modulePath = option(
    'module',
    'apps/parity/color-lighting/src/evidence/auto-exposure-ac27-join.ts',
  );
  const load = jiti(process.cwd(), { esmResolve: true });
  const { joinAutoExposureAc27 } = await load(resolve(modulePath));
  const report = joinAutoExposureAc27({
    three: JSON.parse(await readFile(resolve(threePath), 'utf8')),
    forgeax: JSON.parse(await readFile(resolve(forgeaxPath), 'utf8')),
  });
  await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `${JSON.stringify({
      status: report.status,
      testedRevision: report.testedRevision,
      resolution: report.resolution,
      roiEpsilon: report.readback?.roiEpsilon ?? null,
      rawDelta: report.readback?.rawDelta ?? null,
      overallParityClaim: report.overallParityClaim,
      output: resolve(outputPath),
    })}\n`,
  );
  if (report.status !== 'passed') process.exitCode = 2;
}

const command = process.argv[2];
if (command === 'digest') await buildDigest();
else if (command === 'receiver') await receiver();
else if (command === 'join') await join();
else throw new Error('usage: auto-exposure-ac27.mjs <digest|receiver|join> [options]');
