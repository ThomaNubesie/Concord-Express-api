require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl    = process.env.SUPABASE_URL;
const supabaseSecret = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseSecret) {
  console.warn('[Supabase] WARNING: Missing SUPABASE_URL or SUPABASE_SECRET_KEY');
}

const supabase = createClient(
  supabaseUrl    || 'https://placeholder.supabase.co',
  supabaseSecret || 'placeholder',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

module.exports = supabase;
