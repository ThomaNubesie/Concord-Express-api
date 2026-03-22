const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const { verifyAuth } = require('../middleware/auth');

router.post('/verify', verifyAuth, async (req, res) => {
  const { doc_type, file_url } = req.body;
  const validDocs = ['licence', 'insurance', 'registration', 'photo', 'abstract'];
  if (!validDocs.includes(doc_type)) return res.status(400).json({ error: 'Invalid doc type' });
  const { error } = await supabase.from('driver_profiles').upsert({
    user_id: req.userId, [`${doc_type}_status`]: 'uploaded', [`${doc_type}_url`]: file_url,
  }, { onConflict: 'user_id' });
  if (error) return res.status(500).json({ error: 'Failed to update verification' });
  res.json({ success: true, status: 'uploaded' });
});

router.get('/verification', verifyAuth, async (req, res) => {
  const { data, error } = await supabase.from('driver_profiles').select('*').eq('user_id', req.userId).single();
  if (error) return res.json({ profile: null });
  res.json({ profile: data });
});

router.get('/analytics', verifyAuth, async (req, res) => {
  const { period = 'week' } = req.query;
  const now = new Date(); const startDate = new Date();
  if (period === 'week')  startDate.setDate(now.getDate() - 7);
  if (period === 'month') startDate.setDate(now.getDate() - 30);
  if (period === 'year')  startDate.setFullYear(now.getFullYear() - 1);
  const { data: bookings, error } = await supabase
    .from('bookings').select('fare_amount, seats, status, created_at, trip:trips(from_city, to_city, departure_at, driver_id)')
    .eq('status', 'completed').gte('created_at', startDate.toISOString());
  if (error) return res.status(500).json({ error: 'Failed to fetch analytics' });
  const myBookings = bookings.filter(b => b.trip?.driver_id === req.userId);
  const gross      = myBookings.reduce((s, b) => s + parseFloat(b.fare_amount), 0);
  res.json({ gross, net: gross * 0.9, trips: myBookings.length, passengers: myBookings.reduce((s, b) => s + b.seats, 0) });
});

router.post('/location', verifyAuth, async (req, res) => {
  const { trip_id, lat, lng, heading, speed } = req.body;
  if (!trip_id || !lat || !lng) return res.status(400).json({ error: 'trip_id, lat, lng required' });
  const { error } = await supabase.from('driver_locations').upsert(
    { trip_id, driver_id: req.userId, lat, lng, heading, speed, updated_at: new Date().toISOString() },
    { onConflict: 'trip_id,driver_id' }
  );
  if (error) return res.status(500).json({ error: 'Failed to update location' });
  res.json({ success: true });
});

module.exports = router;
