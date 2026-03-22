require('dotenv').config();
const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');

const otpStore = new Map();

router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });
    const normalized = phone.replace(/\D/g, '');
    const e164 = normalized.startsWith('1') ? `+${normalized}` : `+1${normalized}`;
    const otp     = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 10 * 60 * 1000;
    otpStore.set(e164, { otp, expires, attempts: 0 });
    console.log(`[OTP] ${e164}: ${otp}`);
    res.json({ success: true, message: 'OTP sent', dev_otp: otp });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp, fullName } = req.body;
    if (!phone || !otp) return res.status(400).json({ error: 'Phone and OTP are required' });
    const normalized = phone.replace(/\D/g, '');
    const e164 = normalized.startsWith('1') ? `+${normalized}` : `+1${normalized}`;
    const stored = otpStore.get(e164);
    if (!stored) return res.status(400).json({ error: 'No OTP found. Request a new one.' });
    if (Date.now() > stored.expires) { otpStore.delete(e164); return res.status(400).json({ error: 'OTP expired.' }); }
    if (stored.attempts >= 5) { otpStore.delete(e164); return res.status(400).json({ error: 'Too many attempts.' }); }
    if (stored.otp !== otp) { stored.attempts++; return res.status(400).json({ error: 'Invalid OTP' }); }
    otpStore.delete(e164);
    const { data: existingUser } = await supabase.from('users').select('id').eq('phone', e164).single();
    let userId;
    if (existingUser) {
      userId = existingUser.id;
    } else {
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({ phone: e164, phone_confirm: true });
      if (authError) throw authError;
      userId = authData.user.id;
      const { count } = await supabase.from('users').select('*', { count: 'exact', head: true });
      await supabase.from('users').insert({ id: userId, phone: e164, full_name: fullName || 'Concord User', is_founding_member: (count ?? 0) < 100 });
    }
    const { data: session, error: sessionError } = await supabase.auth.admin.createSession({ user_id: userId });
    if (sessionError) throw sessionError;
    const { data: userProfile } = await supabase.from('users').select('*').eq('id', userId).single();
    res.json({ success: true, access_token: session.access_token, refresh_token: session.refresh_token, user: userProfile });
  } catch (err) {
    res.status(500).json({ error: 'Verification failed: ' + err.message });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'Refresh token required' });
    const { data, error } = await supabase.auth.refreshSession({ refresh_token });
    if (error) return res.status(401).json({ error: 'Invalid refresh token' });
    res.json({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
  } catch (err) {
    res.status(500).json({ error: 'Refresh failed' });
  }
});

router.delete('/logout', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) await supabase.auth.admin.signOut(token);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

module.exports = router;
