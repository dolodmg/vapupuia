import http from 'node:http';
import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { createMediaStreamServer } from './stream/mediaStreamServer.js';
import { buildVoiceTwiml } from './twilio/voiceTwiml.js';

dotenv.config();
console.log('🔍 Verificando configuración:');
console.log('   ELEVENLABS_API_KEY:', process.env.ELEVENLABS_API_KEY ? '✅ Configurada' : '❌ Falta');
console.log('   ELEVENLABS_VOICE_ID:', process.env.ELEVENLABS_VOICE_ID ? '✅ Configurada' : '❌ Falta');
console.log('   GREETING_TEXT:', process.env.GREETING_TEXT || '❌ Usando default');
console.log('   PUBLIC_WS_BASE:', process.env.PUBLIC_WS_BASE || '❌ Falta');

const app = express();

// ✅ LOGGING DE TODAS LAS REQUESTS
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`\n📥 [${timestamp}] ${req.method} ${req.url}`);
  console.log('   Headers:', JSON.stringify({
    'user-agent': req.headers['user-agent'],
    'upgrade': req.headers['upgrade'],
    'connection': req.headers['connection'],
  }, null, 2));
  next();
});

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const port = Number(process.env.PORT ?? 8080);
const mediaStreamPath = process.env.MEDIA_STREAM_PATH ?? '/media-stream';

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    wsPath: mediaStreamPath,
    publicWsBase: process.env.PUBLIC_WS_BASE
  });
});

app.get('/test-ws', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>WebSocket Test</title>
        <style>
          body { font-family: Arial; padding: 20px; }
          #status { font-size: 24px; margin: 20px 0; }
          .success { color: green; }
          .error { color: red; }
          .info { color: blue; }
        </style>
      </head>
      <body>
        <h1>WebSocket Test</h1>
        <div id="status" class="info">🔄 Connecting...</div>
        <div id="log"></div>
        <script>
          const log = document.getElementById('log');
          const status = document.getElementById('status');
          
          function addLog(msg) {
            log.innerHTML += '<div>' + new Date().toLocaleTimeString() + ' - ' + msg + '</div>';
          }
          
          const wsUrl = '${process.env.PUBLIC_WS_BASE}${mediaStreamPath}?callSid=test-browser';
          addLog('Connecting to: ' + wsUrl);
          
          const ws = new WebSocket(wsUrl);
          
          ws.onopen = () => {
            status.innerHTML = '✅ Connected!';
            status.className = 'success';
            addLog('WebSocket connected successfully');
          };
          
          ws.onerror = (e) => {
            status.innerHTML = '❌ Connection Error';
            status.className = 'error';
            addLog('Error: ' + JSON.stringify(e));
          };
          
          ws.onclose = (e) => {
            status.innerHTML = '🔌 Connection Closed';
            status.className = 'info';
            addLog('Closed - Code: ' + e.code + ', Reason: ' + e.reason);
          };
          
          ws.onmessage = (e) => {
            addLog('Message received: ' + e.data);
          };
        </script>
      </body>
    </html>
  `);
});

app.post('/twilio/voice', (req, res) => {
  console.log('\n=== Webhook Twilio llamado ===');
  console.log('CallSid:', req.body.CallSid);
  console.log('From:', req.body.From);
  
  try {
    const twiml = buildVoiceTwiml({
      mediaStreamUrl: `${process.env.PUBLIC_WS_BASE ?? ''}${mediaStreamPath}`,
      callSid: req.body.CallSid ?? '',
      participant: req.body.From ?? '',
    });
    
    console.log('=== TwiML generado ===');
    console.log(twiml);
    console.log('======================\n');
    
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
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 Servidor HTTP escuchando en puerto ${port}`);
  console.log(`📞 Webhook Twilio: POST http://localhost:${port}/twilio/voice`);
  console.log(`🔌 Media Stream WS: ws://localhost:${port}${mediaStreamPath}`);
  console.log(`🌐 URL pública: ${process.env.PUBLIC_WS_BASE}`);
  console.log(`${'='.repeat(60)}\n`);
});
