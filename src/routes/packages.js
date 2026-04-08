const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const stripe   = require('../lib/stripe');
const { verifyAuth } = require('../middleware/auth');
const { Notif } = require('../lib/notifications');

// Route-based prices matching constants/packages.ts
const PRICES = {
  envelope:         { short: 8,  medium: 20, long: 30 },
  bag:              { short: 12, medium: 28, long: 40 },
  carryon:          { short: 15, medium: 32, long: 46 },
  rolling_suitcase: { short: 18, medium: 40, long: 58 },
  small_box:        { short: 14, medium: 34, long: 48 },
  large_box:        { short: 20, medium: 45, long: 62 },
  fragile:          { short: 16, medium: 36, long: 52 },
  heavy:            { short: 30, medium: 65, long: 92 },
};

const DISTANCES = {
  'ottawa-montreal':200,'montreal-ottawa':200,'ottawa-toronto':450,'toronto-ottawa':450,
  'montreal-toronto':540,'toronto-montreal':540,'ottawa-kingston':195,'kingston-ottawa':195,
  'toronto-kingston':260,'kingston-toronto':260,'montreal-quebec':255,'quebec-montreal':255,
  'ottawa-cornwall':110,'cornwall-ottawa':110,'toronto-peterborough':145,'peterborough-toronto':145,
};

// POST /api/packages
router.post('/', verifyAuth, async (req, res) => {
  try {
    const { trip_id, package_type, is_fragile, pickup_area, delivery_area,
            sender_name, sender_phone, recipient_name, recipient_phone,
            notes, payment_method_id, price: clientPrice, cash_only, app_cut } = req.body;

    console.log('[Packages] body:', JSON.stringify({ trip_id, package_type, payment_method_id, clientPrice, cash_only, app_cut }));

    if (!trip_id || !package_type) return res.status(400).json({ error: 'trip_id and package_type required' });

    // Fetch trip
    const { data: trip } = await supabase
      .from('trips').select('from_city, to_city, cash_only, driver_id').eq('id', trip_id).single();
    if (!trip) return res.status(404).json({ error: 'Trip not found' });

    if (trip.driver_id === req.userId) return res.status(400).json({ error: 'Cannot ship on your own trip' });

    // Calculate price from route bucket
    const routeKey  = (trip.from_city + '-' + trip.to_city).toLowerCase();
    const distKm    = DISTANCES[routeKey] || 300;
    const bucket    = distKm <= 100 ? 'short' : distKm <= 350 ? 'medium' : 'long';
    const typePrices = PRICES[package_type] || PRICES.small_box;
    const price     = clientPrice || typePrices[bucket];

    const isCash = cash_only || trip.cash_only;
    // Cash: charge 25% (app cut) upfront; Card: charge full price
    const chargeAmount = isCash ? (app_cut || Math.round(price * 0.25 * 100) / 100) : price;

    let stripeIntentId = null;
    if (payment_method_id && chargeAmount > 0) {
      try {
        const { data: user } = await supabase
          .from('users').select('stripe_customer_id').eq('id', req.userId).single();
        console.log('[Packages] Stripe charge:', { chargeAmount, payment_method_id, customer: user?.stripe_customer_id });
        const intent = await stripe.paymentIntents.create({
          amount: Math.round(chargeAmount * 100), currency: 'cad',
          customer: user?.stripe_customer_id,
          payment_method: payment_method_id,
          confirm: true,
          capture_method: 'manual',
          return_url: 'concordxpress://payment-complete',
        });
        stripeIntentId = intent.id;
      } catch (stripeErr) {
        console.error('[Packages] Stripe error:', stripeErr.message);
        return res.status(400).json({ error: 'Payment failed: ' + stripeErr.message });
      }
    }

    const { data, error } = await supabase.from('packages').insert({
      trip_id,
      sender_id:    req.userId,
      package_type,
      size:         package_type,
      is_fragile:   is_fragile || package_type === 'fragile',
      pickup_area,
      delivery_area,
      sender_name,
      sender_phone,
      recipient_name,
      recipient_phone,
      notes,
      price,
      status: 'pending',
      stripe_payment_intent_id: stripeIntentId,
    }).select().single();

    if (error) return res.status(500).json({ error: 'Failed to create package: ' + error.message });

    // Notify driver
    const { data: driver } = await supabase.from('users')
      .select('fcm_token, full_name').eq('id', trip.driver_id).single();
    if (driver?.fcm_token) {
      await supabase.from('notifications').insert({
        user_id: trip.driver_id,
        type: 'package',
        title: '📦 New package on your trip',
        body: `${sender_name} wants to send a ${package_type.replace('_', ' ')} to ${trip.to_city}`,
        action_url: '/driver/home',
      });
    }

    res.status(201).json({ package: data });
  } catch (err) {
    console.error('[Packages] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/packages/mine — sender sees their packages
router.get('/mine', verifyAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('packages')
    .select('*, trip:trips(id, from_city, to_city, departure_at, driver:users!trips_driver_id_fkey(id, full_name, avatar_url))')
    .eq('sender_id', req.userId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Failed to fetch packages' });
  res.json({ packages: data });
});

// GET /api/packages/trip/:tripId — driver sees packages on their trip
router.get('/trip/:tripId', verifyAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('packages')
    .select('*, sender:users!packages_sender_id_fkey(id, full_name, avatar_url)')
    .eq('trip_id', req.params.tripId)
    .neq('status', 'cancelled');
  if (error) return res.status(500).json({ error: 'Failed to fetch packages' });
  res.json({ packages: data });
});

// PATCH /api/packages/:id/confirm — confirm delivery
router.patch('/:id/confirm', verifyAuth, async (req, res) => {
  const { data: pkg } = await supabase
    .from('packages').select('stripe_payment_intent_id').eq('id', req.params.id).single();
  if (!pkg) return res.status(404).json({ error: 'Package not found' });
  if (pkg.stripe_payment_intent_id) {
    await stripe.paymentIntents.capture(pkg.stripe_payment_intent_id);
  }
  await supabase.from('packages')
    .update({ status: 'delivered', delivery_confirmed_at: new Date().toISOString() })
    .eq('id', req.params.id);
  res.json({ success: true });
});

module.exports = router;
