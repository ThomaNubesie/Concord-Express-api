// src/lib/email.js
// Transactional email via Resend. The client is created lazily from env so it
// can be unit-tested (set RESEND_API_KEY, mock 'resend', call _resetClient()).

const { Resend } = require('resend');

let _client; // undefined = not yet resolved; null = not configured
function getClient() {
  if (_client !== undefined) return _client;
  _client = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
  return _client;
}

// Test hook — forces the client to be re-resolved from current env.
function _resetClient() { _client = undefined; }

function otpEmailHtml(otp) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:420px;margin:0 auto;padding:24px">
      <h2 style="color:#0a0a0a;margin:0 0 8px">Verify your email</h2>
      <p style="color:#444;margin:0 0 16px">Use this code to continue signing in to ConcordXpress.</p>
      <div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#2ECC8F;text-align:center;padding:16px;background:#f4f6f9;border-radius:12px">${otp}</div>
      <p style="color:#888;font-size:12px;margin:16px 0 0">This code expires in 10 minutes. If you didn't request it, you can ignore this email.</p>
    </div>`;
}

// Send a verification code by email. Throws if Resend isn't configured or the
// send fails, so callers can decide how to respond.
async function sendOtpEmail(to, otp) {
  const client = getClient();
  if (!client) throw new Error('Email provider not configured (RESEND_API_KEY missing)');
  // Resend returns { data, error } — it does NOT throw on API errors (e.g.
  // unverified domain, test-sender recipient restriction). We must inspect
  // `error` ourselves, or a failed send looks like success.
  const { error } = await client.emails.send({
    from:    process.env.FROM_EMAIL || 'no-reply@concordexpress.ca',
    to,
    subject: 'Your ConcordXpress verification code',
    text:    `Your ConcordXpress verification code is ${otp}. It is valid for 10 minutes.`,
    html:    otpEmailHtml(otp),
  });
  if (error) throw new Error(error.message || error.name || 'Resend send failed');
}

function receiptEmailHtml(r) {
  const line = (label, amount, strong) =>
    `<tr><td style="padding:6px 0;color:${strong?'#0a0a0a':'#444'};${strong?'font-weight:800;border-top:1px solid #eee':''}">${label}</td>
      <td style="padding:6px 0;text-align:right;color:${strong?'#2ECC8F':'#0a0a0a'};${strong?'font-weight:800;border-top:1px solid #eee':''}">${amount}</td></tr>`;
  const items = (r.lines || []).map(l => line(l.label, l.amount, false)).join('');
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:460px;margin:0 auto;padding:24px">
      <h2 style="color:#0a0a0a;margin:0 0 4px">Your ConcordXpress receipt</h2>
      <p style="color:#888;font-size:12px;margin:0 0 18px">Receipt ${r.receiptId || ''} · ${r.date || ''}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        ${items}
        ${line('Subtotal', r.subtotal, false)}
        ${r.tax ? line('Tax' + (r.province ? ` (${r.province})` : ''), r.tax, false) : ''}
        ${line('Total', r.total, true)}
      </table>
      <p style="color:#888;font-size:12px;margin:18px 0 0">Thank you for verifying with ConcordXpress.</p>
    </div>`;
}

// Send a payment receipt by email. Throws if Resend isn't configured / send fails.
async function sendReceiptEmail(to, receipt) {
  const client = getClient();
  if (!client) throw new Error('Email provider not configured (RESEND_API_KEY missing)');
  const { error } = await client.emails.send({
    from:    process.env.FROM_EMAIL || 'no-reply@concordexpress.ca',
    to,
    subject: `Your ConcordXpress receipt ${receipt.receiptId || ''}`.trim(),
    text:    `ConcordXpress receipt ${receipt.receiptId || ''} — Total ${receipt.total}. Thank you.`,
    html:    receiptEmailHtml(receipt),
  });
  if (error) throw new Error(error.message || error.name || 'Resend send failed');
}

module.exports = { sendOtpEmail, otpEmailHtml, sendReceiptEmail, receiptEmailHtml, _resetClient };
