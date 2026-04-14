require('dotenv').config();
const express  = require('express');
const { verifyAuth } = require('../middleware/auth');
const router   = express.Router();
const supabase = require('../lib/supabase');
const { v4: uuidv4 } = require('uuid');
const jwt      = require('jsonwebtoken');

const twilio    = require('twilio');
const twilioClient = process.env.TWILIO_ACCOUNT_SID
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const JWT_SECRET = process.env.JWT_SECRET;

async function generateOTP(key) {
  const otp     = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await supabase.from('otp_store').upsert({ key, otp, expires, attempts: 0 }, { onConflict: 'key' });
  console.log('[OTP] ' + key + ': ' + otp);
  return otp;
}

async function getOTP(key) {
  const { data } = await supabase.from('otp_store').select('*').eq('key', key).single();
  return data;
}

async function deleteOTP(key) {
  await supabase.from('otp_store').delete().eq('key', key);
}

// Track device and IP
async function trackDevice(userId, req) {
  const deviceId = req.headers['x-device-id'] || req.headers['x-request-id'] || null;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const updates = { last_ip: ip };
  if (deviceId) updates.device_id = deviceId;
  await supabase.from('users').update(updates).eq('id', userId).catch(() => {});
}

function makeTokens(userId) {
  const accessToken  = jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '7d' });
  const refreshToken = jwt.sign({ sub: userId, type: 'refresh' }, JWT_SECRET, { expiresIn: '30d' });
  return { accessToken, refreshToken };
}

// Check for duplicate phone BEFORE sending OTP
router.post('/send-otp', async (req, res) => {
  try {
    const { phone, isNewUser } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });
    const e164 = phone.startsWith('+') ? phone.replace(/\s/g, '') : '+1' + phone.replace(/\D/g, '');

    // If signing up (not signing in), check phone not already registered
    if (isNewUser) {
      const { data: existing } = await supabase
        .from('users').select('id').eq('phone', e164).single();
      if (existing) {
        return res.status(409).json({
          error: 'This phone number is already registered. Please sign in instead.',
          code: 'PHONE_EXISTS',
        });
      }
    }

    const otp = await generateOTP(e164);

    // Send via Twilio if configured
    if (twilioClient) {
      try {
        await twilioClient.messages.create({
          body: `Your Concord Xpress verification code is: ${otp}. Valid for 10 minutes.`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to:   e164,
        });
        console.log('[OTP] SMS sent to', e164);
        res.json({ success: true, message: 'OTP sent' });
      } catch (smsErr) {
        console.error('[Twilio] SMS failed:', smsErr.message);
        // Fall back to dev mode
        res.json({ success: true, message: 'OTP sent', dev_otp: otp });
      }
    } else {
      // Dev mode — return OTP in response
      res.json({ success: true, message: 'OTP sent', dev_otp: otp });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp, fullName, email, isNewUser } = req.body;
    if (!phone || !otp) return res.status(400).json({ error: 'Phone and OTP are required' });
    // Use phone as-is if already in E.164 format, otherwise normalize
    const e164 = phone.startsWith('+') ? phone.replace(/\s/g, '') : '+1' + phone.replace(/\D/g, '');

    // Dev bypass — master OTP code for testing
    const DEV_OTP = process.env.DEV_OTP || '000000';
    const isDevBypass = otp === DEV_OTP;

    if (!isDevBypass) {
      // Verify OTP normally
      const stored = await getOTP(e164);
      if (!stored) return res.status(400).json({ error: 'No code found. Request a new one.' });
      if (Date.now() > new Date(stored.expires).getTime()) { await deleteOTP(e164); return res.status(400).json({ error: 'Code expired.' }); }
      if (stored.attempts >= 5) { await deleteOTP(e164); return res.status(400).json({ error: 'Too many attempts.' }); }
      if (stored.otp !== otp) { await supabase.from('otp_store').update({ attempts: stored.attempts + 1 }).eq('key', e164); return res.status(400).json({ error: 'Invalid code.' }); }
      await deleteOTP(e164);
    }

    const safeName  = ((fullName || 'Concord User').replace(/[^\x00-\x7F]/g, '').trim()) || 'Concord User';
    const safeEmail = email ? email.toLowerCase().trim() : null;

    // Check existing user by phone
    const { data: existingUser } = await supabase
      .from('users').select('*').eq('phone', e164).single();

    let user;

    if (existingUser) {
      // Existing user — update email if provided and not already set
      if (safeEmail && !existingUser.email) {
        // Check if email belongs to an email-only account (phone starts with 'email:')
        const { data: emailAccount } = await supabase
          .from('users').select('*').eq('email', safeEmail).single();
        if (emailAccount && emailAccount.phone && emailAccount.phone.startsWith('email:')) {
          // Merge: delete the email-only account and link email to phone account
          await supabase.from('users').delete().eq('id', emailAccount.id);
          await supabase.from('users').update({ email: safeEmail }).eq('id', existingUser.id);
          existingUser.email = safeEmail;
        } else if (emailAccount && emailAccount.id !== existingUser.id) {
          return res.status(409).json({
            error: 'This email is already linked to another account.',
            code: 'EMAIL_EXISTS',
          });
        } else {
          await supabase.from('users').update({ email: safeEmail }).eq('id', existingUser.id);
          existingUser.email = safeEmail;
        }
      }
      user = existingUser;
    } else {
      // New user — check email uniqueness if provided
      if (safeEmail) {
        const { data: emailConflict } = await supabase
          .from('users').select('*').eq('email', safeEmail).single();
        if (emailConflict && emailConflict.phone && emailConflict.phone.startsWith('email:')) {
          // Email-only account exists — merge by deleting it and using phone account
          await supabase.from('users').delete().eq('id', emailConflict.id);
        } else if (emailConflict) {
          return res.status(409).json({
            error: 'This email is already linked to another account. Use a different email or leave it blank.',
            code: 'EMAIL_EXISTS',
          });
        }
      }

      const userId = uuidv4();
      const { count } = await supabase.from('users').select('*', { count: 'exact', head: true });
      const { data: newUser, error: insertError } = await supabase
        .from('users')
        .insert({
          id:                userId,
          phone:             e164,
          full_name:         safeName,
          email:             safeEmail,
          is_founding_member:(count ?? 0) < 100,
        })
        .select().single();
      if (insertError) throw insertError;
      user = newUser;
    }

    const { accessToken, refreshToken } = makeTokens(user.id);
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
    const otp = await generateOTP(e);
    // Always send OTP regardless of whether user exists — account created on verify
    res.json({ success: true, message: 'Code sent to your email', dev_otp: otp });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send email code' });
  }
});

