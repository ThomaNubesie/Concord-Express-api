const supabase = require('./supabase');

async function sendPushNotification(userId, { title, body, data = {}, sound = 'default' }) {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('push_token')
      .eq('id', userId)
      .single();

    if (!user?.push_token) return;

    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: user.push_token,
        title,
        body,
        data,
        sound,
      }),
    });

    const result = await res.json();
    if (result.data?.status === 'error') {
      console.error('[Push] Failed:', result.data.message);
    }
  } catch (err) {
    console.error('[Push] Error:', err.message);
  }
}

async function sendPushToMultiple(userIds, notification) {
  await Promise.allSettled(
    userIds.map(id => sendPushNotification(id, notification))
  );
}

module.exports = { sendPushNotification, sendPushToMultiple };
