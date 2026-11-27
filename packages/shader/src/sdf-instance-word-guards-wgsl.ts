/** Binding-free raw Instance admission. The adapter supplies only the actual
 * sdfInstanceRowCount() and bounds-checked sdfInstanceWord(row,word) fetches. */
export const SDF_INSTANCE_WORD_GUARDS_WGSL = `
fn sdfInstanceMask(row:u32) -> u32 { return sdfInstanceWord(row,19u); }
fn sdfInstanceFloatUsable(word:u32) -> bool {
 let magnitude=word&0x7fffffffu;
 return magnitude==0u || (magnitude>=0x00800000u && magnitude<=0x7f7fffffu);
}
fn sdfInstanceValid(row:u32) -> bool {
 if(row>=sdfInstanceRowCount() || sdfInstanceRowCount()>1024u){return false;}
 if(sdfInstanceMask(row)>255u){return false;}
 for(var word=0u;word<36u;word++){
  if(word>=16u && word<24u){continue;}
  if(!sdfInstanceFloatUsable(sdfInstanceWord(row,word))){return false;}
 }
 if((sdfInstanceWord(row,3u)&0x7fffffffu)!=0u ||
    (sdfInstanceWord(row,7u)&0x7fffffffu)!=0u ||
    (sdfInstanceWord(row,11u)&0x7fffffffu)!=0u || sdfInstanceWord(row,15u)!=0x3f800000u){return false;}
 let mode=sdfInstanceWord(row,35u);
 return mode==0u || mode==0x3f800000u || mode==0x40000000u;
}
`;
