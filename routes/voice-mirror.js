// routes/voice-mirror.js
// One-line: Synthesize corrected pronunciation text in the user's cloned voice via ElevenLabs TTS.

import { getSupabaseAdmin } from '../lib/supabase.js';
import { synthesizeSpeech } from '../lib/voice.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Only POST allowed' });

  const body =
    typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

  const uid = body.uid || body.userId || null;
  const targetText = (body.targetText || body.text || '').trim();

  if (!uid) return res.status(400).json({ ok: false, error: 'missing uid' });
  if (!targetText) return res.status(400).json({ ok: false, error: 'missing targetText' });

  // Cap text length to control ElevenLabs costs (1 credit per character)
  const MAX_CHARS = 1000;
  if (targetText.length > MAX_CHARS) {
    return res.status(400).json({
      ok: false,
      error: `Text too long (${targetText.length} chars). Max ${MAX_CHARS}.`,
    });
  }

  // Look up user's voice profile
  const supabase = getSupabaseAdmin();
  const { data: profile } = await supabase
    .from('voice_profiles')
    .select('voice_id')
    .eq('uid', uid)
    .eq('status', 'active')
    .maybeSingle();

  if (!profile) {
    return res.status(404).json({
      ok: false,
      error: 'No voice profile found. Create one first via voice-clone.',
    });
  }

  try {
    const audioBuffer = await synthesizeSpeech({
      voiceId: profile.voice_id,
      text: targetText,
    });

    // Update last_used_at (fire-and-forget)
    supabase
      .from('voice_profiles')
      .update({ last_used_at: new Date().toISOString() })
      .eq('uid', uid)
      .then(() => {})
      .catch(() => {});

    // Return audio as base64 in JSON (matches your tts.js pattern when timings are requested)
    return res.status(200).json({
      ok: true,
      audioBase64: audioBuffer.toString('base64'),
      contentType: 'audio/mpeg',
    });
  } catch (err) {
    console.error('[voice-mirror] synthesis failed:', err.message);
    return res.status(502).json({ ok: false, error: 'Synthesis failed', detail: err.message });
  }
}