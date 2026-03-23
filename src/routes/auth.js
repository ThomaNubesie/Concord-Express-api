require('dotenv').config();
const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');

// In-memory OTP store
const otpStore = new Map();

// ── Helper: generate and store OTP ───────────────────────────────────────────

function generateOTP(key) {
  const otp     = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = Date.now() + 10 * 60 * 1000; // 10 minutes
  otpStore.set(key, { otp, expires, attempts: 0 });
  console.log(`[OTP] ${key}: ${otp}`);
  return otp;
}

// ── Helper: send email via Resend ─────────────────────────────────────────────

async function sendEmailOTP(email, otp) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[DEV] Email OTP for ${email}: ${otp}`);
    return true;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    'Concord Xpress <noreply@concordxpress.com>',
        to:      [email],
        subject: `Your Concord Xpress code: ${otp}`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
            <h1 style="color:#00E06C;font-size:28px;margin-bottom:8px">🍁 Concord Xpress</h1>
            <p style="color:#666;margin-bottom:32px">Your verification code:</p>
            <div style="background:#111;border-radius:12px;padding:24px;text-align:center;margin-bottom:32px">
              <span style="font-size:48px;font-weight:900;letter-spacing:12px;color:#00E06C">${otp}</span>
            </div>
            <p style="color:#666;font-size:14px">This code expires in 10 minutes.</p>
            <p style="color:#666;font-size:14px">If you didn't request this, ignore this email.</p>
          </div>
        `,
      }),
    });
    return res.ok;
  } catch (err) {
    console.error('[Email OTP] Error:', err);
    return false;
  }
}

// ── POST /api/auth/send-otp — Phone OTP ───────────────────────────────────────

router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });

    const normalized = phone.replace(/\D/g, '');
    const e164 = normalized.startsWith('1') ? `+${normalized}` : `+1${normalized}`;
    const otp  = generateOTP(e164);

    res.json({
      success:  true,
      message:  'OTP sent',
      dev_otp:  otp, // always return in dev — remove in production
    });
  } catch (err) {
    console.error('[Auth] send-otp error:', err);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// ── POST /api/auth/send-email-otp — Email OTP (recovery) ─────────────────────

router.post('/send-email-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const normalizedEmail = email.toLowerCase().trim();

    // Check if this email is registered
    const { data: user } = await supabase
      .from('users')
      .select('id, email, full_name')
      .eq('email', normalizedEmail)
      .single();

    if (!user) {
      // Don't reveal whether email exists — security best practice
      // But still return success so attacker can't enumerate emails
      return res.json({ success: true, message: 'If this email is registered, a code has been sent.' });
    }

    const otp = generateOTP(normalizedEmail);
    await sendEmailOTP(normalizedEmail, otp);

    res.json({
      success:  true,
      message:  'Code sent to your email',
      dev_otp:  otp, // remove in production
    });
  } catch (err) {
    console.error('[Auth] send-email-otp error:', err);
    res.status(500).json({ error: 'Failed to send email code' });
  }
});

// ── POST /api/auth/verify-otp — Verify phone OTP ────────────────────────────

router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp, fullName } = req.body;
    if (!phone || !otp) return res.status(400).json({ error: 'Phone and OTP are required' });

    const normalized = phone.replace(/\D/g, '');
    const e164 = normalized.startsWith('1') ? `+${normalized}` : `+1${normalized}`;

    const result = await verifyOTPCode(e164, otp);
    if (result.error) return res.status(400).json({ error: result.error });

    const sessionData = await getOrCreateUser({ phone: e164, fullName });
    if (sessionData.error) return res.status(500).json({ error: sessionData.error });

    res.json({ success: true, ...sessionData });
  } catch (err) {
    console.error('[Auth] verify-otp error:', err);
    res.status(500).json({ error: 'Verification failed: ' + err.message });
  }
});

// ── POST /api/auth/verify-email-otp — Verify email OTP (recovery) ────────────

router.post('/verify-email-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and OTP are required' });

    const normalizedEmail = email.toLowerCase().trim();

    const result = await verifyOTPCode(normalizedEmail, otp);
    if (result.error) return res.status(400).json({ error: result.error });

    // Get user by email
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('email', normalizedEmail)
      .single();

    if (!user) return res.status(404).json({ error: 'No account found with this email.' });

    // Create session
    const { data: session, error: sessionError } =
      await supabase.auth.admin.createSession({ user_id: user.id });
    if (sessionError) throw sessionError;

    const { data: userProfile } = await supabase
      .from('users').select('*').eq('id', user.id).single();

    res.json({
      success:       true,
      access_token:  session.access_token,
      refresh_token: session.refresh_token,
      user:          userProfile,
    });
  } catch (err) {
    console.error('[Auth] verify-email-otp error:', err);
    res.status(500).json({ error: 'Verification failed: ' + err.message });
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────────

router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'Refresh token required' });
    const { data, error } = await supabase.auth.refreshSession({ refresh_token });
    if (error) return res.status(401).json({ error: 'Invalid refresh token' });
    res.json({
      access_token:  data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
  } catch (err) {
    res.status(500).json({ error: 'Refresh failed' });
  }
});

// ── DELETE /api/auth/logout ───────────────────────────────────────────────────

router.delete('/logout', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) await supabase.auth.admin.signOut(token);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function verifyOTPCode(key, otp) {
  const stored = otpStore.get(key);
  if (!stored)                     return { error: 'No code found. Request a new one.' };
  if (Date.now() > stored.expires) { otpStore.delete(key); return { error: 'Code expired. Request a new one.' }; }
  if (stored.attempts >= 5)        { otpStore.delete(key); return { error: 'Too many attempts. Request a new code.' }; }
  if (stored.otp !== otp)          { stored.attempts++; return { error: `Invalid code. ${5 - stored.attempts} attempts remaining.` }; }
  otpStore.delete(key);
  return { success: true };
}

async function getOrCreateUser({ phone, fullName }) {
  const safeName = (fullName || "Concord User").replace(/[^\x00-\x7F]/g, "").trim() || "Concord User";
  try {
    const { data: existingUser } = await supabase
      .from('users').select('id').eq('phone', phone).single();

    let userId;

    if (existingUser) {
      userId = existingUser.id;
    } else {
      const { data: authData, error: authError } =
        await supabase.auth.admin.createUser({ phone, phone_confirm: true });
      if (authError) throw authError;
      userId = authData.user.id;

      const { count } = await supabase
        .from('users').select('*', { count: 'exact', head: true });

      await supabase.from('users').insert({
        id:                userId,
        phone,
        full_name:         safeName,
        is_founding_member:(count ?? 0) < 100,
      });
    }

    const { data: session, error: sessionError } =
      await supabase.auth.admin.createSession({ user_id: userId });
    if (sessionError) throw sessionError;

    const { data: userProfile } = await supabase
      .from('users').select('*').eq('id', userId).single();

    return {
      access_token:  session.access_token,
      refresh_token: session.refresh_token,
      user:          userProfile,
    };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = router;
