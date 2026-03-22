const express    = require('express');
const router     = express.Router();
const supabase   = require('../lib/supabase');
const { verifyAuth } = require('../middleware/auth');
const { Notif }  = require('../lib/notifications');

// ── GET /api/trips — Search trips ─────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const {
      from_city, to_city, date,
      seats = 1, page = 1, limit = 20,
    } = req.query;

    if (!from_city || !to_city) {
      return res.status(400).json({ error: 'from_city and to_city are required' });
    }

    let query = supabase
      .from('trips')
      .select(`
        *,
        driver:users!trips_driver_id_fkey(
          id, full_name, avatar_url,
          rating_as_driver, total_trips_driver
        ),
        pickup_stops(*),
        dropoff_stops(*)
      `)
      .eq('from_city', from_city)
      .eq('to_city', to_city)
      .eq('status', 'upcoming')
      .gte('departure_at', new Date().toISOString())
      .lte('seats_booked', supabase.raw('seats_total - ?', [parseInt(seats)]))
      .order('departure_at', { ascending: true })
      .range((page - 1) * limit, page * limit - 1);

    if (date) {
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);
      query = query
        .gte('departure_at', startOfDay.toISOString())
        .lte('departure_at', endOfDay.toISOString());
    }

    const { data: trips, error } = await query;
    if (error) throw error;

    // Add availability status to each trip
    const tripsWithStatus = trips.map(trip => ({
      ...trip,
      seats_available: trip.seats_total - trip.seats_booked,
      availability:    getTripAvailability(trip),
    }));

    res.json({ trips: tripsWithStatus, page: parseInt(page) });
  } catch (err) {
    console.error('[Trips] search error:', err);
    res.status(500).json({ error: 'Failed to search trips' });
  }
});

// ── GET /api/trips/driver/mine — Driver's posted trips ───────────────────────

router.get('/driver/mine', verifyAuth, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;

    let query = supabase
      .from('trips')
      .select(`
        *,
        pickup_stops(*),
        dropoff_stops(*),
        bookings(
          id, status, seats, fare_amount,
          passenger:users!bookings_passenger_id_fkey(
            id, full_name, avatar_url, rating_as_passenger
          ),
          pickup_stop:pickup_stops(area),
          dropoff_stop:dropoff_stops(area)
        )
      `)
      .eq('driver_id', req.userId)
      .order('departure_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (status) query = query.eq('status', status);

    const { data: trips, error } = await query;
    if (error) throw error;

    res.json({ trips });
  } catch (err) {
    console.error('[Trips] driver mine error:', err);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// ── GET /api/trips/:id — Single trip ─────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const { data: trip, error } = await supabase
      .from('trips')
      .select(`
        *,
        driver:users!trips_driver_id_fkey(
          id, full_name, avatar_url,
          rating_as_driver, total_trips_driver
        ),
        pickup_stops(*),
        dropoff_stops(*)
      `)
      .eq('id', req.params.id)
      .single();

    if (error || !trip) {
      return res.status(404).json({ error: 'Trip not found' });
    }

    res.json({ trip });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch trip' });
  }
});

// ── POST /api/trips — Create trip ────────────────────────────────────────────

