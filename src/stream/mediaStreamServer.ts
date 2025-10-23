import type http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { decodeMuLaw } from '../audio/mulaw.js';
import { streamTextToSpeech } from '../tts/elevenLabsClient.js';
import { NoopTranscriber } from '../transcription/noopTranscriber.js';
import { averageVolume } from '../util/audioMetrics.js';

interface SessionState {
  callSid: string;
  streamSid: string;
  socket: WebSocket;
  lastInboundAt: number;
  speechDetectedAt?: number;
  outboundInFlight: boolean;
}

interface CreateServerOptions {
  server: http.Server;
  path: string;
}

const DEFAULT_GENERIC_REPLY = 'Gracias por comunicarte. Estamos procesando tu solicitud.';
const RESPONSE_DELAY_MS = 400;
const SPEECH_THRESHOLD = 800;
const ENABLE_ECHO_BACK = process.env.ECHO_BACK === 'true';

export const createMediaStreamServer = ({ server, path }: CreateServerOptions): void => {
  console.log('Modo eco habilitado:', ENABLE_ECHO_BACK);

  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Map<string, SessionState>();
  const transcriber = new NoopTranscriber();

  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith(path)) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (socket, request) => {
    const urlParams = new URLSearchParams(request.url?.split('?')[1] ?? '');
    const callSid = urlParams.get('callSid') ?? 'unknown';

    console.log(`Conexión Media Stream iniciada para callSid=${callSid}`);

    let session: SessionState | undefined;

    socket.on('message', async (data) => {
      let payload: any;
      try {
        payload = JSON.parse(data.toString());
      } catch (error) {
        console.error('Mensaje inválido recibido:', error);
        return;
      }

      switch (payload.event) {
        case 'start':
          session = {
            callSid,
            streamSid: payload.start.streamSid,
            socket,
            lastInboundAt: Date.now(),
            outboundInFlight: false,
          };
          sessions.set(callSid, session);
          console.log(`Stream iniciado streamSid=${payload.start.streamSid}`);
          break;

        case 'media':
          if (!session) {
            return;
          }
          session.lastInboundAt = Date.now();
          {
            const chunk = Buffer.from(payload.media.payload, 'base64');
            console.log('Recibí media inbound', chunk.length, 'bytes');

            if (ENABLE_ECHO_BACK && session.socket.readyState === session.socket.OPEN) {
              console.log('Eco saliente', chunk.length, 'bytes');
              session.socket.send(
                JSON.stringify({
                  event: 'media',
                  streamSid: session.streamSid,
                  track: 'outbound_track',
                  media: { payload: payload.media.payload },
                }),
              );
            }

            const pcm = decodeMuLaw(chunk);
            const volume = averageVolume(pcm);

            if (volume > SPEECH_THRESHOLD && !session.speechDetectedAt) {
              console.log('Detección de voz inbound (volumen medio:', volume, ')');
              session.speechDetectedAt = Date.now();
            }

            if (volume > SPEECH_THRESHOLD) {
              transcriber.handleAudio(pcm);
            }

            if (
              session.speechDetectedAt &&
              !session.outboundInFlight &&
              Date.now() - session.speechDetectedAt > RESPONSE_DELAY_MS
            ) {
              session.outboundInFlight = true;
              sendGenericReply(session).catch((error) => {
                console.error('Error enviando respuesta ElevenLabs', error);
              });
            }
          }
          break;

        case 'mark':
          console.log('Marca recibida:', payload);
          break;

        case 'stop':
          if (session) {
            sessions.delete(session.callSid);
          }
          console.log(`Stream finalizado callSid=${callSid}`);
          socket.close();
          break;

        default:
          break;
      }
    });

    socket.on('close', () => {
      if (session) {
        sessions.delete(session.callSid);
      }
      console.log(`Socket cerrado callSid=${callSid}`);
    });
  });
};

const sendGenericReply = async (session: SessionState): Promise<void> => {
  const text = process.env.GENERIC_REPLY_TEXT ?? DEFAULT_GENERIC_REPLY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey = process.env.ELEVENLABS_API_KEY;

  console.log('Iniciando respuesta ElevenLabs');

  if (!voiceId || !apiKey) {
    console.warn('Falta ELEVENLABS_VOICE_ID o ELEVENLABS_API_KEY, no se puede enviar respuesta.');
    session.outboundInFlight = false;
    return;
  }

  const startedAt = Date.now();

  try {
    await streamTextToSpeech({
      text,
      apiKey,
      voiceId,
      onChunk: (chunk) => {
        if (session.socket.readyState !== session.socket.OPEN) {
          return;
        }

        session.socket.send(
          JSON.stringify({
            event: 'media',
            streamSid: session.streamSid,
            track: 'outbound_track',
            media: { payload: chunk.toString('base64') },
          }),
        );
      },
    });

    if (session.socket.readyState === session.socket.OPEN) {
      session.socket.send(
        JSON.stringify({
          event: 'mark',
          streamSid: session.streamSid,
          track: 'outbound_track',
          mark: { name: 'generic_reply_sent' },
        }),
      );
    }

    console.log(`Respuesta ElevenLabs enviada en ${Date.now() - startedAt} ms`);
  } finally {
    session.outboundInFlight = false;
  }
};
