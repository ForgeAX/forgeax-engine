import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import process from 'node:process';
import { derivedAdmissionFixture } from '../src/__tests__/fixtures/derived-admission.js';

const cpu = Reflect.get(process, 'threadCpuUsage') as () => {user:number;system:number};
assert.equal(typeof cpu, 'function', 'Native CPU probe requires threadCpuUsage');
const rows: unknown[] = [];
for (const residentBodies of [32, 512, 2048]) {
  const {physics} = await derivedAdmissionFixture(residentBodies);
  try {
    assert.equal(physics.getBodyCount(), residentBodies);
    let started = 0, before = cpu();
    for (let iteration = 0; iteration < 288; iteration++) {
      if (iteration === 32) {started = performance.now();before = cpu();}
      const bodyType = iteration % 2 === 0 ? 'static' as const : 'dynamic' as const;
      const candidates = physics.prepareDerivedBodyTypeCandidates([1,2].map(entity => {
        const publication = physics.getDerivedPublication(entity);
        assert(publication, 'Missing resident Native publication');
        return {publication,bodyType};
      })).unwrap();
      physics.admitDerivedShapeCandidates(candidates).unwrap();
      physics.step(1/60);
    }
    const after = cpu();
    rows.push({residentBodies,steps:256,bodyPolicies:512,wallMs:performance.now()-started,
      threadCpuMs:(after.user+after.system-before.user-before.system)/1000});
    assert.equal(physics.getDerivedBodyType(1),'dynamic');
    assert.equal(physics.getDerivedBodyType(2),'dynamic');
    assert.equal(physics.getDerivedBodyType(residentBodies),'static');
  } finally {physics.dispose();}
}
const sourceSha256=createHash('sha256').update(readFileSync(new URL('../src/rapier-physics-world-3d.ts',import.meta.url))).digest('hex');
process.stdout.write(JSON.stringify({sourceSha256,node:process.version,platform:process.platform,arch:process.arch,scope:'CPU-only local policy preparation, admission and real Rapier steps. No GPU/FPS claim.',rows},null,2)+'\n');
