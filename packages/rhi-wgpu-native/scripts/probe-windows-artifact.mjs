import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { filename, verifyArtifact } from './windows-artifact.mjs';

const directory = resolve(process.argv[2]);
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
verifyArtifact(directory, manifest.sourceInputs);
if (process.env.GITHUB_SHA && manifest.engineCommit !== process.env.GITHUB_SHA)
  throw new Error('native-artifact-ci-source-mismatch');
const script = `
  import {createRequire} from 'node:module';
  const require=createRequire(import.meta.url);
  const binding=require(process.argv[1]);
  if(binding.wgpuVersion()!=='30.0.1') throw new Error('native-version-mismatch');
  const adapter=binding.requestAdapter(null,false);
  const info=adapter?JSON.parse(adapter.info()):null;
  if(info&&info.backend!=='Dx12') throw new Error('native-backend-mismatch');
  const features=adapter?adapter.features():[];
  let compute={status:'adapter-unavailable'};
  if(adapter){
    const device=adapter.requestDevice('{}');
    try{
      const admitted=id=>{if(!id)throw new Error('native-compute-object-unavailable');return id;};
      const storage=admitted(device.createBuffer(JSON.stringify({size:4,usage:132})));
      const readback=admitted(device.createBuffer(JSON.stringify({size:4,usage:9})));
      const shader=JSON.parse(device.createShaderModule(
        '@group(0) @binding(0) var<storage,read_write> result: array<u32>; @compute @workgroup_size(1) fn main(){result[0]=42u;}',
        'portable-runtime-compute',
      ));
      const pipeline=admitted(device.createComputePipeline(JSON.stringify({
        compute:{module:admitted(shader.id),entryPoint:'main'},
      })));
      const layout=admitted(device.pipelineBindGroupLayout(pipeline,0));
      const group=admitted(device.createBindGroup(JSON.stringify({
        layout,entries:[{binding:0,resource:{kind:'buffer',id:storage,size:4}}],
      })));
      const commands=[
        {op:'beginComputePass'}, {op:'setPipeline',id:pipeline},
        {op:'setBindGroup',index:0,id:group}, {op:'dispatch',x:1,y:1,z:1}, {op:'end'},
        {op:'copyBufferToBuffer',source:storage,sourceOffset:0,destination:readback,destinationOffset:0,size:4},
      ];
      device.queueSubmit([admitted(device.finishEncoder(JSON.stringify({commands})))]);
      device.queueWait();
      const mapError=device.bufferMap(readback,1,0,4);
      if(mapError)throw new Error('native-compute-map-failed:'+mapError);
      const bytes=device.bufferReadMapped(readback,0,4);
      const value=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,true);
      device.bufferUnmap(readback);
      const errors=JSON.parse(device.drainErrors());
      if(errors.length)throw new Error('native-compute-validation-failed:'+JSON.stringify(errors));
      if(value!==42)throw new Error('native-compute-readback-mismatch:'+value);
      compute={status:'pass',value,bytes:bytes.byteLength};
    }finally{device.destroy();}
  }
  console.log(JSON.stringify({node:process.versions.node,nodeApi:process.versions.napi,
    loadSucceeded:true,adapter:info,features,compute,rayQuery:features.includes('wgpu-ray-query'),
    hardwareQualified:false}));
`;
// Child loading has no compiler/source/developer PATH or Node module search path.
const env = {
  PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
};
const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, join(directory, filename)], {
  cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 60000,
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
