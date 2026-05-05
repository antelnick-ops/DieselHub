// Stage 2: Forward a BSD order to APG's production sales-order endpoint.
//
// Callable Vercel serverless function. Accepts POST { orderId } from internal
// callers (manual testing now, webhook.js in Stage 3). Reads the BSD order and
// items from Supabase, maps to APG's sales-order schema, authenticates, POSTs.
//
// Success: writes salesOrderNumber back to orders.supplier_order_id and flips
// supplier_status to 'submitted'.
// Failure: 4xx is deterministic and does NOT retry; 5xx / network errors retry
// up to 3 attempts total with 1s/2s/4s backoff. After exhaustion, writes a row
// to apg_failures and returns the error to the caller.

const { createClient } = require('@supabase/supabase-js');

const APG_NOTE_MAX = 50;
const RETRY_BACKOFFS_MS = [1000, 2000, 4000];

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const missing = requiredEnvMissing();
  if (missing.length) {
    console.error('[place-apg-order] Missing env vars:', missing.join(', '));
    return res.status(500).json({ error: 'Server misconfiguration', missing });
  }

  const { orderId } = req.body || {};
  if (!orderId || !isUuid(orderId)) {
    return res.status(400).json({ error: 'orderId (uuid) is required' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    const { order, items } = await loadOrder(supabase, orderId);
    const payload = buildApgPayload(order, items);

    const result = await submitWithRetry(payload);

    if (result.ok) {
      const salesOrderNumber = extractSalesOrderNumber(result.json);
      await markOrderSubmitted(supabase, orderId, salesOrderNumber);
      console.log(
        `[place-apg-order] order ${orderId.slice(0, 8)} submitted, APG SON ${maskSon(salesOrderNumber)}`
      );
      return res.status(200).json({
        ok: true,
        orderId,
        salesOrderNumber,
        attempts: result.attempts,
      });
    }

    await recordFailure(supabase, orderId, payload, result);
    console.error(
      `[place-apg-order] order ${orderId.slice(0, 8)} FAILED after ${result.attempts} attempt(s):`,
      `HTTP ${result.status}`,
      result.raw?.slice(0, 1000)
    );
    return res.status(502).json({
      ok: false,
      orderId,
      attempts: result.attempts,
      apgStatus: result.status,
      apgBody: result.json ?? result.raw ?? null,
      error: result.errorMessage || 'APG order placement failed',
    });
  } catch (err) {
    console.error('[place-apg-order] fatal:', err);
    try {
      await recordFailure(supabase, orderId, null, {
        status: null,
        json: null,
        raw: null,
        errorMessage: err.message,
        attempts: 0,
      });
    } catch (logErr) {
      console.error('[place-apg-order] could not record failure row:', logErr.message);
    }
    return res.status(500).json({ ok: false, error: err.message });
  }
};

function requiredEnvMissing() {
  const required = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
    'APG_API_KEY',
    'APG_AUTH_URL',
    'APG_API_BASE_URL',
    'APG_FALLBACK_PHONE',
  ];
  return required.filter((k) => !process.env[k]);
}

async function loadOrder(supabase, orderId) {
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select(
      'id, order_number, customer_email, ship_name, ship_address, ship_city, ship_state, ship_zip, ship_country, supplier_status, supplier_order_id'
    )
    .eq('id', orderId)
    .single();

  if (orderErr) throw new Error(`Could not load order ${orderId}: ${orderErr.message}`);
  if (!order) throw new Error(`Order ${orderId} not found`);

  if (order.supplier_order_id) {
    throw new Error(
      `Order ${orderId} already has supplier_order_id ${order.supplier_order_id}; refusing to resubmit`
    );
  }

  const { data: items, error: itemsErr } = await supabase
    .from('order_items')
    .select('id, sku, quantity, product_name')
    .eq('order_id', orderId);

  if (itemsErr) throw new Error(`Could not load order_items: ${itemsErr.message}`);
  if (!items || items.length === 0) throw new Error(`Order ${orderId} has no line items`);

  for (const it of items) {
    if (!it.sku) throw new Error(`Order item ${it.id} is missing sku`);
    if (!it.quantity || it.quantity < 1) {
      throw new Error(`Order item ${it.id} has invalid quantity ${it.quantity}`);
    }
  }

  if (!order.ship_name || !order.ship_address || !order.ship_city || !order.ship_state || !order.ship_zip) {
    throw new Error(`Order ${orderId} is missing required shipping fields`);
  }

  return { order, items };
}

