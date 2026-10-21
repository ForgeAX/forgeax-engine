import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {decodeMaterialProgramWire,encodeMaterialProgramWire} from '@forgeax/engine-pack/runtime';

const [sourcePath,outputPath]=process.argv.slice(2);
if(!sourcePath||!outputPath)throw new Error('Usage: node --experimental-strip-types material-program-wire.bench.ts source.pack.json output.json');
const text=await readFile(sourcePath,'utf8');
const source:unknown=JSON.parse(text);
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const expected=hash(source);
const serializationStart=performance.now();
const encoded=encodeMaterialProgramWire(source);
const compact=JSON.stringify(encoded);
const serializationMs=performance.now()-serializationStart;
const observations:{plainParseMs:number;sharedParseMs:number}[]=[];
for(let index=0;index<3;index++){
 const plainStart=performance.now();const plain:unknown=JSON.parse(text);const plainParseMs=performance.now()-plainStart;
 if(hash(plain)!==expected)throw new Error('Plain input checksum changed');
 const sharedStart=performance.now();const restored=decodeMaterialProgramWire(JSON.parse(compact));const sharedParseMs=performance.now()-sharedStart;
 if(!restored.ok)throw restored.error;
 if(hash(restored.value)!==expected)throw new Error('Decoded package differs from the complete source');
 observations.push({plainParseMs,sharedParseMs});
}
await writeFile(outputPath,JSON.stringify({sourcePath,sha256:expected,beforeBytes:Buffer.byteLength(text),afterBytes:Buffer.byteLength(compact),serializationMs,observations},null,2)+'\n');
console.log(outputPath);
