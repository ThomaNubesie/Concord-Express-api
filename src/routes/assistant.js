const express   = require('express');
const router    = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const supabase  = require('../lib/supabase');
const { verifyAuth } = require('../middleware/auth');

const LANG_FULL = { en:'English', fr:'French', ar:'Arabic', es:'Spanish', sw:'Swahili', ha:'Hausa', wo:'Wolof', yo:'Yoruba' };

// Search trips for assistant
async function searchTripsForAssistant(from, to, date, timeOfDay) {
  try {
    let query = supabase
      .from('trips')
      .select(`
        id, from_city, to_city, departure_at, price_per_seat,
        seats_total, seats_booked, cash_only, status,
        pref_ac, pref_music, pref_quiet_ride,
        driver:users!trips_driver_id_fkey(id, full_name, rating_as_driver, total_trips_driver),
        vehicle:driver_profiles!trips_driver_id_fkey(vehicle_make, vehicle_model, vehicle_year, vehicle_color)
      `)
      .eq('from_city', from)
      .eq('to_city', to)
      .eq('status', 'upcoming')
      .gt('departure_at', new Date().toISOString())
      .order('departure_at', { ascending: true })
      .limit(5);

    if (date) {
      // Use UTC to avoid timezone issues
      const start = new Date(date + 'T00:00:00Z');
      const end   = new Date(date + 'T23:59:59Z');
      query = query.gte('departure_at', start.toISOString()).lte('departure_at', end.toISOString());
    }

    const { data: trips } = await query;
    if (!trips?.length) return [];

    // Filter by time of day
    const TIME_RANGES = {
      morning:   [6,  12],
      afternoon: [12, 17],
      evening:   [17, 21],
      night:     [21, 24],
    };

    return trips.filter(t => {
      if (!timeOfDay || timeOfDay === 'any') return true;
      const h = new Date(t.departure_at).getHours();
      const [s, e] = TIME_RANGES[timeOfDay] || [0, 24];
      return h >= s && h < e;
    }).map((t, i) => ({
      index:       i + 1,
      id:          t.id,
      from:        t.from_city,
      to:          t.to_city,
      departure:   new Date(t.departure_at).toLocaleTimeString('en-CA', { hour:'2-digit', minute:'2-digit', hour12:true }),
      date:        new Date(t.departure_at).toLocaleDateString('en-CA', { weekday:'short', month:'short', day:'numeric' }),
      price:       `C$${t.price_per_seat}`,
      seats_left:  t.seats_total - t.seats_booked,
      driver:      t.driver?.full_name || 'Unknown',
      rating:      t.driver?.rating_as_driver?.toFixed(1) || '5.0',
      trips_done:  t.driver?.total_trips_driver || 0,
      vehicle:     t.vehicle ? `${t.vehicle.vehicle_year} ${t.vehicle.vehicle_make} ${t.vehicle.vehicle_model}` : 'Unknown vehicle',
      payment:     t.cash_only ? 'Cash' : 'Card',
    }));
  } catch (e) {
    console.error('[assistant search]', e);
    return [];
  }
}

