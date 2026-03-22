const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const { verifyAuth } = require('../middleware/auth');

router.get('/', verifyAuth, async (req, res) => {
  const { data, error } = await supabase.from('notifications')
    .select('*').eq('user_id', req.userId)
    .order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: 'Failed to fetch notifications' });
  res.json({ notifications: data, unread_count: data.filter(n => !n.is_read).length });
});

router.patch('/read-all', verifyAuth, async (req, res) => {
  await supabase.from('notifications').update({ is_read: true }).eq('user_id', req.userId);
  res.json({ success: true });
});

router.patch('/:id/read', verifyAuth, async (req, res) => {
  await supabase.from('notifications').update({ is_read: true }).eq('id', req.params.id).eq('user_id', req.userId);
  res.json({ success: true });
});

router.delete('/:id', verifyAuth, async (req, res) => {
  await supabase.from('notifications').delete().eq('id', req.params.id).eq('user_id', req.userId);
  res.json({ success: true });
});

module.exports = router;
