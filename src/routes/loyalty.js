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
