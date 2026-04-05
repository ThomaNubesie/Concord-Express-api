// ─────────────────────────────────────────────────────────────────────────────
// routes/users.js
// ─────────────────────────────────────────────────────────────────────────────
const express  = require('express');
const supabase = require('../lib/supabase');
const { verifyAuth } = require('../middleware/auth');

const usersRouter = express.Router();

usersRouter.get('/me', verifyAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('*, driver_profile:driver_profiles(*)')
    .eq('id', req.userId)
    .single();
  if (error) return res.status(404).json({ error: 'User not found' });
  res.json({ user: data });
});

usersRouter.patch('/me', verifyAuth, async (req, res) => {
  const allowed = ['full_name', 'email', 'avatar_url', 'fcm_token'];
  const updates = {};
  for (const field of allowed) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }
  const { data, error } = await supabase
    .from('users').update(updates).eq('id', req.userId).select().single();
  if (error) return res.status(500).json({ error: 'Update failed' });
  res.json({ user: data });
});

usersRouter.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, avatar_url, rating_as_driver, rating_as_passenger, total_trips, total_trips_driver, is_verified, created_at')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: 'User not found' });
  res.json({ user: data });
});

usersRouter.delete('/me', verifyAuth, async (req, res) => {
  await supabase.auth.admin.deleteUser(req.userId);
  await supabase.from('users').delete().eq('id', req.userId);
  res.json({ success: true });
});

module.exports = usersRouter;


// ─────────────────────────────────────────────────────────────────────────────
// routes/messages.js
// ─────────────────────────────────────────────────────────────────────────────
const messagesRouter = express.Router();
const { Notif } = require('../lib/notifications');

messagesRouter.get('/:bookingId', verifyAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('*, sender:users!messages_sender_id_fkey(id, full_name, avatar_url)')
    .eq('booking_id', req.params.bookingId)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: 'Failed to fetch messages' });

  // Mark unread messages as read
  await supabase
    .from('messages')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('booking_id', req.params.bookingId)
    .neq('sender_id', req.userId)
    .eq('is_read', false);

  res.json({ messages: data });
});

messagesRouter.post('/:bookingId', verifyAuth, async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Message content required' });

  const { data: message, error } = await supabase
    .from('messages')
    .insert({ booking_id: req.params.bookingId, sender_id: req.userId, content })
    .select('*, sender:users!messages_sender_id_fkey(id, full_name)')
    .single();

  if (error) return res.status(500).json({ error: 'Failed to send message' });

  // Notify the other party
  const { data: booking } = await supabase
    .from('bookings')
    .select('passenger_id, trip:trips(driver_id)')
    .eq('id', req.params.bookingId)
    .single();

  if (booking) {
    const recipientId = req.userId === booking.passenger_id
      ? booking.trip.driver_id
      : booking.passenger_id;
    const isDriver = req.userId === booking.trip.driver_id;
    const preview  = content.length > 60 ? content.slice(0, 60) + '...' : content;

    if (isDriver) {
      await Notif.driverMessage(recipientId, message.sender.full_name, preview, req.params.bookingId);
    } else {
      await Notif.passengerMessage(recipientId, message.sender.full_name, preview, req.params.bookingId);
    }
  }

  res.status(201).json({ message });
});

module.exports = messagesRouter;


// ─────────────────────────────────────────────────────────────────────────────
// routes/ratings.js
// ─────────────────────────────────────────────────────────────────────────────
const ratingsRouter = express.Router();

ratingsRouter.post('/', verifyAuth, async (req, res) => {
  const { booking_id, ratee_id, score, comment } = req.body;
  if (!booking_id || !ratee_id || !score) {
    return res.status(400).json({ error: 'booking_id, ratee_id, and score required' });
  }

  const { data: booking } = await supabase
    .from('bookings')
    .select('passenger_id, trip:trips(driver_id, departure_at)')
    .eq('id', booking_id)
    .single();

  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const isPassenger = req.userId === booking.passenger_id;
  const role = isPassenger ? 'passenger_rates_driver' : 'driver_rates_passenger';

  const expiresAt = new Date(booking.trip.departure_at);
  expiresAt.setHours(expiresAt.getHours() + 48);

  const { data: rating, error } = await supabase
    .from('ratings')
    .insert({ booking_id, rater_id: req.userId, ratee_id, role, score, comment, expires_at: expiresAt.toISOString() })
    .select().single();

  if (error) return res.status(500).json({ error: 'Failed to submit rating' });

  const { data: rater } = await supabase.from('users').select('full_name').eq('id', req.userId).single();
  if (isPassenger) await Notif.newRating(ratee_id, rater?.full_name ?? 'A passenger', score);

  res.status(201).json({ rating });
});

