const { createClient } = require('@supabase/supabase-js');

// Create a client that verifies JWTs from incoming requests
const verifyAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.replace('Bearer ', '');

    // Verify token against Supabase
    const supabaseClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_PUBLISHABLE_KEY,
      {
        global: {
          headers: { Authorization: `Bearer ${token}` },
        },
      }
    );

    const { data: { user }, error } = await supabaseClient.auth.getUser();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Attach user to request
    req.user   = user;
    req.userId = user.id;
    next();
  } catch (err) {
    console.error('[Auth middleware]', err);
    res.status(500).json({ error: 'Authentication error' });
  }
};

// Optional auth — attaches user if token present, continues if not
const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return next();
  return verifyAuth(req, res, next);
};

module.exports = { verifyAuth, optionalAuth };
