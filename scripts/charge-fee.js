// Admin one-off: charge the verification/driver fee to a driver's SAVED card
// (off-session) and credit them on success. For drivers who completed the
// in-app flow (card saved) but were never actually charged.
//
// Usage (Railway / live env):
//   npm run charge-fee -- --dry  email1@x.com email2@x.com      # preview only
//   npm run charge-fee --        email1@x.com email2@x.com      # charge for real
//
// Safe: skips anyone already fee_paid, skips anyone with no saved card, and on
// a 3-D-Secure / decline it reports and moves on (no partial state — the DB is
// only written after a SUCCEEDED charge).
require('dotenv').config();

const stripe   = require('../src/lib/stripe');
const supabase = require('../src/lib/supabase');

const DRY    = process.argv.includes('--dry');
const emails = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const VERIFY_FEE = 399;   // C$3.99
// Same province tax table as POST /api/payments/verification-fee.
const PROVINCE_TAX = { ON:0.13, QC:0.14975, NB:0.15, NL:0.15, NS:0.15, PE:0.15, BC:0.12, MB:0.12, SK:0.11, AB:0.05, NT:0.05, NU:0.05, YT:0.05 };
const provinceArg = (process.argv.find((a) => a.startsWith('--province=')) || '').split('=')[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (emails.length === 0) {
  console.error('Pass one or more driver emails. e.g. npm run charge-fee -- --dry a@x.com');
  process.exit(1);
}

(async () => {
  console.log(`\n[charge-fee] ${DRY ? 'DRY RUN — ' : ''}processing ${emails.length} driver(s)\n`);

  // Founding-member status (first 100 drivers pay the reduced fee).
  const { data: cfg } = await supabase.from('app_config').select('value').eq('key', 'founding_driver_count').single();
  let foundingCount = parseInt(cfg?.value || '0');

  let charged = 0, skipped = 0, failed = 0;

  for (const email of emails) {
    const { data: user } = await supabase
      .from('users')
      .select('id, full_name, email, role, stripe_customer_id, verification_fee_paid')
      .ilike('email', email).single();

    if (!user) { console.warn(`skip   ${email} — no user`); skipped++; continue; }
    if (user.verification_fee_paid) { console.warn(`skip   ${email} — already fee_paid`); skipped++; continue; }
    if (!user.stripe_customer_id)   { console.warn(`skip   ${email} — no Stripe customer`); skipped++; continue; }

    const { data: dp } = await supabase
      .from('driver_profiles').select('fee_paid, vehicle_province').eq('user_id', user.id).single();
    if (dp?.fee_paid) { console.warn(`skip   ${email} — driver already fee_paid`); skipped++; continue; }

    // Find a saved card on the customer.
    const pms = await stripe.paymentMethods.list({ customer: user.stripe_customer_id, type: 'card' });
    const pm  = pms.data[0];
    if (!pm) { console.warn(`skip   ${email} — NO SAVED CARD (must pay in-app)`); skipped++; continue; }

    const isDriver  = user.role === 'driver' || user.role === 'both';
    const isFounder = foundingCount < 100;
    const driverFee = isFounder ? 1000 : 2000;             // C$10 founder / C$20 standard
    const subtotal  = isDriver ? VERIFY_FEE + driverFee : VERIFY_FEE;
    const province  = (provinceArg || dp?.vehicle_province || 'ON').toUpperCase();
    const taxRate   = PROVINCE_TAX[province] ?? 0.13;
    const tax       = Math.round(subtotal * taxRate);
    const amount    = subtotal + tax;
    const label = `${email}  card ****${pm.card?.last4}  $${(amount / 100).toFixed(2)} = $${(subtotal / 100).toFixed(2)} + ${(taxRate * 100).toFixed(3)}% ${province} tax${isDriver ? (isFounder ? ' (founder)' : ' (standard)') : ''}`;

    if (DRY) { console.log(`would charge  ${label}`); charged++; continue; }

    try {
      const pi = await stripe.paymentIntents.create({
        amount, currency: 'cad',
        customer:       user.stripe_customer_id,
        payment_method: pm.id,
        off_session:    true,
        confirm:        true,
        description:    isDriver
          ? `ConcordXpress verification + driver subscription (${isFounder ? 'founder' : 'standard'})`
          : 'ConcordXpress identity verification',
        metadata: { user_id: user.id, role: user.role, source: 'admin-charge-fee', subtotal_cents: String(subtotal), tax_cents: String(tax), province },
      });

      if (pi.status !== 'succeeded') {
        console.error(`FAILED ${email} — payment status ${pi.status}`);
        failed++; continue;
      }

      // Credit them (mirror the fixed /verification-fee write-back).
      await supabase.from('users').update({ verification_fee_paid: true }).eq('id', user.id);
      if (isDriver) {
        const now = new Date(), exp = new Date(now); exp.setFullYear(exp.getFullYear() + 1);
        await supabase.from('driver_profiles').update({
          fee_paid: true, fee_paid_at: now.toISOString(), fee_expires_at: exp.toISOString(),
          fee_amount: driverFee / 100, is_founding_member: isFounder,
        }).eq('user_id', user.id);
        if (isFounder) { foundingCount++; await supabase.from('app_config').update({ value: String(foundingCount) }).eq('key', 'founding_driver_count'); }
      }
      console.log(`CHARGED ${label}  (pi ${pi.id})`);
      charged++;
    } catch (e) {
      // Off-session card auth required (SCA) or decline → they must do it in-app.
      const code = e.code || e.raw?.code;
      console.error(`FAILED ${email} — ${code || e.message}${code === 'authentication_required' ? ' (needs in-app 3-D-Secure)' : ''}`);
      failed++;
    }
    await sleep(200);
  }

  console.log(`\n[charge-fee] done. ${DRY ? 'would charge' : 'charged'}: ${charged}, skipped: ${skipped}, failed: ${failed}\n`);
  process.exit(0);
})();
