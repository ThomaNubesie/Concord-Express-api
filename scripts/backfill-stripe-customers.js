// One-off backfill: push name / email / phone / country / description onto every
// existing Stripe customer that was created blank (metadata-only). Safe to run
// repeatedly — it only updates, never creates or charges.
//
// Usage (in the backend env, with STRIPE_SECRET_KEY + SUPABASE_* set):
//   npm run backfill-customers            # apply
//   npm run backfill-customers -- --dry   # preview only, no Stripe writes
require('dotenv').config();

const stripe   = require('../src/lib/stripe');
const supabase = require('../src/lib/supabase');
const { customerFields } = require('../src/lib/stripeCustomer');

const DRY = process.argv.includes('--dry');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`\n[backfill] ${DRY ? 'DRY RUN — ' : ''}syncing Stripe customers…\n`);

  const { data: users, error } = await supabase
    .from('users')
    .select('id, full_name, email, phone, country, role, stripe_customer_id')
    .not('stripe_customer_id', 'is', null);

  if (error) { console.error('[backfill] users query failed:', error.message); process.exit(1); }

  let updated = 0, skipped = 0, failed = 0;
  for (const u of users) {
    const fields = customerFields(u, u.id);
    const label = `${u.stripe_customer_id}  ${u.full_name || '(no name)'} <${u.email || 'no email'}>`;
    try {
      if (DRY) {
        console.log(`would update  ${label}  →`, JSON.stringify({ name: fields.name, email: fields.email, phone: fields.phone, country: fields.address?.country, description: fields.description }));
      } else {
        await stripe.customers.update(u.stripe_customer_id, fields);
        console.log(`updated       ${label}`);
      }
      updated++;
      await sleep(120); // gentle on the Stripe rate limit
    } catch (e) {
      // e.g. customer deleted in Stripe — skip, don't fail the whole run.
      if (/No such customer/i.test(e.message)) { console.warn(`skip (gone)   ${label}`); skipped++; }
      else { console.error(`FAILED        ${label}  — ${e.message}`); failed++; }
    }
  }

  console.log(`\n[backfill] done. ${DRY ? 'would update' : 'updated'}: ${updated}, skipped(gone): ${skipped}, failed: ${failed}, total: ${users.length}\n`);
  process.exit(0);
})();
