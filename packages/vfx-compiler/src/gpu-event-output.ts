/** One output buffer is shared by every requesting emitter of a World/frame. */
export const GPU_EVENT_OUTPUT_RUNTIME_WGSL = `
struct VfxGpuOutputEvent {position:vec3<f32>,strength:f32,channel:u32,particleId:u32,tick:u32,padding:u32}
struct VfxGpuOutputChannel {count:atomic<u32>,channel:u32,offset:u32,capacity:u32}
struct VfxGpuEventOutput {count:atomic<u32>,capacity:u32,epoch:u32,channelCount:u32,channels:array<VfxGpuOutputChannel,16>,events:array<VfxGpuOutputEvent>}
@group(0) @binding(25) var<storage,read_write> forgeax_vfx_gpu_events:VfxGpuEventOutput;
fn vfx_emit_event(channelId:u32,position:vec3<f32>,strength:f32,particleId:u32)->bool{
 if(forgeax_vfx_gpu_events.capacity==0u){return false;}
 for(var i=0u;i<min(16u,forgeax_vfx_gpu_events.channelCount);i+=1u){if(forgeax_vfx_gpu_events.channels[i].channel!=channelId){continue;}
  let ordinal=atomicAdd(&forgeax_vfx_gpu_events.channels[i].count,1u);if(ordinal>=forgeax_vfx_gpu_events.channels[i].capacity){return false;}
  let slot=forgeax_vfx_gpu_events.channels[i].offset+ordinal;if(slot>=forgeax_vfx_gpu_events.capacity){return false;}
  forgeax_vfx_gpu_events.events[slot]=VfxGpuOutputEvent(position,strength,channelId,particleId,forgeax_vfx_runtime.tick,0u);atomicAdd(&forgeax_vfx_gpu_events.count,1u);return true;
 }return false;
}
// A channel's one ordered GPU controller may publish an aggregate observation
// into a stable ordinal. Repeated fixed ticks replace it with the latest state;
// this never advances a CPU mirror or consumes another channel's event quota.
fn vfx_write_observation(channelId:u32,ordinal:u32,position:vec3<f32>,strength:f32,observationId:u32)->bool{
 if(forgeax_vfx_gpu_events.capacity==0u){return false;}
 for(var i=0u;i<min(16u,forgeax_vfx_gpu_events.channelCount);i+=1u){if(forgeax_vfx_gpu_events.channels[i].channel!=channelId){continue;}if(ordinal>=forgeax_vfx_gpu_events.channels[i].capacity){return false;}let slot=forgeax_vfx_gpu_events.channels[i].offset+ordinal;if(slot>=forgeax_vfx_gpu_events.capacity){return false;}forgeax_vfx_gpu_events.events[slot]=VfxGpuOutputEvent(position,strength,channelId,observationId,forgeax_vfx_runtime.tick,0u);return true;
 }return false;
}
`;
