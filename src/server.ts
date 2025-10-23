import http from 'node:http';
import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { createMediaStreamServer } from './stream/mediaStreamServer.js';
import { buildVoiceTwiml } from './twilio/voiceTwiml.js';

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const port = Number(process.env.PORT ?? 8080);
const mediaStreamPath = process.env.MEDIA_STREAM_PATH ?? '/media-stream';

app.post('/twilio/voice', (req, res) => {
  try {
    const twiml = buildVoiceTwiml({
      greetingUrl: process.env.ELEVENLABS_GREETING_URL ?? '',
      mediaStreamUrl: `${process.env.PUBLIC_WS_BASE ?? ''}${mediaStreamPath}`,
      callSid: req.body.CallSid ?? '',
      participant: req.body.From ?? '',
    });
    res.type('text/xml');
    res.send(twiml);
  } catch (error) {
    console.error('Error generando TwiML:', error);
    res.status(500).send('Error interno');
  }
});

const server = http.createServer(app);

createMediaStreamServer({
  server,
  path: mediaStreamPath,
});

server.listen(port, () => {
  console.log(`Servidor HTTP escuchando en puerto ${port}`);
  console.log(`Webhook Twilio: POST http://localhost:${port}/twilio/voice`);
  console.log(`Media Stream WS: ws://localhost:${port}${mediaStreamPath}`);
});
