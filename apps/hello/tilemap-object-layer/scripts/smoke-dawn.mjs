#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Tilemap } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import { createTilemapSmoke } from '../../tilemap/scripts/smoke-host.mjs';
import { buildObjectTilemapScene } from '../src/scene.ts';
const here=dirname(fileURLToPath(import.meta.url));
const manifest=readFileSync(resolve(here, '..', 'dist', 'shaders', 'manifest.json'),'utf8');
const host=await createTilemapSmoke(`data:application/json,${encodeURIComponent(manifest)}`);
const scene=buildObjectTilemapScene(host.world,host.assets),frames=Math.max(60,Number(process.env.SMOKE_MIN_FRAMES??60));
const points=[[15.5,8],[8.5,12.5],[17.5,17.5],[4.5,22.5],[16,31]].map(([x,y])=>[x*8,(32-y)*8]);
await host.draw(Math.floor(frames/2));
const before=await host.sample(points);
console.log('five-scene samples',before);
for(let i=0;i<5;i++)host.color(before[i],[[0,0,1],[0,0,1],[0,1,0],[1,1,0],[1,0,1]][i]);
assert.equal([...host.world.query({read:[MeshFilter,MeshRenderer]}).unwrap()].length,1);
// Moving the sprite reveals the overlapping tree; removing cells makes the four map samples black.
host.world.set(scene.sprite,Transform,{pos:[16,40,0]}).unwrap();
await host.draw(1);host.color((await host.sample([points[4]]))[0],[0,0,1]);
host.world.set(scene.map,Tilemap,{tiles:new Uint32Array(32*32)}).unwrap();await host.draw(Math.ceil(frames/2)-1);
for(const pixel of await host.sample(points))host.color(pixel,[0,0,0]);
await host.finish('hello-tilemap-object-layer/smoke');
