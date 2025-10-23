## Sistema de llamada Twilio + ElevenLabs (fase 1)

Este prototipo permite:

1. Recibir una llamada en Twilio y responderla con un saludo alojado previamente (por ejemplo, un MP3 generado y subido a S3/CDN).
2. Abrir un canal **Twilio Media Streams** vía WebSocket hacia este servidor.
3. Detectar actividad de voz del usuario y disparar una respuesta de audio genérica generada en ElevenLabs, entregada de vuelta a la llamada en menos de ~1.5 s.
4. Dejar listo el punto donde luego se integrará un transcriptor (STT) y OpenAI.

### Requisitos previos

- Node.js 18.17+ (trae `fetch`/streams nativos).
- Cuenta Twilio con Voice configurado.
- Audio de saludo precargado en una URL accesible por Twilio (`ELEVENLABS_GREETING_URL`).
- API Key y voice ID de ElevenLabs (agente o voz tradicional) con permiso para streaming (`/v1/text-to-speech/{voice}/stream`).
- (Opcional) Endpoint SSL público; para local usar [ngrok](https://ngrok.com) o el túnel de Twilio.

### Instalación

```bash
npm install
```

Configura variables en `.env` (crea el archivo a partir de `.env.example`):

```
PORT=3000
PUBLIC_WS_BASE=wss://tu-dominio.ngrok.app
ELEVENLABS_GREETING_URL=https://tu-cdn/greeting.mp3
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
GENERIC_REPLY_TEXT=Gracias por comunicarse. En breve lo atenderemos.
MEDIA_STREAM_PATH=/media-stream
```

- `PUBLIC_WS_BASE` debe apuntar al dominio **WSS** que Twilio usará para abrir el Media Stream.
- `MEDIA_STREAM_PATH` tiene que coincidir con el `path` que exponemos en el servidor.
- El saludo inicial debe estar comprimido/normalizado para reproducirse rápido (<300 ms).

### Ejecutar en local

```bash
npm run dev
```

Luego expone el servidor con `ngrok http 3000` y copia:

- Webhook de voz de Twilio → `https://<ngrok>/twilio/voice`
- `PUBLIC_WS_BASE` → `wss://<ngrok>`

### Integración en Twilio

1. Crea/edita un número en **Phone Numbers → Manage → Active Numbers**.
2. En *Voice & Fax / A CALL COMES IN* configura **Webhook** `POST https://<dominio>/twilio/voice`.
3. En Twilio Console habilita **Media Streams** (Voice → Programmable Voice → Settings → Media Streams) si aún no está activado.

La ruta `/twilio/voice` responde con un TwiML como:

```xml
<Response>
  <Play>https://tu-cdn/greeting.mp3</Play>
  <Start>
    <Stream url="wss://<dominio>/media-stream?callSid=..."/>
  </Start>
  <Pause length="600"/>
</Response>
```

### Flujo runtime

1. `Twilio Voice` envía POST → `/twilio/voice`.
2. Generamos TwiML, Twilio reproduce tu audio de bienvenida.
3. Twilio abre un WebSocket a `/media-stream`. Nuestros handlers:
   - Transforman `media.payload` (μ-law 8 kHz) a PCM para STT/pipeline.
   - Aplican una heurística simple de detección de voz (RMS).
   - Cuando detectan voz >400 ms, invocan ElevenLabs y devuelven chunks μ-law 8 kHz (`output_format: "ulaw_8000"`).
4. Se avisa con `mark` al terminar, listos para la siguiente respuesta.

### Dónde enchufar el STT y OpenAI

- Reemplaza `NoopTranscriber` por un servicio real (Deepgram, Whisper Realtime, etc.). El método `handleAudio` recibe PCM 16-bit 8 kHz.
- Al obtener texto, guarda estado por `streamSid` y envía a OpenAI (Chat Completions streaming). En cuanto llegue la idea de respuesta, pásala al `streamTextToSpeech`.
- Controla la cola/latencia: usa `session.outboundInFlight` para no solapar audios.

### Latencia y tuning

- `optimize_streaming_latency` en ElevenLabs: valores bajos (0–1) priorizan velocidad.
- Ajusta `SPEECH_THRESHOLD` y `RESPONSE_DELAY_MS` en `mediaStreamServer.ts` según pruebas reales.
- Twilio envía paquetes cada 20 ms; evita operaciones bloqueantes dentro del handler.

### Hardening pendiente

- Validar firma de Twilio en `/twilio/voice`.
- Guardar logs/instrumentación (Prometheus, Datadog).
- Mecanismo de reintentos si ElevenLabs o STT fallan (enviar `<Say>` fallback).
- Manejar múltiples respuestas por llamada, colgar (`event: "stop"`) cuando corresponda.

Con esto queda armado el esqueleto para reemplazar Vapi y seguir iterando sobre tu agente propio.
