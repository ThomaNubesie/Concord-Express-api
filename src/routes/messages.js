const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const { verifyAuth } = require('../middleware/auth');
const { sendNotification } = require('../lib/notifications');

// ── GET /api/messages/:bookingId ──────────────────────────────────────────────
router.get('/:bookingId', verifyAuth, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { limit = 100, before } = req.query;

    // Verify user is part of this booking
    const { data: booking } = await supabase
      .from('bookings')
      .select('passenger_id, trip:trips(driver_id)')
      .eq('id', bookingId)
      .single();

    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    const isPassenger = booking.passenger_id === req.userId;
    const isDriver    = booking.trip?.driver_id === req.userId;
    if (!isPassenger && !isDriver) return res.status(403).json({ error: 'Not authorized' });

    let query = supabase
      .from('messages')
      .select('*, sender:users!messages_sender_id_fkey(id, full_name, avatar_url)')
      .eq('booking_id', bookingId)
      .order('created_at', { ascending: true })
      .limit(parseInt(limit));

    if (before) query = query.lt('created_at', before);

    const { data: messages, error } = await query;
    if (error) throw error;

    // Mark messages from other party as read
    const unread = messages
      .filter(m => m.sender_id !== req.userId && !m.read_at)
      .map(m => m.id);
    if (unread.length) {
      await supabase.from('messages')
        .update({ read_at: new Date().toISOString() })
        .in('id', unread);
    }

    res.json({ messages: messages || [] });
  } catch (err) {
    console.error('[messages GET]', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ── POST /api/messages/:bookingId ─────────────────────────────────────────────
router.post('/:bookingId', verifyAuth, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { content }   = req.body;

    if (!content?.trim()) return res.status(400).json({ error: 'Message content required' });
    if (content.length > 1000) return res.status(400).json({ error: 'Message too long' });

    // Verify user is part of this booking
    const { data: booking } = await supabase
      .from('bookings')
      .select('passenger_id, trip:trips(id, driver_id, from_city, to_city)')
      .eq('id', bookingId)
      .single();

    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    const isPassenger = booking.passenger_id === req.userId;
    const isDriver    = booking.trip?.driver_id === req.userId;
    if (!isPassenger && !isDriver) return res.status(403).json({ error: 'Not authorized' });

    // Insert message
    const { data: message, error } = await supabase
      .from('messages')
      .insert({
        booking_id: bookingId,
        sender_id:  req.userId,
        content:    content.trim(),
      })
      .select('*, sender:users!messages_sender_id_fkey(id, full_name, avatar_url)')
      .single();

    if (error) throw error;

    // Notify the other party
    const recipientId = isPassenger ? booking.trip?.driver_id : booking.passenger_id;
    const { data: sender } = await supabase
      .from('users').select('full_name').eq('id', req.userId).single();

    if (recipientId) {
      await sendNotification({
        userId:    recipientId,
        category:  'messages',
        icon:      '💬',
        title:     `${sender?.full_name || 'Someone'} sent you a message`,
        body:      content.trim().slice(0, 80),
        relatedId: bookingId,
        actionUrl: `/chat?bookingId=${bookingId}`,
      });
    }

    res.status(201).json({ message });
  } catch (err) {
    console.error('[messages POST]', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── GET /api/messages/:bookingId/unread-count ─────────────────────────────────
router.get('/:bookingId/unread-count', verifyAuth, async (req, res) => {
  try {
    const { count } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('booking_id', req.params.bookingId)
      .neq('sender_id', req.userId)
      .is('read_at', null);
    res.json({ count: count || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

module.exports = router;
