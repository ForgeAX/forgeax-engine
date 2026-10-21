import { inflateSync } from 'node:zlib';

/** Decode only the 8-bit RGB/RGBA PNGs emitted by this Playwright capture. */
export function pixels(png) {
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Expected PNG screenshot');
  let width, height, channels;
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); channels = data[9] === 2 ? 3 : data[9] === 6 ? 4 : 0;
      if (data[8] !== 8 || !channels || data[12] !== 0) throw new Error('Unsupported screenshot PNG format');
    } else if (type === 'IDAT') chunks.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels, decoded = new Uint8Array(stride * height);
  const paeth = (a,b,c) => { const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c; };
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)];
    if (filter > 4) throw new Error('Invalid screenshot PNG filter');
    for (let x = 0; x < stride; x++) {
      const index = row * stride + x, a = x >= channels ? decoded[index-channels] : 0, b = row ? decoded[index-stride] : 0, c = row && x >= channels ? decoded[index-stride-channels] : 0;
      const prediction = [0, a, b, Math.floor((a+b)/2), paeth(a,b,c)][filter];
      decoded[index] = (raw[row*(stride+1)+1+x] + prediction) & 255;
    }
  }
  const rgb = new Uint8Array(width*height*3);
  for(let i=0;i<width*height;i++)rgb.set(decoded.subarray(i*channels,i*channels+3),i*3);
  return {width,height,rgb};
}

export function difference(left, right) {
  if(left.width!==right.width||left.height!==right.height)throw new Error('Screenshot dimensions differ');
  let max=0,sum=0,changedPixels=0;
  for(let i=0;i<left.rgb.length;i+=3){
    let changed=false;
    for(let j=0;j<3;j++){const value=Math.abs(left.rgb[i+j]-right.rgb[i+j]);max=Math.max(max,value);sum+=value;changed ||= value>0;}
    if(changed)changedPixels++;
  }
  return {max,mean:sum/left.rgb.length,changedPixels,pixels:left.width*left.height};
}
