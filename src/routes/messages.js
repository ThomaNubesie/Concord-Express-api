const express   = require('express');
const router    = express.Router();
const supabase  = require('../lib/supabase');
const { verifyAuth } = require('../middleware/auth');
const { sendNotification } = require('../lib/notifications');
const Anthropic = require('@anthropic-ai/sdk');

const LANG_NAMES = {
  en:'English', fr:'French', ar:'Arabic', es:'Spanish',
  sw:'Swahili', ha:'Hausa',  wo:'Wolof',  yo:'Yoruba',
};

async function translateMessage(text, toLang) {
  if (!text?.trim()) return null;
  if (toLang === 'wo') toLang = 'fr';
  if (toLang === 'ha') toLang = 'en';
  const targetLangName = LANG_NAMES[toLang] || 'English';
  try {
    const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages:   [{ role:'user', content:
        `Detect the language of this message and translate it to ${targetLangName}. If the message is already in ${targetLangName}, return it unchanged. Reply with ONLY the translated text, no explanation, no quotes:\n\n${text}`
      }],
    });
    const result = msg.content?.[0]?.text?.trim() || null;
    // If result is identical to input, no translation needed
    if (result === text.trim()) return null;
    return result;
  } catch (e) {
    console.error('[translate]', e.message);
    return null;
  }
}

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

    // Always attempt translation to recipient's language (auto-detects source)
    let translatedContent = null;
    if (recipientId) {
      const { data: recipient } = await supabase
        .from('users').select('language').eq('id', recipientId).single();
      const recipientLang = recipient?.language || 'en';
      translatedContent = await translateMessage(content.trim(), recipientLang);
      if (translatedContent) {
        await supabase.from('messages')
          .update({ translated_content: translatedContent })
          .eq('id', message.id);
        message.translated_content = translatedContent;
      }
      await sendNotification({
        userId:    recipientId,
        category:  'messages',
        icon:      '💬',
        title:     `${sender?.full_name || 'Someone'} sent you a message`,
        body:      (translatedContent || content.trim()).slice(0, 80),
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

// ── POST /api/messages/:bookingId/upload ──────────────────────────────────────
const multer  = require('multer');
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/:bookingId/upload', verifyAuth, upload.single('file'), async (req, res) => {
  try {
    const { bookingId }     = req.params;
    const { attachment_type, meta } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    // Verify user is part of booking
    const { data: booking } = await supabase
      .from('bookings')
      .select('passenger_id, trip:trips(driver_id)')
      .eq('id', bookingId).single();
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    const isPassenger = booking.passenger_id === req.userId;
    const isDriver    = booking.trip?.driver_id === req.userId;
    if (!isPassenger && !isDriver) return res.status(403).json({ error: 'Not authorized' });

    // Upload to Supabase Storage
    const ext      = req.file.mimetype.split('/')[1] || 'jpg';
    const path     = `${bookingId}/${req.userId}/${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from('chat-attachments')
      .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (uploadError) throw uploadError;

    const { data: { publicUrl } } = supabase.storage
      .from('chat-attachments')
      .getPublicUrl(path);

    // Save message with attachment
    const parsedMeta = meta ? JSON.parse(meta) : {};
    const { data: message, error } = await supabase
      .from('messages')
      .insert({
        booking_id:      bookingId,
        sender_id:       req.userId,
        content:         parsedMeta.caption || '',
        attachment_type,
        attachment_url:  publicUrl,
        attachment_meta: parsedMeta,
      })
      .select('*, sender:users!messages_sender_id_fkey(id, full_name, avatar_url)')
      .single();
    if (error) throw error;

    // Notify other party
    const recipientId = isPassenger ? booking.trip?.driver_id : booking.passenger_id;
    const { data: sender } = await supabase.from('users').select('full_name').eq('id', req.userId).single();
    if (recipientId) {
      const typeLabel = attachment_type === 'location' ? 'shared a location' : 'sent a photo';
      await sendNotification({
        userId: recipientId, category: 'messages', icon: '📎',
        title:  `${sender?.full_name || 'Someone'} ${typeLabel}`,
        body:   parsedMeta.caption || '',
        relatedId: bookingId,
        actionUrl: `/chat?bookingId=${bookingId}`,
      });
    }

    res.status(201).json({ message, url: publicUrl });
  } catch (err) {
    console.error('[messages upload]', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});
