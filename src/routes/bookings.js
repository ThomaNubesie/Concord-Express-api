const express    = require('express');
const router     = express.Router();
const supabase   = require('../lib/supabase');
const stripe     = require('../lib/stripe');
const { verifyAuth } = require('../middleware/auth');
const { Notif }  = require('../lib/notifications');

// ── POST /api/bookings — Create booking ───────────────────────────────────────

router.post('/', verifyAuth, async (req, res) => {
  try {
    const {
      trip_id, pickup_stop_id, dropoff_stop_id,
      seats = 1, payment_method_id, credit_to_apply = 0,
    } = req.body;

    if (!trip_id || !pickup_stop_id || !dropoff_stop_id || !payment_method_id) {
      return res.status(400).json({ error: 'Missing required booking fields' });
    }

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
    if (minsUntil < 10) {
      return res.status(400).json({ error: 'Booking closed — trip departs in less than 10 minutes' });
    }

    // Check seats available
    const seatsAvailable = trip.seats_total - trip.seats_booked;
    if (seatsAvailable < seats) {
      return res.status(400).json({ error: `Only ${seatsAvailable} seats available` });
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
    const bookingFee  = parseFloat(process.env.BOOKING_FEE ?? '3.00') * seats;
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

    // Create PaymentIntent with escrow
    const paymentIntent = await stripe.paymentIntents.create({
      amount:               Math.round(totalAmount * 100), // cents
      currency:             'cad',
      customer:             customerId,
      payment_method:       payment_method_id,
      confirm:              true,
      capture_method:       'manual', // hold funds, don't capture yet
      transfer_data:        driverProfile?.stripe_account_id ? {
        destination:        driverProfile.stripe_account_id,
        amount:             Math.round(fareAmount * seats * 0.9 * 100), // 90% to driver
      } : undefined,
      metadata: {
        trip_id,
        passenger_id: req.userId,
        driver_id:    trip.driver_id,
      },
      return_url: 'concordxpress://payment-complete',
    });

    if (paymentIntent.status !== 'requires_capture') {
      return res.status(400).json({ error: 'Payment failed. Please check your payment method.' });
    }

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
        status:                   'confirmed',
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

    // Notify driver of new booking
    await Notif.newBooking(
      trip.driver_id,
      user.full_name,
      trip.from_city,
      trip.to_city,
      pickupStop?.area ?? 'your stop',
      departureTime,
      totalAmount.toFixed(2)
    );

    // Notify passenger of confirmed booking
    await Notif.bookingConfirmed(
      req.userId,
      trip.driver.full_name,
      trip.from_city,
      trip.to_city,
      new Date(trip.departure_at).toLocaleDateString('en-CA', {
        weekday: 'short', month: 'short', day: 'numeric',
      }),
      departureTime,
      totalAmount.toFixed(2)
    );

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

    if (!['confirmed', 'active'].includes(booking.status)) {
      return res.status(400).json({ error: 'Booking cannot be cancelled' });
    }

    // Calculate refund based on tiered policy
    const minsUntil  = (new Date(booking.trip.departure_at) - Date.now()) / 60000;
    const hoursUntil = minsUntil / 60;
    let refundPct    = 0;
    let refundAmount = 0;

    if (hoursUntil > 24) {
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
          id, from_city, to_city, departure_at,
          price_per_seat, status,
          driver:users!trips_driver_id_fkey(
            id, full_name, avatar_url, rating_as_driver, phone
          )
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

    // Notify passenger
    await supabase.from('notifications').insert({
      user_id: booking.passenger_id,
      type: 'booking',
      title: 'Booking Approved!',
      body: 'Your booking request has been approved by the driver.',
      action_url: `/passenger/home`,
    });

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

    // Notify passenger
    await supabase.from('notifications').insert({
      user_id: booking.passenger_id,
      type: 'cancel',
      title: 'Booking Declined',
      body: reason ? `Your booking was declined: ${reason}` : 'Your booking request was declined by the driver.',
      action_url: `/passenger/home`,
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
