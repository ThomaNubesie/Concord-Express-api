const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const { verifyAuth } = require('../middleware/auth');
const { Notif } = require('../lib/notifications');

router.get('/:bookingId', verifyAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('*, sender:users!messages_sender_id_fkey(id, full_name, avatar_url)')
    .eq('booking_id', req.params.bookingId)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: 'Failed to fetch messages' });
  await supabase.from('messages').update({ is_read: true, read_at: new Date().toISOString() })
    .eq('booking_id', req.params.bookingId).neq('sender_id', req.userId).eq('is_read', false);
  res.json({ messages: data });
});

router.post('/:bookingId', verifyAuth, async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Message content required' });
  const { data: message, error } = await supabase
    .from('messages')
    .insert({ booking_id: req.params.bookingId, sender_id: req.userId, content })
    .select('*, sender:users!messages_sender_id_fkey(id, full_name)').single();
  if (error) return res.status(500).json({ error: 'Failed to send message' });
  const { data: booking } = await supabase
    .from('bookings').select('passenger_id, trip:trips(driver_id)').eq('id', req.params.bookingId).single();
  if (booking) {
    const recipientId = req.userId === booking.passenger_id ? booking.trip.driver_id : booking.passenger_id;
    const isDriver    = req.userId === booking.trip.driver_id;
    const preview     = content.length > 60 ? content.slice(0, 60) + '...' : content;
    if (isDriver) await Notif.driverMessage(recipientId, message.sender.full_name, preview, req.params.bookingId);
    else          await Notif.passengerMessage(recipientId, message.sender.full_name, preview, req.params.bookingId);
  }
  res.status(201).json({ message });
});

module.exports = router;
