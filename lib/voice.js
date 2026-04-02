// lib/voice.js
// One-line: ElevenLabs voice cloning + TTS wrapper for Voice Mirror feature.

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

function getElevenLabsKey() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY not configured');
  return key;
}

/**
 * Create an instant voice clone from one or more base64-encoded audio samples.
 * More samples (up to ~2 minutes total) = better clone quality.
 *
 * @param {Object} opts
 * @param {string|string[]} opts.audioBase64 - single base64 string OR array of base64 strings
 * @param {string} opts.name - name for the cloned voice
 * @returns {Promise<{ voiceId: string, requiresVerification: boolean }>}
 */
export async function createVoiceClone({ audioBase64, name }) {
  const key = getElevenLabsKey();

  const form = new FormData();
  form.append('name', name);
  form.append('description', `Lux Voice Mirror clone: ${name}`);
  form.append('remove_background_noise', 'true');

  // Support both single sample and multi-sample
  const samples = Array.isArray(audioBase64) ? audioBase64 : [audioBase64];

  samples.forEach((b64, i) => {
    const buf = Buffer.from(b64, 'base64');
    const blob = new Blob([buf], { type: 'audio/wav' });
    form.append('files', blob, `voice-sample-${i + 1}.wav`);
  });

  const res = await fetch(`${ELEVENLABS_BASE}/voices/add`, {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: form,
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`ElevenLabs clone failed (${res.status}): ${errBody}`);
  }

  const data = await res.json();
  return { voiceId: data.voice_id, requiresVerification: data.requires_verification };
}

/**
 * Synthesize text using a cloned voice. Returns raw audio Buffer (MP3).
 * @param {Object} opts
 * @param {string} opts.voiceId - ElevenLabs voice ID
 * @param {string} opts.text    - text to speak
 * @returns {Promise<Buffer>}
 */
export async function synthesizeSpeech({ voiceId, text }) {
  const key = getElevenLabsKey();

  const res = await fetch(
    `${ELEVENLABS_BASE}/text-to-speech/${voiceId}?output_format=mp3_22050_32`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${errBody}`);
  }

  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Delete a cloned voice from ElevenLabs.
 * @param {string} voiceId
 * @returns {Promise<boolean>}
 */
export async function deleteVoiceClone(voiceId) {
  const key = getElevenLabsKey();

  const res = await fetch(`${ELEVENLABS_BASE}/voices/${voiceId}`, {
    method: 'DELETE',
    headers: { 'xi-api-key': key },
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`ElevenLabs delete failed (${res.status}): ${errBody}`);
  }

  return true;
}