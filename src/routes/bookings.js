const express    = require('express');
const router     = express.Router();
const supabase   = require('../lib/supabase');
const stripe     = require('../lib/stripe');
const { verifyAuth } = require('../middleware/auth');
const { formatTimeInZone, formatDateTimeInZone } = require('../lib/timezone');
const { Notif, sendNotification } = require('../lib/notifications');

// ── POST /api/bookings — Create booking ───────────────────────────────────────

router.post('/', verifyAuth, async (req, res) => {
  try {
    const {
      trip_id, pickup_stop_id, dropoff_stop_id,
      seats = 1, payment_method_id, credit_to_apply = 0,
    } = req.body;

    if (!trip_id || !pickup_stop_id || !dropoff_stop_id) {
      return res.status(400).json({ error: 'Missing required booking fields' });
    }
    // For card trips, payment_method_id is required (checked after trip fetch)

    // Fetch trip
    const { data: trip, error: tripError } = await supabase
      .from('trips')
      .select('*, driver:users!trips_driver_id_fkey(id, full_name, fcm_token)')
      .eq('id', trip_id)
      .single();

    if (tripError || !trip) {
      return res.status(404).json({ error: 'Trip not found' });
    }

    // Check booking is still open
    const minsUntil = (new Date(trip.departure_at) - Date.now()) / 60000;
    if (minsUntil < 15) {
      return res.status(400).json({ error: 'Booking closed — trip departs in less than 15 minutes' });
    }

    // Check seats available
    const seatsAvailable = trip.seats_total - trip.seats_booked;
    if (seatsAvailable < seats) {
      return res.status(400).json({ error: `Only ${seatsAvailable} seats available` });
    }

    // Block driver from booking their own trip
    if (trip.driver_id === req.userId) {
      return res.status(400).json({ error: 'You cannot book your own trip' });
    }

    // Check passenger hasn't already booked this trip
    const { data: existingBooking } = await supabase
      .from('bookings')
      .select('id')
      .eq('trip_id', trip_id)
      .eq('passenger_id', req.userId)
      .in('status', ['confirmed', 'active'])
      .single();

    if (existingBooking) {
      return res.status(400).json({ error: 'You have already booked this trip' });
    }

    // Calculate amounts
    const fareAmount  = trip.price_per_seat * seats;
    const bookingFee  = 2.99 * seats;

    // For cash trips, block if no payment method (needed for booking fee)
    if (!trip.cash_only && !payment_method_id) {
      return res.status(400).json({ error: 'Payment method required for card trips' });
    }
    const creditUsed  = Math.min(credit_to_apply, fareAmount + bookingFee);
    const totalAmount = Math.max(0, fareAmount + bookingFee - creditUsed);

    // Get or create Stripe customer
    const { data: user } = await supabase
      .from('users')
      .select('stripe_customer_id, full_name, email, phone')
      .eq('id', req.userId)
      .single();

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name:  user.full_name,
        email: user.email,
        phone: user.phone,
        metadata: { supabase_user_id: req.userId },
      });
      customerId = customer.id;
      await supabase
        .from('users')
        .update({ stripe_customer_id: customerId })
        .eq('id', req.userId);
    }

    // Get driver's Stripe account
    const { data: driverProfile } = await supabase
      .from('driver_profiles')
      .select('stripe_account_id')
      .eq('user_id', trip.driver_id)
      .single();

    // Create PaymentIntent — cash trips only charge booking fee, card trips charge full amount
    let paymentIntent;
    if (trip.cash_only) {
      // Cash trip: charge C$2.99/seat booking fee, no escrow needed
      paymentIntent = await stripe.paymentIntents.create({
        amount:         Math.round(bookingFee * 100),
        currency:       'cad',
        customer:       customerId,
        payment_method: payment_method_id,
        confirm:        true,
        capture_method: 'automatic',
        description:    'Cash trip booking fee',
        metadata: { trip_id, passenger_id: req.userId, driver_id: trip.driver_id, cash_only: 'true' },
        return_url: 'concordxpress://payment-complete',
      });
      if (!['succeeded','processing'].includes(paymentIntent.status)) {
        return res.status(400).json({ error: 'Booking fee payment failed. Please check your card.' });
      }
    } else {
      // Card trip: full escrow flow
      paymentIntent = await stripe.paymentIntents.create({
        amount:         Math.round(totalAmount * 100),
        currency:       'cad',
        customer:       customerId,
        payment_method: payment_method_id,
        confirm:        true,
        capture_method: 'manual',
        transfer_data:  driverProfile?.stripe_account_id ? {
          destination: driverProfile.stripe_account_id,
          amount:      Math.round(fareAmount * seats * 0.9 * 100),
        } : undefined,
        metadata: { trip_id, passenger_id: req.userId, driver_id: trip.driver_id },
        return_url: 'concordxpress://payment-complete',
      });
      if (paymentIntent.status !== 'requires_capture') {
        return res.status(400).json({ error: 'Payment failed. Please check your payment method.' });
      }
    }

    // Determine approval flow
    const needsApproval = trip.booking_type === 'approval';
    const bookingStatus = needsApproval ? 'pending'    : 'confirmed';
    const approvalStatus= needsApproval ? 'pending'    : 'approved';

    // For approval trips, hold the PaymentIntent but don't capture yet
    // (already created as requires_capture for card, automatic for cash)

    // Create booking record
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .insert({
        trip_id,
        passenger_id:             req.userId,
        pickup_stop_id,
        dropoff_stop_id,
        seats,
        fare_amount:              fareAmount,
        booking_fee:              bookingFee,
        total_amount:             totalAmount,
        status:                   bookingStatus,
        approval_status:          approvalStatus,
        stripe_payment_intent_id: paymentIntent.id,
        agreement_signed_at:      new Date().toISOString(),
        credit_applied:           creditUsed,
      })
      .select()
      .single();

    if (bookingError) {
      // Cancel the payment intent if booking failed
      await stripe.paymentIntents.cancel(paymentIntent.id);
      throw bookingError;
    }

    // Increment seats_booked only for confirmed bookings (not pending approval)
    if (!needsApproval) {
      await supabase.rpc('increment_seats_booked', { trip_id, seats });
    }

    // Mark loyalty credits as used
    if (creditUsed > 0) {
      await supabase
        .from('loyalty_credits')
        .update({
          used_at:         new Date().toISOString(),
          used_in_booking: booking.id,
        })
        .eq('user_id', req.userId)
        .is('used_at', null)
        .gte('amount', creditUsed)
        .limit(1);
    }

    // Get stop details for notification
    const { data: pickupStop } = await supabase
      .from('pickup_stops')
      .select('area, departs_at')
      .eq('id', pickup_stop_id)
      .single();

    const departureTime = pickupStop?.departs_at
      ? new Date(pickupStop.departs_at).toLocaleTimeString('en-CA', {
          hour: '2-digit', minute: '2-digit', hour12: true,
        })
      : '';

    // Notify driver of new booking (or approval request)
    if (needsApproval) {
      setImmediate(() => Notif.bookingApprovalRequest(
        trip.driver_id,
        user.full_name,
        trip.from_city,
        trip.to_city,
        pickupStop?.area ?? 'your stop',
        departureTime,
      ).catch(() => {}));
    } else {
      setImmediate(() => Notif.newBooking(
        trip.driver_id,
        user.full_name,
        trip.from_city,
        trip.to_city,
        pickupStop?.area ?? 'your stop',
        departureTime,
        totalAmount.toFixed(2)
      ));
    }

    // Notify passenger of confirmed booking
    setImmediate(() => Notif.bookingConfirmed(
      req.userId,
      trip.driver.full_name,
      trip.from_city,
      trip.to_city,
      new Date(trip.departure_at).toLocaleDateString('en-CA', {
        weekday: 'short', month: 'short', day: 'numeric',
      }),
      departureTime,
      totalAmount.toFixed(2)
    ));

    // Also notify driver of agreement signed
    await Notif.agreementSigned(
      trip.driver_id,
      user.full_name,
      trip.from_city,
      trip.to_city
    );

    res.status(201).json({ booking });
  } catch (err) {
    console.error('[Bookings] create error:', err);
    res.status(500).json({ error: err.message || 'Failed to create booking' });
  }
});

