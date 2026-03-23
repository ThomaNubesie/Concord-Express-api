require('dotenv').config();
const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const { verifyAuth } = require('../middleware/auth');

const ROUTE_PRICES = {
  'ottawa-toronto':      { floor: 40, ceiling: 56 },
  'ottawa-montreal':     { floor: 22, ceiling: 31 },
  'ottawa-kingston':     { floor: 18, ceiling: 25 },
  'ottawa-cornwall':     { floor: 12, ceiling: 17 },
  'ottawa-peterborough': { floor: 25, ceiling: 35 },
  'toronto-ottawa':      { floor: 40, ceiling: 56 },
  'toronto-montreal':    { floor: 55, ceiling: 77 },
  'montreal-ottawa':     { floor: 22, ceiling: 31 },
  'montreal-quebec':     { floor: 25, ceiling: 35 },
  'montreal-chicoutimi': { floor: 35, ceiling: 49 },
  'kingston-ottawa':     { floor: 18, ceiling: 25 },
  'kingston-toronto':    { floor: 25, ceiling: 35 },
  'moncton-fredericton': { floor: 18, ceiling: 25 },
  'fredericton-moncton': { floor: 18, ceiling: 25 },
};

function getRouteBounds(from, to) {
  return ROUTE_PRICES[from + '-' + to] || { floor: 15, ceiling: 80 };
}

function getTripAvailability(trip) {
  const minsUntil = (new Date(trip.departure_at) - Date.now()) / 60000;
  const seatsLeft = trip.seats_total - trip.seats_booked;
  if (minsUntil < 10)  return 'closed';
  if (minsUntil < 15)  return 'last_chance';
  if (minsUntil < 30)  return 'closing_soon';
  if (seatsLeft === 1) return 'one_left';
  return 'open';
}

function getComfortScore(trip) {
  let score = parseFloat(trip.driver?.rating_as_driver || 3.0);
  if (trip.pref_ac)        score += 0.2;
  if (trip.pref_music)     score += 0.1;
  if (!trip.pref_smoking)  score += 0.2;
  if (trip.driver?.total_trips_driver > 100) score += 0.3;
  if (trip.driver?.total_trips_driver > 300) score += 0.2;
  return score;
}

router.get('/', async (req, res) => {
  try {
    const { from_city, to_city, date, seats = 1, priority = 'time', page = 1, limit = 20 } = req.query;

    if (!from_city || !to_city) {
      return res.status(400).json({ error: 'from_city and to_city are required' });
    }

    const fromLower = from_city.toLowerCase().trim();
    const toLower   = to_city.toLowerCase().trim();

    console.log('[Trips] Searching:', fromLower, '->', toLower, 'seats:', seats, 'priority:', priority);

    // Simple query first — no joins
    const { data: trips, error, count } = await supabase
      .from('trips')
      .select('*', { count: 'exact' })
      .eq('from_city', fromLower)
      .eq('to_city', toLower)
      .eq('status', 'upcoming')
      .limit(parseInt(limit));

    console.log('[Trips] Raw result count:', count, 'error:', error?.message);

    if (error) throw error;

    if (!trips || trips.length === 0) {
      // Debug: check what cities exist
      const { data: sample } = await supabase
        .from('trips')
        .select('from_city, to_city, status')
        .limit(5);
      console.log('[Trips] Sample trips in DB:', JSON.stringify(sample));
      return res.json({ trips: [], total: 0, page: parseInt(page), priority, suggestions: [], debug: { sample } });
    }

    // Now fetch with driver info
    const { data: fullTrips } = await supabase
      .from('trips')
      .select(`
        *,
        driver:users!trips_driver_id_fkey(
          id, full_name, avatar_url,
          rating_as_driver, total_trips_driver, is_verified
        ),
        pickup_stops(*),
        dropoff_stops(*)
      `)
      .eq('from_city', fromLower)
      .eq('to_city', toLower)
      .eq('status', 'upcoming')
      .gte('departure_at', new Date(Date.now() + 10 * 60000).toISOString())
      .order('departure_at', { ascending: true })
      .limit(parseInt(limit));

    let filtered = (fullTrips || []).filter(t => (t.seats_total - t.seats_booked) >= parseInt(seats));

    if (priority === 'price')   filtered.sort((a, b) => a.price_per_seat - b.price_per_seat);
    if (priority === 'comfort') filtered.sort((a, b) => getComfortScore(b) - getComfortScore(a));

    const withMeta = filtered.map(trip => ({
      ...trip,
      seats_available: trip.seats_total - trip.seats_booked,
      availability:    getTripAvailability(trip),
      comfort_score:   getComfortScore(trip),
    }));

    res.json({ trips: withMeta, total: filtered.length, page: parseInt(page), priority, suggestions: [] });
  } catch (err) {
    console.error('[Trips] search error:', err);
    res.status(500).json({ error: 'Failed to search trips: ' + err.message });
  }
});