router.post('/verify-email-otp', async (req, res) => {
  try {
    const { email, otp, fullName, country, language } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and OTP are required' });
    const e = email.toLowerCase().trim();
    const stored = await getOTP(e);
    if (!stored) return res.status(400).json({ error: 'No code found. Request a new one.' });
    if (Date.now() > new Date(stored.expires).getTime()) { await deleteOTP(e); return res.status(400).json({ error: 'Code expired.' }); }
    if (stored.attempts >= 5) { await deleteOTP(e); return res.status(400).json({ error: 'Too many attempts.' }); }
    if (stored.otp !== otp) { await supabase.from('otp_store').update({ attempts: stored.attempts + 1 }).eq('key', e); return res.status(400).json({ error: 'Invalid code.' }); }
    await deleteOTP(e);
    const safeName = ((fullName || 'Concord User').replace(/[^\x00-\x7F]/g, '').trim()) || 'Concord User';
    let { data: user } = await supabase.from('users').select('*').eq('email', e).single();
    if (!user) {
      const { count } = await supabase.from('users').select('*', { count: 'exact', head: true });
      const { data: newUser, error: insertError } = await supabase
        .from('users')
        .insert({ id: uuidv4(), email: e, phone: `email:${e}`, full_name: safeName, is_founding_member: (count ?? 0) < 100 })
        .select().single();
      if (insertError) throw insertError;
      user = newUser;
    }
    const { accessToken, refreshToken } = makeTokens(user.id);
    return res.json({ success: true, access_token: accessToken, refresh_token: refreshToken, user });
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
    const { accessToken, refreshToken } = makeTokens(user.id);
    res.json({ access_token: accessToken, refresh_token: refreshToken });
  } catch (err) {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

router.delete('/logout', async (req, res) => {
  res.json({ success: true });
});


// POST /api/auth/check-duplicate — Check if email or phone already registered
router.post('/check-duplicate', async (req, res) => {
  try {
    const { type, value } = req.body;
    if (!type || !value) return res.status(400).json({ error: 'type and value required' });

    if (type === 'email') {
      const { data } = await supabase
        .from('users').select('id').eq('email', value.toLowerCase().trim()).maybeSingle();
      return res.json({ exists: !!data });
    }

    if (type === 'phone') {
      const { data } = await supabase
        .from('users').select('id').eq('phone', value.trim()).maybeSingle();
      return res.json({ exists: !!data });
    }

    res.status(400).json({ error: 'type must be email or phone' });
  } catch (err) {
    console.error('[check-duplicate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/change-password
router.post('/change-password', verifyAuth, async (req, res) => {
  try {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const { error } = await supabase.auth.admin.updateUserById(req.userId, { password: new_password });
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

// POST /api/auth/extract-intent — Voice search intent extraction
router.post('/extract-intent', async (req, res) => {
  const { text, userCity } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  const today     = new Date();
  const todayStr  = today.toISOString().split('T')[0];
  const dayNames  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const todayName = dayNames[today.getDay()];
  const tomorrow  = new Date(today.getTime() + 86400000).toISOString().split('T')[0];

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client    = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system:     `You extract travel intent for a Canadian carpooling app. Today is ${todayName} ${todayStr}. Tomorrow is ${tomorrow}. User home city: ${userCity || 'ottawa'}. Cities: ottawa, toronto, kingston, cornwall, peterborough, montreal, quebec, chicoutimi, moncton, fredericton. Respond ONLY with JSON: {"from_city": string|null, "to_city": string|null, "date": "YYYY-MM-DD"|null, "seats": number|null, "priority": "time"|"price"|"comfort"|null}. RULES: "tomorrow" = ${tomorrow}. Day names = next occurrence. "today" = ${todayStr}. "2 seats"/"two people"/"two seats" = seats:2. "3 seats"/"three" = seats:3. cheapest/cheap/budget = price. fastest/early = time. best/comfortable = comfort. "the 6ix"/toronto/TO = toronto. MTL/montreal = montreal. YOW/ottawa = ottawa. ALWAYS extract seats when a number is mentioned. ALWAYS extract date when today/tomorrow/day name mentioned.`,
      messages:   [{ role: 'user', content: text }],
    });

    const raw    = message.content?.[0]?.text || '{}';
    const clean  = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    res.json({ intent: parsed });
  } catch (err) {
    res.status(500).json({ error: 'Failed to extract intent' });
  }
});
