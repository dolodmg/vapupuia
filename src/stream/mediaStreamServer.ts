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
  lastSpeechEndedAt?: number;
  greetingSent: boolean;
  greetingCompleted: boolean; // ✅ Nueva flag para saber cuándo terminó el saludo
  speechFramesCount: number; // ✅ Contador de frames con voz detectada
}

interface CreateServerOptions {
  server: http.Server;
  path: string;
}

const DEFAULT_GENERIC_REPLY = 'Gracias por comunicarte. Estamos procesando tu solicitud.';
const RESPONSE_DELAY_MS = 100;
const SPEECH_THRESHOLD = 800;
const MIN_SPEECH_FRAMES = 15; // ✅ Mínimo ~300ms de voz real (15 frames * 20ms)
const ENABLE_ECHO_BACK = process.env.ECHO_BACK === 'true';

export const createMediaStreamServer = ({ server, path }: CreateServerOptions): void => {
  console.log('Modo eco habilitado:', ENABLE_ECHO_BACK);
  console.log('🔧 Creando WebSocket Server en path:', path);

  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Map<string, SessionState>();
  const transcriber = new NoopTranscriber();

  console.log('✅ WebSocket Server creado');

  server.on('upgrade', (req, socket, head) => {
    console.log('🔄 Upgrade request recibido:', req.url);
    console.log('🔄 Headers:', req.headers);
    
    if (!req.url?.startsWith(path)) {
      console.log('❌ URL no coincide con path, destruyendo socket');
      socket.destroy();
      return;
    }

    console.log('✅ URL coincide, haciendo handleUpgrade...');
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log('✅ handleUpgrade completado, emitiendo connection');
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (socket, request) => {
    console.log('🎉 CONNECTION EVENT DISPARADO!!!');
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

      console.log('📨 Mensaje recibido:', payload.event);

      switch (payload.event) {
        case 'start':
          const actualCallSid = payload.start.callSid || callSid;
          
          session = {
            callSid: actualCallSid,
            streamSid: payload.start.streamSid,
            socket,
            lastInboundAt: Date.now(),
            outboundInFlight: false,
            greetingSent: false,
            greetingCompleted: false, // ✅ Inicializar en false
            speechFramesCount: 0, // ✅ Inicializar contador
          };
          sessions.set(actualCallSid, session);
          console.log(`✅ Stream iniciado - callSid=${actualCallSid}, streamSid=${payload.start.streamSid}`);
          console.log(`📋 Tracks disponibles:`, payload.start.tracks);
          
          // Enviar saludo inicial
          const greetingText = process.env.GREETING_TEXT ?? 'Hola, bienvenido. ¿En qué puedo ayudarte?';
          console.log('👋 Preparando saludo:', greetingText);
          sendGreeting(session, greetingText).catch(err => {
            console.error('Error enviando saludo:', err);
          });
          
          break;

        case 'media':
          if (!session) {
            return;
          }
          session.lastInboundAt = Date.now();
          {
            const chunk = Buffer.from(payload.media.payload, 'base64');
            const pcm = decodeMuLaw(chunk);
            const volume = averageVolume(pcm);

            const isSpeech = volume > SPEECH_THRESHOLD;

            // ✅ SOLO detectar voz del usuario DESPUÉS de que terminó el saludo
            if (isSpeech && !session.outboundInFlight && session.greetingCompleted) {
              if (!session.speechDetectedAt) {
                console.log('🎤 Detección de voz inbound (volumen:', volume, ')');
                session.speechDetectedAt = Date.now();
                session.speechFramesCount = 0; // Reset contador
              }
              session.speechFramesCount++; // ✅ Incrementar contador de frames con voz
              session.lastSpeechEndedAt = undefined;
              transcriber.handleAudio(pcm);
            } else if (!isSpeech && session.speechDetectedAt && !session.outboundInFlight) {
              // ✅ Solo responder si hubo suficientes frames de voz real
              if (session.speechFramesCount >= MIN_SPEECH_FRAMES) {
                if (!session.lastSpeechEndedAt) {
                  console.log(`🤫 Usuario dejó de hablar (${session.speechFramesCount} frames detectados)`);
                  session.lastSpeechEndedAt = Date.now();
                }

                if (Date.now() - session.lastSpeechEndedAt > RESPONSE_DELAY_MS) {
                  console.log('🎯 Enviando respuesta tras', RESPONSE_DELAY_MS, 'ms de silencio');
                  session.outboundInFlight = true;
                  
                  session.speechDetectedAt = undefined;
                  session.lastSpeechEndedAt = undefined;
                  session.speechFramesCount = 0; // Reset contador
                  
                  const currentSession = session;
                  sendGenericReply(currentSession).catch((error) => {
                    console.error('❌ Error enviando respuesta ElevenLabs', error);
                    currentSession.outboundInFlight = false;
                  });
                }
              } else {
                // Fue ruido breve, no voz real - resetear
                console.log(`⚠️  Ruido breve detectado (${session.speechFramesCount} frames), ignorando...`);
                session.speechDetectedAt = undefined;
                session.speechFramesCount = 0;
                session.lastSpeechEndedAt = undefined;
              }
            }
          }
          break;

        case 'mark':
          console.log('Marca recibida:', payload);
          // ✅ Detectar cuando terminó el saludo
          if (session && payload.mark?.name === 'greeting_complete') {
            session.greetingCompleted = true;
            console.log('✅ Saludo completado - ahora escuchando al cliente');
          }
          break;

        case 'stop':
          if (session) {
            sessions.delete(session.callSid);
          }
          console.log(`Stream finalizado callSid=${callSid}`);
          break;

        default:
          console.log('Evento desconocido:', payload.event);
          break;
      }
    });

    socket.on('close', () => {
      if (session) {
        sessions.delete(session.callSid);
      }
      console.log(`Socket cerrado callSid=${callSid}`);
    });

    socket.on('error', (error) => {
      console.error('❌ Error en WebSocket:', error);
    });
  });
};

