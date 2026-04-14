const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const { verifyAuth } = require('../middleware/auth');

router.get('/', verifyAuth, async (req, res) => {
  const { data: user }    = await supabase.from('users').select('total_trips, is_founding_member').eq('id', req.userId).single();
  const { data: credits } = await supabase.from('loyalty_credits').select('*').eq('user_id', req.userId)
    .is('used_at', null).gte('expires_at', new Date().toISOString()).order('created_at');
  const { data: draw }    = await supabase.from('draw_entries').select('*').eq('user_id', req.userId)
    .eq('month', new Date().toISOString().slice(0, 7));
  res.json({
    total_trips:             user?.total_trips ?? 0,
    is_founding:             user?.is_founding_member ?? false,
    available_credit:        credits?.reduce((s, c) => s + parseFloat(c.amount), 0) ?? 0,
    credits:                 credits ?? [],
    draw_entries_this_month: draw?.[0]?.entries ?? 0,
  });
});

module.exports = router;

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
      .from('users').select('referred_by').eq('id', req.userId).single();

    if (me?.referred_by) return res.status(400).json({ error: 'You have already used a referral code' });

    // Mark user as referred
    await supabase.from('users').update({ referred_by: referrer.id }).eq('id', req.userId);

    // Credit C$5 to the new user
    await supabase.from('loyalty_credits').insert({
      user_id: req.userId,
      amount: 5.00,
      type: 'referral',
      note: `Referral from ${referrer.full_name}`,
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days
    });

    // Credit C$5 to the referrer too
    await supabase.from('loyalty_credits').insert({
      user_id: referrer.id,
      amount: 5.00,
      type: 'referral',
      note: `Referred a new user`,
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    });

    res.json({ message: 'C$5 credit added! Your referrer also received C$5.' });
  } catch (err) {
    console.error('Referral apply error:', err);
    res.status(500).json({ error: 'Failed to apply referral code' });
  }
});
