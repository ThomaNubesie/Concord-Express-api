const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const twilio   = require('twilio')(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// In-memory OTP store (use Redis in production)
const otpStore = new Map();

// ── POST /api/auth/send-otp ───────────────────────────────────────────────────

router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Normalize phone number
    const normalized = phone.replace(/\D/g, '');
    const e164 = normalized.startsWith('1')
      ? `+${normalized}`
      : `+1${normalized}`;

    // Generate 6-digit OTP
    const otp     = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Store OTP
    otpStore.set(e164, { otp, expires, attempts: 0 });

    // Send via Twilio (or log in development)
    if (process.env.NODE_ENV === 'production') {
      await twilio.messages.create({
        body: `Your Concord Xpress code is: ${otp}. Valid for 10 minutes.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to:   e164,
      });
    } else {
      // Development: log OTP instead of sending SMS
      console.log(`[DEV] OTP for ${e164}: ${otp}`);
    }

    res.json({ success: true, message: 'OTP sent' });
  } catch (err) {
    console.error('[Auth] send-otp error:', err);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// ── POST /api/auth/verify-otp ─────────────────────────────────────────────────

router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp, fullName } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ error: 'Phone and OTP are required' });
    }

    const normalized = phone.replace(/\D/g, '');
    const e164 = normalized.startsWith('1')
      ? `+${normalized}`
      : `+1${normalized}`;

    // Check OTP
    const stored = otpStore.get(e164);

    if (!stored) {
      return res.status(400).json({ error: 'No OTP found for this number. Request a new one.' });
    }

    if (Date.now() > stored.expires) {
      otpStore.delete(e164);
      return res.status(400).json({ error: 'OTP expired. Request a new one.' });
    }

    if (stored.attempts >= 5) {
      otpStore.delete(e164);
      return res.status(400).json({ error: 'Too many attempts. Request a new OTP.' });
    }

    if (stored.otp !== otp) {
      stored.attempts++;
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    // OTP valid — clear it
    otpStore.delete(e164);

    // Sign in or create user via Supabase Auth
    // Use phone as identifier
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      phone:              e164,
      phone_confirm:      true,
      user_metadata:      { full_name: fullName },
    });

    let userId;

    if (authError?.message?.includes('already been registered')) {
      // User exists — get their session
      const { data: existingUser } = await supabase
        .from('users')
        .select('id')
        .eq('phone', e164)
        .single();

      userId = existingUser?.id;
    } else if (authError) {
      console.error('[Auth] Create user error:', authError);
      return res.status(500).json({ error: 'Authentication failed' });
    } else {
      userId = authData.user.id;

      // Create user profile
      await supabase.from('users').insert({
        id:        userId,
        phone:     e164,
        full_name: fullName || 'Concord User',
        // Check if this is a founding member (first 100 users)
        is_founding_member: await isFoundingMember(),
      });
    }

    // Generate session token
    const { data: session, error: sessionError } = await supabase.auth.admin
      .createSession({ user_id: userId });

    if (sessionError) {
      console.error('[Auth] Session error:', sessionError);
      return res.status(500).json({ error: 'Failed to create session' });
    }

    // Get full user profile
    const { data: userProfile } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    res.json({
      success:      true,
      access_token: session.access_token,
      refresh_token:session.refresh_token,
      user:         userProfile,
    });
  } catch (err) {
    console.error('[Auth] verify-otp error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────────

router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

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
    if (token) {
      await supabase.auth.admin.signOut(token);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function isFoundingMember() {
  const { count } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true });
  return (count ?? 0) < 100;
}

module.exports = router;
