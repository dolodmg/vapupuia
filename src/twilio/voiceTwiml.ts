// voiceTwiml.ts
import twilio from 'twilio';

export interface VoiceTwimlOptions {
  mediaStreamUrl: string;
  callSid: string;
  participant: string;
}

const { VoiceResponse } = twilio.twiml;

export const buildVoiceTwiml = ({
  mediaStreamUrl,
  callSid,
  participant,
}: VoiceTwimlOptions): string => {
  if (!mediaStreamUrl) {
    throw new Error('Falta configurar PUBLIC_WS_BASE o MEDIA_STREAM_URL.');
  }

  const response = new VoiceResponse();

  const connect = response.connect();
  connect.stream({
    url: `${mediaStreamUrl}?callSid=${encodeURIComponent(callSid)}`,
  });

  return response.toString();
};