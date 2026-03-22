const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const stripe   = require('../lib/stripe');
const { verifyAuth } = require('../middleware/auth');

router.post('/setup-intent', verifyAuth, async (req, res) => {
  try {
    const { data: user } = await supabase.from('users').select('stripe_customer_id').eq('id', req.userId).single();
    let customerId = user?.stripe_customer_id;
    if (!customerId) {
      const c = await stripe.customers.create({ metadata: { user_id: req.userId } });
      customerId = c.id;
      await supabase.from('users').update({ stripe_customer_id: customerId }).eq('id', req.userId);
    }
    const intent = await stripe.setupIntents.create({ customer: customerId, payment_method_types: ['card'] });
    res.json({ client_secret: intent.client_secret });
  } catch (err) { res.status(500).json({ error: 'Failed to create setup intent' }); }
});

router.get('/methods', verifyAuth, async (req, res) => {
  try {
    const { data: user } = await supabase.from('users').select('stripe_customer_id').eq('id', req.userId).single();
    if (!user?.stripe_customer_id) return res.json({ payment_methods: [] });
    const methods = await stripe.paymentMethods.list({ customer: user.stripe_customer_id, type: 'card' });
    res.json({ payment_methods: methods.data });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch payment methods' }); }
});

router.delete('/methods/:id', verifyAuth, async (req, res) => {
  try {
    await stripe.paymentMethods.detach(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed to remove payment method' }); }
});

router.post('/payout', verifyAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase.from('driver_profiles').select('stripe_account_id').eq('user_id', req.userId).single();
    if (!profile?.stripe_account_id) return res.status(400).json({ error: 'No Stripe account connected' });
    const payout = await stripe.payouts.create(
      { amount: Math.round(req.body.amount * 100), currency: 'cad' },
      { stripeAccount: profile.stripe_account_id }
    );
    res.json({ payout });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) { return res.status(400).json({ error: `Webhook Error: ${err.message}` }); }
  switch (event.type) {
    case 'payment_intent.succeeded': console.log('[Stripe] Payment succeeded:', event.data.object.id); break;
    case 'payout.paid': console.log('[Stripe] Payout paid:', event.data.object.amount / 100); break;
  }
  res.json({ received: true });
});

module.exports = router;
