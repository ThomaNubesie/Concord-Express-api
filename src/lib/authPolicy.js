// src/lib/authPolicy.js
// Pure production-gating policy for auth. Centralized + dependency-free so the
// security rules can be unit-tested without the router or a database.
//
// In production: codes are never returned in API responses, and the master
// dev-bypass code can never authenticate. Locally both stay enabled for testing.

const DEFAULT_MASTER_CODE = '000000';

function isProd(env = process.env.NODE_ENV) {
  return env === 'production';
}

// Whether it's OK to return the raw OTP in an API response (dev only).
function exposeDevCodeAllowed(env = process.env.NODE_ENV) {
  return !isProd(env);
}

// Whether the master dev-bypass code is honoured at all (dev only).
function devBypassAllowed(env = process.env.NODE_ENV) {
  return !isProd(env);
}

// True only when bypass is allowed AND the supplied code matches the master code.
function isMasterBypass(
  otp,
  env = process.env.NODE_ENV,
  masterCode = process.env.DEV_OTP || DEFAULT_MASTER_CODE,
) {
  return devBypassAllowed(env) && otp === masterCode;
}

module.exports = { isProd, exposeDevCodeAllowed, devBypassAllowed, isMasterBypass, DEFAULT_MASTER_CODE };
