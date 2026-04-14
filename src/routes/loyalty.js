const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const { verifyAuth } = require('../middleware/auth');

// ---- Config ----
const REFERRAL_CREDIT       = 5.00;    // C$5 per referral
const REFERRAL_CREDIT_DAYS  = 90;      // expires in 90 days
const MAX_REFERRAL_CREDITS  = 50.00;   // max C$50 total referral earnings (10 referrals)
const MIN_TRIPS_FOR_REFERRER_PAYOUT = 1; // referred user must complete 1 trip before referrer gets paid

// Helper: send notification
async function notify(userId, title, body, type = 'loyalty') {
  await supabase.from('notifications').insert({
    user_id: userId, title, body, type, is_read: false,
  });
}

// GET /api/loyalty — dashboard data
router.get('/', verifyAuth, async (req, res) => {
  const { data: user } = await supabase.from('users')
    .select('total_trips, is_founding_member, referral_code')
    .eq('id', req.userId).single();

  const { data: credits } = await supabase.from('loyalty_credits')
    .select('*').eq('user_id', req.userId)
    .is('used_at', null).gte('expires_at', new Date().toISOString())
    .order('created_at');

  const { data: draw } = await supabase.from('draw_entries')
    .select('*').eq('user_id', req.userId)
    .eq('month', new Date().toISOString().slice(0, 7));

  const { count: referralCount } = await supabase.from('users')
    .select('id', { count: 'exact', head: true })
    .eq('referred_by', req.userId);

  res.json({
    total_trips:             user?.total_trips ?? 0,
    is_founding:             user?.is_founding_member ?? false,
    referral_code:           user?.referral_code ?? null,
    available_credit:        credits?.reduce((s, c) => s + parseFloat(c.amount), 0) ?? 0,
    credits:                 credits ?? [],
    draw_entries_this_month: draw?.[0]?.entries ?? 0,
    referral_count:          referralCount ?? 0,
  });
});

