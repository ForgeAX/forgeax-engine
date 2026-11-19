import type { GpuSlotAllocatorSource } from '@forgeax/engine-vfx';

export const GPU_SLOT_ALLOCATOR_ENTRY = 'forgeax_vfx_pool_allocate_main';
/** Caller validates every state field against Custom f32 reflection and every
 * command field against Parameters f32 reflection, then includes this module in
 * the managed shader and dispatches it once AFTER initial spawn, BEFORE update.
 * It needs no extra binding, CPU mirror, particle readback or World time tick. */
export function createGpuSlotAllocatorRuntime(
  source: GpuSlotAllocatorSource,
  capacity: number,
): string {
  const state = source.state;
  const commands = source.commands
    .map(
      (command, index) =>
        '  {let sequence=u32(max(0.0,params.' +
        command.sequence +
        '));' +
        'let count=min(' +
        source.maxCommandCount +
        'u,u32(max(0.0,params.' +
        command.count +
        ')));' +
        'if(sequence>lastSequence){\n' +
        ' for(var ordinal=0u;ordinal<count;ordinal+=1u){\n' +
        '  var chosen=cursor;var found=false;\n' +
        '  for(var offset=0u;offset<' +
        capacity +
        'u;offset+=1u){let slot=(cursor+offset)%' +
        capacity +
        'u;if(forgeax_vfx_custom[slot].' +
        state.active +
        '<0.5){chosen=slot;found=true;break;}}\n' +
        '  if(!found){var best=-3.402823e38;for(var slot=0u;slot<' +
        capacity +
        'u;slot+=1u){let priority=forgeax_vfx_custom[slot].' +
        state.priority +
        ';if(priority>best){chosen=slot;best=priority;}}}\n' +
        '  var particle=forgeax_vfx_particles[chosen];var custom=forgeax_vfx_custom[chosen];\n' +
        '  particle.id=sequence*1024u+ordinal;particle.age=0.0;particle.alive=1u;\n' +
        '  let ctx=VfxSpawnContext(forgeax_vfx_runtime.delta,forgeax_vfx_runtime.tick,forgeax_vfx_runtime.seed,forgeax_vfx_runtime.playCycle,particle.id,f32(forgeax_vfx_runtime.timeWhole)+forgeax_vfx_runtime.timeFract,forgeax_vfx_runtime.timeWhole,forgeax_vfx_runtime.timeFract,f32(forgeax_vfx_runtime.worldTimeWhole)+forgeax_vfx_runtime.worldTimeFract,forgeax_vfx_runtime.worldTimeWhole,forgeax_vfx_runtime.worldTimeFract);\n' +
        '  ' +
        source.acquire +
        '(ctx,&particle,&custom,' +
        index +
        'u,ordinal,chosen);\n' +
        '  forgeax_vfx_particles[chosen]=particle;forgeax_vfx_custom[chosen]=custom;forgeax_vfx_scratch[chosen]=1u;cursor=(chosen+1u)%' +
        capacity +
        'u;\n' +
        ' }lastSequence=sequence;} }',
    )
    .join('\n');
  const control = source.control
    ? ' let controlContext=VfxSpawnContext(forgeax_vfx_runtime.delta,forgeax_vfx_runtime.tick,forgeax_vfx_runtime.seed,forgeax_vfx_runtime.playCycle,0u,f32(forgeax_vfx_runtime.timeWhole)+forgeax_vfx_runtime.timeFract,forgeax_vfx_runtime.timeWhole,forgeax_vfx_runtime.timeFract,f32(forgeax_vfx_runtime.worldTimeWhole)+forgeax_vfx_runtime.worldTimeFract,forgeax_vfx_runtime.worldTimeWhole,forgeax_vfx_runtime.worldTimeFract);' +
      source.control +
      '(controlContext);\n'
    : '';
  const accessors = source.control
    ? 'fn vfx_pool_load_particle(slot:u32)->VfxParticle{if(slot<' +
      capacity +
      'u){return forgeax_vfx_particles[slot];}var empty:VfxParticle;return empty;}\n' +
      'fn vfx_pool_load_custom(slot:u32)->VfxCustom{if(slot<' +
      capacity +
      'u){return forgeax_vfx_custom[slot];}var empty:VfxCustom;return empty;}\n' +
      'fn vfx_pool_store_particle(slot:u32,particle:VfxParticle){if(slot<' +
      capacity +
      'u){forgeax_vfx_particles[slot]=particle;forgeax_vfx_scratch[slot]=select(0u,1u,particle.alive!=0u);}}\n' +
      'fn vfx_pool_store_custom(slot:u32,custom:VfxCustom){if(slot<' +
      capacity +
      'u){forgeax_vfx_custom[slot]=custom;}}\n'
    : '';
  return (
    accessors +
    '@compute @workgroup_size(1)\nfn ' +
    GPU_SLOT_ALLOCATOR_ENTRY +
    '(@builtin(global_invocation_id) invocation:vec3<u32>){\n' +
    ' if(invocation.x!=0u){return;}let params=vfx_parameters();\n' +
    ' var cursor=u32(max(0.0,forgeax_vfx_custom[0].' +
    state.cursor +
    '))%' +
    capacity +
    'u;\n' +
    ' var lastSequence=u32(max(0.0,forgeax_vfx_custom[0].' +
    state.sequence +
    '));\n' +
    commands +
    '\n' +
    control +
    ' forgeax_vfx_custom[0].' +
    state.cursor +
    '=f32(cursor);forgeax_vfx_custom[0].' +
    state.sequence +
    '=f32(lastSequence);\n}'
  );
}
