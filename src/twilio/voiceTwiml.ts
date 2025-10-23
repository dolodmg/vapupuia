import twilio from 'twilio';

export interface VoiceTwimlOptions {
  greetingUrl: string;
  mediaStreamUrl: string;
  callSid: string;
  participant: string;
}

const { VoiceResponse } = twilio.twiml;

export const buildVoiceTwiml = ({
  greetingUrl,
  mediaStreamUrl,
  callSid,
  participant,
}: VoiceTwimlOptions): string => {
  if (!mediaStreamUrl) {
    throw new Error('Falta configurar PUBLIC_WS_BASE o MEDIA_STREAM_URL.');
  }
  if (!greetingUrl) {
    console.warn('No se configuró ELEVENLABS_GREETING_URL, la llamada iniciará sin saludo.');
  }

  const response = new VoiceResponse();

  if (greetingUrl) {
    response.play({}, greetingUrl);
  }

  const start = response.start();
  start.stream({
    url: `${mediaStreamUrl}?callSid=${encodeURIComponent(callSid)}`,
    track: 'both_tracks',
    name: participant || 'anonymous',
  });

  response.pause({ length: 600 });

  return response.toString();
};
