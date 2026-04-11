const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const { verifyAuth } = require('../middleware/auth');
const { Notif } = require('../lib/notifications');

router.post('/', verifyAuth, async (req, res) => {
  const { booking_id, ratee_id, score, comment, tags, rated_as } = req.body;
  if (!booking_id || !ratee_id || !score) return res.status(400).json({ error: 'booking_id, ratee_id, and score required' });
  const { data: booking } = await supabase.from('bookings')
    .select('passenger_id, trip:trips(driver_id, departure_at)').eq('id', booking_id).single();
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const isPassenger = req.userId === booking.passenger_id;
  const role        = isPassenger ? 'passenger_rates_driver' : 'driver_rates_passenger';
  const expiresAt   = new Date(booking.trip.departure_at);
  expiresAt.setHours(expiresAt.getHours() + 48);
  const { data: rating, error } = await supabase.from('ratings')
    .insert({ booking_id, rater_id: req.userId, ratee_id, role, score, comment, tags: tags||[], expires_at: expiresAt.toISOString() })
    .select().single();
  if (error) return res.status(500).json({ error: 'Failed to submit rating' });
  const { data: rater } = await supabase.from('users').select('full_name').eq('id', req.userId).single();
  if (isPassenger) await Notif.newRating(ratee_id, rater?.full_name ?? 'A passenger', score);
  res.status(201).json({ rating });
});

router.get('/user/:id', async (req, res) => {
  const { data, error } = await supabase.from('ratings')
    .select('*, rater:users!ratings_rater_id_fkey(id, full_name, avatar_url)')
    .eq('ratee_id', req.params.id).order('created_at', { ascending: false }).limit(20);
  if (error) return res.status(500).json({ error: 'Failed to fetch ratings' });
  res.json({ ratings: data });
});

module.exports = router;
