const supabase = require('../lib/supabase');

// ── Send a notification ───────────────────────────────────────────────────────
// Saves to DB + sends FCM push if user has a token

const Anthropic = require('@anthropic-ai/sdk');

async function translateNotifText(text, toLang) {
  if (!text || toLang === 'en') return text;
  try {
    const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role:'user', content: `Translate this mobile notification text to ${toLang}. Reply with ONLY the translation:\n${text}` }],
    });
    return msg.content?.[0]?.text?.trim() || text;
  } catch { return text; }
}

const { formatTimeInZone, formatDateTimeInZone } = require('./timezone');

async function sendNotification({
  userId,
  category,   // trips | messages | payments | system
  title,
  body,
  icon        = '🔔',
  isUrgent    = false,
  actionUrl   = null,
  relatedId   = null,
}) {
  try {
    // 1. Save to notifications table
    const { data: notif, error } = await supabase
      .from('notifications')
      .insert({
        user_id:    userId,
        category,
        title,
        body,
        icon,
        is_urgent:  isUrgent,
        action_url: actionUrl,
        related_id: relatedId,
      })
      .select()
      .single();

    if (error) {
      console.error('[Notifications] DB insert error:', error);
      return null;
    }

    // 2. Get user's push tokens
    const { data: user } = await supabase
      .from('users')
      .select('fcm_token, push_token')
      .eq('id', userId)
      .single();

    const pushData = {
      notificationId: notif.id,
      category,
      actionUrl:      actionUrl ?? '',
      relatedId:      relatedId ?? '',
      screen:         actionUrl || '/notifications',
    };

    // Send via FCM (Android/legacy)
    if (user?.fcm_token) {
      await sendFCMPush({ token: user.fcm_token, title, body, data: pushData });
    }

    // Send via Expo Push (iOS + Android)
    if (user?.push_token) {
      await sendExpoPush({ token: user.push_token, title, body, data: pushData });
    }

    return notif;
  } catch (err) {
    console.error('[Notifications] Error:', err);
    return null;
  }
}

// ── FCM push via Firebase Admin SDK ──────────────────────────────────────────

async function sendFCMPush({ token, title, body, data = {} }) {
  try {
    // Firebase Admin SDK — initialized lazily to avoid startup errors
    // if Firebase env vars aren't set yet
    const admin = require('../lib/firebase');
    await admin.messaging().send({
      token,
      notification: { title, body },
      data:         Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
      android: {
        priority: 'high',
        notification: {
          sound:       'default',
          channelId:   'concord_xpress',
        },
      },
    });
  } catch (err) {
    // FCM errors are non-fatal — notification is already in DB
    console.error('[FCM] Push failed (non-fatal):', err.message);
  }
}

// ── Expo Push (for expo-notifications) ──────────────────────────────────────

async function sendExpoPush({ token, title, body, data = {} }) {
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: token, title, body, data, sound: 'default' }),
    });
    const result = await res.json();
    if (result.data?.status === 'error') {
      console.error('[Expo Push] Failed:', result.data.message);
    }
  } catch (err) {
    console.error('[Expo Push] Error (non-fatal):', err.message);
  }
}

// ── Notification templates ────────────────────────────────────────────────────
// All the trigger points from our notification map