// POST /api/loyalty/referral/apply — apply a referral code
router.post('/referral/apply', verifyAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || code.length < 4) return res.status(400).json({ error: 'Invalid referral code' });

    // Find the referrer
    const { data: referrer } = await supabase
      .from('users').select('id, full_name, referral_code, created_at')
      .eq('referral_code', code.toUpperCase()).single();

    if (!referrer) return res.status(404).json({ error: 'Referral code not found' });
    if (referrer.id === req.userId) return res.status(400).json({ error: 'You cannot use your own referral code' });

    // Check if user already used a referral code
    const { data: me } = await supabase
      .from('users').select('referred_by, full_name, created_at, email, phone')
      .eq('id', req.userId).single();

    if (me?.referred_by) return res.status(400).json({ error: 'You have already used a referral code' });

    // Anti-fraud: account must be less than 7 days old to use a referral code
    const accountAge = Date.now() - new Date(me.created_at).getTime();
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    if (accountAge > SEVEN_DAYS) {
      return res.status(400).json({ error: 'Referral codes can only be used within 7 days of account creation' });
    }

    // Anti-fraud: must have a verified payment method on file
    const stripe = require('../lib/stripe');
    const { data: userFull } = await supabase.from('users')
      .select('stripe_customer_id').eq('id', req.userId).single();
    if (userFull?.stripe_customer_id) {
      const methods = await stripe.paymentMethods.list({
        customer: userFull.stripe_customer_id, type: 'card',
      });
      if (!methods.data || methods.data.length === 0) {
        return res.status(400).json({ error: 'Please add a payment method before using a referral code' });
      }
    } else {
      return res.status(400).json({ error: 'Please add a payment method before using a referral code' });
    }

    // Anti-fraud: check if referrer and new user share the same device
    const { data: meDevice } = await supabase.from('users')
      .select('device_id, last_ip').eq('id', req.userId).single();
    const { data: referrerDevice } = await supabase.from('users')
      .select('device_id, last_ip').eq('id', referrer.id).single();
    
    if (meDevice?.device_id && referrerDevice?.device_id && 
        meDevice.device_id === referrerDevice.device_id) {
      return res.status(400).json({ error: 'Referral not allowed from the same device' });
    }

    // Also check: how many accounts from this device have used referral codes?
    if (meDevice?.device_id) {
      const { data: sameDevice } = await supabase.from('users')
        .select('id').eq('device_id', meDevice.device_id)
        .not('referred_by', 'is', null);
      if (sameDevice && sameDevice.length >= 2) {
        return res.status(400).json({ error: 'Too many referrals from this device' });
      }
    }

    // Anti-fraud: check if referrer has reached max referral earnings
    const { data: referrerCredits } = await supabase.from('loyalty_credits')
      .select('amount').eq('user_id', referrer.id).eq('type', 'referral');
    const referrerTotal = referrerCredits?.reduce((s, c) => s + parseFloat(c.amount), 0) ?? 0;
    if (referrerTotal >= MAX_REFERRAL_CREDITS) {
      // Still give the new user their credit, but don't reward the referrer further
      await supabase.from('users').update({ referred_by: referrer.id }).eq('id', req.userId);
      await supabase.from('loyalty_credits').insert({
        user_id: req.userId,
        amount: REFERRAL_CREDIT,
        type: 'referral',
        note: `Referral from ${referrer.full_name}`,
        expires_at: new Date(Date.now() + REFERRAL_CREDIT_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      });
      await notify(req.userId, '\U0001f381 Welcome credit!',
        `C$${REFERRAL_CREDIT} credit added from ${referrer.full_name}'s referral!`);
      return res.json({ message: `C$${REFERRAL_CREDIT} credit added to your account!` });
    }

    // Mark user as referred
    await supabase.from('users').update({ referred_by: referrer.id }).eq('id', req.userId);

    // Credit the new user immediately
    await supabase.from('loyalty_credits').insert({
      user_id: req.userId,
      amount: REFERRAL_CREDIT,
      type: 'referral',
      note: `Referral from ${referrer.full_name}`,
      expires_at: new Date(Date.now() + REFERRAL_CREDIT_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Referrer credit is PENDING — only released after referred user completes a trip
    await supabase.from('loyalty_credits').insert({
      user_id: referrer.id,
      amount: REFERRAL_CREDIT,
      type: 'referral_pending',
      note: `Pending: ${me?.full_name || 'New user'} must complete ${MIN_TRIPS_FOR_REFERRER_PAYOUT} trip(s)`,
      referred_user_id: req.userId,
      expires_at: new Date(Date.now() + REFERRAL_CREDIT_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Notify both
    await notify(req.userId, '\U0001f381 Welcome credit!',
      `C$${REFERRAL_CREDIT} credit added from ${referrer.full_name}'s referral. Use it on your next booking!`);
    await notify(referrer.id, '\U0001f44b New referral!',
      `${me?.full_name || 'Someone'} used your code! You'll earn C$${REFERRAL_CREDIT} once they complete their first trip.`);

    res.json({ message: `C$${REFERRAL_CREDIT} credit added! Your referrer will be rewarded after your first trip.` });
  } catch (err) {
    console.error('Referral apply error:', err);
    res.status(500).json({ error: 'Failed to apply referral code' });
  }
});

// POST /api/loyalty/referral/release — called after a referred user completes a trip
// This should be called from the trip completion flow
router.post('/referral/release', verifyAuth, async (req, res) => {
  try {
    const { completed_user_id } = req.body;
    const userId = completed_user_id || req.userId;

    // Check if this user was referred
    const { data: user } = await supabase.from('users')
      .select('referred_by, total_trips').eq('id', userId).single();

    if (!user?.referred_by || (user.total_trips || 0) < MIN_TRIPS_FOR_REFERRER_PAYOUT) {
      return res.json({ released: false, reason: 'No pending referral credit or trips not met' });
    }

    // Find the pending credit for the referrer
    const { data: pending } = await supabase.from('loyalty_credits')
      .select('*').eq('user_id', user.referred_by)
      .eq('type', 'referral_pending')
      .eq('referred_user_id', userId)
      .is('used_at', null).single();

    if (!pending) return res.json({ released: false, reason: 'Already released or not found' });

    // Release it — change type from pending to referral
    await supabase.from('loyalty_credits').update({
      type: 'referral',
      note: pending.note.replace('Pending: ', 'Earned: '),
    }).eq('id', pending.id);

    // Notify referrer
    await notify(user.referred_by, '\U0001f389 Referral reward unlocked!',
      `Your referral completed their first trip! C$${REFERRAL_CREDIT} credit is now available.`);

    res.json({ released: true });
  } catch (err) {
    console.error('Referral release error:', err);
    res.status(500).json({ error: 'Failed to release referral credit' });
  }
});

// GET /api/loyalty/referrals — referral tracking dashboard
router.get('/referrals', verifyAuth, async (req, res) => {
  try {
    const { data: referrals } = await supabase.from('users')
      .select('id, full_name, avatar_url, created_at, total_trips')
      .eq('referred_by', req.userId)
      .order('created_at', { ascending: false });

    // Get total earned (only released credits)
    const { data: credits } = await supabase.from('loyalty_credits')
      .select('amount, type').eq('user_id', req.userId)
      .in('type', ['referral', 'referral_pending']);

    const totalEarned = credits?.filter(c => c.type === 'referral').reduce((s, c) => s + parseFloat(c.amount), 0) ?? 0;
    const totalPending = credits?.filter(c => c.type === 'referral_pending').reduce((s, c) => s + parseFloat(c.amount), 0) ?? 0;

    res.json({
      referrals: (referrals ?? []).map(r => ({
        ...r,
        status: (r.total_trips || 0) >= MIN_TRIPS_FOR_REFERRER_PAYOUT ? 'active' : 'pending',
      })),
      total_referred: referrals?.length ?? 0,
      total_earned: totalEarned,
      total_pending: totalPending,
    });
  } catch (err) {
    console.error('Referral list error:', err);
    res.status(500).json({ error: 'Failed to fetch referrals' });
  }
});

// POST /api/loyalty/apply-credit — apply credit to a booking
router.post('/apply-credit', verifyAuth, async (req, res) => {
  try {
    const { amount, booking_id } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    // Only use released credits (not pending)
    const { data: credits } = await supabase.from('loyalty_credits')
      .select('*').eq('user_id', req.userId)
      .in('type', ['referral', 'manual', 'milestone', 'promo'])
      .is('used_at', null).gte('expires_at', new Date().toISOString())
      .order('expires_at', { ascending: true });

    const available = credits?.reduce((s, c) => s + parseFloat(c.amount), 0) ?? 0;
    if (available < amount) return res.status(400).json({ error: 'Insufficient credit', available });

    let remaining = amount;
    for (const credit of credits) {
      if (remaining <= 0) break;
      const creditAmount = parseFloat(credit.amount);
      if (creditAmount <= remaining) {
        await supabase.from('loyalty_credits').update({
          used_at: new Date().toISOString(),
          used_for_booking: booking_id || null,
        }).eq('id', credit.id);
        remaining -= creditAmount;
      } else {
        await supabase.from('loyalty_credits').update({
          amount: creditAmount - remaining,
        }).eq('id', credit.id);
        await supabase.from('loyalty_credits').insert({
          user_id: req.userId,
          amount: remaining,
          type: credit.type,
          note: 'Partial credit used for booking',
          used_at: new Date().toISOString(),
          used_for_booking: booking_id || null,
          expires_at: credit.expires_at,
        });
        remaining = 0;
      }
    }

    const applied = amount - remaining;
    res.json({ applied, remaining_balance: available - applied });
  } catch (err) {
    console.error('Apply credit error:', err);
    res.status(500).json({ error: 'Failed to apply credit' });
  }
});

module.exports = router;
