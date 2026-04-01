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

  // ── GET-style: check status (POST with action:"status") ──────────────
  // (We use POST for everything since the router dispatches POST requests)
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

    // Delete from ElevenLabs (best-effort)
    try {
      await deleteVoiceClone(profile.voice_id);
    } catch (err) {
      console.error('[voice-clone] ElevenLabs delete failed:', err.message);
      // Continue — still mark as deleted in our DB
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

  if (!uid) return res.status(400).json({ ok: false, error: 'missing uid' });
  if (!audioBase64) return res.status(400).json({ ok: false, error: 'missing audioBase64' });
  if (!userName) return res.status(400).json({ ok: false, error: 'missing userName' });

  // Reject tiny samples (< ~3 seconds of 16kHz mono WAV)
  const buf = Buffer.from(audioBase64, 'base64');
  if (buf.length < 80_000) {
    return res.status(400).json({
      ok: false,
      error: 'Audio sample too short. Record at least 15 seconds of clear speech.',
    });
  }

  // Check for existing active profile
  const { data: existing } = await supabase
    .from('voice_profiles')
    .select('voice_id')
    .eq('uid', uid)
    .eq('status', 'active')
    .maybeSingle();

  if (existing) {
    return res.status(409).json({
      ok: false,
      error: 'Voice profile already exists. Delete it first to create a new one.',
      voiceId: existing.voice_id,
    });
  }

  // Create the clone via ElevenLabs
  try {
    const { voiceId, requiresVerification } = await createVoiceClone({
      audioBase64,
      name: `lux-${uid}-${userName.replace(/\s+/g, '-').toLowerCase()}`,
    });

    if (requiresVerification) {
      return res.status(202).json({
        ok: false,
        error: 'Voice requires ElevenLabs verification. Check your ElevenLabs dashboard.',
        voiceId,
      });
    }

    // Store in Supabase
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

    return res.status(200).json({ ok: true, voiceId });
  } catch (err) {
    console.error('[voice-clone] creation failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Voice clone creation failed', detail: err.message });
  }
}