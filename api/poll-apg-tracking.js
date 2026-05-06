// Stage 4: Poll APG for tracking on submitted BSD orders.
//
// Triggered by Vercel cron every 4 hours (see vercel.json `crons`). Also
// callable manually via POST for testing. Gated by APG_TRACKING_POLL_ENABLED.
//
// Flow:
//   1. Query orders where supplier_status='submitted' AND submitted >30 min ago.
//   2. Authenticate to APG once for the whole batch.
//   3. For each order, GET /tracking?salesOrderNumber=<supplier_order_id>.
//      - Tracking present  → mark fulfilled, store tracking + carrier + shipped_at,
//        send customer email, set customer_notified_at.
//      - Tracking absent   → leave as 'submitted' (next poll retries). If
//        submitted >7d ago, log a stale-order warning.
//      - 4xx APG response  → log, skip this order, continue.
//      - 5xx / network err → log, skip this order, continue.
//   4. Email failure does NOT roll back the status update (at-most-once email).
//   5. Return summary JSON; cron-safe regardless of internal errors.

const { createClient } = require('@supabase/supabase-js');

const POLL_DELAY_MIN = 30;
const STALE_DAYS = 7;
const ORDER_BATCH_LIMIT = 100;

module.exports = async (req, res) => {
  // Optional bearer-token auth — runs first so unauthenticated callers learn
  // nothing about flag state or any other internal detail. Vercel cron
  // automatically attaches the header when CRON_SECRET is set in project env.
  // If CRON_SECRET is unset, auth is skipped (local dev convenience).
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.authorization || '';
    const provided = authHeader.replace(/^Bearer\s+/i, '');
    if (provided !== cronSecret) {
      console.warn('[poll-apg-tracking] Unauthorized request — bad/missing CRON_SECRET');
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  if (process.env.APG_TRACKING_POLL_ENABLED !== 'true') {
    console.log('[poll-apg-tracking] APG_TRACKING_POLL_ENABLED is not "true"; skipping');
    return res.status(200).json({ ok: true, skipped: true, reason: 'flag off' });
  }

  const missing = requiredEnvMissing();
  if (missing.length) {
    console.error('[poll-apg-tracking] Missing env vars:', missing.join(', '));
    return res.status(500).json({ ok: false, error: 'Server misconfiguration', missing });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // 1. Candidate orders.
  const cutoffIso = new Date(Date.now() - POLL_DELAY_MIN * 60 * 1000).toISOString();
  const staleIso = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: orders, error: queryErr } = await supabase
    .from('orders')
    .select('id, order_number, customer_email, customer_name, supplier_order_id, supplier_submitted_at')
    .eq('supplier_status', 'submitted')
    .not('supplier_order_id', 'is', null)
    .lt('supplier_submitted_at', cutoffIso)
    .order('supplier_submitted_at', { ascending: true })
    .limit(ORDER_BATCH_LIMIT);

  if (queryErr) {
    console.error('[poll-apg-tracking] order query failed:', queryErr.message);
    return res.status(500).json({ ok: false, error: queryErr.message });
  }

  if (!orders || orders.length === 0) {
    console.log('[poll-apg-tracking] no candidate orders');
    return res.status(200).json({ ok: true, polled: 0, updated: 0, emailed: 0, warnings: 0, errors: 0 });
  }

  console.log(`[poll-apg-tracking] ${orders.length} candidate order(s) to poll`);

  // 2. Authenticate once for the batch.
  let token;
  try {
    token = await authenticate();
    console.log(`[poll-apg-tracking] APG auth ok, token prefix ${token.slice(0, 12)}...`);
  } catch (err) {
    console.error('[poll-apg-tracking] APG auth failed:', err.message);
    return res.status(502).json({ ok: false, error: 'APG auth failed' });
  }

  // 3. Per-order loop.
  const counts = { polled: 0, updated: 0, emailed: 0, warnings: 0, errors: 0 };

  for (const order of orders) {
    counts.polled++;
    const shortId = String(order.id).slice(0, 8);

    let trackingResp;
    try {
      trackingResp = await getTracking(token, order.supplier_order_id);
    } catch (err) {
      console.error(`[poll-apg-tracking] order ${shortId} APG fetch failed: ${err.message}`);
      counts.errors++;
      continue;
    }

    const tracking = pickFirstTracking(trackingResp);

    if (!tracking) {
      if (order.supplier_submitted_at && order.supplier_submitted_at < staleIso) {
        console.warn(
          `[poll-apg-tracking] STALE: order ${shortId} (APG SON ${order.supplier_order_id}) ` +
          `submitted_at=${order.supplier_submitted_at} has no tracking after ${STALE_DAYS} days`
        );
        counts.warnings++;
      }
      continue;
    }

    // Update with idempotency guard: only flip from 'submitted' to 'fulfilled'.
    const updatePayload = {
      supplier_status: 'fulfilled',
      tracking_number: tracking.trackingNumber,
      tracking_carrier: tracking.carrier || null,
      shipped_at: new Date().toISOString(),
    };

    const { data: updatedRows, error: updateErr } = await supabase
      .from('orders')
      .update(updatePayload)
      .eq('id', order.id)
      .eq('supplier_status', 'submitted')
      .select('id');

    if (updateErr) {
      console.error(`[poll-apg-tracking] order ${shortId} update failed: ${updateErr.message}`);
      counts.errors++;
      continue;
    }

    if (!updatedRows || updatedRows.length === 0) {
      // Race: another invocation already moved this row past 'submitted'.
      console.log(`[poll-apg-tracking] order ${shortId} already updated; skipping email`);
      continue;
    }

    counts.updated++;
    console.log(
      `[poll-apg-tracking] order ${shortId} fulfilled: carrier=${tracking.carrier || '?'} ` +
      `tracking=${maskTracking(tracking.trackingNumber)}`
    );

    // Email — failure does NOT roll back the status update.
    try {
      await sendShipmentEmail(order, tracking);
      const { error: notifyErr } = await supabase
        .from('orders')
        .update({ customer_notified_at: new Date().toISOString() })
        .eq('id', order.id);
      if (notifyErr) {
        console.error(`[poll-apg-tracking] order ${shortId} customer_notified_at write failed: ${notifyErr.message}`);
      }
      counts.emailed++;
    } catch (emailErr) {
      console.error(`[poll-apg-tracking] order ${shortId} email failed: ${emailErr.message}`);
    }
  }

  console.log(
    `[poll-apg-tracking] Polled ${counts.polled}, updated ${counts.updated}, ` +
    `emailed ${counts.emailed}, warnings ${counts.warnings}, errors ${counts.errors}`
  );

  return res.status(200).json({ ok: true, ...counts });
};

function requiredEnvMissing() {
  const required = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
    'APG_API_KEY',
    'APG_AUTH_URL',
    'APG_API_BASE_URL',
    'RESEND_API_KEY',
  ];
  return required.filter((k) => !process.env[k]);
}

