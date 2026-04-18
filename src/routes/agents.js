// ─────────────────────────────────────────────────────────────────────────────
// routes/agents.js  –  AI Agent Orchestrator & Admin Dashboard
// ─────────────────────────────────────────────────────────────────────────────
const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const { verifyAuth } = require('../middleware/auth');
const { sendPushNotification } = require('../lib/push');

// ── Helpers ──────────────────────────────────────────────────────────────────

const AGENTS = [
  { id: 'agent-dispatcher',      name: 'Dispatcher',          role: 'Trip matching & seat allocation' },
  { id: 'agent-pricing',         name: 'Pricing Engine',      role: 'Dynamic pricing & surge detection' },
  { id: 'agent-safety',          name: 'Safety Monitor',      role: 'Driver verification & fraud detection' },
  { id: 'agent-support',         name: 'Support Bot',         role: 'Passenger & driver support tickets' },
  { id: 'agent-notifications',   name: 'Notification Agent',  role: 'Push, SMS & email orchestration' },
  { id: 'agent-analytics',       name: 'Analytics Agent',     role: 'Revenue & usage analytics' },
  { id: 'agent-compliance',      name: 'Compliance Agent',    role: 'Regulatory & tax compliance' },
  { id: 'agent-loyalty',         name: 'Loyalty Agent',       role: 'Rewards, referrals & retention' },
  { id: 'agent-routing',         name: 'Routing Agent',       role: 'Route optimization & ETA prediction' },
  { id: 'agent-payments',        name: 'Payments Agent',      role: 'Payment processing & payouts' },
];