const sendGreeting = async (session: SessionState, text: string): Promise<void> => {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!voiceId || !apiKey) {
    console.warn('⚠️  No se puede enviar saludo - falta configuración');
    session.greetingSent = true;
    session.greetingCompleted = true; // ✅ Marcar como completado incluso si falla
    return;
  }

  console.log('👋 Enviando saludo inicial...');
  console.log('   VoiceID:', voiceId.substring(0, 8) + '...');
  console.log('   Texto:', text);

  let chunkNumber = 1;

  try {
    // ✅ Enviar directamente, sin buffering
    await streamTextToSpeech({
      text,
      apiKey,
      voiceId,
      onChunk: (chunk) => {
        if (session.socket.readyState !== session.socket.OPEN) {
          console.warn('⚠️  Socket cerrado durante greeting');
          return;
        }

        const message = JSON.stringify({
          event: 'media',
          streamSid: session.streamSid,
          media: {
            track: 'outbound',
            chunk: String(chunkNumber),
            timestamp: String(Date.now()),
            payload: chunk.toString('base64')
          }
        });

        session.socket.send(message);
        
        if (chunkNumber === 1 || chunkNumber % 50 === 0) {
          console.log(`👋 Greeting chunk ${chunkNumber} enviado`);
        }
        
        chunkNumber++;
      },
    });

    console.log(`✅ Saludo inicial enviado (${chunkNumber - 1} chunks)`);
    
    if (session.socket.readyState === session.socket.OPEN) {
      session.socket.send(
        JSON.stringify({
          event: 'mark',
          streamSid: session.streamSid,
          mark: {
            name: 'greeting_complete'
          }
        })
      );
      console.log('🏁 Marca "greeting_complete" enviada');
    }
  } catch (error) {
    console.error('❌ Error enviando saludo:', error);
    if (error instanceof Error) {
      console.error('   Message:', error.message);
    }
  } finally {
    session.greetingSent = true;
    console.log('✅ greetingSent = true');
  }
};

const sendGenericReply = async (session: SessionState): Promise<void> => {
  const text = process.env.GENERIC_REPLY_TEXT ?? DEFAULT_GENERIC_REPLY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey = process.env.ELEVENLABS_API_KEY;

  console.log('🔊 Iniciando respuesta ElevenLabs');
  console.log('   Texto:', text);

  if (!voiceId || !apiKey) {
    console.warn('⚠️  Falta ELEVENLABS_VOICE_ID o ELEVENLABS_API_KEY');
    session.outboundInFlight = false;
    return;
  }

  const startedAt = Date.now();
  let chunkNumber = 1;

  try {
    console.log('📡 Llamando a ElevenLabs API...');
    
    // ✅ Enviar directamente, sin buffering ni delays
    await streamTextToSpeech({
      text,
      apiKey,
      voiceId,
      onChunk: (chunk) => {
        if (session.socket.readyState !== session.socket.OPEN) {
          console.warn('⚠️  Socket cerrado, no se puede enviar');
          return;
        }

        const message = JSON.stringify({
          event: 'media',
          streamSid: session.streamSid,
          media: {
            track: 'outbound',
            chunk: String(chunkNumber),
            timestamp: String(Date.now()),
            payload: chunk.toString('base64')
          }
        });

        if (chunkNumber === 1 || chunkNumber % 50 === 0) {
          console.log(`📤 Chunk ${chunkNumber} enviado`);
        }
        
        session.socket.send(message);
        chunkNumber++;
      },
    });

    console.log(`✅ Total chunks enviados: ${chunkNumber - 1}`);

    if (session.socket.readyState === session.socket.OPEN) {
      session.socket.send(
        JSON.stringify({
          event: 'mark',
          streamSid: session.streamSid,
          mark: {
            name: 'audio_complete'
          }
        })
      );
      console.log('🏁 Marca "audio_complete" enviada');
    }

    console.log(`✅ Respuesta ElevenLabs enviada en ${Date.now() - startedAt} ms`);
  } catch (error) {
    console.error('❌ Error en streamTextToSpeech:', error);
    throw error;
  } finally {
    session.outboundInFlight = false;
    console.log('♻️  Listo para detectar nueva voz');
  }
};