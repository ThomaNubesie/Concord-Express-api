// ═════════════════════════════════════════════════════════════════════════
// ConcordXpress API — Trips search & booking endpoints
// ═════════════════════════════════════════════════════════════════════════
// Drop this file into: ~/Desktop/api/src/routes/trips-public.js
// Then register it in src/index.js:
//   const tripsPublicRoutes = require('./routes/trips-public');
//   app.use('/api/trips', tripsPublicRoutes);
//
// These are the PUBLIC search endpoints consumed by the web.
// They don't require auth (anyone can search), but booking does.
// ═════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// ─── GET /api/trips/search ─────────────────────────────────────────────
router.get('/search', async (req, res) => {
  try {
    const { from, to, date, seats = 1 } = req.query;

    if (!from || !to) {
      return res.status(400).json({ error: 'from and to required' });
    }

    // Query Supabase for matching trips
    const query = supabase
      .from('trips')
      .select(`
        id,
        from_city,
        from_station,
        from_lat,
        from_lng,
        to_city,
        to_station,
        to_lat,
        to_lng,
        departure_time,
        arrival_time,
        duration_minutes,
        price_per_seat,
        currency,
        available_seats,
        co2_saved_kg,
        features,
        drivers:driver_id (
          id,
          name,
          avatar_color,
          rating,
          trip_count,
          verified,
          languages,
          vehicle_model,
          vehicle_color
        )
      `)
      .ilike('from_city', `%${from.split(',')[0]}%`)
      .ilike('to_city', `%${to.split(',')[0]}%`)
      .gte('available_seats', parseInt(seats))
      .eq('status', 'open')
      .order('departure_time', { ascending: true })
      .limit(50);

    if (date) {
      const d = new Date(date);
      if (!isNaN(d.getTime())) {
        const startOfDay = new Date(d.setHours(0, 0, 0, 0)).toISOString();
        const endOfDay = new Date(d.setHours(23, 59, 59, 999)).toISOString();
        query.gte('departure_at', startOfDay).lte('departure_at', endOfDay);
      }
    }

    const { data, error } = await query;
    if (error) throw error;

    // Shape for web client
    const trips = (data || []).map((t) => ({
      id: t.id,
      driver: {
        id: t.drivers?.id,
        name: t.drivers?.name,
        avatarColor: t.drivers?.avatar_color,
        rating: t.drivers?.rating,
        tripCount: t.drivers?.trip_count,
        verified: t.drivers?.verified,
        languages: t.drivers?.languages || [],
        vehicle: t.drivers?.vehicle_model ? { model: t.drivers.vehicle_model, color: t.drivers.vehicle_color } : null,
      },
      from: { city: t.from_city, station: t.from_station, lat: t.from_lat, lng: t.from_lng },
      to: { city: t.to_city, station: t.to_station, lat: t.to_lat, lng: t.to_lng },
      departureTime: t.departure_time,
      arrivalTime: t.arrival_time,
      durationMinutes: t.duration_minutes,
      pricePerSeat: t.price_per_seat,
      currency: t.currency || 'CAD',
      availableSeats: t.available_seats,
      co2SavedKg: t.co2_saved_kg || 0,
      features: t.features || [],
    }));

    res.json(trips);
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ─── GET /api/trips/:id ────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('trips')
      .select(`
        *,
        drivers:driver_id (*)
      `)
      .eq('id', req.params.id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Trip not found' });

    const trip = {
      id: data.id,
      driver: {
        id: data.drivers?.id,
        name: data.drivers?.name,
        avatarColor: data.drivers?.avatar_color,
        rating: data.drivers?.rating,
        tripCount: data.drivers?.trip_count,
        verified: data.drivers?.verified,
        languages: data.drivers?.languages || [],
        vehicle: data.drivers?.vehicle_model ? { model: data.drivers.vehicle_model, color: data.drivers.vehicle_color } : null,
      },
      from: { city: data.from_city, station: data.from_station, lat: data.from_lat, lng: data.from_lng },
      to: { city: data.to_city, station: data.to_station, lat: data.to_lat, lng: data.to_lng },
      departureTime: data.departure_time,
      arrivalTime: data.arrival_time,
      durationMinutes: data.duration_minutes,
      pricePerSeat: data.price_per_seat,
      currency: data.currency || 'CAD',
      availableSeats: data.available_seats,
      co2SavedKg: data.co2_saved_kg || 0,
      features: data.features || [],
    };

    res.json(trip);
  } catch (err) {
    console.error('Get trip error:', err);
    res.status(500).json({ error: 'Failed to load trip' });
  }
});

// ─── POST /api/bookings — Create booking with Stripe escrow ────────────
router.post('/bookings', async (req, res) => {
  try {
    const { tripId, seats, paymentMethod, passengerName, passengerEmail } = req.body;

    if (!tripId || !seats || !passengerName || !passengerEmail) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Fetch trip
    const { data: trip, error: tripErr } = await supabase
      .from('trips')
      .select('*')
      .eq('id', tripId)
      .single();

    if (tripErr || !trip) return res.status(404).json({ error: 'Trip not found' });
    if (trip.available_seats < seats) return res.status(400).json({ error: 'Not enough seats' });

    const subtotal = trip.price_per_seat * seats;
    const bookingFee = seats * 3;
    const total = subtotal + bookingFee;

    // Create booking record
    const { data: booking, error: bookingErr } = await supabase
      .from('bookings')
      .insert({
        trip_id: tripId,
        passenger_name: passengerName,
        passenger_email: passengerEmail,
        seats,
        payment_method: paymentMethod,
        amount_cents: Math.round(total * 100),
        currency: trip.currency || 'CAD',
        status: paymentMethod === 'card' ? 'pending_payment' : 'confirmed',
        source: 'web',
      })
      .select()
      .single();

    if (bookingErr) throw bookingErr;

    // For card payments, create Stripe PaymentIntent (escrow)
    let clientSecret = null;
    if (paymentMethod === 'card') {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const intent = await stripe.paymentIntents.create({
        amount: Math.round(total * 100),
        currency: (trip.currency || 'CAD').toLowerCase(),
        capture_method: 'manual', // hold funds in escrow
        metadata: { booking_id: booking.id, trip_id: tripId },
      });
      clientSecret = intent.client_secret;

      await supabase
        .from('bookings')
        .update({ stripe_payment_intent_id: intent.id })
        .eq('id', booking.id);
    }

    res.json({
      bookingId: booking.id,
      escrowId: booking.stripe_payment_intent_id || null,
      clientSecret,
      total,
    });
  } catch (err) {
    console.error('Booking error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