const SYSTEM_PROMPT = `You are the ConcordXpress AI assistant — a smart, friendly in-app assistant for a multi-country intercity carpooling platform. You help both drivers and passengers with their trips, packages, earnings, emergencies, and app navigation.

You have access to the user context AND real-time trip search results when provided.

## Your capabilities:
- Search and present available trips with full details
- Navigate to booking screen with a specific trip
- Answer questions about trips, bookings, packages, earnings
- Navigate to any screen in the app
- Initiate emergency calls (911, tow truck, emergency contacts)
- Explain app features in the user language

## When presenting trip search results:
- List each trip clearly: number, time, driver name + rating, vehicle, seats left, price
- Highlight which best matches the user criteria
- Always end with: "Would you like to book any of these? Just say the number."
- If user says "yes" or a number, ask "Which one?" if unclear, then navigate to booking

## Available screens — COMPLETE MAP:

### Driver screens (only for driver role):
- /driver/home — Driver dashboard: upcoming trips, earnings summary, next trip alert
- /driver/post-trip — Post a new trip (or use create_trip action instead)
- /driver/my-trips — All driver trips with earnings breakdown
- /driver/trip-details (needs tripId) — Trip details: passengers, route, manage bookings
- /driver/analytics — Full analytics: earnings charts, traffic conditions, fill rates, payout history
- /driver/payout — Request payout: select trips, choose instant or standard
- /driver/checkin — Check in passengers at pickup
- /driver/rate-passengers — Rate passengers after trip

### Passenger screens (only for passenger role):
- /passenger/home — Passenger dashboard: upcoming bookings, search bar
- /passenger/booking (needs tripId) — Book a specific trip
- /passenger/trip-details (needs tripId) — Booking details, track ride, cancel
- /passenger/package-details (needs packageId) — Track a sent package
- /passenger/checkin-wait — Waiting for driver at pickup

### Shared screens (both roles):
- /search (params: from, to, date, seats) — Search trips by city, date, seats
- /chat (needs bookingId) — Message driver or passenger
- /profile — View/edit profile, vehicle info, quick links
- /settings — App settings: notifications, privacy, language, theme
- /notifications — All notifications
- /payment-methods — Manage payment cards
- /payout-account — Set up payout method (Stripe, Interac, Flutterwave)
- /loyalty — Rewards, referral program, founding member perks
- /send-package — Send a package with a driver
- /edit-trip (needs tripId) — Edit an existing trip (driver only)
- /cancel-trip (needs bookingId or tripId, isDriver) — Cancel a trip or booking
- /dispute (needs bookingId, tripId) — Report an issue with a trip
- /report-problem — Report a general app problem
- /contact-support — Contact support via email or ticket
- /help-centre — FAQ and help articles
- /blocked-users — Manage blocked users
- /change-password — Change account password
- /privacy-policy — Privacy policy
- /terms-of-service — Terms of service
- /driver-verification — Upload insurance and registration docs
- /identity-verification — Verify identity with licence/passport
- /driver-setup — Set up driver profile and vehicle
- /trip-tracking (needs tripId) — Live GPS tracking during trip
- /rating (needs bookingId) — Rate driver after trip
- /alternative-trips (needs tripId) — Find alternative trips after cancellation
- /driver-profile (needs driverId) — View a driver's public profile
- /passenger-profile (needs passengerId) — View a passenger's public profile

### Navigation tips:
- When user asks "show me my earnings" → navigate to /driver/analytics
- When user asks "I want to pay out" → navigate to /driver/payout
- When user asks "show my bookings" → navigate to /passenger/home
- When user asks "change my password" → navigate to /change-password
- When user asks "I need help" → navigate to /help-centre
- When user asks "block someone" → ask WHO they want to block, then navigate to that person's profile (/driver-profile or /passenger-profile) where the block button is. /blocked-users is for MANAGING already blocked users, not for blocking new ones.
- When user asks "update my profile" → navigate to /profile
- When user asks "add a payment card" → navigate to /payment-methods
- When user asks "track my ride" → navigate to /trip-tracking with tripId
- When user asks about a specific trip → navigate to trip-details with tripId
- When user says "message the driver" → find the bookingId and navigate to /chat

## Emergency numbers by country:
- CA/US: 911, UK: 999, FR: 15/17/18, MA: 15/19, Africa: 112

## Response format — ALWAYS valid JSON only:
{
  "speech": "Spoken response (conversational, user language, max 3 sentences for trips)",
  "action": null OR { "type": "navigate", "screen": "/path", "params": {} }
               OR { "type": "call", "number": "911" }
               OR { "type": "search_filter", "from": "ottawa", "to": "montreal", "date": "tomorrow", "timeOfDay": "morning" }
}

## Rules:
- Always respond in user language
- For trip results: be conversational but include key details (time, driver, rating, price, seats, car)
- action type "search_filter" updates the search screen filters without navigating away
- Never make up data — only use context and search results provided
- Always return valid JSON only — no markdown fences, no extra text`;

