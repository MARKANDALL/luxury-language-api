// /api/tts.js
export default async function handler(req, res) {
  // CORS headers (allow your sandbox to call this)
  res.setHeader('Access-Control-Allow-Origin', '*'); // or set to your exact origin
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end(); // preflight OK
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { text, voice = 'en-US-AvaNeural', rate = '0%' } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Missing text' });
    }

    const key = process.env.AZURE_SPEECH_KEY;
    const region = process.env.AZURE_SPEECH_REGION;
    if (!key || !region) {
      return res.status(500).json({ error: 'Server TTS not configured' });
    }

    const ssml = `
<speak version="1.0" xml:lang="en-US">
  <voice name="${voice}">
    <prosody rate="${rate}">
      ${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}
    </prosody>
  </voice>
</speak>`.trim();

    const endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

    const azureRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'LuxPronunciationTool'
      },
      body: ssml
    });

    if (!azureRes.ok) {
      const detail = await azureRes.text().catch(() => '');
      return res.status(azureRes.status).json({ error: 'Azure TTS error', detail });
    }

    const buf = Buffer.from(await azureRes.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buf);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Unexpected server error' });
  }
}
