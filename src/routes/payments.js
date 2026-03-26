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

// POST /api/payments/attach-method — Attach payment method to customer after confirmSetup
router.post('/attach-method', verifyAuth, async (req, res) => {
  try {
    const { payment_method_id } = req.body;
    if (!payment_method_id) return res.status(400).json({ error: 'payment_method_id required' });

    const { data: user } = await supabase
      .from('users').select('stripe_customer_id').eq('id', req.userId).single();

    let customerId = user?.stripe_customer_id;
    if (!customerId) {
      const c = await stripe.customers.create({ metadata: { user_id: req.userId } });
      customerId = c.id;
      await supabase.from('users').update({ stripe_customer_id: customerId }).eq('id', req.userId);
    }

    await stripe.paymentMethods.attach(payment_method_id, { customer: customerId });
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: payment_method_id },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[Payments] attach error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/methods/:id', verifyAuth, async (req, res) => {
  try {
    await stripe.paymentMethods.detach(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed to remove payment method' }); }
});

// POST /api/payments/connect/onboard — Create Stripe Connect account for driver
router.post('/connect/onboard', verifyAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from('driver_profiles')
      .select('stripe_account_id')
      .eq('user_id', req.userId).single();

    let accountId = profile?.stripe_account_id;

    // Create Connect account if doesn't exist
    if (!accountId) {
      const { data: user } = await supabase
        .from('users').select('email, full_name').eq('id', req.userId).single();

      const account = await stripe.accounts.create({
        type:    'express',
        country: 'CA',
        email:   user?.email,
        capabilities: {
          card_payments: { requested: true },
          transfers:     { requested: true },
        },
        business_type: 'individual',
        metadata: { supabase_user_id: req.userId },
      });

      accountId = account.id;
      await supabase.from('driver_profiles')
        .update({ stripe_account_id: accountId })
        .eq('user_id', req.userId);
    }

    // Create onboarding link
    const accountLink = await stripe.accountLinks.create({
      account:     accountId,
      refresh_url: 'https://concord-express-api-production.up.railway.app/api/payments/connect/onboard',
      return_url:  'https://concord-express-api-production.up.railway.app/api/payments/connect/complete',
      type:        'account_onboarding',
    });

    res.json({ url: accountLink.url, account_id: accountId });
  } catch (err) {
    console.error('[Connect] onboard error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payments/connect/status — Check driver Connect account status
router.get('/connect/status', verifyAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from('driver_profiles')
      .select('stripe_account_id')
      .eq('user_id', req.userId).single();

    if (!profile?.stripe_account_id) {
      return res.json({ connected: false, charges_enabled: false });
    }

    const account = await stripe.accounts.retrieve(profile.stripe_account_id);
    res.json({
      connected:       true,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      account_id:      profile.stripe_account_id,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payments/connect/balance — Driver wallet balance
router.get('/connect/balance', verifyAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from('driver_profiles')
      .select('stripe_account_id')
      .eq('user_id', req.userId).single();

    if (!profile?.stripe_account_id) {
      return res.json({ available: 0, pending: 0 });
    }

    const balance = await stripe.balance.retrieve(
      { stripeAccount: profile.stripe_account_id }
    );

    const available = balance.available.reduce((sum, b) => sum + b.amount, 0) / 100;
    const pending   = balance.pending.reduce((sum, b) => sum + b.amount, 0) / 100;

    res.json({ available, pending, currency: 'cad' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
