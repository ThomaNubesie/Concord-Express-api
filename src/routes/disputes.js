const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const { verifyAuth } = require('../middleware/auth');
const { Notif } = require('../lib/notifications');

router.post('/', verifyAuth, async (req, res) => {
  const { booking_id, issue_type, description, is_urgent } = req.body;
  if (!booking_id || !issue_type || !description) return res.status(400).json({ error: 'booking_id, issue_type, and description required' });
  const { data, error } = await supabase.from('disputes')
    .insert({ booking_id, reporter_id: req.userId, issue_type, description, is_urgent: is_urgent ?? false })
    .select().single();
  if (error) return res.status(500).json({ error: 'Failed to file dispute' });
  const { data: booking } = await supabase.from('bookings')
    .select('passenger_id, trip:trips(driver_id)').eq('id', booking_id).single();
  if (booking) {
    const otherId    = req.userId === booking.passenger_id ? booking.trip.driver_id : booking.passenger_id;
    const { data: reporter } = await supabase.from('users').select('full_name').eq('id', req.userId).single();
    await Notif.disputeOpened(otherId, reporter?.full_name ?? 'A user');
  }
  res.status(201).json({ dispute: data });
});

router.get('/:id', verifyAuth, async (req, res) => {
  const { data, error } = await supabase.from('disputes').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Dispute not found' });
  res.json({ dispute: data });
});

module.exports = router;