const Notif = {

  // ── Driver receives ───────────────────────────────────────────────────────

  newBooking: (driverId, passengerName, fromCity, toCity, stop, time, amount) =>
    sendNotification({
      userId:    driverId,
      category:  'trips',
      icon:      '✅',
      title:     `New Booking — ${passengerName}`,
      body:      `${passengerName} booked a seat on your ${fromCity} → ${toCity} trip. Boards at ${stop} · ${time} · C$${amount} held in escrow.`,
      actionUrl: '/driver/home',
    }),

  bookingApprovalRequest: (driverId, passengerName, fromCity, toCity, stop, time) =>
    sendNotification({
      userId:    driverId,
      category:  'trips',
      icon:      '✋',
      title:     `Approval Request — ${passengerName}`,
      body:      `${passengerName} wants to join your ${fromCity} → ${toCity} trip. Boards at ${stop} · ${time}. Approve or decline in your trip details.`,
      actionUrl: '/driver/my-trips',
    }),

  bookingCancelled: (driverId, passengerName, fromCity, toCity, time) =>
    sendNotification({
      userId:    driverId,
      category:  'trips',
      icon:      '✕',
      title:     `Booking Cancelled — ${passengerName}`,
      body:      `${passengerName} cancelled their seat on ${fromCity} → ${toCity} · ${time}. 1 seat is now available again.`,
      actionUrl: '/driver/my-trips',
    }),

  passengerMessage: (driverId, passengerName, preview, bookingId) =>
    sendNotification({
      userId:    driverId,
      category:  'messages',
      icon:      '💬',
      title:     `Message from ${passengerName}`,
      body:      `"${preview}"`,
      isUrgent:  true,
      actionUrl: '/chat',
      relatedId: bookingId,
    }),

  paymentReleased: (driverId, amount, fromCity, toCity) =>
    sendNotification({
      userId:    driverId,
      category:  'payments',
      icon:      '💰',
      title:     `Payment Released — C$${amount}`,
      body:      `All passengers confirmed arrival. C$${amount} has been released to your account.`,
      actionUrl: '/driver/analytics',
    }),

  newRating: (driverId, passengerName, stars) =>
    sendNotification({
      userId:    driverId,
      category:  'trips',
      icon:      '⭐',
      title:     `New Rating — ${stars} Stars`,
      body:      `${passengerName} left you a ${stars}-star rating.`,
      actionUrl: '/driver-profile',
    }),

  agreementSigned: (driverId, passengerName, fromCity, toCity) =>
    sendNotification({
      userId:    driverId,
      category:  'trips',
      icon:      '✍️',
      title:     `Agreement Signed — ${passengerName}`,
      body:      `${passengerName} accepted your Passenger Agreement for ${fromCity} → ${toCity}. Booking confirmed.`,
      actionUrl: '/driver/my-trips',
    }),

  noShow: (driverId, passengerName, stop) =>
    sendNotification({
      userId:    driverId,
      category:  'trips',
      icon:      '🚫',
      title:     `No-Show — ${passengerName}`,
      body:      `${passengerName} did not board at ${stop}. No refund has been issued.`,
      actionUrl: '/driver/my-trips',
    }),

  disputeOpened: (driverId, passengerName) =>
    sendNotification({
      userId:    driverId,
      category:  'trips',
      icon:      '⚠️',
      title:     `Dispute Opened — ${passengerName}`,
      body:      `${passengerName} opened a dispute. Our support team will contact you within 1 hour.`,
      isUrgent:  true,
      actionUrl: '/dispute',
    }),

  bookingsClosed: (driverId, fromCity, toCity, passengerCount) =>
    sendNotification({
      userId:    driverId,
      category:  'system',
      icon:      '🔒',
      title:     `Bookings Closed — ${fromCity} → ${toCity}`,
      body:      `10 minutes to departure. ${passengerCount} passengers confirmed.`,
      actionUrl: '/driver/home',
    }),

  payoutDeposited: (driverId, amount) =>
    sendNotification({
      userId:    driverId,
      category:  'payments',
      icon:      '🏦',
      title:     `Payout Deposited — C$${amount}`,
      body:      `C$${amount} has been deposited to your bank account. Allow 1–3 business days.`,
      actionUrl: '/driver/payout',
    }),

  strikeAdded: (driverId, count) =>
    sendNotification({
      userId:    driverId,
      category:  'system',
      icon:      '⚠️',
      title:     `Strike Warning — ${count} of 10`,
      body:      `A cancellation strike has been added to your account (${count}/10). ${10 - count} strikes remain before suspension.`,
      actionUrl: '/loyalty',
      isUrgent:  count >= 8,
    }),

  documentApproved: (driverId, docType) =>
    sendNotification({
      userId:    driverId,
      category:  'system',
      icon:      '✅',
      title:     `Document Approved — ${docType}`,
      body:      `Your ${docType} has been verified successfully.`,
    }),

  documentRejected: (driverId, docType, reason) =>
    sendNotification({
      userId:    driverId,
      category:  'system',
      icon:      '❌',
      title:     `Document Rejected — ${docType}`,
      body:      `Your ${docType} was rejected: ${reason}. Please re-upload.`,
      actionUrl: '/driver-verification',
      isUrgent:  true,
    }),

  // ── Passenger receives ────────────────────────────────────────────────────

  driverApproaching: (passengerId, driverName, stop, etaMins) =>
    sendNotification({
      userId:    passengerId,
      category:  'trips',
      icon:      '🚗',
      title:     `${driverName} is approaching!`,
      body:      `Be ready at ${stop}. ETA ${etaMins} minutes.`,
      isUrgent:  true,
      actionUrl: '/trip-tracking',
    }),

  driverMessage: (passengerId, driverName, preview, bookingId) =>
    sendNotification({
      userId:    passengerId,
      category:  'messages',
      icon:      '💬',
      title:     `Message from ${driverName}`,
      body:      `"${preview}"`,
      actionUrl: '/chat',
      relatedId: bookingId,
    }),

  bookingConfirmed: (passengerId, driverName, fromCity, toCity, date, time, amount) =>
    sendNotification({
      userId:    passengerId,
      category:  'trips',
      icon:      '✅',
      title:     `Booking Confirmed`,
      body:      `Your seat is confirmed with ${driverName} for ${fromCity} → ${toCity} on ${date} at ${time}. C$${amount} held in escrow.`,
      actionUrl: '/passenger/home',
    }),

  tripUpdated: (passengerId, driverName, changeDescription) =>
    sendNotification({
      userId:    passengerId,
      category:  'trips',
      icon:      '⚠️',
      title:     `Trip Updated by Driver`,
      body:      `${driverName} updated your trip: ${changeDescription}. You may cancel for a full refund.`,
      actionUrl: '/passenger/home',
    }),

  tripCancelledByDriver: (passengerId, driverName, fromCity, toCity, refundAmount) =>
    sendNotification({
      userId:    passengerId,
      category:  'trips',
      icon:      '✕',
      title:     `Trip Cancelled by Driver`,
      body:      `${driverName} cancelled the ${fromCity} → ${toCity} trip. Full refund of C$${refundAmount} will appear in 3–5 business days.`,
      actionUrl: '/search',
    }),

  escrowReleased: (passengerId, driverName, amount) =>
    sendNotification({
      userId:    passengerId,
      category:  'payments',
      icon:      '🔒',
      title:     `Payment Released`,
      body:      `C$${amount} released to ${driverName}. Thank you for confirming arrival!`,
      actionUrl: '/passenger/home',
    }),

  rateYourDriver: (passengerId, driverName, bookingId) =>
    sendNotification({
      userId:    passengerId,
      category:  'trips',
      icon:      '⭐',
      title:     `Rate Your Driver`,
      body:      `How was your ride with ${driverName}? You have 48 hours to leave a rating.`,
      actionUrl: '/rating',
      relatedId: bookingId,
    }),

  // ── Departure reminders (passenger) ──────────────────────────────────
  departureReminder24h: (passengerId, driverName, route, time) =>
    sendNotification({
      userId:    passengerId,
      category:  'trips',
      icon:      '📅',
      title:     `Trip Tomorrow`,
      body:      `Reminder: your ${route} trip with ${driverName} departs tomorrow at ${time}. Get ready!`,
      actionUrl: '/passenger/home',
    }),

  departureReminder1h: (passengerId, driverName, route, stop) =>
    sendNotification({
      userId:    passengerId,
      category:  'trips',
      icon:      '⏰',
      isUrgent:  true,
      title:     `Departing in 1 Hour`,
      body:      `Your ${route} trip with ${driverName} leaves in 1 hour. Head to ${stop} now!`,
      actionUrl: '/passenger/home',
    }),

  departureReminder30m: (passengerId, driverName, stop) =>
    sendNotification({
      userId:    passengerId,
      category:  'trips',
      icon:      '🚨',
      isUrgent:  true,
      title:     `30 Minutes to Departure`,
      body:      `Your ride with ${driverName} leaves in 30 minutes. Be at ${stop} — don't miss it!`,
      actionUrl: '/passenger/home',
    }),

  // ── Departure reminders (driver) ───────────────────────────────────
  driverReminder24h: (driverId, route, time, seatsBooked) =>
    sendNotification({
      userId:    driverId,
      category:  'trips',
      icon:      '📅',
      title:     `Trip Tomorrow`,
      body:      `Reminder: your ${route} trip departs tomorrow at ${time}. ${seatsBooked} seat${seatsBooked !== 1 ? 's' : ''} booked.`,
      actionUrl: '/driver/home',
    }),

  driverReminder1h: (driverId, route, seatsBooked) =>
    sendNotification({
      userId:    driverId,
      category:  'trips',
      icon:      '⏰',
      isUrgent:  true,
      title:     `Departing in 1 Hour`,
      body:      `Your ${route} trip leaves in 1 hour. ${seatsBooked} passenger${seatsBooked !== 1 ? 's' : ''} waiting. Time to get ready!`,
      actionUrl: '/driver/home',
    }),

  driverReminder30m: (driverId, route) =>
    sendNotification({
      userId:    driverId,
      category:  'trips',
      icon:      '🚨',
      isUrgent:  true,
      title:     `30 Minutes to Departure`,
      body:      `Your ${route} trip leaves in 30 minutes. Head to the pickup point!`,
      actionUrl: '/driver/home',
    }),

  driverReminder15m: (driverId, route) =>
    sendNotification({
      userId:    driverId,
      category:  'trips',
      icon:      '🟢',
      isUrgent:  true,
      title:     `Start Your Trip`,
      body:      `Your ${route} trip departs in 15 minutes. Tap to start the trip and begin check-in.`,
      actionUrl: '/driver/home',
    }),

  // ── Late-trip escalations (driver hasn't started) ────────────────────────
  driverNotStartedWarning: (driverId, route) =>
    sendNotification({
      userId:    driverId,
      category:  'trips',
      icon:      '⚠️',
      isUrgent:  true,
      title:     `Trip leaves in 5 minutes`,
      body:      `You haven't started your ${route} trip yet. Tap "Running late" in trip details to add time, or start the trip now.`,
      actionUrl: '/driver/home',
    }),

  driverGracePeriod: (driverId, route) =>
    sendNotification({
      userId:    driverId,
      category:  'trips',
      icon:      '⏰',
      isUrgent:  true,
      title:     `Departure time reached`,
      body:      `Your ${route} trip should have started. You have 5 minutes to start the trip or mark "Running late" — otherwise this counts as a strike.`,
      actionUrl: '/driver/home',
    }),

  passengerGracePeriod: (passengerId, driverName, route) =>
    sendNotification({
      userId:    passengerId,
      category:  'trips',
      icon:      '⌛',
      isUrgent:  true,
      title:     `${driverName} is late`,
      body:      `Your ${route} driver hasn't started the trip. We're giving them 5 more minutes. If they don't respond, you'll see alternative trips and can cancel for a full refund.`,
      actionUrl: '/passenger/home',
    }),

  driverStrike: (driverId, route) =>
    sendNotification({
      userId:    driverId,
      category:  'trips',
      icon:      '🚫',
      isUrgent:  true,
      title:     `Strike issued — trip not started`,
      body:      `Your ${route} trip was not started within the grace period. A strike has been recorded on your account.`,
      actionUrl: '/driver/home',
    }),

  passengerTripDelayed: (passengerId, driverName, route, bookingId) =>
    sendNotification({
      userId:    passengerId,
      category:  'trips',
      icon:      '🔁',
      isUrgent:  true,
      title:     `Trip not started — alternatives available`,
      body:      `${driverName} did not start your ${route} trip. We've matched you with alternative trips, or you can cancel for a full refund.`,
      actionUrl: bookingId ? `/passenger/alternatives?bookingId=${bookingId}` : '/passenger/home',
      relatedId: bookingId,
    }),

  // Legacy alias
  departureReminder: (passengerId, driverName, stop, time) =>
    sendNotification({
      userId:    passengerId,
      category:  'trips',
      icon:      '⏰',
      title:     `Departure Tomorrow — Be Ready`,
      body:      `Reminder: your trip with ${driverName} departs tomorrow. Your pickup is ${stop} at ${time}. Please be 5 minutes early.`,
      actionUrl: '/passenger/home',
    }),

  loyaltyMilestone: (passengerId, trips, creditAmount) =>
    sendNotification({
      userId:    passengerId,
      category:  'payments',
      icon:      '🎉',
      title:     `Loyalty Milestone — ${trips} Trips!`,
      body:      creditAmount > 0
        ? `You've completed ${trips} trips! A C$${creditAmount} loyalty credit has been added to your account.`
        : `You've completed ${trips} trips! A monthly draw entry has been added.`,
      actionUrl: '/loyalty',
    }),
};

module.exports = { sendNotification, Notif };
