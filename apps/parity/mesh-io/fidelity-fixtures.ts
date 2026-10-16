import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runCliGltf } from '@forgeax/engine-gltf/cli-gltf';
import { importMeshFile } from '@forgeax/engine-mesh-io';
import UPNG from 'upng-js';
export interface FidelityFixture {id:string;label:string;guids:string[];sceneGuid?:string;animationGuid?:string;lightIntensity?:number}
export async function prepareFidelityFixtures(root:string):Promise<FidelityFixture[]> {
  const rows:FidelityFixture[]=[];
  const pixels=new Uint8Array(16*16*4);
  for(let y=0;y<16;y++)for(let x=0;x<16;x++)pixels.set(x<8?(y<8?[255,40,20,255]:[20,220,60,255]):(y<8?[40,80,255,255]:[240,200,30,255]),(y*16+x)*4);
  await mkdir(resolve(root,'paint'),{recursive:true});await writeFile(resolve(root,'paint/checker.png'),new Uint8Array(UPNG.encode([pixels.buffer],16,16,0)));
  const obj='mtllib paint/card.mtl\no Card\nv -0.8 -0.6 0\nv 0.8 -0.6 0\nv 0.8 0.6 0\nv -0.8 0.6 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nusemtl Checker\nf 1/1 2/2 3/3 4/4\n';
  await writeFile(resolve(root,'paint/card.mtl'),'newmtl Checker\nKd 1 1 1\nPr 1\nPm 0\nmap_Kd checker.png\n');
  const objPath=resolve(root,'mtl.obj');await writeFile(objPath,obj);const admitted=(await importMeshFile(objPath)).unwrap();rows.push({id:'obj-mtl',label:'OBJ / MTL / real texture',guids:admitted.subAssets.filter(row=>row.kind==='mesh').map(row=>row.guid)});
  const binary=new Uint8Array(108);const view=new DataView(binary.buffer);
  const positions=[-.8,-.6,0, .8,-.6,0, .8,.6,0, -.8,.6,0];positions.forEach((value,index)=>view.setFloat32(Math.floor(index/3)*16+(index%3)*4,value,true));
  new Float32Array(binary.buffer,64,8).set([0,0,1,0,1,1,0,1]);new Uint16Array(binary.buffer,96,6).set([0,1,2,0,2,3]);
  const base={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0,1]}],nodes:[{name:'Card',mesh:0},{name:'Camera',camera:0,translation:[0,0,3]}],cameras:[{type:'perspective',perspective:{yfov:1.1,aspectRatio:4/3,znear:.2,zfar:20}}],buffers:[{byteLength:binary.length,uri:`data:application/octet-stream;base64,${Buffer.from(binary).toString('base64')}`}],bufferViews:[{buffer:0,byteLength:64,byteStride:16},{buffer:0,byteOffset:64,byteLength:32},{buffer:0,byteOffset:96,byteLength:12}],accessors:[{bufferView:0,type:'VEC3',componentType:5126,count:4},{bufferView:1,type:'VEC2',componentType:5126,count:4},{bufferView:2,type:'SCALAR',componentType:5123,count:6}],meshes:[{name:'Card',primitives:[{attributes:{POSITION:0,TEXCOORD_0:1},indices:2,material:0}]}]};
  for(const [id,material,lightIntensity]of [
    ['unlit-dark',{pbrMetallicRoughness:{baseColorFactor:[.2,.6,.1,1]},extensions:{KHR_materials_unlit:{}}},0],
    ['unlit-light',{pbrMetallicRoughness:{baseColorFactor:[.2,.6,.1,1]},extensions:{KHR_materials_unlit:{}}},15],
    ['emissive-1',{pbrMetallicRoughness:{baseColorFactor:[0,0,0,1],metallicFactor:0,roughnessFactor:1},emissiveFactor:[.08,.03,.02],extensions:{KHR_materials_emissive_strength:{emissiveStrength:1}}},0],
    ['emissive-5',{pbrMetallicRoughness:{baseColorFactor:[0,0,0,1],metallicFactor:0,roughnessFactor:1},emissiveFactor:[.08,.03,.02],extensions:{KHR_materials_emissive_strength:{emissiveStrength:5}}},0],
    ['unlit-texture',{pbrMetallicRoughness:{baseColorFactor:[1,1,1,1],baseColorTexture:{index:0}},extensions:{KHR_materials_unlit:{}}},0],
    ['camera-ortho',{pbrMetallicRoughness:{baseColorFactor:[.2,.6,.1,1]},extensions:{KHR_materials_unlit:{}}},0],
  ] as const) {
    const source={...base,...(id==='unlit-texture'?{images:[{uri:'paint/checker.png'}],textures:[{source:0}]}:{}),materials:[material],extensionsRequired:Object.keys(material.extensions),...(id==='camera-ortho'?{cameras:[{type:'orthographic',orthographic:{xmag:1.4,ymag:.8,znear:.2,zfar:20}}]}:{})};
    const path=resolve(root,`${id}.gltf`);await writeFile(path,JSON.stringify(source));const errors:string[]=[];
    if(await runCliGltf(['import',path],{stdoutWrite(){},stderrWrite:line=>errors.push(line)}))throw new Error(errors.join('\n'));
    const meta=JSON.parse(await readFile(`${path}.meta.json`,'utf8')) as {subAssets:{kind:string;guid:string}[]};
    rows.push({id,label:id.replaceAll('-',' '),guids:meta.subAssets.filter(row=>row.kind==='mesh').map(row=>row.guid),sceneGuid:meta.subAssets.find(row=>row.kind==='scene')!.guid,lightIntensity});
  }
  for (const id of ['unlit-color', 'unlit-skin']) {
    const data = new Uint8Array(id === 'unlit-color' ? 172 : 268); data.set(binary);
    const extraViews = id === 'unlit-color' ? [{buffer:0,byteOffset:108,byteLength:64}] : [{buffer:0,byteOffset:108,byteLength:32},{buffer:0,byteOffset:140,byteLength:64},{buffer:0,byteOffset:204,byteLength:64}];
    const extraAccessors = id === 'unlit-color' ? [{bufferView:3,type:'VEC4',componentType:5126,count:4}] : [{bufferView:3,type:'VEC4',componentType:5123,count:4},{bufferView:4,type:'VEC4',componentType:5126,count:4},{bufferView:5,type:'MAT4',componentType:5126,count:1}];
    if (id === 'unlit-color') new Float32Array(data.buffer,108,16).set([.2,.6,.1,1,.2,.6,.1,1,.2,.6,.1,1,.2,.6,.1,1]);
    else {new Float32Array(data.buffer,140,16).set([1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0]);new Float32Array(data.buffer,204,16).set([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);}
    const source = {...base,buffers:[{byteLength:data.length,uri:`data:application/octet-stream;base64,${Buffer.from(data).toString('base64')}`}],bufferViews:[...base.bufferViews,...extraViews],accessors:[...base.accessors,...extraAccessors],materials:[{pbrMetallicRoughness:{baseColorFactor:id === 'unlit-color' ? [1,1,1,1] : [.2,.6,.1,1]},extensions:{KHR_materials_unlit:{}}}],extensionsRequired:['KHR_materials_unlit'],meshes:[{name:'Card',primitives:[{attributes:{POSITION:0,TEXCOORD_0:1,...(id === 'unlit-color' ? {COLOR_0:3} : {JOINTS_0:3,WEIGHTS_0:4})},indices:2,material:0}]}],...(id === 'unlit-skin' ? {nodes:[{...base.nodes[0],skin:0},base.nodes[1],{name:'Bone',translation:[.15,0,0]}],scenes:[{nodes:[0,1,2]}],skins:[{joints:[2],skeleton:2,inverseBindMatrices:5}]} : {})};
    const path=resolve(root,`${id}.gltf`);await writeFile(path,JSON.stringify(source));const errors:string[]=[];
    if(await runCliGltf(['import',path],{stdoutWrite(){},stderrWrite:line=>errors.push(line)}))throw new Error(errors.join('\n'));
    const meta=JSON.parse(await readFile(`${path}.meta.json`,'utf8')) as {subAssets:{kind:string;guid:string}[]};
    const scene = meta.subAssets.find(row=>row.kind==='scene');if(scene === undefined)throw new Error('missing source scene');
    rows.push({id,label:id.replaceAll('-',' '),guids:meta.subAssets.filter(row=>row.kind==='mesh').map(row=>row.guid),sceneGuid:scene.guid,lightIntensity:0});
  }
  const cubicBytes=new Uint8Array(188);cubicBytes.set(binary);new Float32Array(cubicBytes.buffer,108,2).set([0,2]);new Float32Array(cubicBytes.buffer,116,18).set([0,0,0, 0,0,0, .3,0,0, -.3,0,0, 0,0,0, 0,0,0]);
  const cubic={...base,buffers:[{byteLength:188,uri:`data:application/octet-stream;base64,${Buffer.from(cubicBytes).toString('base64')}`}],bufferViews:[...base.bufferViews,{buffer:0,byteOffset:108,byteLength:8},{buffer:0,byteOffset:116,byteLength:72}],accessors:[...base.accessors,{bufferView:3,type:'SCALAR',componentType:5126,count:2},{bufferView:4,type:'VEC3',componentType:5126,count:6}],materials:[{extensions:{KHR_materials_unlit:{}},pbrMetallicRoughness:{baseColorFactor:[.2,.6,.1,1]}}],extensionsRequired:['KHR_materials_unlit'],animations:[{name:'Cubic',samplers:[{input:3,output:4,interpolation:'CUBICSPLINE'}],channels:[{sampler:0,target:{node:0,path:'translation'}}]}]};
  const path=resolve(root,'cubic.gltf');await writeFile(path,JSON.stringify(cubic));
  const errors:string[]=[];if(await runCliGltf(['import',path],{stdoutWrite(){},stderrWrite:line=>errors.push(line)}))throw new Error(errors.join('\n'));
  const meta=JSON.parse(await readFile(`${path}.meta.json`,'utf8')) as {subAssets:{kind:string;guid:string}[]};
  rows.push({id:'cubic',label:'Cubic source / Cook / pose',guids:meta.subAssets.filter(row=>row.kind==='mesh').map(row=>row.guid),sceneGuid:meta.subAssets.find(row=>row.kind==='scene')!.guid,animationGuid:meta.subAssets.find(row=>row.kind==='animation-clip')!.guid,lightIntensity:0});
  return rows;
}