router.post('/', verifyAuth, async (req, res) => {
  try {
    const {
      from_city, to_city, departure_at,
      seats_total, price_per_seat,
      pickup_stops, dropoff_stops,
      preferences = {}, notes,
      is_transit = false, is_recurring = false, recurring_days,
    } = req.body;

    // Validate required fields
    if (!from_city || !to_city || !departure_at || !seats_total || !price_per_seat) {
      return res.status(400).json({ error: 'Missing required trip fields' });
    }

    // Get price bounds for route
    const bounds = getRoutePriceBounds(from_city, to_city);
    if (price_per_seat < bounds.floor || price_per_seat > bounds.ceiling) {
      return res.status(400).json({
        error: `Price must be between C$${bounds.floor} and C$${bounds.ceiling} for this route`,
      });
    }

    // Check max 2 trips per day
    const dayStart = new Date(departure_at);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(departure_at);
    dayEnd.setHours(23, 59, 59, 999);

    const { count } = await supabase
      .from('trips')
      .select('*', { count: 'exact', head: true })
      .eq('driver_id', req.userId)
      .gte('departure_at', dayStart.toISOString())
      .lte('departure_at', dayEnd.toISOString())
      .in('status', ['upcoming', 'active']);

    if (count >= 2) {
      return res.status(400).json({ error: 'You already have 2 trips on this day' });
    }

    // Create trip
    const { data: trip, error: tripError } = await supabase
      .from('trips')
      .insert({
        driver_id:      req.userId,
        from_city,
        to_city,
        departure_at,
        seats_total,
        price_per_seat,
        price_floor:    bounds.floor,
        price_ceiling:  bounds.ceiling,
        notes,
        is_transit,
        is_recurring,
        recurring_days,
        // Spread preferences
        pref_ac:           preferences.ac           ?? true,
        pref_music:        preferences.music        ?? true,
        pref_pets:         preferences.pets         ?? false,
        pref_smoking:      preferences.smoking      ?? false,
        pref_no_eating:    preferences.noEating     ?? false,
        pref_no_drinks:    preferences.noDrinks     ?? false,
        pref_shoes_on:     preferences.shoesOn      ?? false,
        pref_quiet_ride:   preferences.quietRide    ?? false,
        pref_brief_calls:  preferences.briefCalls   ?? false,
        pref_temperature:  preferences.temperature  ?? 'any',
        pref_extra_stops:  preferences.extraStops   ?? 'none',
        pref_children:     preferences.children     ?? 'welcome',
        pref_wait_mins:    preferences.waitMins     ?? 5,
        pref_luggage:      preferences.luggage      ?? 'all',
      })
      .select()
      .single();

    if (tripError) throw tripError;

    // Insert pickup stops
    if (pickup_stops?.length) {
      const stopsToInsert = pickup_stops.map((stop, i) => ({
        trip_id:    trip.id,
        area:       stop.area,
        lat:        stop.lat,
        lng:        stop.lng,
        is_custom:  stop.isCustom ?? false,
        custom_addr:stop.customAddr,
        departs_at: stop.time,
        stop_order: i,
      }));

      const { error: stopsError } = await supabase
        .from('pickup_stops')
        .insert(stopsToInsert);

      if (stopsError) throw stopsError;
    }

    // Insert dropoff stops
    if (dropoff_stops?.length) {
      const dropoffsToInsert = dropoff_stops.map((stop, i) => ({
        trip_id:    trip.id,
        area:       stop.area,
        lat:        stop.lat,
        lng:        stop.lng,
        is_custom:  stop.isCustom ?? false,
        custom_addr:stop.customAddr,
        stop_order: i,
      }));

      const { error: dropoffsError } = await supabase
        .from('dropoff_stops')
        .insert(dropoffsToInsert);

      if (dropoffsError) throw dropoffsError;
    }

    // Fetch complete trip with stops
    const { data: fullTrip } = await supabase
      .from('trips')
      .select('*, pickup_stops(*), dropoff_stops(*)')
      .eq('id', trip.id)
      .single();

    res.status(201).json({ trip: fullTrip });
  } catch (err) {
    console.error('[Trips] create error:', err);
    res.status(500).json({ error: 'Failed to create trip' });
  }
});

// ── PATCH /api/trips/:id — Edit trip ─────────────────────────────────────────

router.patch('/:id', verifyAuth, async (req, res) => {
  try {
    // Verify driver owns this trip
    const { data: trip, error: fetchError } = await supabase
      .from('trips')
      .select('*, bookings(id, status, passenger_id)')
      .eq('id', req.params.id)
      .eq('driver_id', req.userId)
      .single();

    if (fetchError || !trip) {
      return res.status(404).json({ error: 'Trip not found' });
    }

    // Determine lock state
    const hasBookings    = trip.bookings?.some(b => ['confirmed','active'].includes(b.status));
    const minsUntilDep   = (new Date(trip.departure_at) - Date.now()) / 60000;
    const lockState      = minsUntilDep < 0   ? 'active'
                         : minsUntilDep < 60  ? 'locked'
                         : hasBookings        ? 'partial'
                         : 'unlocked';

    if (lockState === 'locked' || lockState === 'active') {
      return res.status(400).json({ error: 'Trip is locked and cannot be edited' });
    }

    // Build allowed updates based on lock state
    const allowedFields = lockState === 'unlocked'
      ? ['seats_total','price_per_seat','departure_at','notes',
         'pref_ac','pref_music','pref_pets','pref_smoking','pref_no_eating',
         'pref_no_drinks','pref_shoes_on','pref_quiet_ride','pref_brief_calls',
         'pref_temperature','pref_extra_stops','pref_children',
         'pref_wait_mins','pref_luggage']
      : ['notes','pref_ac','pref_music','pref_pets','pref_smoking',
         'pref_no_eating','pref_no_drinks','pref_shoes_on','pref_quiet_ride',
         'pref_brief_calls','pref_temperature','pref_extra_stops',
         'pref_children','pref_wait_mins','pref_luggage'];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    const { data: updated, error } = await supabase
      .from('trips')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    // Notify passengers of changes
    if (hasBookings && Object.keys(updates).length > 0) {
      const passengers = trip.bookings
        .filter(b => ['confirmed','active'].includes(b.status))
        .map(b => b.passenger_id);

      const changeDesc = buildChangeDescription(updates);
      for (const passengerId of passengers) {
        await Notif.tripUpdated(passengerId, 'Your driver', changeDesc);
      }
    }

    res.json({ trip: updated });
  } catch (err) {
    console.error('[Trips] edit error:', err);
    res.status(500).json({ error: 'Failed to update trip' });
  }
});

// ── DELETE /api/trips/:id — Cancel trip ──────────────────────────────────────

