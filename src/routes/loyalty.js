const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const { verifyAuth } = require('../middleware/auth');

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

  // Count how many people this user has referred
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

    // Find the referrer by code
    const { data: referrer } = await supabase
      .from('users').select('id, full_name, referral_code')
      .eq('referral_code', code.toUpperCase()).single();

    if (!referrer) return res.status(404).json({ error: 'Referral code not found' });
    if (referrer.id === req.userId) return res.status(400).json({ error: 'You cannot use your own referral code' });

    // Check if user already used a referral code
    const { data: me } = await supabase
      .from('users').select('referred_by, full_name').eq('id', req.userId).single();

    if (me?.referred_by) return res.status(400).json({ error: 'You have already used a referral code' });

    // Mark user as referred
    await supabase.from('users').update({ referred_by: referrer.id }).eq('id', req.userId);

    // Credit C$5 to the new user
    await supabase.from('loyalty_credits').insert({
      user_id: req.userId,
      amount: 5.00,
      type: 'referral',
      note: `Referral from ${referrer.full_name}`,
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Credit C$5 to the referrer
    await supabase.from('loyalty_credits').insert({
      user_id: referrer.id,
      amount: 5.00,
      type: 'referral',
      note: `Referred ${me?.full_name || 'a new user'}`,
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Notify the referrer
    await notify(referrer.id,
      '🎉 Referral reward!',
      `${me?.full_name || 'Someone'} used your referral code. C$5 credit added to your account!`
    );

    // Notify the new user
    await notify(req.userId,
      '🎁 Welcome credit!',
      `C$5 credit added from ${referrer.full_name}'s referral. Use it on your next booking!`
    );

    res.json({ message: 'C$5 credit added! Your referrer also received C$5.' });
  } catch (err) {
    console.error('Referral apply error:', err);
    res.status(500).json({ error: 'Failed to apply referral code' });
  }
});

// GET /api/loyalty/referrals — referral tracking dashboard
router.get('/referrals', verifyAuth, async (req, res) => {
  try {
    const { data: referrals } = await supabase.from('users')
      .select('id, full_name, avatar_url, created_at')
      .eq('referred_by', req.userId)
      .order('created_at', { ascending: false });

    // Get total credit earned from referrals
    const { data: credits } = await supabase.from('loyalty_credits')
      .select('amount')
      .eq('user_id', req.userId)
      .eq('type', 'referral');

    const totalEarned = credits?.reduce((s, c) => s + parseFloat(c.amount), 0) ?? 0;

    res.json({
      referrals: referrals ?? [],
      total_referred: referrals?.length ?? 0,
      total_earned: totalEarned,
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

    // Get available credits (oldest first)
    const { data: credits } = await supabase.from('loyalty_credits')
      .select('*').eq('user_id', req.userId)
      .is('used_at', null).gte('expires_at', new Date().toISOString())
      .order('expires_at', { ascending: true });

    const available = credits?.reduce((s, c) => s + parseFloat(c.amount), 0) ?? 0;
    if (available < amount) return res.status(400).json({ error: 'Insufficient credit', available });

    // Consume credits oldest-first until amount is covered
    let remaining = amount;
    for (const credit of credits) {
      if (remaining <= 0) break;
      const creditAmount = parseFloat(credit.amount);
      if (creditAmount <= remaining) {
        // Use entire credit
        await supabase.from('loyalty_credits').update({
          used_at: new Date().toISOString(),
          used_for_booking: booking_id || null,
        }).eq('id', credit.id);
        remaining -= creditAmount;
      } else {
        // Partial use: reduce this credit's amount, create a used record
        await supabase.from('loyalty_credits').update({
          amount: creditAmount - remaining,
        }).eq('id', credit.id);
        // Insert a record for the used portion
        await supabase.from('loyalty_credits').insert({
          user_id: req.userId,
          amount: remaining,
          type: credit.type,
          note: `Partial credit used for booking`,
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
