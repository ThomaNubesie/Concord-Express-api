const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const { verifyAuth } = require('../middleware/auth');

router.post('/verify', verifyAuth, async (req, res) => {
  const { doc_type, file_url } = req.body;
  const validDocs = ['licence', 'insurance', 'registration', 'photo', 'abstract'];
  if (!validDocs.includes(doc_type)) return res.status(400).json({ error: 'Invalid doc type' });
  const { error } = await supabase.from('driver_profiles').upsert({
    user_id: req.userId, [`${doc_type}_status`]: 'uploaded', [`${doc_type}_url`]: file_url,
  }, { onConflict: 'user_id' });
  if (error) return res.status(500).json({ error: 'Failed to update verification' });
  res.json({ success: true, status: 'uploaded' });
});

// POST /api/driver/vehicle — save vehicle info
router.post('/vehicle', verifyAuth, async (req, res) => {
  const {
    vehicle_make, vehicle_model, vehicle_year, vehicle_color,
    vehicle_plate, vehicle_province, vehicle_seats, vehicle_image_url,
  } = req.body;
  const { error } = await supabase.from('driver_profiles').upsert({
    user_id: req.userId,
    vehicle_make, vehicle_model, vehicle_year, vehicle_color,
    vehicle_plate, vehicle_province, vehicle_seats, vehicle_image_url,
  }, { onConflict: 'user_id' });
  if (error) return res.status(500).json({ error: 'Failed to save vehicle info' });
  res.json({ success: true });
});

// POST /api/driver/fee — record driver fee payment
router.post('/fee', verifyAuth, async (req, res) => {
  const { payment_intent_id, amount } = req.body;
  try {
    // Check founding member count
    const { data: config } = await supabase
      .from('app_config').select('value').eq('key', 'founding_driver_count').single();
    const count = parseInt(config?.value || '0');
    const isFounder = count < 100;
    const now = new Date();
    const expires = new Date(now);
    expires.setFullYear(expires.getFullYear() + 1);

    const { error } = await supabase.from('driver_profiles').upsert({
      user_id:            req.userId,
      fee_paid:           true,
      fee_paid_at:        now.toISOString(),
      fee_expires_at:     expires.toISOString(),
      fee_amount:         amount,
      is_founding_member: isFounder,
      driver_status:      'pending',
    }, { onConflict: 'user_id' });
    if (error) return res.status(500).json({ error: 'Failed to record fee' });

    // Increment founding count if founder
    if (isFounder) {
      await supabase.from('app_config')
        .update({ value: String(count + 1) })
        .eq('key', 'founding_driver_count');
    }
    res.json({ success: true, is_founding_member: isFounder, founding_count: count + 1 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process fee' });
  }
});

// GET /api/driver/founding-count — get current founding member count
router.get('/founding-count', async (req, res) => {
  const { data } = await supabase
    .from('app_config').select('value').eq('key', 'founding_driver_count').single();
  res.json({ count: parseInt(data?.value || '0'), limit: 100 });
});

router.get('/verification', verifyAuth, async (req, res) => {
  const { data, error } = await supabase.from('driver_profiles').select('*').eq('user_id', req.userId).single();
  if (error) return res.json({ profile: null });
  res.json({ profile: data });
});

router.get('/analytics', verifyAuth, async (req, res) => {
  try {
    const { period = 'week' } = req.query;
    const now = new Date(); const startDate = new Date();
    if (period === 'week')  startDate.setDate(now.getDate() - 7);
    if (period === 'month') startDate.setDate(now.getDate() - 30);
    if (period === 'year')  startDate.setFullYear(now.getFullYear() - 1);

    // Get completed trips driven by this driver in period
    const { data: trips, error: tripsErr } = await supabase
      .from('trips')
      .select('id, departure_at, bookings(id, fare_amount, seats, status)')
      .eq('driver_id', req.userId)
      .in('status', ['completed', 'active'])
      .gte('departure_at', startDate.toISOString());
    if (tripsErr) throw tripsErr;

    // Get package earnings for same trips
    const tripIds = (trips || []).map(t => t.id);
    let pkgEarnings = 0;
    if (tripIds.length) {
      const { data: pkgs } = await supabase
        .from('packages')
        .select('price, status')
        .in('trip_id', tripIds)
        .neq('status', 'cancelled');
      pkgEarnings = (pkgs || []).reduce((s, p) => s + parseFloat(p.price || 0) * 0.75, 0);
    }

    // Get all-time trip count
    const { count: allTimeTrips } = await supabase
      .from('trips')
      .select('id', { count: 'exact', head: true })
      .eq('driver_id', req.userId)
      .eq('status', 'completed');

    let gross = 0, passengers = 0, uniqueTrips = 0;
    for (const trip of trips || []) {
      const completedBookings = (trip.bookings || []).filter(b =>
        ['confirmed', 'active', 'completed'].includes(b.status)
      );
      if (completedBookings.length > 0 || true) uniqueTrips++;
      for (const b of completedBookings) {
        gross += parseFloat(b.fare_amount || 0);
        passengers += b.seats || 1;
      }
    }
    gross += pkgEarnings;
    const net = gross * 0.9;

    res.json({ gross, net, trips: uniqueTrips, passengers, pkg_earnings: pkgEarnings, all_time_trips: allTimeTrips || 0 });
  } catch (err) {
    console.error('[analytics]', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// POST /api/driver/location — Update driver location
router.post('/location', verifyAuth, async (req, res) => {
  const { trip_id, lat, lng, heading, speed } = req.body;
  if (!trip_id || !lat || !lng) return res.status(400).json({ error: 'trip_id, lat, lng required' });
  const { error } = await supabase.from('driver_locations').upsert(
    { trip_id, driver_id: req.userId, lat, lng, heading, speed, updated_at: new Date().toISOString() },
    { onConflict: 'trip_id,driver_id' }
  );
  if (error) return res.status(500).json({ error: 'Failed to update location' });
  res.json({ success: true });
});

// GET /api/driver/location/:tripId — Get driver's current location for a trip
router.get('/location/:tripId', verifyAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('driver_locations')
      .select('*')
      .eq('trip_id', req.params.tripId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (error) return res.json({ location: null });
    res.json({ location: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch location' });
  }
});

module.exports = router;