router.delete('/:id', verifyAuth, async (req, res) => {
  try {
    const { data: trip, error: fetchError } = await supabase
      .from('trips')
      .select(`
        *,
        bookings(
          id, status, passenger_id,
          stripe_payment_intent_id, total_amount
        )
      `)
      .eq('id', req.params.id)
      .eq('driver_id', req.userId)
      .single();

    if (fetchError || !trip) {
      return res.status(404).json({ error: 'Trip not found' });
    }

    if (trip.status === 'completed') {
      return res.status(400).json({ error: 'Cannot cancel a completed trip' });
    }

    const stripe = require('../lib/stripe');

    // Refund all active bookings
    const activeBookings = trip.bookings?.filter(
      b => ['confirmed','active'].includes(b.status)
    ) ?? [];

    for (const booking of activeBookings) {
      // Full refund for driver-initiated cancellation
      if (booking.stripe_payment_intent_id) {
        await stripe.refunds.create({
          payment_intent: booking.stripe_payment_intent_id,
        });
      }

      await supabase
        .from('bookings')
        .update({
          status:        'cancelled',
          cancelled_at:  new Date().toISOString(),
          cancel_by:     'driver',
          cancel_reason: 'Driver cancelled trip',
          refund_amount: booking.total_amount,
          refund_pct:    100,
        })
        .eq('id', booking.id);

      // Notify passenger
      await Notif.tripCancelledByDriver(
        booking.passenger_id,
        'Your driver',
        trip.from_city,
        trip.to_city,
        booking.total_amount
      );
    }

    // Cancel trip
    await supabase
      .from('trips')
      .update({ status: 'cancelled' })
      .eq('id', req.params.id);

    // Add strike if there were booked passengers
    if (activeBookings.length > 0) {
      await addDriverStrike(req.userId, 'Trip cancelled with booked passengers');
    }

    res.json({ success: true, refunds_issued: activeBookings.length });
  } catch (err) {
    console.error('[Trips] cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel trip' });
  }
});

// ── PATCH /api/trips/:id/stops/:stopId/complete ───────────────────────────────

router.patch('/:id/stops/:stopId/complete', verifyAuth, async (req, res) => {
  try {
    const { data: stop, error } = await supabase
      .from('pickup_stops')
      .update({ is_done: true, done_at: new Date().toISOString() })
      .eq('id', req.params.stopId)
      .eq('trip_id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ stop });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark stop complete' });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTripAvailability(trip) {
  const minsUntil = (new Date(trip.departure_at) - Date.now()) / 60000;
  const seatsLeft = trip.seats_total - trip.seats_booked;
  if (minsUntil < 10)  return 'closed';
  if (minsUntil < 15)  return 'last_chance';
  if (minsUntil < 30)  return 'closing_soon';
  if (seatsLeft === 1) return 'one_left';
  return 'open';
}

function getRoutePriceBounds(fromCity, toCity) {
  // Route price floors (match constants/cities.ts)
  const PRICES = {
    'ottawa-toronto':       { floor: 40, ceiling: 56 },
    'ottawa-montreal':      { floor: 22, ceiling: 31 },
    'ottawa-kingston':      { floor: 18, ceiling: 25 },
    'ottawa-cornwall':      { floor: 12, ceiling: 17 },
    'ottawa-peterborough':  { floor: 25, ceiling: 35 },
    'montreal-quebec':      { floor: 25, ceiling: 35 },
    'montreal-chicoutimi':  { floor: 35, ceiling: 49 },
    'moncton-fredericton':  { floor: 18, ceiling: 25 },
  };
  const key = `${fromCity.toLowerCase()}-${toCity.toLowerCase()}`;
  return PRICES[key] ?? { floor: 15, ceiling: 50 };
}

function buildChangeDescription(updates) {
  const changes = [];
  if (updates.departure_at) changes.push('departure time changed');
  if (updates.seats_total)  changes.push('seat count updated');
  if (updates.price_per_seat) changes.push('price updated');
  if (Object.keys(updates).some(k => k.startsWith('pref_'))) changes.push('preferences updated');
  if (updates.notes) changes.push('driver notes updated');
  return changes.join(', ') || 'trip details updated';
}

async function addDriverStrike(driverId, reason) {
  const { data: profile } = await supabase
    .from('driver_profiles')
    .select('strike_count')
    .eq('user_id', driverId)
    .single();

  if (!profile) return;

  const newCount = (profile.strike_count ?? 0) + 1;
  const isSuspended = newCount >= 10;

  await supabase
    .from('driver_profiles')
    .update({
      strike_count:   newCount,
      last_strike_at: new Date().toISOString(),
      is_suspended:   isSuspended,
      suspended_at:   isSuspended ? new Date().toISOString() : null,
      suspension_reason: isSuspended ? 'Reached 10 strikes' : null,
    })
    .eq('user_id', driverId);

  await Notif.strikeAdded(driverId, newCount);
}

module.exports = router;
