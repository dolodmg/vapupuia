export const averageVolume = (pcm: Int16Array): number => {
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    sum += Math.abs(pcm[i]);
  }
  return sum / pcm.length;
};
