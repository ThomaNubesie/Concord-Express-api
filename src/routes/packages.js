const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const stripe   = require('../lib/stripe');
const { verifyAuth } = require('../middleware/auth');

router.post('/', verifyAuth, async (req, res) => {
  try {
    const { trip_id, size, is_fragile, pickup_area, delivery_area,
            sender_name, sender_phone, recipient_name, recipient_phone, notes, payment_method_id } = req.body;
    const PRICES = { envelope: 8, small: 15, medium: 25, large: 40 };
    const price  = (PRICES[size] ?? 15) + (is_fragile ? 5 : 0);
    const { data: user } = await supabase.from('users').select('stripe_customer_id').eq('id', req.userId).single();
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(price * 100), currency: 'cad',
      customer: user?.stripe_customer_id, payment_method: payment_method_id,
      confirm: true, capture_method: 'manual', return_url: 'concordxpress://payment-complete',
    });
    const { data, error } = await supabase.from('packages').insert({
      trip_id, sender_id: req.userId, size, is_fragile, pickup_area, delivery_area,
      sender_name, sender_phone, recipient_name, recipient_phone, notes, price,
      stripe_payment_intent_id: intent.id,
    }).select().single();
    if (error) return res.status(500).json({ error: 'Failed to create package' });
    res.status(201).json({ package: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id/confirm', verifyAuth, async (req, res) => {
  const { data: pkg } = await supabase.from('packages').select('stripe_payment_intent_id').eq('id', req.params.id).single();
  if (!pkg) return res.status(404).json({ error: 'Package not found' });
  await stripe.paymentIntents.capture(pkg.stripe_payment_intent_id);
  await supabase.from('packages').update({ status: 'delivered', delivery_confirmed_at: new Date().toISOString() }).eq('id', req.params.id);
  res.json({ success: true });
});

module.exports = router;