// ── GET /api/bookings/:id ─────────────────────────────────────────────────────

router.get('/:id', verifyAuth, async (req, res) => {
  try {
    const { data: booking, error } = await supabase
      .from('bookings')
      .select(`
        *,
        trip:trips(
          *, driver:users!trips_driver_id_fkey(id, full_name, avatar_url, rating_as_driver)
        ),
        pickup_stop:pickup_stops(area, departs_at),
        dropoff_stop:dropoff_stops(area),
        passenger:users!bookings_passenger_id_fkey(id, full_name, avatar_url)
      `)
      .eq('id', req.params.id)
      .single();

    if (error || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // Verify user is participant
    const isPassenger = booking.passenger_id === req.userId;
    const isDriver    = booking.trip?.driver_id === req.userId;
    if (!isPassenger && !isDriver) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    res.json({ booking });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

// ── PATCH /api/bookings/:id — Update booking fields ─────────────────────────
router.patch('/:id', verifyAuth, async (req, res) => {
  try {
    const allowed = ['rated_at', 'rating_notified_count', 'checked_in_at', 'checkin_extended_mins'];
    const updates = {};
    for (const field of allowed) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields' });
    const { data, error } = await supabase.from('bookings').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ booking: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update booking' });
  }
});

// ── PATCH /api/bookings/:id/confirm — Passenger confirms arrival ──────────────

router.patch('/:id/confirm', verifyAuth, async (req, res) => {
  try {
    const { data: booking, error: fetchError } = await supabase
      .from('bookings')
      .select('*, trip:trips(driver_id, from_city, to_city)')
      .eq('id', req.params.id)
      .eq('passenger_id', req.userId)
      .single();

    if (fetchError || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (booking.status !== 'active' && booking.status !== 'confirmed') {
      return res.status(400).json({ error: 'Booking cannot be confirmed at this stage' });
    }

    // Capture payment — release escrow to driver
    await stripe.paymentIntents.capture(booking.stripe_payment_intent_id);

    // Update booking
    await supabase
      .from('bookings')
      .update({
        status:               'completed',
        arrived_at:           new Date().toISOString(),
        arrival_confirmed_at: new Date().toISOString(),
      })
      .eq('id', req.params.id);

    // Notify driver payment released
    const netAmount = (booking.fare_amount * 0.9).toFixed(2);
    await Notif.paymentReleased(
      booking.trip.driver_id,
      netAmount,
      booking.trip.from_city,
      booking.trip.to_city
    );

    // Send rate your driver notification after 1 hour
    setTimeout(async () => {
      const { data: driver } = await supabase
        .from('users')
        .select('full_name')
        .eq('id', booking.trip.driver_id)
        .single();
      await Notif.rateYourDriver(req.userId, driver?.full_name ?? 'Your driver', booking.id);
    }, 60 * 60 * 1000);

    res.json({ success: true, message: 'Arrival confirmed. Payment released to driver.' });
  } catch (err) {
    console.error('[Bookings] confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm arrival' });
  }
});

// ── DELETE /api/bookings/:id — Cancel booking ────────────────────────────────

router.delete('/:id', verifyAuth, async (req, res) => {
  try {
    const { data: booking, error: fetchError } = await supabase
      .from('bookings')
      .select('*, trip:trips(driver_id, from_city, to_city, departure_at, driver:users!trips_driver_id_fkey(full_name))')
      .eq('id', req.params.id)
      .eq('passenger_id', req.userId)
      .single();

    if (fetchError || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (!['confirmed', 'active', 'pending'].includes(booking.status)) {
      return res.status(400).json({ error: 'Booking cannot be cancelled' });
    }

    // Pending approval — full refund, no penalty, no cancellation count
    const isPendingApproval = booking.status === 'pending' || booking.approval_status === 'pending';

    // Calculate refund based on tiered policy
    const minsUntil  = (new Date(booking.trip.departure_at) - Date.now()) / 60000;
    const hoursUntil = minsUntil / 60;
    let refundPct    = 0;
    let refundAmount = 0;

    if (isPendingApproval) {
      // Full refund, no penalty for pending approval cancellations
      refundPct    = 100;
      refundAmount = booking.total_amount;
    } else if (hoursUntil > 24) {
      refundPct    = 100;
      refundAmount = booking.total_amount;
    } else if (hoursUntil >= 2) {
      refundPct    = 75;
      refundAmount = booking.fare_amount * 0.75;
    } else if (hoursUntil >= 1) {
      refundPct    = 50;
      refundAmount = booking.fare_amount * 0.50;
    }

    // Issue refund if applicable
    if (refundAmount > 0 && booking.stripe_payment_intent_id) {
      await stripe.refunds.create({
        payment_intent: booking.stripe_payment_intent_id,
        amount:         Math.round(refundAmount * 100),
      });
    }

    // Update booking
    await supabase
      .from('bookings')
      .update({
        status:        'cancelled',
        cancelled_at:  new Date().toISOString(),
        cancel_by:     'passenger',
        cancel_reason: req.body.reason ?? 'Passenger cancelled',
        refund_amount: refundAmount,
        refund_pct:    refundPct,
      })
      .eq('id', req.params.id);

    // Only decrement seats and increment cancellation count for confirmed bookings
    if (!isPendingApproval) {
      await supabase.from('trips')
        .update({ seats_booked: supabase.rpc('decrement', { x: booking.seats }) })
        .eq('id', booking.trip_id);
      // Increment passenger cancellation count
      const { data: pax } = await supabase.from('users').select('cancellations_as_passenger').eq('id', req.userId).single();
      await supabase.from('users').update({ cancellations_as_passenger: (pax?.cancellations_as_passenger || 0) + 1 }).eq('id', req.userId);
    }

    // Notify driver
    const { data: user } = await supabase
      .from('users')
      .select('full_name')
      .eq('id', req.userId)
      .single();

    await Notif.bookingCancelled(
      booking.trip.driver_id,
      user.full_name,
      booking.trip.from_city,
      booking.trip.to_city,
      new Date(booking.trip.departure_at).toLocaleTimeString('en-CA', {
        hour: '2-digit', minute: '2-digit', hour12: true,
      })
    );

    res.json({
      success:       true,
      refund_amount: refundAmount,
      refund_pct:    refundPct,
      message:       refundAmount > 0
        ? `Refund of C$${refundAmount.toFixed(2)} (${refundPct}%) will appear in 3–5 business days.`
        : 'No refund applies for late cancellations.',
    });
  } catch (err) {
    console.error('[Bookings] cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel booking' });
  }
});

// ── POST /api/bookings/:id/noshow — Mark no-show ──────────────────────────────

router.post('/:id/noshow', verifyAuth, async (req, res) => {
  try {
    const { data: booking, error: fetchError } = await supabase
      .from('bookings')
      .select('*, trip:trips(driver_id, from_city, to_city)')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // Only driver can mark no-show
    if (booking.trip.driver_id !== req.userId) {
      return res.status(403).json({ error: 'Only the driver can mark a no-show' });
    }

    await supabase
      .from('bookings')
      .update({
        status:       'no_show',
        is_no_show:   true,
        cancelled_at: new Date().toISOString(),
        cancel_by:    'system',
        cancel_reason:'Passenger no-show',
        refund_amount:0,
        refund_pct:   0,
      })
      .eq('id', req.params.id);

    // Get passenger name for notification
    const { data: passenger } = await supabase
      .from('users')
      .select('full_name')
      .eq('id', booking.passenger_id)
      .single();

    const { data: stop } = await supabase
      .from('pickup_stops')
      .select('area')
      .eq('id', booking.pickup_stop_id)
      .single();

    await Notif.noShow(req.userId, passenger?.full_name ?? 'Passenger', stop?.area ?? 'your stop');

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark no-show' });
  }
});


// POST /api/bookings/init-flutterwave — Create pending booking + generate FW payment link
router.post('/init-flutterwave', verifyAuth, async (req, res) => {
  try {
    const { trip_id, pickup_stop_id, dropoff_stop_id, seats = 1, credit_to_apply = 0 } = req.body;
    if (!trip_id || !pickup_stop_id || !dropoff_stop_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { data: trip } = await supabase
      .from('trips')
      .select('*, driver:users!trips_driver_id_fkey(id, full_name, country)')
      .eq('id', trip_id).single();
    if (!trip) return res.status(404).json({ error: 'Trip not found' });

    const minsUntil = (new Date(trip.departure_at) - Date.now()) / 60000;
    if (minsUntil < 10) return res.status(400).json({ error: 'Booking closed' });

    const seatsAvailable = trip.seats_total - trip.seats_booked;
    if (seatsAvailable < seats) return res.status(400).json({ error: `Only ${seatsAvailable} seats available` });
    if (trip.driver_id === req.userId) return res.status(400).json({ error: 'Cannot book your own trip' });

    const { data: existing } = await supabase.from('bookings')
      .select('id').eq('trip_id', trip_id).eq('passenger_id', req.userId)
      .in('status', ['confirmed','active','pending_payment']).single();
    if (existing) return res.status(400).json({ error: 'Already booked' });

    const { data: user } = await supabase
      .from('users').select('full_name, email, country, language').eq('id', req.userId).single();

    const fareAmount  = trip.price_per_seat * seats;
    const bookingFee  = 2.99 * seats;
    const creditUsed  = Math.min(credit_to_apply, fareAmount + bookingFee);
    const totalAmount = Math.max(0, fareAmount + bookingFee - creditUsed);

    // Get currency for passenger's country
    const COUNTRY_CURRENCY_MAP = {
      SN:'XOF', CI:'XOF', GH:'GHS', NG:'NGN', CM:'XAF', KE:'KES', RW:'RWF', MA:'MAD',
    };
    const currency = COUNTRY_CURRENCY_MAP[user?.country] || 'USD';
    const RATES = { XOF:447, GHS:11.2, NGN:1148, XAF:447, KES:97, RWF:1040, MAD:7.4, USD:0.74 };
    const fwAmount = (totalAmount * (RATES[currency] || 1)).toFixed(2);

    const tx_ref = `CX-BK-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;

    // Create pending booking first
    const needsApproval = trip.booking_type === 'approval';
    const { data: booking, error: bookingError } = await supabase.from('bookings').insert({
      trip_id, passenger_id: req.userId, pickup_stop_id, dropoff_stop_id,
      seats, fare_amount: fareAmount, booking_fee: bookingFee,
      total_amount: totalAmount, credit_applied: creditUsed,
      status:            'pending_payment',
      approval_status:   needsApproval ? 'pending' : 'approved',
      payment_provider:  'flutterwave',
      flutterwave_tx_ref: tx_ref,
      agreement_signed_at: new Date().toISOString(),
    }).select().single();
    if (bookingError) throw bookingError;

    // Generate Flutterwave payment link
    const fwRes = await fetch('https://api.flutterwave.com/v3/payments', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tx_ref,
        amount:          fwAmount,
        currency,
        redirect_url:    'https://concord-express-api-production.up.railway.app/api/payments/flutterwave-redirect',
        payment_options: 'mobilemoney,card',
        customer:        { email: user?.email, name: user?.full_name },
        customizations: {
          title:       'ConcordXpress',
          description: `Seat booking: ${trip.from_city} → ${trip.to_city}`,
        },
        meta: { booking_id: booking.id, user_id: req.userId, trip_id },
      }),
    });
    const fwData = await fwRes.json();
    if (fwData.status !== 'success') {
      await supabase.from('bookings').delete().eq('id', booking.id);
      return res.status(400).json({ error: fwData.message || 'Payment init failed' });
    }

    res.json({ link: fwData.data.link, tx_ref, booking_id: booking.id });
  } catch (err) {
    console.error('[FW Booking Init]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bookings/verify-flutterwave — Verify FW payment and confirm booking
router.post('/verify-flutterwave', verifyAuth, async (req, res) => {
  try {
    const { tx_ref, booking_id } = req.body;
    if (!tx_ref || !booking_id) return res.status(400).json({ error: 'tx_ref and booking_id required' });

    // Verify with Flutterwave
    const fwRes = await fetch(
      `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${tx_ref}`,
      { headers: { 'Authorization': `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } }
    );
    const fwData = await fwRes.json();
    if (fwData.status !== 'success' || fwData.data?.status !== 'successful') {
      await supabase.from('bookings').update({ status: 'cancelled' }).eq('id', booking_id);
      return res.status(400).json({ error: 'Payment not successful', fw_status: fwData.data?.status });
    }

    // Fetch booking
    const { data: booking } = await supabase.from('bookings')
      .select('*, trip:trips!bookings_trip_id_fkey(driver_id, seats_booked, from_city, to_city, departure_at, driver:users!trips_driver_id_fkey(full_name, fcm_token, country))')
      .eq('id', booking_id).single();
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.passenger_id !== req.userId) return res.status(403).json({ error: 'Not your booking' });

    const needsApproval = booking.approval_status === 'pending';
    const newStatus     = needsApproval ? 'pending' : 'confirmed';

    await supabase.from('bookings')
      .update({ status: newStatus, flutterwave_tx_ref: tx_ref })
      .eq('id', booking_id);

    if (!needsApproval) {
      await supabase.from('trips')
        .rpc('increment_seats_booked', { trip_id: booking.trip_id, seats: booking.seats });
    }

    // Notify driver
    const { data: pickupStop } = await supabase
      .from('pickup_stops').select('area, departs_at').eq('id', booking.pickup_stop_id).single();
    const departureTime = pickupStop?.departs_at
      ? new Date(pickupStop.departs_at).toLocaleTimeString('en-CA', { hour:'2-digit', minute:'2-digit', hour12:true })
      : '';

    if (needsApproval) {
      setImmediate(() => Notif.bookingApprovalRequest(
        booking.trip.driver_id, booking.trip.driver?.full_name || 'A passenger',
        booking.trip.from_city, booking.trip.to_city,
        pickupStop?.area ?? 'your stop', departureTime
      ).catch(() => {}));
    } else {
      setImmediate(() => Notif.newBooking(
        booking.trip.driver_id, booking.trip.driver?.full_name || 'A passenger',
        booking.trip.from_city, booking.trip.to_city,
        pickupStop?.area ?? 'your stop', departureTime,
        fmtAmount(booking.total_amount, booking.trip.driver?.country || 'CA')
      ).catch(() => {}));
    }

    res.json({ success: true, status: newStatus, booking_id });
  } catch (err) {
    console.error('[FW Booking Verify]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// ── GET /api/bookings — Get current user's bookings ───────────────────────────
router.get('/', verifyAuth, async (req, res) => {
  try {
    const { status } = req.query;

    let query = supabase
      .from('bookings')
      .select(`
        *,
        trip:trips(
          id, from_city, to_city, departure_at, original_departure_at, seats_total, seats_booked,
          price_per_seat, status, cash_only, pref_ac, pref_music, pref_quiet_ride,
          pref_luggage, pref_wait_mins, notes, accepts_packages,
          driver:users!trips_driver_id_fkey(
            id, full_name, avatar_url, rating_as_driver, total_trips_driver, phone
          ),
          pickup_stops(*),
          dropoff_stops(*),
          break_stops(*),
          bookings(id, status, seats, passenger:users!bookings_passenger_id_fkey(id, full_name, avatar_url))
        ),
        pickup_stop:pickup_stops!bookings_pickup_stop_id_fkey(id, area, departs_at),
        dropoff_stop:dropoff_stops!bookings_dropoff_stop_id_fkey(id, area)
      `)
      .eq('passenger_id', req.userId)
      .order('created_at', { ascending: false });

    if (status) query = query.eq('status', status);

    const { data: bookings, error } = await query;
    if (error) throw error;

    res.json({ bookings: bookings || [] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// POST /api/bookings/:id/approve — Driver approves booking
router.post('/:id/approve', verifyAuth, async (req, res) => {
  try {
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('*, trip:trips(driver_id)')
      .eq('id', req.params.id)
      .single();

    if (error || !booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.trip?.driver_id !== req.userId) return res.status(403).json({ error: 'Not your trip' });

    await supabase.from('bookings')
      .update({ approval_status: 'approved', status: 'confirmed' })
      .eq('id', req.params.id);

    // Get driver name and trip details for notification
    const { data: tripDetails } = await supabase
      .from('trips')
      .select('from_city, to_city, departure_at, driver:users!trips_driver_id_fkey(full_name)')
      .eq('id', booking.trip_id).single();

    const driverName = tripDetails?.driver?.full_name || 'Your driver';
    const depDate = tripDetails?.departure_at
      ? new Date(tripDetails.departure_at).toLocaleDateString('en-CA', { weekday:'short', month:'short', day:'numeric' })
      : '';

    // Send push + in-app notification to passenger
    await sendNotification({
      userId:    booking.passenger_id,
      category:  'booking',
      icon:      '✅',
      isUrgent:  true,
      title:     '🎉 Booking Approved!',
      body:      `${driverName} approved your trip from ${tripDetails?.from_city || ''} to ${tripDetails?.to_city || ''} on ${depDate}.`,
      relatedId: booking.trip_id,
    });

    // Also increment seats_booked now that it's confirmed
    await supabase.from('trips')
      .update({ seats_booked: supabase.raw('seats_booked + ' + booking.seats) })
      .eq('id', booking.trip_id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve booking' });
  }
});

// POST /api/bookings/:id/decline — Driver declines booking with reason
router.post('/:id/decline', verifyAuth, async (req, res) => {
  try {
    const { reason } = req.body;
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('*, trip:trips(driver_id, from_city, to_city)')
      .eq('id', req.params.id)
      .single();

    if (error || !booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.trip?.driver_id !== req.userId) return res.status(403).json({ error: 'Not your trip' });

    // Update booking status
    await supabase.from('bookings')
      .update({ 
        approval_status: 'declined', 
        status: 'cancelled',
        cancel_reason: reason || 'Declined by driver',
        cancel_by: 'driver',
        cancelled_at: new Date().toISOString(),
      })
      .eq('id', req.params.id);

    // Free up the seats
    await supabase.from('trips')
      .update({ seats_booked: supabase.raw('seats_booked - ' + booking.seats) })
      .eq('id', booking.trip_id);

    // Send reason as a chat message
    if (reason) {
      const { data: driver } = await supabase
        .from('users').select('id').eq('id', req.userId).single();
      await supabase.from('messages').insert({
        booking_id: booking.id,
        sender_id:  req.userId,
        content:    `Booking declined: ${reason}`,
      });
    }

    // Send push + in-app notification to passenger
    await sendNotification({
      userId:    booking.passenger_id,
      category:  'cancel',
      icon:      '❌',
      isUrgent:  true,
      title:     'Booking Declined',
      body:      reason ? `Your booking was declined: ${reason}` : 'Your booking request was declined by the driver.',
      relatedId: booking.trip_id,
    });

    // Process refund if payment was captured
    if (booking.stripe_payment_intent_id && booking.total_amount > 0) {
      try {
        const stripe = require('../lib/stripe');
        await stripe.refunds.create({
          payment_intent: booking.stripe_payment_intent_id,
        });
      } catch (e) {
        console.log('[Stripe] Refund failed:', e.message);
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to decline booking' });
  }
});
