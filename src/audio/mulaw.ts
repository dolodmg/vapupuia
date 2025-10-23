const MU_LAW_MAX = 0x1FFF;
const LOG_TABLE: number[] = [];

for (let i = 0; i < 256; i += 1) {
  let value = i ^ 0xFF;
  let t = ((value & 0x0F) << 3) + 0x84;
  t <<= 1;
  t += 0x02;
  const sign = value & 0x80 ? -1 : 1;
  const exponent = (value >> 4) & 0x07;
  t <<= exponent;
  LOG_TABLE[i] = sign * (t - 0x84);
}

export const decodeMuLaw = (buffer: Buffer): Int16Array => {
  const out = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i += 1) {
    out[i] = LOG_TABLE[buffer[i]];
  }
  return out;
};

const BIAS = 0x84;

export const encodeMuLaw = (pcm: Int16Array): Buffer => {
  const out = Buffer.alloc(pcm.length);
  const cBias = 0x84;
  const cClip = 32635;

  for (let i = 0; i < pcm.length; i += 1) {
    let sample = pcm[i];
    let sign = sample < 0 ? 0x80 : 0;
    if (sample < 0) {
      sample = -sample;
    }
    if (sample > cClip) {
      sample = cClip;
    }
    sample += cBias;

    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
      exponent -= 1;
    }

    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    const mulaw = ~(sign | (exponent << 4) | mantissa);
    out[i] = mulaw;
  }

  return out;
};

export const monoPcmToBuffer = (pcm: Int16Array): Buffer => {
  const buffer = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i += 1) {
    buffer.writeInt16LE(pcm[i], i * 2);
  }
  return buffer;
};