ratingsRouter.get('/user/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('ratings')
    .select('*, rater:users!ratings_rater_id_fkey(id, full_name, avatar_url)')
    .eq('ratee_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) return res.status(500).json({ error: 'Failed to fetch ratings' });
  res.json({ ratings: data });
});

module.exports = ratingsRouter;


// ─────────────────────────────────────────────────────────────────────────────
// routes/disputes.js
// ─────────────────────────────────────────────────────────────────────────────
const disputesRouter = express.Router();

disputesRouter.post('/', verifyAuth, async (req, res) => {
  const { booking_id, issue_type, description, is_urgent } = req.body;
  if (!booking_id || !issue_type || !description) {
    return res.status(400).json({ error: 'booking_id, issue_type, and description required' });
  }

  const { data, error } = await supabase
    .from('disputes')
    .insert({ booking_id, reporter_id: req.userId, issue_type, description, is_urgent: is_urgent ?? false })
    .select().single();

  if (error) return res.status(500).json({ error: 'Failed to file dispute' });

  // Get other party to notify
  const { data: booking } = await supabase
    .from('bookings')
    .select('passenger_id, trip:trips(driver_id)')
    .eq('id', booking_id).single();

  if (booking) {
    const otherId = req.userId === booking.passenger_id
      ? booking.trip.driver_id
      : booking.passenger_id;
    const { data: reporter } = await supabase.from('users').select('full_name').eq('id', req.userId).single();
    await Notif.disputeOpened(otherId, reporter?.full_name ?? 'A user');
  }

  res.status(201).json({ dispute: data });
});

disputesRouter.get('/:id', verifyAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('disputes').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Dispute not found' });
  res.json({ dispute: data });
});

module.exports = disputesRouter;


// ─────────────────────────────────────────────────────────────────────────────
// routes/notifications.js
// ─────────────────────────────────────────────────────────────────────────────
const notificationsRouter = express.Router();

notificationsRouter.get('/', verifyAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: 'Failed to fetch notifications' });

  const unread = data.filter(n => !n.is_read).length;
  res.json({ notifications: data, unread_count: unread });
});

notificationsRouter.patch('/read-all', verifyAuth, async (req, res) => {
  await supabase.from('notifications').update({ is_read: true }).eq('user_id', req.userId);
  res.json({ success: true });
});

notificationsRouter.patch('/:id/read', verifyAuth, async (req, res) => {
  await supabase.from('notifications').update({ is_read: true })
    .eq('id', req.params.id).eq('user_id', req.userId);
  res.json({ success: true });
});

notificationsRouter.delete('/:id', verifyAuth, async (req, res) => {
  await supabase.from('notifications').delete()
    .eq('id', req.params.id).eq('user_id', req.userId);
  res.json({ success: true });
});

module.exports = notificationsRouter;


// ─────────────────────────────────────────────────────────────────────────────
// routes/payments.js
// ─────────────────────────────────────────────────────────────────────────────
const paymentsRouter = express.Router();
const stripeLib      = require('../lib/stripe');

paymentsRouter.post('/setup-intent', verifyAuth, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users').select('stripe_customer_id').eq('id', req.userId).single();

    let customerId = user?.stripe_customer_id;
    if (!customerId) {
      const c = await stripeLib.customers.create({ metadata: { user_id: req.userId } });
      customerId = c.id;
      await supabase.from('users').update({ stripe_customer_id: customerId }).eq('id', req.userId);
    }

    const intent = await stripeLib.setupIntents.create({ customer: customerId, payment_method_types: ['card'] });
    res.json({ client_secret: intent.client_secret });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create setup intent' });
  }
});

paymentsRouter.get('/methods', verifyAuth, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users').select('stripe_customer_id').eq('id', req.userId).single();
    if (!user?.stripe_customer_id) return res.json({ payment_methods: [] });

    const methods = await stripeLib.paymentMethods.list({
      customer: user.stripe_customer_id, type: 'card',
    });
    res.json({ payment_methods: methods.data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payment methods' });
  }
});

paymentsRouter.delete('/methods/:id', verifyAuth, async (req, res) => {
  try {
    await stripeLib.paymentMethods.detach(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove payment method' });
  }
});

paymentsRouter.post('/payout', verifyAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from('driver_profiles').select('stripe_account_id').eq('user_id', req.userId).single();
    if (!profile?.stripe_account_id) {
      return res.status(400).json({ error: 'No Stripe account connected' });
    }
    const payout = await stripeLib.payouts.create(
      { amount: Math.round(req.body.amount * 100), currency: 'cad' },
      { stripeAccount: profile.stripe_account_id }
    );
    res.json({ payout });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stripe webhook
paymentsRouter.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripeLib.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  switch (event.type) {
    case 'payment_intent.succeeded':
      console.log('[Stripe] Payment succeeded:', event.data.object.id);
      break;
    case 'payout.paid':
      const payout = event.data.object;
      console.log('[Stripe] Payout paid:', payout.amount / 100);
      break;
  }

  res.json({ received: true });
});

