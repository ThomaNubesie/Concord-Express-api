require('dotenv').config();
const express    = require('express');
const router     = express.Router();
const supabase   = require('../lib/supabase');
const { verifyAuth } = require('../middleware/auth');

// Route price bounds
const ROUTE_PRICES = {
  'ottawa-toronto':       { floor: 40, ceiling: 56 },
  'ottawa-montreal':      { floor: 22, ceiling: 31 },
  'ottawa-kingston':      { floor: 18, ceiling: 25 },
  'ottawa-cornwall':      { floor: 12, ceiling: 17 },
  'ottawa-peterborough':  { floor: 25, ceiling: 35 },
  'toronto-ottawa':       { floor: 40, ceiling: 56 },
  'toronto-montreal':     { floor: 55, ceiling: 77 },
  'montreal-ottawa':      { floor: 22, ceiling: 31 },
  'montreal-quebec':      { floor: 25, ceiling: 35 },
  'montreal-chicoutimi':  { floor: 35, ceiling: 49 },
  'kingston-ottawa':      { floor: 18, ceiling: 25 },
  'kingston-toronto':     { floor: 25, ceiling: 35 },
  'moncton-fredericton':  { floor: 18, ceiling: 25 },
  'fredericton-moncton':  { floor: 18, ceiling: 25 },
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
  let score = trip.driver?.rating_as_driver || 3.0;
  if (trip.pref_ac)          score += 0.2;
  if (trip.pref_music)       score += 0.1;
  if (!trip.pref_smoking)    score += 0.2;
  if (!trip.pref_no_eating)  score += 0.1;
  if (trip.pref_luggage === 'all' || trip.pref_luggage === 'large') score += 0.2;
  if (trip.driver?.total_trips_driver > 100) score += 0.3;
  if (trip.driver?.total_trips_driver > 300) score += 0.2;
  return score;
}

