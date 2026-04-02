// routes/voice-clone.js
// One-line: Create, check, or delete a user's ElevenLabs voice clone for Voice Mirror.

import { getSupabaseAdmin } from '../lib/supabase.js';
import { createVoiceClone, deleteVoiceClone } from '../lib/voice.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  const body =
    typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

  const uid = body.uid || body.userId || null;
  const supabase = getSupabaseAdmin();

  // ── STATUS: check if user has a voice profile ────────────────────────
  if (body.action === 'status') {
    if (!uid) return res.status(400).json({ ok: false, error: 'missing uid' });

    const { data: profile } = await supabase
      .from('voice_profiles')
      .select('voice_id, provider, created_at, last_used_at')
      .eq('uid', uid)
      .eq('status', 'active')
      .maybeSingle();

    return res.status(200).json({
      ok: true,
      hasProfile: !!profile,
      ...(profile && {
        voiceId: profile.voice_id,
        provider: profile.provider,
        createdAt: profile.created_at,
      }),
    });
  }

  // ── DELETE: remove a voice profile ───────────────────────────────────
  if (body.action === 'delete') {
    if (!uid) return res.status(400).json({ ok: false, error: 'missing uid' });

    const { data: profile } = await supabase
      .from('voice_profiles')
      .select('voice_id, provider')
      .eq('uid', uid)
      .eq('status', 'active')
      .maybeSingle();

    if (!profile) {
      return res.status(404).json({ ok: false, error: 'no active voice profile found' });
    }

    try {
      await deleteVoiceClone(profile.voice_id);
    } catch (err) {
      console.error('[voice-clone] ElevenLabs delete failed:', err.message);
    }

    await supabase
      .from('voice_profiles')
      .update({ status: 'deleted' })
      .eq('uid', uid)
      .eq('status', 'active');

    return res.status(200).json({ ok: true, deleted: true });
  }

  // ── CREATE: default action ───────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const { audioBase64, userName } = body;
  // audioBase64 can be a single string OR an array of strings (multi-sample)

  if (!uid) return res.status(400).json({ ok: false, error: 'missing uid' });
  if (!audioBase64) return res.status(400).json({ ok: false, error: 'missing audioBase64' });
  if (!userName) return res.status(400).json({ ok: false, error: 'missing userName' });

  // Validate samples
  const samples = Array.isArray(audioBase64) ? audioBase64 : [audioBase64];

  if (samples.length === 0) {
    return res.status(400).json({ ok: false, error: 'No audio samples provided.' });
  }
  if (samples.length > 10) {
    return res.status(400).json({ ok: false, error: 'Too many samples. Max 10.' });
  }

  // Check each sample has reasonable size (> ~3 seconds)
  for (let i = 0; i < samples.length; i++) {
    const buf = Buffer.from(samples[i], 'base64');
    if (buf.length < 30_000) {
      return res.status(400).json({
        ok: false,
        error: `Sample ${i + 1} is too short. Each recording should be at least 10 seconds.`,
      });
    }
  }

  // Check for existing active profile — delete it first (re-clone)
  const { data: existing } = await supabase
    .from('voice_profiles')
    .select('voice_id')
    .eq('uid', uid)
    .eq('status', 'active')
    .maybeSingle();

  if (existing) {
    // Auto-delete old profile to allow re-cloning with better samples
    try {
      await deleteVoiceClone(existing.voice_id);
    } catch (err) {
      console.error('[voice-clone] old clone cleanup failed:', err.message);
    }
    await supabase
      .from('voice_profiles')
      .update({ status: 'deleted' })
      .eq('uid', uid)
      .eq('status', 'active');
  }

  // Create the clone via ElevenLabs (sends all samples)
  try {
    const { voiceId, requiresVerification } = await createVoiceClone({
      audioBase64: samples,
      name: `lux-${uid}-${userName.replace(/\s+/g, '-').toLowerCase()}`,
    });

    if (requiresVerification) {
      return res.status(202).json({
        ok: false,
        error: 'Voice requires ElevenLabs verification. Check your ElevenLabs dashboard.',
        voiceId,
      });
    }

    const { error: dbErr } = await supabase.from('voice_profiles').upsert({
      uid,
      voice_id: voiceId,
      provider: 'elevenlabs',
      user_name: userName,
      created_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
      status: 'active',
    });

    if (dbErr) console.error('[voice-clone] Supabase insert error:', dbErr);

    return res.status(200).json({
      ok: true,
      voiceId,
      samplesUsed: samples.length,
    });
  } catch (err) {
    console.error('[voice-clone] creation failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Voice clone creation failed', detail: err.message });
  }
}