router.post('/', verifyAuth, async (req, res) => {
  try {
    const { query, context, language, role, history = [], searchContext } = req.body;
    if (!query?.trim()) return res.status(400).json({ error: 'Query required' });

    const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Detect trip search intent and fetch real trips using Claude to parse
    let tripResults = [];
    let tripSearchCtx = '';
    const lq = query.toLowerCase();
    const searchIntent = lq.includes('trip') || lq.includes('ride') || lq.includes('from') ||
      lq.includes('ottawa') || lq.includes('montreal') || lq.includes('toronto') ||
      lq.includes('kingston') || lq.includes('quebec') || lq.includes('cornwall') ||
      lq.includes('find') || lq.includes('book') || lq.includes('travel') ||
      lq.includes('dakar') || lq.includes('nairobi') || lq.includes('accra') ||
      lq.includes('abidjan') || lq.includes('paris') || lq.includes('london');

    if (searchIntent || searchContext) {
      // Use Claude to extract structured search params from natural language
      const today = new Date();
      const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
      
      const extractRes = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Extract trip search parameters from this query. Today is ${today.toISOString().split('T')[0]}, tomorrow is ${tomorrow.toISOString().split('T')[0]}.

Available city IDs: ottawa, montreal, toronto, kingston, cornwall, peterborough, quebec, chicoutimi, moncton, fredericton, vancouver, calgary, edmonton, dakar, abidjan, nairobi, accra, paris, london, casablanca

Query: "${query}"

Respond with JSON only:
{"from":"city_id_or_empty","to":"city_id_or_empty","date":"YYYY-MM-DD_or_empty","timeOfDay":"any|morning|afternoon|evening|night"}`
        }]
      });

      let extracted = { from:'', to:'', date:'', timeOfDay:'any' };
      try {
        const raw = extractRes.content?.[0]?.text?.trim() || '{}';
        const clean = raw.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
        extracted = JSON.parse(clean);
      } catch {}

      const fromCity  = searchContext?.from  || extracted.from  || '';
      const toCity    = searchContext?.to    || extracted.to    || '';
      const dateStr   = searchContext?.date  || extracted.date  || '';
      const timeOfDay = searchContext?.timeOfDay || extracted.timeOfDay || 'any';

      console.log('[Assistant search] from:', fromCity, 'to:', toCity, 'date:', dateStr, 'time:', timeOfDay);
      console.log('[Assistant search] from:', fromCity, 'to:', toCity, 'date:', dateStr, 'time:', timeOfDay);
      if (fromCity && toCity) {
        tripResults = await searchTripsForAssistant(fromCity, toCity, dateStr, timeOfDay);
        if (tripResults.length) {
          tripSearchCtx = `

LIVE TRIP SEARCH RESULTS (${fromCity} → ${toCity}${dateStr ? ' on ' + dateStr : ''}${timeOfDay !== 'any' ? ' ' + timeOfDay : ''}):
${JSON.stringify(tripResults, null, 2)}

Total: ${tripResults.length} trip(s) found.`;
        } else {
          tripSearchCtx = `

No trips found for ${fromCity} → ${toCity}${dateStr ? ' on ' + dateStr : ''}.`;
        }
      }
    }

    const msgs = [
      ...history.map((m) => ({
        role:    m.role === 'user' ? 'user' : 'assistant',
        content: m.text,
      })),
      {
        role:    'user',
        content: `User context:
${context}${tripSearchCtx}

User query: ${query}`,
      },
    ];

    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system:     SYSTEM_PROMPT + 
        '\n\nIMPORTANT: This user is a ' + (role || 'passenger').toUpperCase() + '. ' +
        (role === 'driver'
          ? 'Focus on driver features: posting trips, managing bookings, earnings, payouts, passenger approvals, trip tracking. You can help them post trips by collecting details. When they ask about trips, show THEIR posted trips not search results.'
          : 'Focus on passenger features: finding trips, booking, tracking, packages, payments. When they ask about trips, search for available trips to book.') +
        '\n\nLANGUAGE: You MUST respond in ' + (LANG_FULL[language] || 'English') + '. Every word of your speech response must be in ' + (LANG_FULL[language] || 'English') + '. This includes greetings, trip details, questions, confirmations — everything. The only exceptions are proper nouns (city names, app name ConcordXpress, brand names).',
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
      speech:      parsed.speech || "I didn't understand that. Please try again.",
      action:      parsed.action || null,
      tripResults: tripResults.length ? tripResults : undefined,
    });
  } catch (err) {
    console.error('[assistant]', err);
    res.status(500).json({ speech: "Sorry, I'm having trouble right now.", action: null });
  }
});

module.exports = router;
