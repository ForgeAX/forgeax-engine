/** Deliberately synthetic canonical input and frozen World outcomes. Only the
 * production Card status consumer is under test; no raster/contact/World proof
 * is supplied or claimed by this fixture. */
export const CONTROLLED_CARD_RECEIVER_TAG = 0x53594e01;

function replaceBody(source: string, name: string, replacement: string) {
  const marker = `fn ${name}(`;
  if (source.split(marker).length !== 2) throw Error(`One actual ${name} required`);
  const start = source.indexOf(marker),
    body = source.indexOf('{', start);
  let end = body + 1,
    depth = 1;
  while (depth && end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  if (body < 0 || depth) throw Error(`Closed actual ${name} required`);
  return `${source.slice(0, body)}{${replacement}}${source.slice(end)}`;
}

export function frozenCardStatusQuery(source: string) {
  const receiver = replaceBody(
    source,
    'cardReceiver',
    `
 var none:CardCanonicalReceiver;
 if(receiverCase.control.z!=1u||receiverCase.control.w!=${CONTROLLED_CARD_RECEIVER_TAG}u||receiverCase.control.x!=cards[tile].ids.x||frame.expectedSource.w!=1u){return none;}
 let point=sdfIntervalVector(receiverCase.originLo.xyz,receiverCase.originHi.xyz);
 if(!sdfIntervalVectorValid(point)){return none;}
 return CardCanonicalReceiver(point,receiverCase.control.x,receiverCase.control.y,1u);`,
  );
  const contact = replaceBody(
    receiver,
    'cardReceiverContact',
    `
 let none=SdfSurfaceContact(0xffffffffu,0xffffffffu,0u);
 if(receiver.valid!=1u||!sdfSurfaceRayUsable(world)||any(world.originLo!=receiverCase.originLo.xyz)||any(world.originHi!=receiverCase.originHi.xyz)){return none;}
 return SdfSurfaceContact(receiver.row,receiver.primitive,1u);`,
  );
  return (
    replaceBody(
      contact,
      'traceWorld',
      `
 queryObserved[0]=vec4u(queryCase.x,1u,contact.valid,frame.expectedSource.w);
 return Hit(vec4u(queryCase.x,0u,0u,0u),vec4f(0),vec4f(0),vec4f(0));`,
    ) +
    `
struct ControlledCardReceiver { originLo:vec4u, originHi:vec4u, control:vec4u }
@group(0) @binding(17) var<uniform> queryCase:vec4u;
@group(0) @binding(18) var<storage,read_write> queryObserved:array<vec4u>;
@group(0) @binding(19) var<uniform> receiverCase:ControlledCardReceiver;
`
  );
}