module.exports = paymentsRouter;


// ─────────────────────────────────────────────────────────────────────────────
// routes/driver.js
// ─────────────────────────────────────────────────────────────────────────────
const driverRouter = express.Router();

driverRouter.post('/verify', verifyAuth, async (req, res) => {
  const { doc_type, file_url } = req.body;
  const validDocs = ['licence', 'insurance', 'registration', 'photo', 'abstract'];
  if (!validDocs.includes(doc_type)) return res.status(400).json({ error: 'Invalid doc type' });

  const updateField = `${doc_type}_status`;
  const urlField    = `${doc_type}_url`;

  // Upsert driver profile
  const { error } = await supabase.from('driver_profiles').upsert({
    user_id:       req.userId,
    [updateField]: 'uploaded',
    [urlField]:    file_url,
  }, { onConflict: 'user_id' });

  if (error) return res.status(500).json({ error: 'Failed to update verification' });
  res.json({ success: true, status: 'uploaded' });
});

driverRouter.get('/verification', verifyAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('driver_profiles').select('*').eq('user_id', req.userId).single();
  if (error) return res.json({ profile: null });
  res.json({ profile: data });
});

driverRouter.get('/analytics', verifyAuth, async (req, res) => {
  const { period = 'week' } = req.query;
  const now   = new Date();
  let startDate = new Date();

  if (period === 'week')  startDate.setDate(now.getDate() - 7);
  if (period === 'month') startDate.setDate(now.getDate() - 30);
  if (period === 'year')  startDate.setFullYear(now.getFullYear() - 1);

  const { data: bookings, error } = await supabase
    .from('bookings')
    .select('fare_amount, booking_fee, seats, status, created_at, trip:trips(from_city, to_city, departure_at)')
    .eq('status', 'completed')
    .gte('created_at', startDate.toISOString())
    .eq('trip.driver_id', req.userId);

  if (error) return res.status(500).json({ error: 'Failed to fetch analytics' });

  const gross      = bookings.reduce((s, b) => s + parseFloat(b.fare_amount), 0);
  const net        = gross * 0.9;
  const trips      = new Set(bookings.map(b => b.trip_id)).size;
  const passengers = bookings.reduce((s, b) => s + b.seats, 0);

  res.json({ gross, net, trips, passengers, bookings });
});

driverRouter.post('/location', verifyAuth, async (req, res) => {
  const { trip_id, lat, lng, heading, speed } = req.body;
  if (!trip_id || !lat || !lng) return res.status(400).json({ error: 'trip_id, lat, lng required' });

  const { error } = await supabase.from('driver_locations').upsert({
    trip_id, driver_id: req.userId, lat, lng, heading, speed, updated_at: new Date().toISOString(),
  }, { onConflict: 'trip_id,driver_id' });

  if (error) return res.status(500).json({ error: 'Failed to update location' });
  res.json({ success: true });
});

module.exports = driverRouter;


// ─────────────────────────────────────────────────────────────────────────────
// routes/packages.js
// ─────────────────────────────────────────────────────────────────────────────
const packagesRouter = express.Router();
const stripeForPkg   = require('../lib/stripe');

