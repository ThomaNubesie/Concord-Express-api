const stripe   = require('./stripe');
const supabase = require('./supabase');

// Build the Stripe customer fields from a user row so customers show real
// info (name / email / phone / country / description) instead of blanks.
function customerFields(user, userId) {
  const role = user?.role || 'user';
  const fields = {
    metadata: { user_id: userId, role, country: user?.country || '' },
  };
  if (user?.email)     fields.email = user.email;
  if (user?.full_name) fields.name  = user.full_name;
  // Some accounts store a non-phone string in `phone` (e.g. "email:..."); only
  // send something that looks like a real number.
  if (user?.phone && /^\+?[0-9][0-9 ()\-]{5,}$/.test(user.phone)) fields.phone = user.phone;
  fields.description = user?.full_name ? `${role} — ${user.full_name}` : role;
  // Stripe's address.country must be a 2-letter ISO code.
  if (user?.country && /^[A-Za-z]{2}$/.test(user.country)) {
    fields.address = { country: user.country.toUpperCase() };
  }
  return fields;
}

// Return the user's Stripe customer id, creating a fully-populated customer if
// one doesn't exist yet. If it already exists, best-effort sync the latest
// profile info so previously-blank customers get backfilled on next use.
async function getOrCreateStripeCustomer(userId) {
  const { data: user } = await supabase
    .from('users')
    .select('stripe_customer_id, full_name, email, phone, country, role')
    .eq('id', userId).single();

  if (user?.stripe_customer_id) {
    try { await stripe.customers.update(user.stripe_customer_id, customerFields(user, userId)); }
    catch (e) { console.error('[stripeCustomer] update failed:', e.message); }
    return user.stripe_customer_id;
  }

  const c = await stripe.customers.create(customerFields(user, userId));
  await supabase.from('users').update({ stripe_customer_id: c.id }).eq('id', userId);
  return c.id;
}

module.exports = { getOrCreateStripeCustomer, customerFields };
