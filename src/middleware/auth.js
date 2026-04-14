const jwt     = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('WARNING: JWT_SECRET environment variable is not set! Auth will not work.');
}

const verifyAuth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token   = authHeader.replace('Bearer ', '');
    const decoded = jwt.verify(token, JWT_SECRET);

    req.userId = decoded.userId || decoded.id || decoded.sub;
    req.user   = decoded;
    next();
  } catch (err) {
    console.error('[Auth middleware]', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return next();
  return verifyAuth(req, res, next);
};

module.exports = { verifyAuth, optionalAuth };