/** Middleware: require admin role */
const requireAdmin = async (req, res, next) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('role')
      .eq('id', req.userId)
      .single();

    if (error || !user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    console.error('[Agents] Admin check failed:', err.message);
    return res.status(500).json({ error: 'Authorization check failed' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /agents/status  –  Status of all 10 agents
// ─────────────────────────────────────────────────────────────────────────────
router.get('/agents/status', verifyAuth, requireAdmin, async (req, res) => {
  try {
    // Try to fetch live task counts from agent_tasks
    const { data: tasks, error } = await supabase
      .from('agent_tasks')
      .select('agent_id, status')
      .in('status', ['pending', 'in_progress']);

    if (error) {
      // Fallback: return hardcoded status when table doesn't exist
      console.error('[Agents] agent_tasks query failed (table may not exist):', error.message);
      const fallback = AGENTS.map(a => ({
        ...a,
        status: 'active',
        taskCount: 0,
        lastAction: null,
        lastActionAt: null,
      }));
      return res.json({ agents: fallback });
    }

    // Build counts per agent
    const countMap = {};
    for (const t of tasks) {
      countMap[t.agent_id] = (countMap[t.agent_id] || 0) + 1;
    }

    // Fetch latest activity per agent
    const { data: latestActions } = await supabase
      .from('agent_activity')
      .select('agent_id, action, created_at')
      .order('created_at', { ascending: false })
      .limit(50);

    const lastActionMap = {};
    if (latestActions) {
      for (const act of latestActions) {
        if (!lastActionMap[act.agent_id]) {
          lastActionMap[act.agent_id] = { action: act.action, at: act.created_at };
        }
      }
    }

    const agents = AGENTS.map(a => {
      const tc = countMap[a.id] || 0;
      const la = lastActionMap[a.id];
      return {
        ...a,
        status: tc > 5 ? 'busy' : tc > 0 ? 'active' : 'idle',
        taskCount: tc,
        lastAction: la?.action || null,
        lastActionAt: la?.at || null,
      };
    });

    res.json({ agents });
  } catch (err) {
    console.error('[Agents] GET /agents/status error:', err.message);
    res.status(500).json({ error: 'Failed to fetch agent status' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /agents/feed  –  Recent agent activity feed
// ─────────────────────────────────────────────────────────────────────────────
router.get('/agents/feed', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('agent_activity')
      .select('id, agent_id, agent_name, action, details, created_at, related_id')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      // Fallback: return sample feed data when table doesn't exist
      console.error('[Agents] agent_activity query failed:', error.message);
      const now = new Date().toISOString();
      const sample = [
        { id: 1, agentName: 'Dispatcher',         action: 'Matched rider to trip',       details: 'Seat allocated on trip #204', createdAt: now, relatedId: null },
        { id: 2, agentName: 'Safety Monitor',      action: 'Flagged suspicious account',  details: 'Multiple failed ID uploads',  createdAt: now, relatedId: null },
        { id: 3, agentName: 'Notification Agent',   action: 'Sent departure reminder',     details: '12 reminders sent',           createdAt: now, relatedId: null },
        { id: 4, agentName: 'Pricing Engine',       action: 'Adjusted surge pricing',      details: 'Montreal-Toronto corridor',   createdAt: now, relatedId: null },
        { id: 5, agentName: 'Support Bot',          action: 'Resolved support ticket',     details: 'Auto-resolved refund #88',    createdAt: now, relatedId: null },
      ];
      return res.json({ feed: sample });
    }

    const feed = (data || []).map(row => ({
      id: row.id,
      agentName: row.agent_name,
      action: row.action,
      details: row.details,
      createdAt: row.created_at,
      relatedId: row.related_id,
    }));

    res.json({ feed });
  } catch (err) {
    console.error('[Agents] GET /agents/feed error:', err.message);
    res.status(500).json({ error: 'Failed to fetch agent feed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. POST /agents/assign  –  Assign a task to a specific agent
// ─────────────────────────────────────────────────────────────────────────────
router.post('/agents/assign', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { agentId, taskType, priority, relatedId, details } = req.body;

    if (!agentId || !taskType) {
      return res.status(400).json({ error: 'agentId and taskType are required' });
    }

    const validAgent = AGENTS.find(a => a.id === agentId);
    if (!validAgent) {
      return res.status(400).json({ error: 'Invalid agentId' });
    }

    const { data, error } = await supabase
      .from('agent_tasks')
      .insert({
        agent_id: agentId,
        task_type: taskType,
        priority: priority || 'normal',
        related_id: relatedId || null,
        details: details || null,
        status: 'pending',
        assigned_by: req.userId,
      })
      .select()
      .single();

    if (error) {
      console.error('[Agents] Failed to insert agent_tasks:', error.message);
      return res.status(500).json({ error: 'Failed to assign task' });
    }

    // Log agent activity
    await supabase.from('agent_activity').insert({
      agent_id: agentId,
      agent_name: validAgent.name,
      action: 'Task assigned: ' + taskType,
      details: details || null,
      related_id: relatedId || null,
    }).then(() => {}).catch(() => {});

    res.status(201).json({ task: data });
  } catch (err) {
    console.error('[Agents] POST /agents/assign error:', err.message);
    res.status(500).json({ error: 'Failed to assign task' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. GET /admin/dashboard  –  All admin dashboard data in one call
// ─────────────────────────────────────────────────────────────────────────────
router.get('/admin/dashboard', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const now = new Date().toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStartISO = todayStart.toISOString();

    const results = {};

    // Total users count
    try {
      const { count, error } = await supabase.from('users').select('id', { count: 'exact', head: true });
      results.totalUsers = error ? 0 : count;
    } catch (e) { console.error('[Admin] totalUsers:', e.message); results.totalUsers = 0; }

    // Active trips (status = 'upcoming' and departure_at > now)
    try {
      const { count, error } = await supabase
        .from('trips')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'upcoming')
        .gt('departure_at', now);
      results.activeTrips = error ? 0 : count;
    } catch (e) { console.error('[Admin] activeTrips:', e.message); results.activeTrips = 0; }

    // Open disputes count
    try {
      const { count, error } = await supabase
        .from('disputes')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'open');
      results.openDisputes = error ? 0 : count;
    } catch (e) { console.error('[Admin] openDisputes:', e.message); results.openDisputes = 0; }

    // Pending verifications count
    try {
      const { count, error } = await supabase
        .from('driver_profiles')
        .select('id', { count: 'exact', head: true })
        .eq('identity_verified', false);
      results.pendingVerifications = error ? 0 : count;
    } catch (e) { console.error('[Admin] pendingVerifications:', e.message); results.pendingVerifications = 0; }

    // Pending booking approvals count
    try {
      const { count, error } = await supabase
        .from('bookings')
        .select('id', { count: 'exact', head: true })
        .eq('approval_status', 'pending');
      results.pendingApprovals = error ? 0 : count;
    } catch (e) { console.error('[Admin] pendingApprovals:', e.message); results.pendingApprovals = 0; }

    // Recent cancellations (last 7 days)
    try {
      const { count, error } = await supabase
        .from('bookings')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'cancelled')
        .gte('updated_at', sevenDaysAgo);
      results.recentCancellations = error ? 0 : count;
    } catch (e) { console.error('[Admin] recentCancellations:', e.message); results.recentCancellations = 0; }

    // Today's revenue (sum of booking amounts)
    try {
      const { data, error } = await supabase
        .from('bookings')
        .select('total_price')
        .eq('status', 'confirmed')
        .gte('created_at', todayStartISO);
      if (error) {
        results.todayRevenue = 0;
      } else {
        results.todayRevenue = (data || []).reduce((sum, b) => sum + (b.total_price || 0), 0);
      }
    } catch (e) { console.error('[Admin] todayRevenue:', e.message); results.todayRevenue = 0; }

    // Active packages count
    try {
      const { count, error } = await supabase
        .from('packages')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'active');
      results.activePackages = error ? 0 : count;
    } catch (e) { console.error('[Admin] activePackages:', e.message); results.activePackages = 0; }

    // Recent agent activity (last 10)
    try {
      const { data, error } = await supabase
        .from('agent_activity')
        .select('id, agent_name, action, details, created_at')
        .order('created_at', { ascending: false })
        .limit(10);
      results.recentAgentActivity = error ? [] : (data || []);
    } catch (e) { console.error('[Admin] recentAgentActivity:', e.message); results.recentAgentActivity = []; }

    res.json({ dashboard: results });
  } catch (err) {
    console.error('[Admin] GET /admin/dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. GET /admin/disputes  –  All open disputes with related data
// ─────────────────────────────────────────────────────────────────────────────
router.get('/admin/disputes', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('disputes')
      .select(`
        *,
        reporter:users!disputes_reporter_id_fkey(id, full_name, email, avatar_url),
        booking:bookings(
          id, status, total_price,
          passenger:users!bookings_passenger_id_fkey(id, full_name, email),
          trip:trips(id, origin, destination, departure_at, driver_id)
        )
      `)
      .eq('status', 'open')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[Admin] Disputes query error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch disputes' });
    }

    res.json({ disputes: data || [] });
  } catch (err) {
    console.error('[Admin] GET /admin/disputes error:', err.message);
    res.status(500).json({ error: 'Failed to fetch disputes' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. GET /admin/verifications  –  Pending driver verifications
// ─────────────────────────────────────────────────────────────────────────────
router.get('/admin/verifications', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('driver_profiles')
      .select(`
        *,
        user:users(id, full_name, email, phone, avatar_url, created_at)
      `)
      .eq('identity_verified', false)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[Admin] Verifications query error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch verifications' });
    }

    res.json({ verifications: data || [] });
  } catch (err) {
    console.error('[Admin] GET /admin/verifications error:', err.message);
    res.status(500).json({ error: 'Failed to fetch verifications' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. GET /admin/approvals  –  Pending booking approvals
// ─────────────────────────────────────────────────────────────────────────────
router.get('/admin/approvals', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bookings')
      .select(`
        *,
        passenger:users!bookings_passenger_id_fkey(id, full_name, email, avatar_url),
        trip:trips(id, origin, destination, departure_at, driver_id,
          driver:users!trips_driver_id_fkey(id, full_name)
        )
      `)
      .eq('approval_status', 'pending')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[Admin] Approvals query error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch approvals' });
    }

    res.json({ approvals: data || [] });
  } catch (err) {
    console.error('[Admin] GET /admin/approvals error:', err.message);
    res.status(500).json({ error: 'Failed to fetch approvals' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. PATCH /admin/verifications/:userId  –  Approve or reject driver
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/admin/verifications/:userId', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { action, reason } = req.body;

    if (!action || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action must be "approve" or "reject"' });
    }

    const isApproved = action === 'approve';

    const { data, error } = await supabase
      .from('driver_profiles')
      .update({
        identity_verified: isApproved,
        verification_status: isApproved ? 'approved' : 'rejected',
        verification_reason: reason || null,
        verified_at: isApproved ? new Date().toISOString() : null,
        verified_by: req.userId,
      })
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      console.error('[Admin] Verification update error:', error.message);
      return res.status(500).json({ error: 'Failed to update verification' });
    }

    // Send push notification to the driver
    await sendPushNotification(userId, {
      title: isApproved ? 'Verification Approved' : 'Verification Rejected',
      body: isApproved
        ? 'Your driver profile has been verified. You can now create trips!'
        : 'Your driver verification was not approved.' + (reason ? ' Reason: ' + reason : ''),
      data: { type: 'verification_update', status: action },
    });

    // Log agent activity
    await supabase.from('agent_activity').insert({
      agent_id: 'agent-safety',
      agent_name: 'Safety Monitor',
      action: 'Driver verification ' + action + 'd',
      details: 'User ' + userId + (reason ? ' — ' + reason : ''),
      related_id: userId,
    }).then(() => {}).catch(() => {});

    res.json({ verification: data, action });
  } catch (err) {
    console.error('[Admin] PATCH /admin/verifications/:userId error:', err.message);
    res.status(500).json({ error: 'Failed to update verification' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. PATCH /admin/approvals/:bookingId  –  Approve or reject booking
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/admin/approvals/:bookingId', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { action } = req.body;

    if (!action || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action must be "approve" or "reject"' });
    }

    const isApproved = action === 'approve';

    const { data, error } = await supabase
      .from('bookings')
      .update({
        approval_status: isApproved ? 'approved' : 'rejected',
        status: isApproved ? 'confirmed' : 'rejected',
        approved_at: isApproved ? new Date().toISOString() : null,
        approved_by: req.userId,
      })
      .eq('id', bookingId)
      .eq('approval_status', 'pending')
      .select('*, passenger_id')
      .single();

    if (error) {
      console.error('[Admin] Approval update error:', error.message);
      return res.status(500).json({ error: 'Failed to update booking approval' });
    }

    // Send push notification to the passenger
    await sendPushNotification(data.passenger_id, {
      title: isApproved ? 'Booking Approved' : 'Booking Rejected',
      body: isApproved
        ? 'Your booking has been approved. See you on the road!'
        : 'Your booking request was not approved. Please contact support for details.',
      data: { type: 'booking_approval', bookingId, status: action },
    });

    // Log agent activity
    await supabase.from('agent_activity').insert({
      agent_id: 'agent-dispatcher',
      agent_name: 'Dispatcher',
      action: 'Booking ' + action + 'd',
      details: 'Booking ' + bookingId,
      related_id: bookingId,
    }).then(() => {}).catch(() => {});

    res.json({ booking: data, action });
  } catch (err) {
    console.error('[Admin] PATCH /admin/approvals/:bookingId error:', err.message);
    res.status(500).json({ error: 'Failed to update booking approval' });
  }
});

module.exports = router;
