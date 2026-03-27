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
  const allowed = ['full_name', 'email', 'avatar_url', 'fcm_token', 'role', 'city'];
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
  const allowed = ['default_cash_only', 'vehicle_make', 'vehicle_model', 'vehicle_year', 'vehicle_color', 'vehicle_plate', 'vehicle_province'];
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

module.exports = router;