// GET /api/trips - Search with priority sorting
router.get('/', async (req, res) => {
  try {
    const {
      from_city, to_city, date,
      seats   = 1,
      priority = 'time',  // time | price | comfort
      page    = 1,
      limit   = 20,
    } = req.query;

    if (!from_city || !to_city) {
      return res.status(400).json({ error: 'from_city and to_city are required' });
    }

    // Build base query
    let query = supabase
      .from('trips')
      .select(`
        *,
        driver:users!trips_driver_id_fkey(
          id, full_name, avatar_url,
          rating_as_driver, total_trips_driver,
          is_verified,
          driver_profile:driver_profiles(
            vehicle_make, vehicle_model, vehicle_year, vehicle_color
          )
        ),
        pickup_stops(*),
        dropoff_stops(*),
        bookings(
          id, status,
          passenger:users!bookings_passenger_id_fkey(id, full_name, avatar_url)
        )
      `)
      .eq('from_city', from_city.toLowerCase())
      .eq('to_city', to_city.toLowerCase())
      .eq('status', 'upcoming')
      .gte('departure_at', new Date(Date.now() + 10 * 60000).toISOString())
      .gte('seats_total', parseInt(seats));

    // Date filter
    if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);
      query = query
        .gte('departure_at', start.toISOString())
        .lte('departure_at', end.toISOString());
    } else {
      // Default: next 30 days
      const future = new Date();
      future.setDate(future.getDate() + 30);
      query = query.lte('departure_at', future.toISOString());
    }

    // Base sort by departure time always
    query = query.order('departure_at', { ascending: true });

    const { data: trips, error } = await query;
    if (error) throw error;

    // Filter trips with available seats
    // Show all trips but mark availability
    let filtered = trips || [];
    // For seat filtering: only hide trips where seats needed > available AND trip is not fully booked (fake)
    if (parseInt(seats) > 1) {
      filtered = filtered.filter(t => {
        const avail = t.seats_total - t.seats_booked;
        return avail === 0 || avail >= parseInt(seats);
      });
    }

    // Apply priority sorting
    if (priority === 'price') {
      filtered.sort((a, b) => a.price_per_seat - b.price_per_seat);
    } else if (priority === 'comfort') {
      filtered.sort((a, b) => getComfortScore(b) - getComfortScore(a));
    }
    // 'time' keeps departure_at sort from query

    // Paginate
    const start = (parseInt(page) - 1) * parseInt(limit);
    const paginated = filtered.slice(start, start + parseInt(limit));

    // Add metadata
    const withMeta = paginated.map(trip => ({
      ...trip,
      seats_available: trip.seats_total - trip.seats_booked,
      availability:    getTripAvailability(trip),
      comfort_score:   getComfortScore(trip),
      is_fake: trip.seats_booked >= trip.seats_total,
      avatar_url: trip.driver?.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(trip.driver?.full_name || "driver")}0026backgroundColor=b6e3f4,c0aede,d1d4f9`,
    }));

    // Smart suggestions based on priority
    const suggestions = buildSuggestions(filtered, priority, from_city, to_city);

    res.json({
      trips:       withMeta,
      total:       filtered.length,
      page:        parseInt(page),
      priority,
      suggestions,
    });
  } catch (err) {
    console.error('[Trips] search error:', err);
    res.status(500).json({ error: 'Failed to search trips' });
  }
});

function buildSuggestions(trips, priority, fromCity, toCity) {
  const suggestions = [];
  if (!trips.length) return suggestions;

  if (priority === 'time') {
    // Find cheapest trip and suggest it
    const cheapest = [...trips].sort((a, b) => a.price_per_seat - b.price_per_seat)[0];
    const earliest = trips[0];
    if (cheapest.id !== earliest.id) {
      suggestions.push({
        type: 'price_tip',
        text: 'Leaving ' + getTimeDiff(earliest.departure_at, cheapest.departure_at) + ' later saves you C$' + (cheapest.price_per_seat - earliest.price_per_seat).toFixed(0),
        trip_id: cheapest.id,
      });
    }
  }

  if (priority === 'price') {
    // Find most comfortable and suggest it
    const comfort = [...trips].sort((a, b) => getComfortScore(b) - getComfortScore(a))[0];
    const cheapest = trips[0];
    if (comfort.id !== cheapest.id) {
      const diff = comfort.price_per_seat - cheapest.price_per_seat;
      suggestions.push({
        type: 'comfort_tip',
        text: 'C$' + diff.toFixed(0) + ' more gets you a top-rated driver (' + (comfort.driver?.rating_as_driver || 4.5).toFixed(1) + ' stars)',
        trip_id: comfort.id,
      });
    }
  }

  if (priority === 'comfort') {
    const topComfort = trips[0];
    if (topComfort) {
      suggestions.push({
        type: 'comfort_leader',
        text: (topComfort.driver?.full_name || 'Top driver') + ' is the highest rated on this route with ' + (topComfort.driver?.total_trips_driver || 0) + ' completed trips',
        trip_id: topComfort.id,
      });
    }
  }

  // Always add seat urgency if applicable
  const oneSeatLeft = trips.find(t => (t.seats_total - t.seats_booked) === 1);
  if (oneSeatLeft) {
    suggestions.push({
      type: 'urgency',
      text: 'One seat left on the ' + new Date(oneSeatLeft.departure_at).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: true }) + ' departure',
      trip_id: oneSeatLeft.id,
    });
  }

  return suggestions;
}

function getTimeDiff(date1, date2) {
  const diff = Math.abs(new Date(date2) - new Date(date1)) / 60000;
  if (diff < 60) return Math.round(diff) + ' minutes';
  return Math.round(diff / 60) + ' hours';
}

// GET /api/trips/driver/mine
router.get('/driver/mine', verifyAuth, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    let query = supabase
      .from('trips')
      .select(`*, pickup_stops(*), dropoff_stops(*), bookings(
        id, status, seats, fare_amount,
        passenger:users!bookings_passenger_id_fkey(id, full_name, avatar_url, rating_as_passenger),
        pickup_stop:pickup_stops(area),
        dropoff_stop:dropoff_stops(area)
      )`)
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

// GET /api/trips/:id
router.get('/:id', async (req, res) => {
  try {
    const { data: trip, error } = await supabase
      .from('trips')
      .select(`*, driver:users!trips_driver_id_fkey(
        id, full_name, avatar_url, rating_as_driver, total_trips_driver, is_verified
      ), pickup_stops(*), dropoff_stops(*)`)
      .eq('id', req.params.id)
      .single();
    if (error || !trip) return res.status(404).json({ error: 'Trip not found' });
    res.json({ trip: { ...trip, availability: getTripAvailability(trip) } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch trip' });
  }
});

// POST /api/trips
router.post('/', verifyAuth, async (req, res) => {
  try {
    const { from_city, to_city, departure_at, seats_total, price_per_seat,
            pickup_stops, dropoff_stops, preferences = {}, notes, accepts_packages, package_types, max_package_kg,
            booking_type = 'direct',
    cashOnly = false,
            is_transit = false, is_recurring = false, recurring_days } = req.body;

    if (!from_city || !to_city || !departure_at || !seats_total || !price_per_seat) {
      return res.status(400).json({ error: 'Missing required trip fields' });
    }

    const bounds = getRouteBounds(from_city.toLowerCase(), to_city.toLowerCase());
    if (price_per_seat < bounds.floor || price_per_seat > bounds.ceiling) {
      return res.status(400).json({
        error: 'Price must be between C$' + bounds.floor + ' and C$' + bounds.ceiling + ' for this route',
      });
    }

    // Check max 2 trips per day
    const dayStart = new Date(departure_at); dayStart.setHours(0,0,0,0);
    const dayEnd   = new Date(departure_at); dayEnd.setHours(23,59,59,999);
    const { count } = await supabase.from('trips').select('*', { count: 'exact', head: true })
      .eq('driver_id', req.userId)
      .gte('departure_at', dayStart.toISOString())
      .lte('departure_at', dayEnd.toISOString())
      .in('status', ['upcoming', 'active']);
    if (count >= 2) return res.status(400).json({ error: 'You already have 2 trips on this day' });

    const { data: trip, error: tripError } = await supabase.from('trips').insert({
      driver_id: req.userId, from_city: from_city.toLowerCase(), to_city: to_city.toLowerCase(),
      departure_at, seats_total, price_per_seat,
      price_floor: bounds.floor, price_ceiling: bounds.ceiling,
      notes, booking_type, is_transit, is_recurring, recurring_days,
      accepts_packages: accepts_packages ?? false,
      package_types:    package_types    ?? [],
      max_package_kg:   max_package_kg   ?? 10,
      status:           'upcoming',
      pref_ac:          preferences.ac           ?? true,
      pref_music:       preferences.music        ?? true,
      pref_pets:        preferences.pets         ?? false,
      pref_smoking:     preferences.smoking      ?? false,
      pref_no_eating:   preferences.noEating     ?? false,
      pref_no_drinks:   preferences.noDrinks     ?? false,
      pref_shoes_on:    preferences.shoesOn      ?? false,
      pref_quiet_ride:  preferences.quietRide    ?? false,
      pref_brief_calls: preferences.briefCalls   ?? false,
      pref_temperature: preferences.temperature  ?? 'any',
      pref_extra_stops: preferences.extraStops   ?? 'none',
      pref_children:    preferences.children     ?? 'welcome',
      pref_wait_mins:   preferences.waitMins     ?? 5,
      cash_only:        cashOnly ?? false,
      pref_luggage:     preferences.luggage      ?? 'all',
    }).select().single();
    if (tripError) throw tripError;

    if (pickup_stops?.length) {
      await supabase.from('pickup_stops').insert(
        pickup_stops.map((s, i) => ({
          trip_id: trip.id, area: s.area, lat: s.lat, lng: s.lng,
          is_custom: s.isCustom ?? false, custom_addr: s.customAddr,
          departs_at: s.time, stop_order: i,
        }))
      );
    }

    if (dropoff_stops?.length) {
      await supabase.from('dropoff_stops').insert(
        dropoff_stops.map((s, i) => ({
          trip_id: trip.id, area: s.area, lat: s.lat, lng: s.lng,
          is_custom: s.isCustom ?? false, custom_addr: s.customAddr,
          stop_order: i,
        }))
      );
    }

    const { data: fullTrip } = await supabase.from('trips')
      .select('*, pickup_stops(*), dropoff_stops(*)')
      .eq('id', trip.id).single();

    res.status(201).json({ trip: fullTrip });
  } catch (err) {
    console.error('[Trips] create error:', err);
    res.status(500).json({ error: 'Failed to create trip' });
  }
});

// PATCH /api/trips/:id
router.patch('/:id', verifyAuth, async (req, res) => {
  try {
    const { data: trip, error: fetchError } = await supabase.from('trips')
      .select('*, bookings(id, status, passenger_id)')
      .eq('id', req.params.id).eq('driver_id', req.userId).single();
    if (fetchError || !trip) return res.status(404).json({ error: 'Trip not found' });
    const hasBookings  = trip.bookings?.some(b => ['confirmed','active'].includes(b.status));
    const minsUntilDep = (new Date(trip.departure_at) - Date.now()) / 60000;
    const lockState    = minsUntilDep < 0 ? 'active' : minsUntilDep < 60 ? 'locked' : hasBookings ? 'partial' : 'unlocked';
    if (lockState === 'locked' || lockState === 'active') {
      return res.status(400).json({ error: 'Trip is locked and cannot be edited' });
    }
    const allowedFields = lockState === 'unlocked'
      ? ['seats_total','price_per_seat','departure_at','notes','booking_closes_at',
         'pref_ac','pref_music','pref_pets','pref_smoking','pref_no_eating',
         'pref_no_drinks','pref_shoes_on','pref_quiet_ride','pref_brief_calls',
         'pref_temperature','pref_extra_stops','pref_children','pref_wait_mins','pref_luggage']
      : ['notes','pref_ac','pref_music','pref_pets','pref_smoking','pref_no_eating',
         'pref_no_drinks','pref_shoes_on','pref_quiet_ride','pref_brief_calls',
         'pref_temperature','pref_extra_stops','pref_children','pref_wait_mins','pref_luggage'];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    const { data: updated, error } = await supabase.from('trips')
      .update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;

    // Update pickup stops if provided and trip is unlocked
    if (lockState === 'unlocked' && req.body.pickup_stops?.length) {
      await supabase.from('pickup_stops').delete().eq('trip_id', req.params.id);
      await supabase.from('pickup_stops').insert(
        req.body.pickup_stops.map((s, i) => ({
          trip_id:    req.params.id,
          area:       s.area,
          lat:        s.lat || 45.4215,
          lng:        s.lng || -75.6972,
          departs_at: s.time || s.departs_at || req.body.departure_at,
          stop_order: i,
        }))
      );
    }

    // Update dropoff stops if provided and trip is unlocked
    if (lockState === 'unlocked' && req.body.dropoff_stops?.length) {
      await supabase.from('dropoff_stops').delete().eq('trip_id', req.params.id);
      await supabase.from('dropoff_stops').insert(
        req.body.dropoff_stops.map((s, i) => ({
          trip_id:    req.params.id,
          area:       s.area,
          lat:        s.lat || 45.4215,
          lng:        s.lng || -75.6972,
          stop_order: i,
        }))
      );
    }

    const { data: fullTrip } = await supabase.from('trips')
      .select('*, pickup_stops(*), dropoff_stops(*)')
      .eq('id', req.params.id).single();

    res.json({ trip: fullTrip || updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update trip' });
  }
});

// DELETE /api/trips/:id
router.delete('/:id', verifyAuth, async (req, res) => {
  try {
    const { data: trip } = await supabase.from('trips')
      .select('*, bookings(id, status, passenger_id, stripe_payment_intent_id, total_amount)')
      .eq('id', req.params.id).eq('driver_id', req.userId).single();
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    if (trip.status === 'completed') return res.status(400).json({ error: 'Cannot cancel a completed trip' });
    const activeBookings = trip.bookings?.filter(b => ['confirmed','active'].includes(b.status)) ?? [];
    for (const booking of activeBookings) {
      await supabase.from('bookings').update({
        status: 'cancelled', cancelled_at: new Date().toISOString(),
        cancel_by: 'driver', refund_amount: booking.total_amount, refund_pct: 100,
      }).eq('id', booking.id);
    }
    await supabase.from('trips').update({ status: 'cancelled' }).eq('id', req.params.id);
    res.json({ success: true, refunds_issued: activeBookings.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel trip' });
  }
});

// PATCH /api/trips/:id/stops/:stopId/complete
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


// POST /api/trips/:id/start — Driver starts the trip
router.post('/:id/start', verifyAuth, async (req, res) => {
  try {
    const { data: trip, error } = await supabase
      .from('trips').select('driver_id, status').eq('id', req.params.id).single();
    if (error || !trip) return res.status(404).json({ error: 'Trip not found' });
    if (trip.driver_id !== req.userId) return res.status(403).json({ error: 'Not your trip' });
    if (trip.status !== 'upcoming') return res.status(400).json({ error: 'Trip cannot be started' });
    await supabase.from('trips').update({ status: 'active' }).eq('id', req.params.id);
    await supabase.from('bookings').update({ status: 'active' })
      .eq('trip_id', req.params.id).in('status', ['confirmed']);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start trip' });
  }
});

// POST /api/trips/:id/complete — Driver completes the trip + captures payments
router.post('/:id/complete', verifyAuth, async (req, res) => {
  try {
    const { data: trip, error } = await supabase
      .from('trips').select('driver_id').eq('id', req.params.id).single();
    if (error || !trip) return res.status(404).json({ error: 'Trip not found' });
    if (trip.driver_id !== req.userId) return res.status(403).json({ error: 'Not your trip' });

    // Mark trip completed
    await supabase.from('trips').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', req.params.id);

    // Get all confirmed bookings with payment intents
    const { data: bookings } = await supabase
      .from('bookings')
      .select('id, stripe_payment_intent_id, fare_amount, seats, passenger_id')
      .eq('trip_id', req.params.id)
      .in('status', ['active', 'confirmed']);

    // Capture each payment intent (release from escrow)
    const stripe = require('../lib/stripe');
    for (const booking of bookings || []) {
      if (booking.stripe_payment_intent_id) {
        try {
          await stripe.paymentIntents.capture(booking.stripe_payment_intent_id);
        } catch (e) {
          console.log('[Stripe] Capture failed for booking', booking.id, e.message);
        }
      }
      // Mark booking completed
      await supabase.from('bookings')
        .update({ status: 'completed' })
        .eq('id', booking.id);

      // Notify passenger
      await supabase.from('notifications').insert({
        user_id: booking.passenger_id,
        type: 'trip',
        title: '🏁 Trip Completed',
        body: 'Your trip is complete. Payment has been processed. Thank you for riding with Concord!',
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Trips] complete error:', err);
    res.status(500).json({ error: 'Failed to complete trip' });
  }
});

// POST /api/trips/:id/running-late — Driver notifies passengers they are running late
router.post('/:id/running-late', verifyAuth, async (req, res) => {
  try {
    const { data: trip } = await supabase
      .from('trips').select('driver_id, from_city, to_city, departure_at')
      .eq('id', req.params.id).single();
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    if (trip.driver_id !== req.userId) return res.status(403).json({ error: 'Not your trip' });

    const { data: bookings } = await supabase
      .from('bookings').select('passenger_id')
      .eq('trip_id', req.params.id)
      .eq('status', 'confirmed');

    if (bookings?.length) {
      await supabase.from('notifications').insert(
        bookings.map((b) => ({
          user_id: b.passenger_id,
          type: 'trip',
          title: '⏱ Driver Running Late',
          body: `Your driver is running late for the ${trip.from_city} → ${trip.to_city} trip. Please stand by.`,
        }))
      );
    }
    res.json({ success: true, notified: bookings?.length || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to notify passengers' });
  }
});

// POST /api/trips/:id/close — Driver closes trip from new bookings
router.post('/:id/close', verifyAuth, async (req, res) => {
  try {
    const { data: trip, error } = await supabase
      .from('trips').select('driver_id, status').eq('id', req.params.id).single();
    if (error || !trip) return res.status(404).json({ error: 'Trip not found' });
    if (trip.driver_id !== req.userId) return res.status(403).json({ error: 'Not your trip' });
    await supabase.from('trips')
      .update({ booking_closes_at: new Date().toISOString() })
      .eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to close trip' });
  }
});

router.post('/:id/cancel', verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, note } = req.body;

    if (!reason) return res.status(400).json({ error: 'Cancellation reason is required' });

    // Get trip with bookings
    const { data: trip, error: tripErr } = await supabase
      .from('trips')
      .select('*, bookings(id, passenger_id, status, fare_amount, seats)')
      .eq('id', id)
      .eq('driver_id', req.userId)
      .single();

    if (tripErr || !trip) return res.status(404).json({ error: 'Trip not found' });
    if (trip.status !== 'upcoming') return res.status(400).json({ error: 'Only upcoming trips can be cancelled' });

    // Determine quarter
    const now = new Date();
    const month = now.getMonth(); // 0-11
    const quarter = month < 3 ? 'q1' : month < 6 ? 'q2' : month < 9 ? 'q3' : 'q4';
    const col = `cancellations_${quarter}`;

    // Get driver cancellation count
    const { data: driver } = await supabase
      .from('users').select(`id, ${col}, account_suspended`).eq('id', req.userId).single();

    const currentCount = driver?.[col] || 0;
    const isLate = (new Date(trip.departure_at) - now) < 24 * 60 * 60 * 1000;

    // Check if limit exceeded
    if (currentCount >= 7) {
      return res.status(403).json({
        error: 'Quarterly cancellation limit reached. Pay C$25 reinstatement fee to continue.',
        code: 'CANCELLATION_LIMIT',
        requires_payment: true,
      });
    }

    // Cancel the trip
    await supabase.from('trips').update({
      status: 'cancelled',
      cancellation_reason: reason,
      cancellation_note: note || null,
      cancelled_at: now.toISOString(),
      had_passengers: confirmedBookings.length > 0,
    }).eq('id', id);

    // Only increment cancellation counter if there were passengers
    if (confirmedBookings.length > 0) {
      await supabase.from('users').update({ [col]: currentCount + 1 }).eq('id', req.userId);
    }

    // Refund and notify all confirmed passengers
    const confirmedBookings = (trip.bookings || []).filter(b => ['confirmed','active'].includes(b.status));

    for (const booking of confirmedBookings) {
      // Cancel booking
      await supabase.from('bookings').update({ status: 'cancelled', cancellation_reason: 'driver_cancelled' }).eq('id', booking.id);

      // Find alternative trips on same route
      const { data: altTrips } = await supabase
        .from('trips')
        .select('id, departure_at, price_per_seat, seats_total, seats_booked, driver:driver_id(full_name, rating_as_driver, total_trips_driver)')
        .eq('from_city', trip.from_city)
        .eq('to_city', trip.to_city)
        .eq('status', 'upcoming')
        .neq('driver_id', req.userId)
        .gte('departure_at', now.toISOString())
        .order('departure_at', { ascending: true })
        .limit(3);

      // Send notification to passenger
      await supabase.from('notifications').insert({
        user_id: booking.passenger_id,
        type: 'trip_cancelled',
        title: 'Your trip was cancelled',
        body: `${trip.from_city} → ${trip.to_city} on ${new Date(trip.departure_at).toLocaleDateString()} was cancelled. Reason: ${reason}. You have been fully refunded.`,
        data: JSON.stringify({
          trip_id: trip.id,
          reason,
          note: note || null,
          alternative_trips: (altTrips || []).map(t => t.id),
          is_late: isLate,
        }),
        read: false,
      });
    }

    res.json({
      success: true,
      cancellations_used: currentCount + 1,
      cancellations_remaining: 7 - (currentCount + 1),
      quarter,
      passengers_notified: confirmedBookings.length,
    });
  } catch (err) {
    console.error('[Cancel trip]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
