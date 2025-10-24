import axios from 'axios';
import type { Readable } from 'node:stream';
import { encodeMuLaw } from '../audio/mulaw.js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { PassThrough } from 'node:stream';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

interface StreamTextToSpeechOptions {
  text: string;
  apiKey: string;
  voiceId: string;
  optimizeStreamingLatency?: 0 | 1 | 2 | 3 | 4;
  onChunk: (mulawChunk: Buffer) => void;
}

const MULAW_FRAME_SIZE = 160; // 20ms @ 8kHz

export const streamTextToSpeech = async ({
  text,
  apiKey,
  voiceId,
  optimizeStreamingLatency = 4, 
  onChunk,
}: StreamTextToSpeechOptions): Promise<void> => {
  if (!text || text.trim().length === 0) {
    throw new Error('El texto no puede estar vacío');
  }
  
  if (!apiKey || !voiceId) {
    throw new Error('API key y voice ID son requeridos');
  }

  console.log('🌐 Haciendo request a ElevenLabs...');
  console.log('   Texto:', text);
  
  let response;
  
  try {
    response = await axios.post<unknown>(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      {
        text,
        model_id: 'eleven_multilingual_v2', 
        output_format: 'mp3_22050_32', 
        optimize_streaming_latency: optimizeStreamingLatency,
      },
      {
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        responseType: 'stream',
        timeout: 30000,
      },
    );

    console.log('✅ Response recibida, status:', response.status);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error('❌ Error:', error.response?.status, error.response?.data);
    }
    throw error;
  }

  const mp3Stream = response.data as Readable;
  let framesSent = 0;
  const startTime = Date.now();

  await new Promise<void>((resolve, reject) => {
    let pending = Buffer.alloc(0);
    const PCM_FRAME_SIZE = 320; // 160 samples * 2 bytes @ 8kHz

    // PassThrough stream para mejor control
    const passThroughStream = new PassThrough();
    mp3Stream.pipe(passThroughStream);

    // Configurar ffmpeg con opciones de baja latencia
    const command = ffmpeg()
      .input(passThroughStream)
      .inputFormat('mp3')
      .audioCodec('pcm_s16le')
      .audioFrequency(8000) // ✅ Directo a 8kHz (sin downsample después)
      .audioChannels(1)
      .format('s16le')
      .outputOptions([
        '-fflags nobuffer', // ✅ Sin buffering
        '-flags low_delay', // ✅ Baja latencia
        '-probesize 32', // ✅ Probe pequeño
        '-analyzeduration 0', // ✅ No analizar
      ])
      .on('error', (err) => {
        console.error('❌ Error en ffmpeg:', err);
        reject(err);
      })
      .on('start', (commandLine) => {
        console.log('🎬 FFmpeg started:', commandLine);
      });

    const pcmStream = command.pipe() as Readable;

    pcmStream.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      
      while (pending.length >= PCM_FRAME_SIZE) {
        const pcmFrame = pending.subarray(0, PCM_FRAME_SIZE);
        pending = pending.subarray(PCM_FRAME_SIZE);
        
        // Ya está a 8kHz, convertir directamente a Int16Array
        const samples8k = new Int16Array(MULAW_FRAME_SIZE);
        for (let i = 0; i < MULAW_FRAME_SIZE; i++) {
          samples8k[i] = pcmFrame.readInt16LE(i * 2);
        }
        
        // Convertir a muLaw
        const mulawFrame = encodeMuLaw(samples8k);
        
        framesSent++;
        if (framesSent === 1) {
          console.log(`⚡ Primer frame en ${Date.now() - startTime}ms`);
        }
        if (framesSent % 50 === 0) {
          console.log(`📤 Frame ${framesSent}`);
        }
        
        onChunk(mulawFrame);
      }
    });

    pcmStream.on('end', () => {
      console.log(`🏁 Total: ${framesSent} frames en ${Date.now() - startTime}ms`);
      resolve();
    });

    pcmStream.on('error', (error) => {
      console.error('❌ Error en PCM stream:', error);
      reject(error);
    });
  });
};