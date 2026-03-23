require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl    = (process.env.SUPABASE_URL || '').trim();
const supabaseSecret = (process.env.SUPABASE_SECRET_KEY || '').trim();

if (!supabaseUrl || !supabaseSecret) {
  console.warn('[Supabase] WARNING: Missing SUPABASE_URL or SUPABASE_SECRET_KEY');
}

const supabase = createClient(
  supabaseUrl    || 'https://placeholder.supabase.co',
  supabaseSecret || 'placeholder',
  {
    auth: {
      autoRefreshToken: false,
      persistSession:   false,
    },
    global: {
      headers: {
        'apikey': supabaseSecret,
      },
    },
    db: {
      schema: 'public',
    },
  }
);

module.exports = supabase;
