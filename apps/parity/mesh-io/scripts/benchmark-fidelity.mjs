import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCliGltf } from '@forgeax/engine-gltf/cli-gltf';
import { gltfImporter } from '@forgeax/engine-gltf/node-importer';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { ImporterRegistry, runImport, projectImportProductForBuild } from '@forgeax/engine-import';
import { finalizePackageTransportSource } from '@forgeax/engine-pack/build';
import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..'),destination=resolve(root,'artifacts/asset-format-fidelity/closure');
await mkdir(destination,{recursive:true});
if(!process.env.FIDELITY_TRIANGLES){
 for(const triangles of [12,10000,120000])execFileSync(process.execPath,[fileURLToPath(import.meta.url)],{cwd:root,env:{...process.env,FIDELITY_TRIANGLES:String(triangles)},stdio:'inherit',timeout:900000});
 process.exit(0);
}
const triangles=Number(process.env.FIDELITY_TRIANGLES),vertices=triangles*3;
const png=await readFile(resolve(root,'artifacts/mesh-io/fixtures/paint/checker.png'));
const registry=new ImporterRegistry();registry.register(gltfImporter);registry.register(imageImporter);
const cookers=new NativeCookerRegistry();cookers.register(createMaterialPackCooker());
const inputs={};
for(const [label,stride]of [['tight',12],['strided',16]]){
 const bytes=new Uint8Array(vertices*stride+vertices*8),view=new DataView(bytes.buffer);
 for(let i=0;i<vertices;i++){const c=i%3;view.setFloat32(i*stride,c===1?1:0,true);view.setFloat32(i*stride+4,c===2?1:0,true);view.setFloat32(i*stride+8,0,true);view.setFloat32(vertices*stride+i*8,c===1?1:0,true);view.setFloat32(vertices*stride+i*8+4,c===2?1:0,true);}
 const source={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{name:'Triangles',mesh:0}],buffers:[{byteLength:bytes.length,uri:`data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`}],bufferViews:[{buffer:0,byteLength:vertices*stride,...(stride===16?{byteStride:16}:{})},{buffer:0,byteOffset:vertices*stride,byteLength:vertices*8}],accessors:[{bufferView:0,type:'VEC3',componentType:5126,count:vertices},{bufferView:1,type:'VEC2',componentType:5126,count:vertices}],meshes:[{name:'Triangles',primitives:[{attributes:{POSITION:0,TEXCOORD_0:1},material:0}]}],materials:[{name:'Paint',pbrMetallicRoughness:{baseColorFactor:[1,1,1,1],baseColorTexture:{index:0},metallicFactor:0,roughnessFactor:1}}],images:[{uri:`data:image/png;base64,${png.toString('base64')}`}],textures:[{source:0}]};
 const path=resolve(destination,`${triangles}-${label}.gltf`);await writeFile(path,JSON.stringify(source));const errors=[];
 const start=performance.now();if(await runCliGltf(['import',path],{stdoutWrite(){},stderrWrite:line=>errors.push(line)}))throw new Error(errors.join('\n'));
 const meta={...JSON.parse(await readFile(`${path}.meta.json`,'utf8')),source:path};inputs[label]={path,meta,sourceBytes:(await readFile(path)).length,admissionMs:performance.now()-start};
}
const execute=async(label)=>{
 const start=performance.now(),cpuStart=process.cpuUsage(),input=inputs[label];
 const result=await runImport(input.meta,registry,{readSource:async path=>({ok:true,value:new Uint8Array(await readFile(path))}),decodeImage:imageImporter.capabilities.decodeImage},cookers);
 if(!result.ok||'skipped'in result.value)throw new Error(JSON.stringify(result));
 const cpu=process.cpuUsage(cpuStart),assets=result.value.pack.assets;
 if(!assets.some(asset=>asset.kind==='material'&&asset.payload.cooked))throw new Error('missing actual Material NativeCook');
 return {label,wallMs:performance.now()-start,cpuMs:(cpu.user+cpu.system)/1000,rss:process.memoryUsage().rss,processPeakRss:process.resourceUsage().maxRSS*1024,loadAverage:loadavg(),assetKinds:assets.map(asset=>asset.kind),intermediateCookJsonBytes:Buffer.byteLength(JSON.stringify(result.value.cookProducts)), projectedPackJsonBytes:Buffer.byteLength(JSON.stringify(projectImportProductForBuild(result.value.product))),artifactBytes:result.value.product.assets.reduce((sum,asset)=>sum+Object.values(asset.artifacts).reduce((sum,artifact)=>sum+artifact.bytes.length,0),0)};
};
if(process.env.FIDELITY_BYTES_ONLY){
 const sizes=[];for(const label of ['tight','strided']) {
 const result=await runImport(inputs[label].meta,registry,{readSource:async path=>({ok:true,value:new Uint8Array(await readFile(path))}),decodeImage:imageImporter.capabilities.decodeImage},cookers);
 if(!result.ok||'skipped'in result.value)throw new Error(JSON.stringify(result));
 const route=await finalizePackageTransportSource(projectImportProductForBuild(result.value.product),{base:'/',packagePath:'perf.pack.json',artifactPath:(guid,key)=>`${guid}/${key}.bin`});
 sizes.push({label,packJsonBytes:Buffer.byteLength(JSON.stringify(route.pack)),artifactBytes:route.artifacts.reduce((sum,artifact)=>sum+artifact.bytes.length,0),artifacts:route.artifacts.map(({path,bytes})=>({path,byteLength:bytes.length}))});
 }
 await writeFile(resolve(destination,`${triangles}-bytes.json`),JSON.stringify({scope:'separate final producer byte accounting; timings do not replace the completed ABBA series; actual canonical Pack transport finalizer, emitted JSON and artifact byte lengths; excludes HTTP headers',sizes},null,2)+'\n'); process.exit(0);
}
const warmup=[];for(let i=0;i<2;i++)for(const label of ['tight','strided'])warmup.push(await execute(label));
const raw=[];for(let block=0;block<8;block++)for(const label of ['tight','strided','strided','tight'])raw.push({block,...await execute(label)});
const summaries={};for(const label of ['tight','strided']){const rows=raw.filter(row=>row.label===label);const percentile=field=>{const values=rows.map(row=>row[field]).sort((a,b)=>a-b);return {p50:values[7],p95:values[15]};};summaries[label]={wallMs:percentile('wallMs'),cpuMs:percentile('cpuMs'),intermediateCookJsonBytes:rows[0].intermediateCookJsonBytes,projectedPackJsonBytes:rows[0].projectedPackJsonBytes,artifactBytes:rows[0].artifactBytes};}
const report={sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),cpu:cpus()[0].model,runtime:process.version,triangles,vertices,protocol:'2 excluded warmups/route; 8 ABBA blocks; same source geometry/material/16x16 image, dense versus strided position storage; real Import + Material NativeCook + finalized CookReceipt; source admission reported separately; shader compiler is warm; HTTP/GPU load is separate browser evidence; peak RSS is this isolated size process including source construction, warmup and all trials, not per-operation allocation',inputs,warmup,raw,summaries,processPeakRss:process.resourceUsage().maxRSS*1024};
await writeFile(resolve(destination,`${triangles}.json`),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({triangles,summaries,processPeakRss:report.processPeakRss}));
