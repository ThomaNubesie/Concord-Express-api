const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const { verifyAuth } = require('../middleware/auth');

router.get('/me', verifyAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('users').select('*, driver_profile:driver_profiles(*)')
    .eq('id', req.userId).single();
  if (error) return res.status(404).json({ error: 'User not found' });
  res.json({ user: data });
});

router.patch('/me', verifyAuth, async (req, res) => {
  const allowed = ['full_name', 'email', 'avatar_url', 'fcm_token', 'role', 'city', 'language', 'country', 'phone'];
  const updates = {};
  for (const field of allowed) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }
  const { data, error } = await supabase
    .from('users').update(updates).eq('id', req.userId).select().single();
  if (error) return res.status(500).json({ error: 'Update failed' });
  res.json({ user: data });
});

// PATCH /api/users/me/driver-profile — update driver profile settings
router.patch('/me/driver-profile', verifyAuth, async (req, res) => {
  const allowed = ['default_cash_only', 'vehicle_make', 'vehicle_model', 'vehicle_year', 'vehicle_color', 'vehicle_plate', 'vehicle_province', 'vehicle_seats', 'vehicle_image_url', 'interac_contact'];
  const updates = {};
  for (const field of allowed) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }
  const { data, error } = await supabase
    .from('driver_profiles')
    .upsert({ user_id: req.userId, ...updates }, { onConflict: 'user_id' })
    .select().single();
  if (error) return res.status(500).json({ error: 'Update failed' });
  res.json({ driver_profile: data });
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, avatar_url, rating_as_driver, rating_as_passenger, total_trips, total_trips_driver, is_verified, created_at')
    .eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'User not found' });
  res.json({ user: data });
});

router.delete('/me', verifyAuth, async (req, res) => {
  await supabase.auth.admin.deleteUser(req.userId);
  await supabase.from('users').delete().eq('id', req.userId);
  res.json({ success: true });
});

// PATCH /api/users/language
router.patch('/language', verifyAuth, async (req, res) => {
  try {
    const { language } = req.body;
    const allowed = ['en','fr','ar','es','sw','ha','wo','yo'];
    if (!allowed.includes(language)) return res.status(400).json({ error: 'Invalid language' });
    const { error } = await supabase.from('users').update({ language }).eq('id', req.userId);
    if (error) throw error;
    res.json({ success: true, language });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update language' });
  }
});

// POST /api/users/translate/ui-batch — translate UI strings batch
router.post('/translate/ui-batch', async (req, res) => {
  try {
    const { strings, target_lang } = req.body;
    if (!strings || !target_lang || target_lang === 'en') {
      return res.json({ translated: strings });
    }
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: `Translate these mobile app UI strings from English to ${target_lang}. Return ONLY valid JSON with identical keys. Keep very short and natural. Do not translate proper nouns like ConcordXpress.\n\n${JSON.stringify(strings)}`
      }],
    });
    const text = msg.content?.[0]?.text?.trim() || '{}';
    const clean = text.replace(/\`\`\`json|\`\`\`/g, '').trim();
    const translated = JSON.parse(clean);
    res.json({ translated });
  } catch (err) {
    res.json({ translated: req.body.strings });
  }
});

module.exports = router;
