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

// POST /api/driver/vehicle — save vehicle info
router.post('/vehicle', verifyAuth, async (req, res) => {
  const {
    vehicle_make, vehicle_model, vehicle_year, vehicle_color,
    vehicle_plate, vehicle_province, vehicle_seats, vehicle_image_url,
  } = req.body;
  const { error } = await supabase.from('driver_profiles').upsert({
    user_id: req.userId,
    vehicle_make, vehicle_model, vehicle_year, vehicle_color,
    vehicle_plate, vehicle_province, vehicle_seats, vehicle_image_url,
  }, { onConflict: 'user_id' });
  if (error) return res.status(500).json({ error: 'Failed to save vehicle info' });
  res.json({ success: true });
});

// POST /api/driver/fee — record driver fee payment
router.post('/fee', verifyAuth, async (req, res) => {
  const { payment_intent_id, amount } = req.body;
  try {
    // Check founding member count
    const { data: config } = await supabase
      .from('app_config').select('value').eq('key', 'founding_driver_count').single();
    const count = parseInt(config?.value || '0');
    const isFounder = count < 100;
    const now = new Date();
    const expires = new Date(now);
    expires.setFullYear(expires.getFullYear() + 1);

    const { error } = await supabase.from('driver_profiles').upsert({
      user_id:            req.userId,
      fee_paid:           true,
      fee_paid_at:        now.toISOString(),
      fee_expires_at:     expires.toISOString(),
      fee_amount:         amount,
      is_founding_member: isFounder,
      driver_status:      'pending',
    }, { onConflict: 'user_id' });
    if (error) return res.status(500).json({ error: 'Failed to record fee' });

    // Increment founding count if founder
    if (isFounder) {
      await supabase.from('app_config')
        .update({ value: String(count + 1) })
        .eq('key', 'founding_driver_count');
    }
    res.json({ success: true, is_founding_member: isFounder, founding_count: count + 1 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process fee' });
  }
});

// GET /api/driver/founding-count — get current founding member count
router.get('/founding-count', async (req, res) => {
  const { data } = await supabase
    .from('app_config').select('value').eq('key', 'founding_driver_count').single();
  res.json({ count: parseInt(data?.value || '0'), limit: 100 });
});

router.get('/verification', verifyAuth, async (req, res) => {
  const { data, error } = await supabase.from('driver_profiles').select('*').eq('user_id', req.userId).single();
  if (error) return res.json({ profile: null });
  res.json({ profile: data });
});

router.get('/analytics', verifyAuth, async (req, res) => {
  try {
    const { period = 'week' } = req.query;
    const now = new Date(); const startDate = new Date();
    if (period === 'week')  startDate.setDate(now.getDate() - 7);
    if (period === 'month') startDate.setDate(now.getDate() - 30);
    if (period === 'year')  startDate.setFullYear(now.getFullYear() - 1);

    // Get completed trips driven by this driver in period
    const { data: trips, error: tripsErr } = await supabase
      .from('trips')
      .select('id, departure_at, bookings(id, fare_amount, seats, status)')
      .eq('driver_id', req.userId)
      .in('status', ['completed', 'active'])
      .gte('departure_at', startDate.toISOString());
    if (tripsErr) throw tripsErr;

    // Get package earnings for same trips
    const tripIds = (trips || []).map(t => t.id);
    let pkgEarnings = 0;
    if (tripIds.length) {
      const { data: pkgs } = await supabase
        .from('packages')
        .select('price, status')
        .in('trip_id', tripIds)
        .neq('status', 'cancelled');
      pkgEarnings = (pkgs || []).reduce((s, p) => s + parseFloat(p.price || 0) * 0.75, 0);
    }

    // Get all-time trip count
    const { count: allTimeTrips } = await supabase
      .from('trips')
      .select('id', { count: 'exact', head: true })
      .eq('driver_id', req.userId)
      .eq('status', 'completed');

    let gross = 0, passengers = 0, uniqueTrips = 0;
    for (const trip of trips || []) {
      const completedBookings = (trip.bookings || []).filter(b =>
        ['confirmed', 'active', 'completed'].includes(b.status)
      );
      if (completedBookings.length > 0 || true) uniqueTrips++;
      for (const b of completedBookings) {
        gross += parseFloat(b.fare_amount || 0);
        passengers += b.seats || 1;
      }
    }
    gross += pkgEarnings;
    const net = gross * 0.9;

    // Build daily earnings breakdown
    const dailyMap = {};
    for (const trip of trips || []) {
      const day = trip.departure_at?.slice(0, 10);
      if (!day) continue;
      for (const b of (trip.bookings || []).filter((b) => ['confirmed','active','completed'].includes(b.status))) {
        dailyMap[day] = (dailyMap[day] || 0) + parseFloat(b.fare_amount || 0) * 0.9;
      }
    }
    const daily = Object.entries(dailyMap).map(([date, amount]) => ({ date, amount: +amount.toFixed(2) })).sort((a,b) => a.date.localeCompare(b.date));

    // Get ratings breakdown
    const { data: ratings } = await supabase.from('ratings').select('stars').eq('rated_user_id', req.userId);
    const ratingBreakdown = [5,4,3,2,1].map(s => ({
      stars: s,
      count: (ratings || []).filter((r) => r.stars === s).length,
    }));
    const avgRating = ratings?.length ? (ratings.reduce((s,r) => s+r.stars, 0) / ratings.length).toFixed(1) : '5.0';

    // Get cancellation count
    const { count: cancelCount } = await supabase.from('trips').select('id', { count:'exact', head:true })
      .eq('driver_id', req.userId).eq('status', 'cancelled');

    // Get package stats
    const { data: pkgStats } = await supabase.from('packages')
      .select('status, price').in('trip_id', tripIds.length ? tripIds : ['00000000-0000-0000-0000-000000000000']);
    const pkgDelivered = (pkgStats || []).filter((p) => p.status === 'delivered').length;
    const pkgPending   = (pkgStats || []).filter((p) => p.status === 'in_transit').length;

    // Get pending balance
    const { data: dp } = await supabase.from('driver_profiles').select('pending_balance, total_paid_out').eq('user_id', req.userId).single();

    res.json({
      gross, net, trips: uniqueTrips, passengers, pkg_earnings: pkgEarnings,
      all_time_trips: allTimeTrips || 0, daily, rating_breakdown: ratingBreakdown,
      avg_rating: avgRating, cancellation_count: cancelCount || 0,
      pkg_delivered: pkgDelivered, pkg_pending: pkgPending,
      pending_balance: dp?.pending_balance || 0,
      total_paid_out: dp?.total_paid_out || 0,
    });
  } catch (err) {
    console.error('[analytics]', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// POST /api/driver/location — Update driver location
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

// GET /api/driver/location/:tripId — Get driver's current location for a trip
router.get('/location/:tripId', verifyAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('driver_locations')
      .select('*')
      .eq('trip_id', req.params.tripId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (error) return res.json({ location: null });
    res.json({ location: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch location' });
  }
});

// GET /api/driver/traffic-conditions — real traffic data for a route by hour
router.get('/traffic-conditions', verifyAuth, async (req, res) => {
  try {
    const { from_city, to_city } = req.query;
    if (!from_city || !to_city) return res.status(400).json({ error: 'from_city and to_city required' });

    const CITY_COORDS = {
      ottawa:       { lat: 45.4215,  lng: -75.6972 },
      toronto:      { lat: 43.6532,  lng: -79.3832 },
      montreal:     { lat: 45.5017,  lng: -73.5673 },
      kingston:     { lat: 44.2312,  lng: -76.4860 },
      cornwall:     { lat: 45.0182,  lng: -74.7266 },
      peterborough: { lat: 44.3091,  lng: -78.3197 },
      quebec:       { lat: 46.8139,  lng: -71.2080 },
      chicoutimi:   { lat: 48.4279,  lng: -71.0683 },
      moncton:      { lat: 46.0878,  lng: -64.7782 },
      fredericton:  { lat: 45.9636,  lng: -66.6431 },
    };

    const from = CITY_COORDS[from_city.toLowerCase()];
    const to   = CITY_COORDS[to_city.toLowerCase()];
    if (!from || !to) return res.status(400).json({ error: 'Unknown city' });

    const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;

    // Fetch current route with traffic
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${from.lng},${from.lat};${to.lng},${to.lat}?access_token=${MAPBOX_TOKEN}&annotations=duration,congestion&overview=full&geometries=geojson`;
    const response = await fetch(url);
    const data = await response.json();
    const route = data.routes?.[0];

    if (!route) return res.status(404).json({ error: 'No route found' });

    // Get typical duration (no traffic)
    const typicalUrl = `https://api.mapbox.com/directions/v5/mapbox/driving/${from.lng},${from.lat};${to.lng},${to.lat}?access_token=${MAPBOX_TOKEN}&overview=none`;
    const typicalRes = await fetch(typicalUrl);
    const typicalData = await typicalRes.json();
    const typicalDuration = typicalData.routes?.[0]?.duration || route.duration;

    // Congestion summary from leg annotations
    const congestion = route.legs?.[0]?.annotation?.congestion || [];
    const congestionCounts = { unknown:0, low:0, moderate:0, heavy:0, severe:0 };
    congestion.forEach(c => { if (congestionCounts[c] !== undefined) congestionCounts[c]++; });
    const totalSegments = congestion.length || 1;
    const congestionScore = (
      (congestionCounts.low * 1 + congestionCounts.moderate * 2 +
       congestionCounts.heavy * 3 + congestionCounts.severe * 4) / totalSegments
    ).toFixed(2);

    const delayMins = Math.round((route.duration - typicalDuration) / 60);
    const congestionLevel =
      parseFloat(congestionScore) < 1 ? 'clear' :
      parseFloat(congestionScore) < 2 ? 'light' :
      parseFloat(congestionScore) < 3 ? 'moderate' : 'heavy';

    // Get trip fill rate data for this route from DB
    const { data: routeTrips } = await supabase
      .from('trips')
      .select('departure_at, seats_total, seats_booked, bookings(status)')
      .eq('from_city', from_city.toLowerCase())
      .eq('to_city', to_city.toLowerCase())
      .eq('status', 'completed')
      .gte('departure_at', new Date(Date.now() - 90*24*60*60*1000).toISOString());

    // Fill rate by hour from historical data
    const hourlyFill = new Array(24).fill(null).map(() => ({ trips:0, booked:0, seats:0 }));
    for (const trip of routeTrips || []) {
      const h = new Date(trip.departure_at).getHours();
      const confirmed = (trip.bookings||[]).filter(b => ['confirmed','active','completed'].includes(b.status)).length;
      hourlyFill[h].trips++;
      hourlyFill[h].booked += confirmed;
      hourlyFill[h].seats  += trip.seats_total || 0;
    }

    const hourlyStats = hourlyFill.map((h, hour) => ({
      hour,
      label: hour === 0 ? '12am' : hour < 12 ? `${hour}am` : hour === 12 ? '12pm' : `${hour-12}pm`,
      fill_rate: h.seats > 0 ? Math.round((h.booked/h.seats)*100) : null,
      trip_count: h.trips,
    }));

    // Best times recommendation
    const bestTimes = hourlyStats
      .filter(h => h.trip_count >= 2 && h.fill_rate !== null)
      .sort((a,b) => (b.fill_rate||0) - (a.fill_rate||0))
      .slice(0,3)
      .map(h => h.label);

    res.json({
      route: { from: from_city, to: to_city },
      current_traffic: {
        duration_mins: Math.round(route.duration / 60),
        typical_mins:  Math.round(typicalDuration / 60),
        delay_mins:    Math.max(0, delayMins),
        congestion_level: congestionLevel,
        congestion_score: congestionScore,
        distance_km: Math.round(route.distance / 1000),
      },
      congestion_breakdown: {
        clear:    Math.round((congestionCounts.unknown + congestionCounts.low) / totalSegments * 100),
        moderate: Math.round(congestionCounts.moderate / totalSegments * 100),
        heavy:    Math.round((congestionCounts.heavy + congestionCounts.severe) / totalSegments * 100),
      },
      hourly_fill_rate: hourlyStats,
      best_departure_times: bestTimes,
      historical_trips: (routeTrips||[]).length,
    });
  } catch (err) {
    console.error('[traffic-conditions]', err);
    res.status(500).json({ error: 'Failed to fetch traffic data' });
  }
});

// GET /api/driver/platform-insights — platform-wide traffic analytics
router.get('/platform-insights', verifyAuth, async (req, res) => {
  try {
    // Get all completed trips from last 90 days
    const since = new Date();
    since.setDate(since.getDate() - 90);

    const { data: trips } = await supabase
      .from('trips')
      .select('id, from_city, to_city, departure_at, seats_total, seats_booked, bookings(id, status)')
      .in('status', ['completed', 'active'])
      .gte('departure_at', since.toISOString());

    if (!trips || trips.length === 0) {
      return res.json({
        hourly: [], daily: [], routes: [], fill_rate_by_hour: [],
        best_hours: [], best_days: [], insights: []
      });
    }

    // ── Hourly demand (0–23) ─────────────────────────────────────────────
    const hourlyCount  = new Array(24).fill(0);
    const hourlyBooked = new Array(24).fill(0);
    const hourlySeats  = new Array(24).fill(0);
    const dailyCount   = new Array(7).fill(0);  // 0=Sun
    const dailyBooked  = new Array(7).fill(0);
    const routeMap     = {};

    for (const trip of trips) {
      const dep = new Date(trip.departure_at);
      const hour = dep.getHours();
      const day  = dep.getDay();
      const confirmed = (trip.bookings || []).filter(b =>
        ['confirmed','active','completed'].includes(b.status)
      ).length;

      hourlyCount[hour]++;
      hourlyBooked[hour] += confirmed;
      hourlySeats[hour]  += trip.seats_total || 0;
      dailyCount[day]++;
      dailyBooked[day]   += confirmed;

      // Route popularity
      const routeKey = `${trip.from_city}→${trip.to_city}`;
      if (!routeMap[routeKey]) routeMap[routeKey] = { route: routeKey, from: trip.from_city, to: trip.to_city, trips: 0, booked: 0, seats: 0 };
      routeMap[routeKey].trips++;
      routeMap[routeKey].booked += confirmed;
      routeMap[routeKey].seats  += trip.seats_total || 0;
    }

    // Build hourly data with fill rate
    const hourly = hourlyCount.map((count, h) => ({
      hour: h,
      label: h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h-12}pm`,
      trips: count,
      fill_rate: hourlySeats[h] > 0 ? Math.round((hourlyBooked[h] / hourlySeats[h]) * 100) : 0,
      avg_booked: count > 0 ? +(hourlyBooked[h] / count).toFixed(1) : 0,
    }));

    // Build daily data
    const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const daily = dailyCount.map((count, d) => ({
      day: d, label: DAY_NAMES[d], trips: count,
      fill_rate: dailyBooked[d] > 0 && count > 0 ? Math.round((dailyBooked[d] / count) * 10) / 10 : 0,
    }));

    // Top routes by fill rate
    const routes = Object.values(routeMap)
      .map((r) => ({
        ...r,
        fill_rate: r.seats > 0 ? Math.round((r.booked / r.seats) * 100) : 0,
      }))
      .sort((a, b) => b.trips - a.trips)
      .slice(0, 10);

    // Best hours (top 5 by fill rate, min 3 trips)
    const best_hours = [...hourly]
      .filter(h => h.trips >= 3)
      .sort((a, b) => b.fill_rate - a.fill_rate)
      .slice(0, 5)
      .map(h => h.label);

    // Best days
    const best_days = [...daily]
      .filter(d => d.trips >= 3)
      .sort((a, b) => b.fill_rate - a.fill_rate)
      .slice(0, 3)
      .map(d => d.label);

    // Human-readable insights
    const insights = [];
    if (best_hours.length) insights.push(`🕐 Best departure times: ${best_hours.slice(0,3).join(', ')}`);
    if (best_days.length)  insights.push(`📅 Busiest days: ${best_days.join(', ')}`);
    const topRoute = routes[0];
    if (topRoute) insights.push(`🔥 Most popular route: ${topRoute.from} → ${topRoute.to} (${topRoute.fill_rate}% fill rate)`);
    const peakHour = hourly.reduce((a, b) => b.trips > a.trips ? b : a, hourly[0]);
    if (peakHour?.trips > 0) insights.push(`⚡ Peak hour: ${peakHour.label} (${peakHour.trips} trips)`);

    res.json({ hourly, daily, routes, best_hours, best_days, insights, total_trips: trips.length });
  } catch (err) {
    console.error('[platform-insights]', err);
    res.status(500).json({ error: 'Failed to fetch insights' });
  }
});

module.exports = router;

// POST /api/driver/support/ticket
router.post('/support/ticket', verifyAuth, async (req, res) => {
  try {
    const { category, subject, message } = req.body;
    if (!subject || !message) return res.status(400).json({ error: 'Subject and message required' });
    const { data: user } = await supabase.from('users').select('full_name, email, phone').eq('id', req.userId).single();
    await supabase.from('support_tickets').insert({
      user_id: req.userId, category, subject, message,
      user_name: user?.full_name, user_email: user?.email,
    }).select();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed to submit ticket' }); }
});

// POST /api/driver/support/report
router.post('/support/report', verifyAuth, async (req, res) => {
  try {
    const { type, severity, description, trip_id } = req.body;
    if (!description) return res.status(400).json({ error: 'Description required' });
    await supabase.from('problem_reports').insert({
      user_id: req.userId, type, severity, description, trip_id: trip_id || null,
    }).select();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed to submit report' }); }
});