function buildApgPayload(order, items) {
  const shortId = String(order.id).slice(0, 8);
  const noteRaw = `BSD #${order.order_number || shortId}`;
  const note = noteRaw.slice(0, APG_NOTE_MAX);
  const poNumber = String(order.id).slice(0, 50);

  return {
    customerPurchaseOrderNumber: poNumber,
    note,
    salesOrderLines: items.map((it) => ({
      itemNumber: it.sku,
      quantity: it.quantity,
      note: `BSD #${String(it.id).slice(0, 8)}`.slice(0, APG_NOTE_MAX),
    })),
    shipToAddress: {
      name: order.ship_name,
      addressLine1: order.ship_address,
      city: order.ship_city,
      regionCode: order.ship_state,
      postalCode: order.ship_zip,
      countryCode: order.ship_country || 'US',
      phone: process.env.APG_FALLBACK_PHONE,
    },
  };
}

async function authenticate() {
  const url = `${process.env.APG_AUTH_URL}?apiKey=${encodeURIComponent(process.env.APG_API_KEY)}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`APG auth failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(`APG auth response was not JSON: ${text.slice(0, 200)}`); }
  if (!body.sessionToken) throw new Error('APG auth body had no sessionToken');
  return body.sessionToken;
}

async function postSalesOrder(token, payload) {
  const res = await fetch(`${process.env.APG_API_BASE_URL}/sales-orders/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* leave null */ }
  return { status: res.status, ok: res.ok, raw, json };
}

async function submitWithRetry(payload) {
  let attempts = 0;
  let lastResult = null;
  let lastErrorMessage = null;

  for (let i = 0; i < RETRY_BACKOFFS_MS.length; i++) {
    attempts++;
    try {
      const token = await authenticate();
      console.log(`[place-apg-order] auth ok, token prefix ${token.slice(0, 12)}... (attempt ${attempts})`);
      const r = await postSalesOrder(token, payload);
      lastResult = r;

      if (r.ok) return { ok: true, attempts, ...r };

      // 4xx is deterministic — do not retry.
      if (r.status >= 400 && r.status < 500) {
        return {
          ok: false,
          attempts,
          status: r.status,
          json: r.json,
          raw: r.raw,
          errorMessage: `APG rejected order: HTTP ${r.status}`,
        };
      }

      // 5xx — retry if we have more attempts.
      lastErrorMessage = `APG server error: HTTP ${r.status}`;
    } catch (err) {
      // Network / auth / parsing error — retry.
      lastErrorMessage = err.message;
      lastResult = null;
    }

    const isLast = i === RETRY_BACKOFFS_MS.length - 1;
    if (!isLast) await sleep(RETRY_BACKOFFS_MS[i]);
  }

  return {
    ok: false,
    attempts,
    status: lastResult?.status ?? null,
    json: lastResult?.json ?? null,
    raw: lastResult?.raw ?? null,
    errorMessage: lastErrorMessage || 'APG order placement failed after retries',
  };
}

function extractSalesOrderNumber(json) {
  if (!json) return null;
  return json.salesOrderNumber ?? json.salesOrderId ?? null;
}

async function markOrderSubmitted(supabase, orderId, salesOrderNumber) {
  const { error } = await supabase
    .from('orders')
    .update({
      supplier_status: 'submitted',
      supplier_order_id: salesOrderNumber,
      supplier_submitted_at: new Date().toISOString(),
    })
    .eq('id', orderId);
  if (error) throw new Error(`Could not update order ${orderId}: ${error.message}`);
}

async function recordFailure(supabase, orderId, payload, result) {
  const { error } = await supabase.from('apg_failures').insert({
    order_id: orderId,
    request_payload: payload,
    response_status: result.status,
    response_body: result.json ?? (result.raw ? { raw: result.raw } : null),
    error_message: result.errorMessage || null,
    retry_count: Math.max(0, (result.attempts || 1) - 1),
  });
  if (error) throw error;
}

function maskSon(son) {
  if (!son) return '(none)';
  const s = String(son);
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}****${s.slice(-2)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '');
}
