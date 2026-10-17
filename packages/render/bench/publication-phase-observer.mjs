// Private CPU owner observer for the exact retained 924 VFX fixture bundle.
// This is not a Runtime transform or a browser collector. Every patch anchor
// must match once. Observed accept remains synchronous with original results.
import assert from 'node:assert/strict';
const replace=(s,a,b)=>{assert.equal(s.split(a).length,2,'Ambiguous/missing anchor: '+a.slice(0,80));return s.replace(a,b);};
export function instrument(input,observed,transport){
 let s=input;
 s=replace(s,'  async function frame(stage, dt, fire) {','  async function frame(stage, dt, fire) {\n    globalThis.__phaseFree();\n' + (observed?'    const __p = {stage, sequence:sequence+1, phases:{}};\n    globalThis.__publicationPhase = __p;':'') + '');
 const old='    const candidate2 = u(publisher.prepare(world.getResource(Time5).elapsed)), packet = structuredClone(candidate2.packet, { transfer: [...renderPublicationTransfers(candidate2.packet), ...renderPublicationAssetTransfers(candidate2.packet)] });\n    candidate2.accept();';
 const timed=observed?`    const __publishStart=performance.now();let __tick=__publishStart;globalThis.__extractionMs=0;
    const candidate2=u(publisher.prepare(world.getResource(Time5).elapsed));
    {const n=performance.now();__p.phases.extraction=globalThis.__extractionMs;__p.phases.prepareOther=n-__tick-globalThis.__extractionMs;__tick=n;}
    const __columns=renderPublicationTransfers(candidate2.packet);
    {const n=performance.now();__p.phases.frameTransferList=n-__tick;__tick=n;}
    const __assetBuffers=renderPublicationAssetTransfers(candidate2.packet);
    {const n=performance.now();__p.phases.assetTransferList=n-__tick;__tick=n;}
    const __transfer=[...__columns,...__assetBuffers];
    {const n=performance.now();__p.phases.transferListCombine=n-__tick;__tick=n;}
    let packet;${transport==='clone'?'packet=structuredClone(candidate2.packet,{transfer:__transfer});':'globalThis.__sendPublication(candidate2.packet,__transfer);'}
    {const n=performance.now();__p.phases.transportSend=n-__tick;__tick=n;}
    candidate2.accept();
    {const n=performance.now();__p.phases.sourceAccept=n-__tick;__tick=n;}
    ${transport==='clone'?'':'packet=globalThis.__receivePublication();'}
    {const n=performance.now();__p.phases.transportReceive=n-__tick;__tick=n;}
    __p.publicationMs=performance.now()-__publishStart;
    __p.packetCounts={assets:packet.assets.length,meshBuffers:__assetBuffers.length,templates:packet.templates.length,upserts:packet.upserts.length,features:packet.features.length,invalidatedAssets:packet.invalidatedAssets.length};`:
 `    const candidate2=u(publisher.prepare(world.getResource(Time5).elapsed));
    let packet;${transport==='clone'?'packet=structuredClone(candidate2.packet,{transfer:[...renderPublicationTransfers(candidate2.packet),...renderPublicationAssetTransfers(candidate2.packet)]});':'globalThis.__sendPublication(candidate2.packet,[...renderPublicationTransfers(candidate2.packet),...renderPublicationAssetTransfers(candidate2.packet)]);'}
    candidate2.accept();${transport==='clone'?'':'packet=globalThis.__receivePublication();'}`;
 s=replace(s,old,timed);
 if(observed){
  s=replace(s,'        const frame = extractFrames(', '        const __extractStart=performance.now();\n        const frame = extractFrames(');
  s=replace(s,'        const meshCounts = /* @__PURE__ */ new Map();', '        globalThis.__extractionMs += performance.now()-__extractStart;\n        const meshCounts = /* @__PURE__ */ new Map();');
  s=replace(s,'    const feedback = [], receipt = u(renderer.draw(', '    const __drawStart=performance.now();\n    const feedback = [], receipt = u(renderer.draw(');
  s=replace(s,'    u(await receipt.completed);','    __p.phases.rendererDraw=performance.now()-__drawStart;const __completionStart=performance.now();\n    u(await receipt.completed);\n    __p.phases.completedAwait=performance.now()-__completionStart;const __ackStart=performance.now();');
  s=replace(s,'    u(publisher.acknowledgeFeatures(packet.revision, feedback));','    u(publisher.acknowledgeFeatures(packet.revision, feedback));\n    __p.phases.featureAck=performance.now()-__ackStart;const __recycleStart=performance.now();');
  s=replace(s,'    u(publisher.recycle(packet.revision, renderPublicationTransfers(packet)));','    u(publisher.recycle(packet.revision, renderPublicationTransfers(packet)));\n    __p.phases.sourceRecycle=performance.now()-__recycleStart;globalThis.__publicationPhases.push(__p);');
  const accept='  accept(packet, materialAssets) {';
  // Receiver accept is nested inside Renderer.draw; record it separately without adding to draw.
  const start=s.indexOf('var RenderPublicationReceiver = class');const before=s.slice(0,start),tail=s.slice(start);assert(tail.includes(accept));
  s=before+tail.replace(accept,'  accept(packet, materialAssets) {\n    const __receiverStart=performance.now();try {');
  const next='  snapshot(input) {';const end=s.indexOf(next,s.indexOf('var RenderPublicationReceiver = class'));assert(end>0);const head=s.slice(0,end);const close=head.lastIndexOf('  }');assert(close>0);
  s=s.slice(0,close)+'    } finally { if(globalThis.__publicationPhase) globalThis.__publicationPhase.receiverAcceptMs=(globalThis.__publicationPhase.receiverAcceptMs??0)+performance.now()-__receiverStart; }\n'+s.slice(close);
 }
 s=replace(s,'u(publisher.recycle(packet.revision, renderPublicationTransfers(packet)))','u(publisher.recycle(packet.revision, globalThis.__returnPublication(renderPublicationTransfers(packet))))');
 return s;
}
