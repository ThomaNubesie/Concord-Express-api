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
    res.json({ client_secret: intent.client_secret, customer_id: customerId });
  } catch (err) { console.error('[SetupIntent]', err.message); res.status(500).json({ error: err.message }); }
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


// POST /api/payments/identity-session — Create Stripe Identity verification session
router.post('/identity-session', verifyAuth, async (req, res) => {
  try {
    const session = await stripe.identity.verificationSessions.create({
      type: 'document',
      metadata: { user_id: req.userId },
      return_url: 'https://concord-express-api-production.up.railway.app/api/payments/identity-redirect',
      options: {
        document: {
          allowed_types: ['driving_license', 'passport', 'id_card'],
          require_id_number:         false,
          require_live_capture:      true,
          require_matching_selfie:   true,
        },
      },
    });
    await supabase.from('users')
      .update({ identity_session_id: session.id, identity_status: 'pending' })
      .eq('id', req.userId);
    res.json({ url: session.url, client_secret: session.client_secret, session_id: session.id });
  } catch (err) {
    console.error('[Identity] session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payments/identity-status — Check verification session status
router.get('/identity-status', verifyAuth, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users').select('identity_session_id, identity_status').eq('id', req.userId).single();
    if (!user?.identity_session_id) return res.json({ status: 'not_started' });
    const session = await stripe.identity.verificationSessions.retrieve(user.identity_session_id);
    if (session.status !== user.identity_status) {
      await supabase.from('users')
        .update({ identity_status: session.status }).eq('id', req.userId);
    }
    res.json({ status: session.status, session_id: user.identity_session_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/verification-fee — Charge verification fee (+ optional driver subscription)
router.post('/verification-fee', verifyAuth, async (req, res) => {
  try {
    const { payment_method_id, role, is_founding_member } = req.body;
    if (!payment_method_id) return res.status(400).json({ error: 'payment_method_id required' });

    const VERIFY_FEE  = 399;  // C$3.99 in cents
    const DRIVER_FEE  = is_founding_member ? 1000 : 2000; // C$10 or C$20
    const totalCents  = role === 'passenger'
      ? VERIFY_FEE
      : role === 'driver' || role === 'both'
      ? VERIFY_FEE + DRIVER_FEE
      : VERIFY_FEE;

    const { data: user } = await supabase
      .from('users').select('stripe_customer_id, full_name, email').eq('id', req.userId).single();

    let customerId = user?.stripe_customer_id;
    if (!customerId) {
      const c = await stripe.customers.create({
        email: user?.email, name: user?.full_name,
        metadata: { user_id: req.userId },
      });
      customerId = c.id;
      await supabase.from('users').update({ stripe_customer_id: customerId }).eq('id', req.userId);
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount:           totalCents,
      currency:         'cad',
      customer:         customerId,
      payment_method:   payment_method_id,
      confirm:          true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      description:      role === 'passenger'
        ? 'ConcordXpress identity verification'
        : `ConcordXpress verification + driver subscription (${is_founding_member ? 'founder' : 'standard'})`,
      metadata: { user_id: req.userId, role, is_founding_member: String(!!is_founding_member) },
    });

    if (!['succeeded','processing'].includes(paymentIntent.status)) {
      return res.status(400).json({ error: 'Payment failed. Please check your card.' });
    }

    await supabase.from('users')
      .update({ verification_fee_paid: true })
      .eq('id', req.userId);

    if (role === 'driver' || role === 'both') {
      const expiresAt = new Date();
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);
      await supabase.from('driver_profiles')
        .update({
          subscription_paid:    true,
          subscription_expires: expiresAt.toISOString(),
          is_founding_member:   !!is_founding_member,
        })
        .eq('user_id', req.userId);
    }

    res.json({ success: true, payment_intent_id: paymentIntent.id, amount: totalCents });
  } catch (err) {
    console.error('[VerificationFee] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// POST /api/payments/flutterwave-init — Generate Flutterwave payment link (keeps secret key server-side)
router.post('/flutterwave-init', verifyAuth, async (req, res) => {
  try {
    const { role, is_founding_member } = req.body;
    const { data: user } = await supabase
      .from('users').select('full_name, email').eq('id', req.userId).single();

    const VERIFY_FEE = 3.99;
    const DRIVER_FEE = is_founding_member ? 10.00 : 20.00;
    const amount     = role === 'passenger' ? VERIFY_FEE
                     : VERIFY_FEE + DRIVER_FEE;

    const tx_ref = `CX-${Date.now()}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;

    const response = await fetch('https://api.flutterwave.com/v3/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tx_ref,
        amount:          amount.toFixed(2),
        currency:        'USD',
        redirect_url:    'https://concord-express-api-production.up.railway.app/api/payments/flutterwave-redirect',
        payment_options: 'mobilemoney',
        customer: {
          email: user?.email || 'user@concordxpress.ca',
          name:  user?.full_name || 'ConcordXpress User',
        },
        customizations: {
          title:       'ConcordXpress',
          description: role === 'passenger'
            ? 'Identity verification fee'
            : `Verification + driver subscription (${is_founding_member ? 'founder' : 'standard'})`,
        },
        meta: { user_id: req.userId, role, is_founding_member },
      }),
    });

    const data = await response.json();
    if (data.status !== 'success') {
      return res.status(400).json({ error: data.message || 'Failed to initialize payment' });
    }

    res.json({ link: data.data.link, tx_ref });
  } catch (err) {
    console.error('[Flutterwave] init error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/flutterwave-verify — Verify Flutterwave transaction after redirect
router.post('/flutterwave-verify', verifyAuth, async (req, res) => {
  try {
    const { tx_ref } = req.body;
    const response = await fetch(
      `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${tx_ref}`,
      { headers: { 'Authorization': `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } }
    );
    const data = await response.json();
    if (data.status === 'success' && data.data?.status === 'successful') {
      await supabase.from('users')
        .update({ verification_fee_paid: true }).eq('id', req.userId);
      return res.json({ success: true, transaction: data.data });
    }
    res.status(400).json({ error: 'Transaction not successful', status: data.data?.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payments/flutterwave-redirect — Catches Flutterwave redirect and closes webview
router.get('/flutterwave-redirect', (req, res) => {
  const { status, tx_ref, transaction_id } = req.query;
  // Return a page that the app's webview can detect and close
  res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width"></head><body>
    <script>
      window.location.href = 'concordxpress://payment-complete?status=${status}&tx_ref=${tx_ref}&transaction_id=${transaction_id}';
      setTimeout(() => { document.body.innerHTML = '<p style="font-family:sans-serif;text-align:center;padding:40px">Payment ${status}. Returning to app...</p>'; }, 500);
    </script>
  </body></html>`);
});

// GET /api/payments/identity-redirect — Catches Stripe Identity redirect
router.get('/identity-redirect', (req, res) => {
  res.send(`<!DOCTYPE html><html><body>
    <script>
      window.location.href = 'concordxpress://identity-complete';
      setTimeout(() => { document.body.innerHTML = '<p style="font-family:sans-serif;text-align:center;padding:40px">Verification complete. Returning to app...</p>'; }, 500);
    </script>
  </body></html>`);
});

module.exports = router;
