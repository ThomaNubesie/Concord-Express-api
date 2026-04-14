/**
 * Input sanitization utilities
 */

// Strip HTML tags and dangerous characters
function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/<[^>]*>/g, '')           // strip HTML tags
    .replace(/[<>]/g, '')              // remove angle brackets
    .replace(/javascript:/gi, '')      // remove JS protocol
    .replace(/on\w+\s*=/gi, '')      // remove event handlers
    .trim();
}

// Recursively sanitize all string values in an object
function sanitizeBody(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clean = Array.isArray(obj) ? [] : {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string') {
      clean[key] = sanitizeString(val);
    } else if (typeof val === 'object' && val !== null) {
      clean[key] = sanitizeBody(val);
    } else {
      clean[key] = val;
    }
  }
  return clean;
}

// Validate email format
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Validate phone (E.164)
function isValidPhone(phone) {
  return /^\+?[1-9]\d{6,14}$/.test(phone.replace(/[\s\-\(\)]/g, ''));
}

// Validate UUID
function isValidUUID(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

module.exports = { sanitizeString, sanitizeBody, isValidEmail, isValidPhone, isValidUUID };
