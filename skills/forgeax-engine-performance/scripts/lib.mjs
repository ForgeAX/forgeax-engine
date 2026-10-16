import { createHash } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function requireFact(condition, message) {
  if (!condition) throw new Error(message);
}

export function pointer(value, path = '') {
  requireFact(
    typeof path === 'string' && (path === '' || path.startsWith('/')),
    'Use a JSON Pointer',
  );
  if (path === '') return value;
  for (const token of path.slice(1).split('/')) {
    requireFact(!/~(?![01])/u.test(token), 'Invalid JSON Pointer escape');
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    requireFact(
      value !== null && typeof value === 'object' && Object.hasOwn(value, key),
      `Missing pointer: ${path}`,
    );
    value = value[key];
  }
  return value;
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const digest = (value) => createHash('sha256').update(value).digest('hex');

export async function loadJson(path) {
  const bytes = await readFile(path);
  return { value: JSON.parse(bytes), sha256: digest(bytes) };
}

export function statistics(values) {
  requireFact(
    Array.isArray(values) &&
      values.length > 0 &&
      values.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0),
    'Samples must be nonempty, finite, nonnegative numbers',
  );
  const sorted = [...values].sort((a, b) => a - b);
  let mean = 0;
  let squared = 0;
  values.forEach((value, i) => {
    const delta = value - mean;
    mean += delta / (i + 1);
    squared += delta * (value - mean);
  });
  const rank = (fraction) => sorted[Math.ceil(sorted.length * fraction) - 1];
  return {
    count: values.length,
    min: sorted[0],
    mean,
    p50: rank(0.5),
    p95: rank(0.95),
    p99: rank(0.99),
    max: sorted.at(-1),
    populationStddev: Math.sqrt(squared / values.length),
    quantile: 'nearest-rank',
  };
}

export async function emitJson(value, output, inputs = []) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (output !== undefined) {
    let destination = resolve(output);
    let destinationStat;
    try {
      destination = await realpath(destination);
      destinationStat = await stat(destination);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const input of inputs) {
      const inputStat = await stat(input);
      requireFact(
        destination !== (await realpath(input)) &&
          !(
            destinationStat &&
            destinationStat.dev === inputStat.dev &&
            destinationStat.ino === inputStat.ino
          ),
        'Output must not overwrite an input',
      );
    }
    await writeFile(output, text);
  } else process.stdout.write(text);
}

export function runCli(moduleUrl, main) {
  if (process.argv[1] && moduleUrl === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch((error) => {
      process.stderr.write(`${JSON.stringify({ status: 'invalid', reason: error.message })}\n`);
      process.exitCode = 1;
    });
  }
}