router.get('/driver/mine', verifyAuth, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    let query = supabase
      .from('trips')
      .select('*, pickup_stops(*), dropoff_stops(*), bookings(id, status, seats, fare_amount, passenger:users!bookings_passenger_id_fkey(id, full_name, avatar_url))')
      .eq('driver_id', req.userId)
      .order('departure_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);
    if (status) query = query.eq('status', status);
    const { data: trips, error } = await query;
    if (error) throw error;
    res.json({ trips });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { data: trip, error } = await supabase
      .from('trips')
      .select('*, driver:users!trips_driver_id_fkey(id, full_name, avatar_url, rating_as_driver, total_trips_driver, is_verified), pickup_stops(*), dropoff_stops(*)')
      .eq('id', req.params.id)
      .single();
    if (error || !trip) return res.status(404).json({ error: 'Trip not found' });
    res.json({ trip: { ...trip, availability: getTripAvailability(trip) } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch trip' });
  }
});

router.post('/', verifyAuth, async (req, res) => {
  try {
    const { from_city, to_city, departure_at, seats_total, price_per_seat,
            pickup_stops, dropoff_stops, preferences = {}, notes,
            is_transit = false, is_recurring = false, recurring_days } = req.body;
    if (!from_city || !to_city || !departure_at || !seats_total || !price_per_seat) {
      return res.status(400).json({ error: 'Missing required trip fields' });
    }
    const bounds = getRouteBounds(from_city.toLowerCase(), to_city.toLowerCase());
    const dayStart = new Date(departure_at); dayStart.setHours(0,0,0,0);
    const dayEnd   = new Date(departure_at); dayEnd.setHours(23,59,59,999);
    const { count } = await supabase.from('trips').select('*', { count: 'exact', head: true })
      .eq('driver_id', req.userId).gte('departure_at', dayStart.toISOString())
      .lte('departure_at', dayEnd.toISOString()).in('status', ['upcoming','active']);
    if (count >= 2) return res.status(400).json({ error: 'You already have 2 trips on this day' });
    const { data: trip, error: tripError } = await supabase.from('trips').insert({
      driver_id: req.userId, from_city: from_city.toLowerCase(), to_city: to_city.toLowerCase(),
      departure_at, seats_total, price_per_seat,
      price_floor: bounds.floor, price_ceiling: bounds.ceiling,
      notes, is_transit, is_recurring, recurring_days,
      pref_ac: preferences.ac ?? true, pref_music: preferences.music ?? true,
      pref_pets: preferences.pets ?? false, pref_smoking: preferences.smoking ?? false,
      pref_no_eating: preferences.noEating ?? false, pref_no_drinks: preferences.noDrinks ?? false,
      pref_shoes_on: preferences.shoesOn ?? false, pref_quiet_ride: preferences.quietRide ?? false,
      pref_brief_calls: preferences.briefCalls ?? false,
      pref_temperature: preferences.temperature ?? 'any',
      pref_extra_stops: preferences.extraStops ?? 'none',
      pref_children: preferences.children ?? 'welcome',
      pref_wait_mins: preferences.waitMins ?? 5,
      pref_luggage: preferences.luggage ?? 'all',
    }).select().single();
    if (tripError) throw tripError;
    if (pickup_stops?.length) {
      await supabase.from('pickup_stops').insert(
        pickup_stops.map((s, i) => ({ trip_id: trip.id, area: s.area, lat: s.lat, lng: s.lng, is_custom: s.isCustom ?? false, departs_at: s.time, stop_order: i }))
      );
    }
    if (dropoff_stops?.length) {
      await supabase.from('dropoff_stops').insert(
        dropoff_stops.map((s, i) => ({ trip_id: trip.id, area: s.area, lat: s.lat, lng: s.lng, is_custom: s.isCustom ?? false, stop_order: i }))
      );
    }
    const { data: fullTrip } = await supabase.from('trips').select('*, pickup_stops(*), dropoff_stops(*)').eq('id', trip.id).single();
    res.status(201).json({ trip: fullTrip });
  } catch (err) {
    console.error('[Trips] create error:', err);
    res.status(500).json({ error: 'Failed to create trip' });
  }
});

router.patch('/:id', verifyAuth, async (req, res) => {
  try {
    const { data: trip } = await supabase.from('trips').select('*, bookings(id, status)').eq('id', req.params.id).eq('driver_id', req.userId).single();
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    const hasBookings = trip.bookings?.some(b => ['confirmed','active'].includes(b.status));
    const minsUntil   = (new Date(trip.departure_at) - Date.now()) / 60000;
    const lockState   = minsUntil < 0 ? 'active' : minsUntil < 60 ? 'locked' : hasBookings ? 'partial' : 'unlocked';
    if (lockState === 'locked' || lockState === 'active') return res.status(400).json({ error: 'Trip is locked' });
    const allowed = lockState === 'unlocked'
      ? ['seats_total','price_per_seat','departure_at','notes','pref_ac','pref_music','pref_pets','pref_smoking','pref_no_eating','pref_no_drinks','pref_shoes_on','pref_quiet_ride','pref_brief_calls','pref_temperature','pref_extra_stops','pref_children','pref_wait_mins','pref_luggage']
      : ['notes','pref_ac','pref_music','pref_pets','pref_smoking','pref_no_eating','pref_no_drinks','pref_shoes_on','pref_quiet_ride','pref_brief_calls','pref_temperature','pref_extra_stops','pref_children','pref_wait_mins','pref_luggage'];
    const updates = {};
    for (const f of allowed) { if (req.body[f] !== undefined) updates[f] = req.body[f]; }
    const { data: updated, error } = await supabase.from('trips').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ trip: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update trip' });
  }
});

router.delete('/:id', verifyAuth, async (req, res) => {
  try {
    const { data: trip } = await supabase.from('trips').select('*, bookings(id, status, total_amount)').eq('id', req.params.id).eq('driver_id', req.userId).single();
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    const activeBookings = trip.bookings?.filter(b => ['confirmed','active'].includes(b.status)) ?? [];
    for (const b of activeBookings) {
      await supabase.from('bookings').update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_by: 'driver', refund_amount: b.total_amount, refund_pct: 100 }).eq('id', b.id);
    }
    await supabase.from('trips').update({ status: 'cancelled' }).eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel trip' });
  }
});

router.patch('/:id/stops/:stopId/complete', verifyAuth, async (req, res) => {
  try {
    const { data: stop, error } = await supabase.from('pickup_stops')
      .update({ is_done: true, done_at: new Date().toISOString() })
      .eq('id', req.params.stopId).eq('trip_id', req.params.id).select().single();
    if (error) throw error;
    res.json({ stop });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark stop complete' });
  }
});

module.exports = router;