packagesRouter.post('/', verifyAuth, async (req, res) => {
  const { trip_id, package_type, is_fragile, pickup_area, delivery_area,
          sender_name, sender_phone, recipient_name, recipient_phone,
          notes, payment_method_id, price: clientPrice, cash_only } = req.body;

  if (!trip_id || !package_type) return res.status(400).json({ error: 'trip_id and package_type required' });

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

  // Fetch trip to determine route distance
  const { data: trip } = await supabase
    .from('trips').select('from_city, to_city, cash_only, driver_id').eq('id', trip_id).single();
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  // Block sender from shipping on their own trip
  if (trip.driver_id === req.userId) return res.status(400).json({ error: 'Cannot ship on your own trip' });

  const DISTANCES = {
    'ottawa-montreal':200,'montreal-ottawa':200,'ottawa-toronto':450,'toronto-ottawa':450,
    'montreal-toronto':540,'toronto-montreal':540,'ottawa-kingston':195,'kingston-ottawa':195,
    'toronto-kingston':260,'kingston-toronto':260,'montreal-quebec':255,'quebec-montreal':255,
    'ottawa-cornwall':110,'cornwall-ottawa':110,'toronto-peterborough':145,'peterborough-toronto':145,
  };
  const routeKey = (trip.from_city+'-'+trip.to_city).toLowerCase();
  const distKm   = DISTANCES[routeKey] || 300;
  const bucket   = distKm <= 100 ? 'short' : distKm <= 350 ? 'medium' : 'long';
  const typePrices = PRICES[package_type] || PRICES.small_box;
  const price    = clientPrice || typePrices[bucket];

  const isCash = cash_only || trip.cash_only;

  let stripeIntentId = null;
  if (!isCash && payment_method_id) {
    const { data: user } = await supabase
      .from('users').select('stripe_customer_id').eq('id', req.userId).single();
    const intent = await stripeForPkg.paymentIntents.create({
      amount: Math.round(price * 100), currency: 'cad',
      customer: user?.stripe_customer_id,
      payment_method: payment_method_id,
      confirm: true,
      capture_method: 'manual',
      return_url: 'concordxpress://payment-complete',
    });
    stripeIntentId = intent.id;
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
  const { data: driver } = await supabase.from('users').select('fcm_token, full_name').eq('id', trip.driver_id).single();
  if (driver?.fcm_token) {
    await supabase.from('notifications').insert({
      user_id: trip.driver_id,
      type: 'package',
      title: '📦 New package on your trip',
      body: sender_name + ' wants to send a ' + package_type.replace('_',' ') + ' to ' + trip.to_city,
      action_url: '/driver/home',
    });
  }

  res.status(201).json({ package: data });
});

packagesRouter.patch('/:id/confirm', verifyAuth, async (req, res) => {
  const { data: pkg } = await supabase
    .from('packages').select('stripe_payment_intent_id').eq('id', req.params.id).single();
  if (!pkg) return res.status(404).json({ error: 'Package not found' });

  await stripeForPkg.paymentIntents.capture(pkg.stripe_payment_intent_id);
  await supabase.from('packages').update({ status: 'delivered', delivery_confirmed_at: new Date().toISOString() }).eq('id', req.params.id);
  res.json({ success: true });
});

module.exports = packagesRouter;


// ─────────────────────────────────────────────────────────────────────────────
// routes/loyalty.js
// ─────────────────────────────────────────────────────────────────────────────
const loyaltyRouter = express.Router();

loyaltyRouter.get('/', verifyAuth, async (req, res) => {
  const { data: user } = await supabase
    .from('users').select('total_trips, is_founding_member').eq('id', req.userId).single();

  const { data: credits } = await supabase
    .from('loyalty_credits').select('*').eq('user_id', req.userId)
    .is('used_at', null).gte('expires_at', new Date().toISOString()).order('created_at');

  const { data: drawEntries } = await supabase
    .from('draw_entries').select('*').eq('user_id', req.userId)
    .eq('month', new Date().toISOString().slice(0, 7));

  const availableCredit = credits?.reduce((s, c) => s + parseFloat(c.amount), 0) ?? 0;

  res.json({
    total_trips:       user?.total_trips ?? 0,
    is_founding:       user?.is_founding_member ?? false,
    available_credit:  availableCredit,
    credits,
    draw_entries_this_month: drawEntries?.[0]?.entries ?? 0,
  });
});

module.exports = loyaltyRouter;


// ─────────────────────────────────────────────────────────────────────────────
// Re-export all routers for use in src/index.js
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: This file exports nothing — each section above is a self-contained
// router module. Save each section as its own file:
//
//   src/routes/users.js          → usersRouter export
//   src/routes/messages.js       → messagesRouter export
//   src/routes/ratings.js        → ratingsRouter export
//   src/routes/disputes.js       → disputesRouter export
//   src/routes/notifications.js  → notificationsRouter export
//   src/routes/payments.js       → paymentsRouter export
//   src/routes/driver.js         → driverRouter export
//   src/routes/packages.js       → packagesRouter export
//   src/routes/loyalty.js        → loyaltyRouter export
//
// Each file should end with: module.exports = [routerName];
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/packages/mine — Sender sees their sent packages
packagesRouter.get('/mine', verifyAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('packages')
    .select('*, trip:trips(id, from_city, to_city, departure_at, driver:users!trips_driver_id_fkey(id, full_name, avatar_url))')
    .eq('sender_id', req.userId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Failed to fetch packages' });
  res.json({ packages: data });
});

// GET /api/packages/trip/:tripId — Driver sees packages on their trip
packagesRouter.get('/trip/:tripId', verifyAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('packages')
    .select('*, sender:users!packages_sender_id_fkey(id, full_name, avatar_url)')
    .eq('trip_id', req.params.tripId)
    .neq('status', 'cancelled');
  if (error) return res.status(500).json({ error: 'Failed to fetch packages' });
  res.json({ packages: data });
});
