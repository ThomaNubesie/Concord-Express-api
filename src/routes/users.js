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

// POST /api/users/me/avatar — upload a profile picture
const multer = require('multer');
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/me/avatar', verifyAuth, avatarUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!/^image\//.test(req.file.mimetype || '')) {
      return res.status(400).json({ error: 'File must be an image' });
    }

    const ext  = (req.file.mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const path = `${req.userId}/${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
    if (uploadError) throw uploadError;

    const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path);

    const { data, error } = await supabase
      .from('users').update({ avatar_url: publicUrl }).eq('id', req.userId)
      .select().single();
    if (error) throw error;

    res.json({ user: data, avatar_url: publicUrl });
  } catch (err) {
    console.error('[Users] avatar upload error:', err.message);
    res.status(500).json({ error: 'Could not upload your photo. Please try again.' });
  }
});

// GET /api/users/me/savings — what the passenger saved vs other modes.
// Train/Bus: fixed per-corridor reference fares (mode_prices table).
// POP (Poparide) / Kangaroo (Amigo): the SAME ride fare the passenger paid
// plus that platform's fee, since carpool ride prices are comparable. Compared
// against the passenger's ConcordXpress all-in cost (fare + C$2.99/seat).
router.get('/me/savings', verifyAuth, async (req, res) => {
  try {
    const CX_FEE = 2.99;      // ConcordXpress booking fee per seat
    const POP_PCT = 0.15;     // Poparide service fee (% of ride)
    const AMIGO_FEE = 7.00;   // Amigo Express reservation fee per seat

    const { data: bookings } = await supabase
      .from('bookings')
      .select('seats, fare_amount, trip:trips(from_city, to_city)')
      .eq('passenger_id', req.userId)
      .eq('status', 'completed');

    const { data: prices } = await supabase
      .from('mode_prices').select('from_city, to_city, mode, price_cad');
    const priceMap = {};
    for (const p of prices || []) {
      const k = `${p.from_city}|${p.to_city}`;
      (priceMap[k] = priceMap[k] || {})[p.mode] = parseFloat(p.price_cad);
    }

    const m = {
      train:    { ref: 0, saved: 0, trips: 0 },
      bus:      { ref: 0, saved: 0, trips: 0 },
      pop:      { ref: 0, saved: 0, trips: 0 },
      kangaroo: { ref: 0, saved: 0, trips: 0 },
    };
    let trips = 0, totalPaid = 0;

    for (const b of bookings || []) {
      const seats = b.seats || 1;
      const ride  = parseFloat(b.fare_amount || 0); // total ride fare (all seats)
      if (ride <= 0) continue;
      const cxCost = ride + CX_FEE * seats;
      trips++; totalPaid += cxCost;

      const rp = priceMap[`${b.trip?.from_city}|${b.trip?.to_city}`] || {};
      // carpools — always comparable
      const popCost = ride * (1 + POP_PCT);
      const kanCost = ride + AMIGO_FEE * seats;
      m.pop.ref += popCost;      m.pop.saved += popCost - cxCost;      m.pop.trips++;
      m.kangaroo.ref += kanCost; m.kangaroo.saved += kanCost - cxCost; m.kangaroo.trips++;
      // fixed-price modes — only when we have a reference fare for the route
      if (rp.train != null) { const c = rp.train * seats; m.train.ref += c; m.train.saved += c - cxCost; m.train.trips++; }
      if (rp.bus   != null) { const c = rp.bus   * seats; m.bus.ref   += c; m.bus.saved   += c - cxCost; m.bus.trips++; }
    }

    const r2 = x => Math.round(x * 100) / 100;
    for (const k of Object.keys(m)) { m[k].ref = r2(m[k].ref); m[k].saved = r2(m[k].saved); }
    res.json({ trips, total_paid: r2(totalPaid), modes: m });
  } catch (err) {
    console.error('[savings]', err.message);
    res.status(500).json({ error: 'Failed to compute savings' });
  }
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select(`
      id, full_name, avatar_url, email, phone,
      rating_as_driver, rating_as_passenger,
      total_trips, total_trips_driver,
      is_verified, is_founding_member, country, language,
      created_at, total_co2_saved_kg,
      driver_profile:driver_profiles (
        id, vehicle_make, vehicle_model, vehicle_year,
        vehicle_color, vehicle_plate, vehicle_seats,
        vehicle_image_url, identity_verified, bio
      )
    `)
    .eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'User not found' });

  // Fetch ratings
  let ratings = [];
  try {
    const { data: ratingsData } = await supabase
      .from('ratings')
      .select('id, score, comment, created_at, rater:rater_id (full_name, avatar_url)')
      .eq('ratee_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(10);
    ratings = ratingsData || [];
  } catch (e) { /* ratings table may not exist */ }

  res.json({ user: data, ratings });
});

router.delete('/me', verifyAuth, async (req, res) => {
  try {
    // Accounts live in our custom `users` table (phone OTP + JWT), not Supabase
    // Auth — so the auth-admin delete is best-effort and must never fail the
    // request (it throws when there's no matching auth user).
    try { await supabase.auth.admin.deleteUser(req.userId); } catch (_) {}
    const { error } = await supabase.from('users').delete().eq('id', req.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('[Users] delete account error:', err.message);
    res.status(500).json({ error: 'Could not delete your account. Please try again.' });
  }
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

    // Chunk strings into batches of 80 to avoid token limits
    const chunkObj = (obj, size) => {
      const keys = Object.keys(obj);
      const chunks = [];
      for (let i = 0; i < keys.length; i += size) {
        const chunk = {};
        keys.slice(i, i + size).forEach(k => { chunk[k] = obj[k]; });
        chunks.push(chunk);
      }
      return chunks;
    };

    const chunks = chunkObj(strings, 80);
    let translated = {};

    for (const chunk of chunks) {
      try {
        const msg = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4000,
          messages: [{
            role: 'user',
            content: `Translate these mobile app UI strings from English to ${target_lang}. Return ONLY valid JSON with identical keys. Keep translations very short and natural for a mobile app. Do not translate: ConcordXpress, C$, XOF, XAF, USD, EUR, SMS, GPS, SOS, OK, ID.

${JSON.stringify(chunk)}`
          }],
        });
        const text = msg.content?.[0]?.text?.trim() || '{}';
        const clean = text.replace(/\`\`\`json|\`\`\`/g, '').trim();
        const chunkTranslated = JSON.parse(clean);
        translated = { ...translated, ...chunkTranslated };
      } catch (chunkErr) {
        // If a chunk fails, use original strings for that chunk
        translated = { ...translated, ...chunk };
      }
    }

    res.json({ translated });
  } catch (err) {
    console.error('[translate/ui-batch]', err);
    res.json({ translated: req.body.strings });
  }
});

// POST /api/users/block/:userId — block a user
router.post('/block/:userId', verifyAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    if (userId === req.userId) return res.status(400).json({ error: 'Cannot block yourself' });
    const { error } = await supabase.from('blocked_users').upsert({
      blocker_id: req.userId, blocked_id: userId
    }, { onConflict: 'blocker_id,blocked_id' });
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/users/block/:userId — unblock a user
router.delete('/block/:userId', verifyAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('blocked_users')
      .delete().eq('blocker_id', req.userId).eq('blocked_id', req.params.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/users/blocked — list blocked users
router.get('/blocked', verifyAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('blocked_users')
      .select('blocked_id, created_at, blocked:users!blocked_users_blocked_id_fkey(id, full_name, avatar_url)')
      .eq('blocker_id', req.userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    const blocked = (data || []).map(b => ({ ...b.blocked, blocked_at: b.created_at }));
    res.json({ blocked });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/users/block-status/:userId — check if user is blocked
router.get('/block-status/:userId', verifyAuth, async (req, res) => {
  try {
    const { data } = await supabase.from('blocked_users')
      .select('id').eq('blocker_id', req.userId).eq('blocked_id', req.params.userId).single();
    res.json({ blocked: !!data });
  } catch { res.json({ blocked: false }); }
});

// GET /api/users/driver-profile-status
router.get('/driver-profile-status', verifyAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from('driver_profiles')
      .select('vehicle_make, vehicle_plate, stripe_account_id, interac_contact, identity_verified')
      .eq('user_id', req.userId).single();

    const hasVehicle  = !!(profile?.vehicle_make && profile?.vehicle_plate);
    const hasPayout   = !!(profile?.stripe_account_id || profile?.interac_contact);
    const hasIdentity = !!(profile?.identity_verified);

    res.json({
      setup_complete: hasVehicle && hasPayout && hasIdentity,
      steps: { identity: hasIdentity, vehicle: hasVehicle, payout: hasPayout }
    });
  } catch {
    res.json({ setup_complete: false, steps: { identity:false, vehicle:false, payout:false } });
  }
});

// POST /api/users/push-token — save Expo push notification token
router.post('/push-token', verifyAuth, async (req, res) => {
  const { push_token, platform } = req.body;
  if (!push_token) return res.status(400).json({ error: 'push_token required' });
  const { error } = await supabase
    .from('users')
    .update({ push_token, push_platform: platform || 'ios' })
    .eq('id', req.userId);
  if (error) return res.status(500).json({ error: 'Failed to save push token' });
  res.json({ ok: true });
});

module.exports = router;
