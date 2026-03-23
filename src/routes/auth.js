require('dotenv').config();
const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const { v4: uuidv4 } = require('uuid');
const jwt      = require('jsonwebtoken');

const otpStore = new Map();
const JWT_SECRET = process.env.JWT_SECRET || 'concordxpress-secret';

function generateOTP(key) {
  const otp     = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = Date.now() + 10 * 60 * 1000;
  otpStore.set(key, { otp, expires, attempts: 0 });
  console.log('[OTP] ' + key + ': ' + otp);
  return otp;
}

router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });
    const digits = phone.replace(/\D/g, '');
    const e164 = digits.startsWith('1') ? '+' + digits : '+1' + digits;
    const otp = generateOTP(e164);
    res.json({ success: true, message: 'OTP sent', dev_otp: otp });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp, fullName } = req.body;
    if (!phone || !otp) return res.status(400).json({ error: 'Phone and OTP are required' });
    const digits = phone.replace(/\D/g, '');
    const e164 = digits.startsWith('1') ? '+' + digits : '+1' + digits;
    const stored = otpStore.get(e164);
    if (!stored) return res.status(400).json({ error: 'No code found. Request a new one.' });
    if (Date.now() > stored.expires) { otpStore.delete(e164); return res.status(400).json({ error: 'Code expired.' }); }
    if (stored.attempts >= 5) { otpStore.delete(e164); return res.status(400).json({ error: 'Too many attempts.' }); }
    if (stored.otp !== otp) { stored.attempts++; return res.status(400).json({ error: 'Invalid code.' }); }
    otpStore.delete(e164);
    const safeName = ((fullName || 'Concord User').replace(/[^\x00-\x7F]/g, '').trim()) || 'Concord User';
    const { data: existingUser } = await supabase.from('users').select('*').eq('phone', e164).single();
    let user;
    if (existingUser) {
      user = existingUser;
    } else {
      const userId = uuidv4();
      const { count } = await supabase.from('users').select('*', { count: 'exact', head: true });
      const { data: newUser, error: insertError } = await supabase
        .from('users')
        .insert({ id: userId, phone: e164, full_name: safeName, is_founding_member: (count ?? 0) < 100 })
        .select().single();
      if (insertError) throw insertError;
      user = newUser;
    }
    const accessToken  = jwt.sign({ sub: user.id, phone: e164 }, JWT_SECRET, { expiresIn: '1h' });
    const refreshToken = jwt.sign({ sub: user.id, type: 'refresh' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, access_token: accessToken, refresh_token: refreshToken, user });
  } catch (err) {
    console.error('[Auth] verify-otp error:', err);
    res.status(500).json({ error: 'Verification failed: ' + err.message });
  }
});

router.post('/send-email-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const e = email.toLowerCase().trim();
    const { data: user } = await supabase.from('users').select('id').eq('email', e).single();
    if (!user) return res.json({ success: true, message: 'If this email is registered, a code has been sent.' });
    const otp = generateOTP(e);
    res.json({ success: true, message: 'Code sent to your email', dev_otp: otp });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send email code' });
  }
});

router.post('/verify-email-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and OTP are required' });
    const e = email.toLowerCase().trim();
    const stored = otpStore.get(e);
    if (!stored) return res.status(400).json({ error: 'No code found. Request a new one.' });
    if (Date.now() > stored.expires) { otpStore.delete(e); return res.status(400).json({ error: 'Code expired.' }); }
    if (stored.attempts >= 5) { otpStore.delete(e); return res.status(400).json({ error: 'Too many attempts.' }); }
    if (stored.otp !== otp) { stored.attempts++; return res.status(400).json({ error: 'Invalid code.' }); }
    otpStore.delete(e);
    const { data: user } = await supabase.from('users').select('*').eq('email', e).single();
    if (!user) return res.status(404).json({ error: 'No account found with this email.' });
    const accessToken  = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '1h' });
    const refreshToken = jwt.sign({ sub: user.id, type: 'refresh' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, access_token: accessToken, refresh_token: refreshToken, user });
  } catch (err) {
    res.status(500).json({ error: 'Verification failed: ' + err.message });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'Refresh token required' });
    const decoded = jwt.verify(refresh_token, JWT_SECRET);
    const { data: user } = await supabase.from('users').select('*').eq('id', decoded.sub).single();
    if (!user) return res.status(401).json({ error: 'User not found' });
    const newAccess  = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '1h' });
    const newRefresh = jwt.sign({ sub: user.id, type: 'refresh' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ access_token: newAccess, refresh_token: newRefresh });
  } catch (err) {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

router.delete('/logout', async (req, res) => {
  res.json({ success: true });
});

module.exports = router;
