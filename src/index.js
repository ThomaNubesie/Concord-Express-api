require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');

const app = express();

app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false,
  crossOriginEmbedderPolicy: false,
}));

// Force HTTPS in production
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect('https://' + req.headers.host + req.url);
    }
    next();
  });
}
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? (process.env.FRONTEND_URL || 'https://concordxpress.ca').split(',')
    : '*',
  credentials: true,
}));
app.use(morgan('combined'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Sanitize all incoming request bodies
const { sanitizeBody } = require('./lib/sanitize');
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeBody(req.body);
  }
  next();
});
app.use('/api/bookings', rateLimit({ windowMs: 60000, max: 30, message: { error: 'Too many requests' } }));
app.use('/api/auth',     rateLimit({ windowMs: 60000, max: 20, message: { error: 'Too many requests' } }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500, message: { error: 'Too many requests' } });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many login attempts. Please wait 15 minutes.' } });
app.use('/api/auth/send-otp', authLimiter);
app.use('/api/auth/verify-otp', authLimiter);
app.use('/api/', limiter);
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Concord Xpress API', version: '1.0.0', timestamp: new Date().toISOString() });
});

app.get('/health/deep', async (req, res) => {
  const checks = { api: 'ok', database: 'unknown', timestamp: new Date().toISOString() };
  try {
    const { error } = await require('./lib/supabase').from('users').select('id').limit(1);
    checks.database = error ? 'error: ' + error.message : 'ok';
  } catch (e) { checks.database = 'error: ' + e.message; }
  const allOk = checks.database === 'ok';
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    service: 'Concord Xpress API',
    version: '1.0.0',
    ...checks,
    uptime: Math.floor(process.uptime()) + 's',
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
  });
});

const loadRoute = (path, file) => {
  try { app.use(path, require(file)); console.log('✅ ' + path); }
  catch (err) { console.error('❌ ' + path + ': ' + err.message); }
};

loadRoute('/api/auth',          './routes/auth');
loadRoute('/api/users',         './routes/users');
loadRoute('/api/trips',         './routes/trips');
loadRoute('/api/bookings',      './routes/bookings');
loadRoute('/api/payments',      './routes/payments');
loadRoute('/api/messages',      './routes/messages');
loadRoute('/api/ratings',       './routes/ratings');
loadRoute('/api/disputes',      './routes/disputes');
loadRoute('/api/notifications', './routes/notifications');
loadRoute('/api/driver',        './routes/driver');
loadRoute('/api/packages',      './routes/packages');
loadRoute('/api/assistant',     './routes/assistant');
loadRoute('/api/loyalty',         './routes/loyalty');
loadRoute('/api/tax-documents',  './routes/tax-documents');

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  console.error('[ERROR]', new Date().toISOString(), req.method, req.path, err.message);
  const status = err.status || 500;
  const message = process.env.NODE_ENV === 'production' && status === 500
    ? 'Internal server error'
    : err.message || 'Internal server error';
  res.status(status).json({ error: message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log('🍁 Concord Xpress API running on port ' + PORT);
  console.log('   Environment: ' + process.env.NODE_ENV);
  console.log('   Supabase:    ' + process.env.SUPABASE_URL);
});

module.exports = app;
// redeploy Tue Mar 31 11:37:29 EDT 2026


// Graceful shutdown
const shutdown = (signal) => {
  console.log('[Server] ' + signal + ' received. Shutting down gracefully...');
  server.close(() => {
    console.log('[Server] HTTP server closed');
    process.exit(0);
  });
  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('[Server] Forced shutdown after 10s timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  shutdown('uncaughtException');
});
