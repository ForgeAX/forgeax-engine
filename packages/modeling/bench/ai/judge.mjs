import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

// Blind review: every collected render is copied under an anonymous id in a seeded shuffle
// and scored with the RUBRIC by a separate `claude -p` call that sees no condition labels.
// The id-to-run key is written outside the judge's directory.

const here = import.meta.dirname;
const protocol = JSON.parse(readFileSync(join(here, 'protocol.json'), 'utf8'));
const briefSet = JSON.parse(readFileSync(join(here, 'briefs.json'), 'utf8'));

const { values: args } = parseArgs({
  options: { root: { type: 'string', default: '/tmp/m5-runs' } },
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, seed) {
  const random = mulberry32(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const ITEM_IDS = protocol.rubric.items.map((item) => item.id);

function schema() {
  const score = { type: 'integer', minimum: 1, maximum: 5 };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['entries'],
    properties: {
      entries: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'scores', 'briefFidelity', 'note'],
          properties: {
            id: { type: 'string' },
            scores: {
              type: 'object',
              additionalProperties: false,
              required: ITEM_IDS,
              properties: Object.fromEntries(ITEM_IDS.map((id) => [id, score])),
            },
            briefFidelity: score,
            note: { type: 'string' },
          },
        },
      },
    },
  };
}

function judgePrompt(entries) {
  const rubric = protocol.rubric.items
    .map((item) => `- ${item.id}: 5 = ${item.five}; 1 = ${item.one}`)
    .join('\n');
  return `You are a blind reviewer of 3D prop renders. The current directory holds ${entries.length} images (${entries
    .map((e) => e.image)
    .join(
      ', ',
    )}). Each image is a 2x2 sheet of one prop: front, right, top and isometric orthographic views, rendered with the same camera set, the same lights and the same neutral gray material for every image. entries.json lists each image id with the prop it is meant to be.

Read every image with the Read tool, then score each image independently with this rubric (integers 1 to 5; use the descriptions literally; the rubric was written for game shots, so when an item cannot show in an isolated prop sheet, score what the image actually shows):
${rubric}

Also give briefFidelity (1 to 5): how well the visible geometry matches the description in entries.json. Keep each note to one or two sentences about the geometry you see. Return only the structured result with one entry per image id.`;
}

function runJudge(dir, entries) {
  const a = protocol.agent;
  const result = spawnSync(
    'claude',
    [
      '-p',
      judgePrompt(entries),
      '--model',
      a.model,
      '--effort',
      a.effort,
      '--max-turns',
      String(entries.length * 2 + 6),
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(schema()),
      '--tools',
      'Read',
      '--allowedTools',
      'Read',
      '--permission-mode',
      'dontAsk',
      '--no-session-persistence',
    ],
    { cwd: dir, encoding: 'utf8', timeout: 1_200_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const out = JSON.parse(result.stdout);
  const structured =
    out.structured_output ?? (typeof out.result === 'string' ? JSON.parse(out.result) : out.result);
  return {
    entries: structured.entries,
    turns: out.num_turns,
    costUsd: out.total_cost_usd,
    seconds: out.duration_ms / 1000,
  };
}

function main() {
  const runs = readdirSync(args.root)
    .filter((name) => existsSync(join(args.root, name, 'collect.json')))
    .sort()
    .map((name) => ({
      name,
      collect: JSON.parse(readFileSync(join(args.root, name, 'collect.json'), 'utf8')),
    }));
  const passes = [];
  protocol.review.shuffleSeeds.forEach((seed, p) => {
    const judgeDir = join(args.root, '_judge', `p${p + 1}`);
    rmSync(judgeDir, { recursive: true, force: true });
    mkdirSync(judgeDir, { recursive: true });
    const order = shuffle(runs, seed);
    const key = {};
    const entries = [];
    const unscored = [];
    order.forEach((run, i) => {
      const id = `E${String(i + 1).padStart(2, '0')}`;
      key[id] = run.name;
      if (run.collect.render?.ok) {
        const image = `${id}.png`;
        copyFileSync(run.collect.render.sheet, join(judgeDir, image));
        const brief = briefSet.briefs.find((b) => b.id === run.collect.brief);
        entries.push({ id, image, prop: `${brief.title}: ${brief.text}` });
      } else {
        unscored.push(id);
      }
    });
    writeFileSync(join(judgeDir, 'entries.json'), `${JSON.stringify(entries, null, 2)}\n`);
    const judged = entries.length > 0 ? runJudge(judgeDir, entries) : { entries: [] };
    const missing = Object.fromEntries(
      ITEM_IDS.map((id) => [id, protocol.review.missingImageScore]),
    );
    const scores = {};
    for (const entry of judged.entries) {
      if (key[entry.id] === undefined) continue;
      scores[key[entry.id]] = { anonymousId: entry.id, ...entry };
    }
    for (const id of unscored) {
      scores[key[id]] = {
        anonymousId: id,
        scores: missing,
        briefFidelity: protocol.review.missingImageScore,
        note: 'no render: missingImageScore',
        imputed: true,
      };
    }
    passes.push({
      pass: p + 1,
      seed,
      judgeTurns: judged.turns ?? 0,
      judgeCostUsd: judged.costUsd ?? 0,
      judgeSeconds: judged.seconds ?? 0,
      scores,
    });
    console.log(`judge pass ${p + 1}: ${entries.length} images scored, ${unscored.length} imputed`);
  });
  writeFileSync(
    join(args.root, 'review.json'),
    `${JSON.stringify({ schema: 'forgeax.ai-benchmark.review/1', passes }, null, 2)}\n`,
  );
}

main();
