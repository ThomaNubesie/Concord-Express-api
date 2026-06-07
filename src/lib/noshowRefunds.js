// ═══════════════════════════════════════════════════════════════════════════
// System-cancellation Stripe settlement — Scheduled job (every 5 min)
//
// When the system cancels a booking (driver no-show, or an approval trip the
// driver never approved — including fake/seed approval trips), the Stripe
// PaymentIntent is left dangling. This job settles it so the client is never
// charged for a trip that did not happen:
//   • card trips → PI is uncaptured (requires_capture) → CANCEL to release the
//                  authorization immediately (otherwise it lingers ~7 days)
//   • cash trips → only the C$2.99 booking fee was captured → REFUND it
// Each booking is stamped noshow_settled_at so it is processed exactly once.
// ═══════════════════════════════════════════════════════════════════════════

const supabase = require('./supabase');
const stripe   = require('./stripe');

async function processSystemCancellationRefunds() {
  const { data: bookings, error } = await supabase
    .from('bookings')
    .select('id, stripe_payment_intent_id')
    .eq('cancel_by', 'system')
    .eq('status', 'cancelled')
    .is('noshow_settled_at', null)
    .not('stripe_payment_intent_id', 'is', null)
    .limit(50);
  if (error) { console.log('[noshow-refund] query error:', error.message); return; }
  if (!bookings?.length) return;

  for (const b of bookings) {
    let action = 'none';
    try {
      const pi = await stripe.paymentIntents.retrieve(
        b.stripe_payment_intent_id, { expand: ['latest_charge'] }
      );
      if (pi.status === 'requires_capture') {
        // Card escrow hold that was never captured — release it now.
        await stripe.paymentIntents.cancel(b.stripe_payment_intent_id);
        action = 'auth_released';
      } else if (pi.status === 'succeeded') {
        // Captured (e.g. cash booking fee) — refund whatever remains.
        const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
        const refundable = (pi.amount_received || 0) - (charge?.amount_refunded || 0);
        if (refundable > 0) {
          await stripe.refunds.create({ payment_intent: b.stripe_payment_intent_id });
          action = 'refunded';
        }
      }
    } catch (e) {
      const benign = e?.code === 'resource_missing'        // seed/placeholder PI
        || e?.code === 'charge_already_refunded'
        || e?.code === 'payment_intent_unexpected_state';
      if (!benign) {
        // transient (network/Stripe) — leave unsettled to retry next run
        console.log('[noshow-refund] booking', b.id, 'error:', e.message);
        continue;
      }
      action = 'skipped';
    }
    await supabase.from('bookings')
      .update({ noshow_settled_at: new Date().toISOString() })
      .eq('id', b.id);
    if (action !== 'none' && action !== 'skipped') {
      console.log('[noshow-refund] booking', b.id, '->', action);
    }
  }
}

function startNoshowRefunds() {
  setTimeout(processSystemCancellationRefunds, 30 * 1000);          // shortly after boot
  setInterval(processSystemCancellationRefunds, 5 * 60 * 1000);     // then every 5 min
}

module.exports = { startNoshowRefunds, processSystemCancellationRefunds };
