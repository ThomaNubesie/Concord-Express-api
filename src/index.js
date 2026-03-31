require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');

const app = express();

app.set("trust proxy", 1);

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(morgan('combined'));
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500, message: { error: 'Too many requests' } });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many login attempts. Please wait 15 minutes.' } });
app.use('/api/auth/send-otp', authLimiter);
app.use('/api/auth/verify-otp', authLimiter);
app.use('/api/', limiter);
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Concord Xpress API', version: '1.0.0', timestamp: new Date().toISOString() });
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
loadRoute('/api/loyalty',       './routes/loyalty');

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message || 'Internal server error' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log('🍁 Concord Xpress API running on port ' + PORT);
  console.log('   Environment: ' + process.env.NODE_ENV);
  console.log('   Supabase:    ' + process.env.SUPABASE_URL);
});

module.exports = app;
// redeploy Tue Mar 31 11:37:29 EDT 2026
