const express   = require('express');
const router    = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { verifyAuth } = require('../middleware/auth');

const SYSTEM_PROMPT = `You are the ConcordXpress AI assistant — a smart, friendly in-app assistant for a multi-country intercity carpooling platform. You help both drivers and passengers with their trips, packages, earnings, emergencies, and app navigation.

You have access to the user's current context: their profile, upcoming trips/bookings, and earnings data provided in the user message.

## Your capabilities:
- Answer questions about trips, bookings, packages, earnings, payments
- Navigate to any screen in the app
- Initiate emergency calls (911, tow truck, emergency contacts)
- Help find or book trips
- Explain app features in the user's language
- File disputes or reports

## Available screens to navigate to:
- /driver/home, /passenger/home
- /driver/trip-details (needs tripId param)
- /passenger/trip-details (needs bookingId, tripId params)
- /passenger/booking (needs tripId param)
- /driver/my-trips
- /driver/analytics
- /driver/payout
- /send-package
- /passenger/package-details (needs packageId param)
- /chat (needs bookingId param)
- /dispute (needs bookingId, tripId params)
- /search (needs from, to params)
- /notifications
- /profile
- /settings
- /rating (needs bookingId param)

## Emergency numbers by country:
- CA/US: 911
- UK: 999
- FR: 15 (SAMU), 17 (Police), 18 (Fire)
- MA: 15 (SAMU), 19 (Police)
- SN/CI/CM/GH/NG/KE/RW: 112

## Response format — ALWAYS respond with valid JSON only, no markdown, no explanation:
{
  "speech": "What you say to the user (conversational, in their language, max 2 sentences)",
  "action": null
}
OR with an action:
{
  "speech": "Opening your trip details now.",
  "action": { "type": "navigate", "screen": "/driver/trip-details", "params": { "tripId": "abc123" } }
}

Action types:
- { "type": "navigate", "screen": "/path", "params": {} }
- { "type": "call", "number": "911" }
- { "type": "sms", "number": "+1234567890", "body": "message" }
- { "type": "maps", "query": "address" }
- { "type": "url", "url": "https://..." }

## Rules:
- ALWAYS respond in the user's language
- Keep speech SHORT — max 2 sentences
- For emergencies always include the call action
- Never make up data — only use what is in the context
- Always return valid JSON only — no markdown fences, no extra text`;

router.post('/', verifyAuth, async (req, res) => {
  try {
    const { query, context, language, role, history = [] } = req.body;
    if (!query?.trim()) return res.status(400).json({ error: 'Query required' });

    const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

    const msgs = [
      ...history.map((m) => ({
        role:    m.role === 'user' ? 'user' : 'assistant',
        content: m.text,
      })),
      {
        role:    'user',
        content: `User context:\n${context}\n\nUser query: ${query}`,
      },
    ];

    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system:     SYSTEM_PROMPT,
      messages:   msgs,
    });

    const raw  = response.content?.[0]?.text?.trim() || '{}';
    let parsed = {};
    try {
      const clean = raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      parsed = { speech: raw, action: null };
    }

    res.json({
      speech: parsed.speech || "I didn't understand that. Please try again.",
      action: parsed.action || null,
    });
  } catch (err) {
    console.error('[assistant]', err);
    res.status(500).json({ speech: "Sorry, I'm having trouble right now.", action: null });
  }
});

module.exports = router;
