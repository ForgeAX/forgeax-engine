import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

test('every executable daily CI job declares a bounded execution window', () => {
  for (const file of ['ci.yml', 'sdk-pr-preflight.yml', 'webgpu-compatibility.yml']) {
    const workflow = parse(readFileSync(`.github/workflows/${file}`, 'utf8'));
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (!job.steps) continue;
      const label = `${file}:${id}`;
      assert.ok(Object.hasOwn(job, 'timeout-minutes'), `${label} inherits the six-hour default`);
      const minutes = job['timeout-minutes'];
      if (typeof minutes === 'number') {
        assert.ok(Number.isInteger(minutes) && minutes > 0 && minutes < 360, label);
      } else assert.match(minutes, /^\$\{\{.+\}\}$/, label);
    }
  }
});
