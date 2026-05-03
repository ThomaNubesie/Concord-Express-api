// ═══════════════════════════════════════════════════════════════════════════
// Trip Departure Reminders — Scheduled job
//
// Sends notifications at: 24h, 1h, 30min (driver + passenger), 15min (driver only)
// Run this every 5 minutes via setInterval or node-cron
// ═══════════════════════════════════════════════════════════════════════════

const supabase = require('./supabase');
const { Notif } = require('./notifications');

// Track sent reminders to avoid duplicates (in-memory, resets on restart)
const sent = new Set();

function reminderKey(tripId, userId, window) {
  return `${tripId}:${userId}:${window}`;
}

async function sendTripReminders() {
  try {
    const now = new Date();

    // Fetch upcoming trips in the next 25 hours, plus trips up to 10 min past
    // departure (still 'upcoming' = driver hasn't started → late escalations)
    const cutoff = new Date(now.getTime() + 25 * 60 * 60000);
    const lateCutoff = new Date(now.getTime() - 10 * 60000);
    const { data: trips, error } = await supabase
      .from('trips')
      .select(`
        id, driver_id, from_city, to_city, departure_at,
        seats_booked, status,
        pickup_stops(area, departs_at),
        driver:users!trips_driver_id_fkey(id, full_name, push_token),
        bookings(
          id, status, seats,
          passenger:users!bookings_passenger_id_fkey(id, full_name, push_token)
        )
      `)
      .eq('status', 'upcoming')
      .gte('departure_at', lateCutoff.toISOString())
      .lte('departure_at', cutoff.toISOString());

    if (error || !trips) {
      console.error('[reminders] Query error:', error);
      return;
    }

    let count = 0;

    for (const trip of trips) {
      const depTime = new Date(trip.departure_at);
      const minsUntil = (depTime.getTime() - now.getTime()) / 60000;
      const route = `${trip.from_city} → ${trip.to_city}`;
      const timeStr = depTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const firstStop = trip.pickup_stops?.[0]?.area || trip.from_city;
      const driverName = trip.driver?.full_name || 'your driver';
      const seatsBooked = trip.seats_booked || 0;

      // Determine which reminders to send based on time window.
      // Late escalations (T-5, T-0, T+5) only fire while status is still
      // 'upcoming' — i.e. driver hasn't started the trip yet.
      const windows = [];
      if (minsUntil <= 24 * 60 + 5 && minsUntil > 24 * 60 - 5) windows.push('24h');
      if (minsUntil <= 65 && minsUntil > 55)                     windows.push('1h');
      if (minsUntil <= 35 && minsUntil > 25)                     windows.push('30m');
      if (minsUntil <= 18 && minsUntil > 12)                     windows.push('15m');
      if (minsUntil <= 5 && minsUntil > 0)                       windows.push('late_warning');
      if (minsUntil <= 0 && minsUntil > -5)                      windows.push('grace_period');
      if (minsUntil <= -5 && minsUntil > -10)                    windows.push('strike');

      // Whether each window also notifies passengers
      const passengerWindows = new Set(['24h', '1h', '30m', 'grace_period', 'strike']);

      for (const w of windows) {
        // ── Driver reminders ──
        if (trip.driver?.id && trip.driver?.push_token) {
          const key = reminderKey(trip.id, trip.driver.id, `driver-${w}`);
          if (!sent.has(key)) {
            try {
              if (w === '24h')          await Notif.driverReminder24h(trip.driver.id, route, timeStr, seatsBooked);
              if (w === '1h')           await Notif.driverReminder1h(trip.driver.id, route, seatsBooked);
              if (w === '30m')          await Notif.driverReminder30m(trip.driver.id, route);
              if (w === '15m')          await Notif.driverReminder15m(trip.driver.id, route);
              if (w === 'late_warning') await Notif.driverNotStartedWarning(trip.driver.id, route);
              if (w === 'grace_period') await Notif.driverGracePeriod(trip.driver.id, route);
              if (w === 'strike') {
                await Notif.driverStrike(trip.driver.id, route);
                // Record strike on driver's row + auto-cancel the trip so /start
                // returns "Trip cannot be started" if driver tries later
                const { data: d } = await supabase.from('users')
                  .select('strikes_as_driver').eq('id', trip.driver.id).single();
                await supabase.from('users')
                  .update({ strikes_as_driver: (d?.strikes_as_driver || 0) + 1 })
                  .eq('id', trip.driver.id);
                await supabase.from('trips')
                  .update({ status: 'cancelled', cancellation_reason: 'driver_no_show' })
                  .eq('id', trip.id);
              }
              sent.add(key);
              count++;
            } catch (e) { console.error('[reminders] Driver notify error:', e.message); }
          }
        }

        // ── Passenger reminders ──
        if (passengerWindows.has(w)) {
          const confirmedBookings = (trip.bookings || []).filter(b =>
            ['confirmed', 'active'].includes(b.status) && b.passenger?.id
          );

          for (const booking of confirmedBookings) {
            const passId = booking.passenger.id;
            const key = reminderKey(trip.id, passId, `pass-${w}`);
            if (sent.has(key)) continue;
            if (!booking.passenger.push_token) continue;

            try {
              if (w === '24h')          await Notif.departureReminder24h(passId, driverName, route, timeStr);
              if (w === '1h')           await Notif.departureReminder1h(passId, driverName, route, firstStop);
              if (w === '30m')          await Notif.departureReminder30m(passId, driverName, firstStop);
              if (w === 'grace_period') await Notif.passengerGracePeriod(passId, driverName, route);
              if (w === 'strike')       await Notif.passengerTripDelayed(passId, driverName, route, booking.id);
              sent.add(key);
              count++;
            } catch (e) { console.error('[reminders] Passenger notify error:', e.message); }
          }
        }
      }
    }

    if (count > 0) console.log(`[reminders] Sent ${count} reminder(s)`);

    // Prune old keys (trips that have departed)
    for (const key of sent) {
      const tripId = key.split(':')[0];
      const trip = trips.find(t => t.id === tripId);
      if (!trip) sent.delete(key); // Trip no longer upcoming, safe to remove
    }

  } catch (e) {
    console.error('[reminders] Fatal error:', e);
  }
}

// Start the scheduler — runs every 5 minutes
function startTripReminders() {
  console.log('[reminders] Trip reminder scheduler started (every 5 min)');
  sendTripReminders(); // Run immediately on startup
  setInterval(sendTripReminders, 5 * 60 * 1000); // Then every 5 minutes
}

module.exports = { startTripReminders, sendTripReminders };