async function authenticate() {
  const url = `${process.env.APG_AUTH_URL}?apiKey=${encodeURIComponent(process.env.APG_API_KEY)}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`APG auth HTTP ${res.status} ${text.slice(0, 200)}`);
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(`APG auth response not JSON: ${text.slice(0, 200)}`); }
  if (!body.sessionToken) throw new Error('APG auth body missing sessionToken');
  return body.sessionToken;
}

async function getTracking(token, salesOrderNumber) {
  const url = `${process.env.APG_API_BASE_URL}/tracking?salesOrderNumber=${encodeURIComponent(salesOrderNumber)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) {
    const tag = res.status >= 500 ? '5xx' : '4xx';
    throw new Error(`APG /tracking HTTP ${res.status} (${tag}): ${text.slice(0, 200)}`);
  }
  try { return JSON.parse(text); }
  catch { throw new Error(`APG /tracking response not JSON: ${text.slice(0, 200)}`); }
}

// APG /tracking returns an array of tracking objects per the docs:
// [{ trackingNumber, carrier, isDropShip, packageItems }]. Some endpoints
// wrap arrays under a key; check for both shapes defensively.
function pickFirstTracking(resp) {
  if (!resp) return null;
  const arr = Array.isArray(resp) ? resp : (resp.tracking || resp.data || []);
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.find((t) => t && t.trackingNumber) || null;
}

async function sendShipmentEmail(order, tracking) {
  if (!order.customer_email) throw new Error('order has no customer_email');

  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  const orderShortId = String(order.id).slice(0, 8);
  const orderRef = order.order_number || orderShortId;
  const firstName = order.customer_name ? String(order.customer_name).split(/\s+/)[0] : '';
  const greeting = firstName ? `Hey ${firstName},` : 'Hey,';
  const trackingUrl = carrierTrackingUrl(tracking.carrier, tracking.trackingNumber);

  await resend.emails.send({
    from: 'BlackStackDiesel <noreply@black-stack-diesel.com>',
    to: order.customer_email,
    subject: 'Your BlackStackDiesel order has shipped 📦',
    text: [
      greeting,
      '',
      `Your order #${orderRef} just left the warehouse and is on its way.`,
      '',
      `Tracking number: ${tracking.trackingNumber}`,
      `Carrier: ${tracking.carrier || '(not specified)'}`,
      `Track it: ${trackingUrl}`,
      '',
      'Thanks for ordering from BlackStackDiesel.',
      '',
      '🖤💨',
      '— BlackStackDiesel',
    ].join('\n'),
  });
}

function carrierTrackingUrl(carrier, num) {
  const c = String(carrier || '').toUpperCase();
  const n = encodeURIComponent(num);
  if (c.includes('UPS')) return `https://www.ups.com/track?tracknum=${n}`;
  if (c.includes('FEDEX')) return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
  if (c.includes('USPS')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
  if (c.includes('DHL')) return `https://www.dhl.com/en/express/tracking.html?AWB=${n}`;
  return `https://www.google.com/search?q=${encodeURIComponent(`${carrier || ''} tracking ${num}`)}`;
}

function maskTracking(num) {
  if (!num) return '(none)';
  const s = String(num);
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}****${s.slice(-2)}`;
}
