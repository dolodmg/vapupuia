import axios from 'axios';
import type { Readable } from 'node:stream';

interface StreamTextToSpeechOptions {
  text: string;
  apiKey: string;
  voiceId: string;
  optimizeStreamingLatency?: 0 | 1 | 2 | 3 | 4;
  onChunk: (mulawChunk: Buffer) => void;
}

const FRAME_SIZE = 160; // 20 ms @ 8kHz

export const streamTextToSpeech = async ({
  text,
  apiKey,
  voiceId,
  optimizeStreamingLatency = 1,
  onChunk,
}: StreamTextToSpeechOptions): Promise<void> => {
  const response = await axios.post<unknown>(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
    {
      text,
      optimize_streaming_latency: optimizeStreamingLatency,
      output_format: 'ulaw_8000',
    },
    {
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/ulaw',
      },
      responseType: 'stream',
    },
  );

  const audioStream = response.data as Readable;

  await new Promise<void>((resolve, reject) => {
    let pending = Buffer.alloc(0);

    audioStream.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= FRAME_SIZE) {
        const frame = pending.subarray(0, FRAME_SIZE);
        pending = pending.subarray(FRAME_SIZE);
        onChunk(frame);
      }
    });

    audioStream.on('end', () => {
      if (pending.length > 0) {
        const padded = Buffer.alloc(FRAME_SIZE);
        pending.copy(padded);
        onChunk(padded);
      }
      resolve();
    });

    audioStream.on('error', (error: unknown) => reject(error));
  });
};
