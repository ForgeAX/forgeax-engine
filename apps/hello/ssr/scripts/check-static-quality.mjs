import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// Independent local peaks, persistent ranges and counts supplement recovery ROI.
// Declare before the candidate run; baseline aliases remain visible in the report.
const baseline=JSON.parse(readFileSync(process.argv[2],'utf8'));
const candidate=JSON.parse(readFileSync(process.argv[3],'utf8'));
assert.deepEqual(candidate.regions,baseline.regions);
assert.deepEqual(candidate.extent,baseline.extent);
const checks=Object.entries(baseline.statistics).map(([region,b])=>{
 const c=candidate.statistics[region];
 const limits={mean:b.mean+1/64, maximum:b.maximum+4, above4:b.above4*1.2+8,
  rangeMaximum:b.temporalRange.maximum+4,rangeAbove4:b.temporalRange.above4*1.2+4};
 const passed=c.mean<=limits.mean && c.maximum<=limits.maximum && c.above4<=limits.above4
  && c.temporalRange.maximum<=limits.rangeMaximum && c.temporalRange.above4<=limits.rangeAbove4;
 return {region,baseline:b,candidate:c,limits,passed};
});
// Near-zero baseline means make a relative percentage gate ill-posed. The
// absolute allowance is one code on 1/64 of pixels, with independent >4-code
// counts, peaks and persistent ranges still constrained above.
const passed=checks.every(c=>c.passed);
console.log(JSON.stringify({mode:'matched-static-cycle-regression',passed,checks},null,2));
if(!passed) process.exitCode=1;
