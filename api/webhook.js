const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  if (
    !process.env.STRIPE_SECRET_KEY ||
    !process.env.STRIPE_WEBHOOK_SECRET ||
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_KEY
  ) {
    console.error('Missing required environment variables');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature failed' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object, stripe, supabase);
        break;

      case 'checkout.session.async_payment_failed':
        await handleCheckoutFailed(event.data.object, supabase);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook processing error:', err);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
};

async function handleCheckoutCompleted(session, stripe, supabase) {
  const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ['line_items', 'line_items.data.price.product']
  });

  const { data: existingOrder, error: existingOrderError } = await supabase
    .from('orders')
    .select('id')
    .eq('stripe_checkout_session_id', session.id)
    .limit(1)
    .maybeSingle();

  if (existingOrderError) {
    throw existingOrderError;
  }

  if (existingOrder?.id) {
    console.log(`Order already exists for session ${session.id}`);
    return;
  }

  const shippingAddress =
    session.shipping_details?.address ||
    session.customer_details?.address ||
    {};

  const shipName =
    session.shipping_details?.name ||
    session.customer_details?.name ||
    null;

  const customerEmail =
    session.customer_details?.email ||
    session.customer_email ||
    session.metadata?.customer_email ||
    '';

  if (!customerEmail) {
    throw new Error('Customer email missing from Stripe session');
  }

  const subtotal = toMoney(session.amount_subtotal);
  const shippingTotal = toMoney(session.total_details?.amount_shipping || 0);
  const tax = toMoney(session.total_details?.amount_tax || 0);
  const total = toMoney(session.amount_total);

  const orderPayload = {
    customer_id: isUuid(session.metadata?.customer_id) ? session.metadata.customer_id : null,
    customer_email: customerEmail,
    customer_name: session.customer_details?.name || null,
    ship_name: shipName,
    ship_address: joinAddressLines(shippingAddress.line1, shippingAddress.line2),
    ship_city: shippingAddress.city || null,
    ship_state: shippingAddress.state || null,
    ship_zip: shippingAddress.postal_code || null,
    ship_country: shippingAddress.country || 'US',
    subtotal,
    shipping_total: shippingTotal,
    tax,
    total,
    stripe_checkout_session_id: session.id,
    stripe_payment_intent_id: session.payment_intent || null,
    currency: (session.currency || 'usd').toUpperCase(),
    shipping_method:
      session.metadata?.shipping_method ||
      session.shipping_cost?.shipping_rate ||
      null,
    shipping_service: session.shipping_cost?.shipping_rate || null,
    payment_status: 'paid',
    status: 'confirmed',
    supplier_status: 'queued'
  };

  const { data: insertedOrder, error: orderInsertError } = await supabase
    .from('orders')
    .insert(orderPayload)
    .select('id, order_number')
    .single();

  if (orderInsertError) {
    throw orderInsertError;
  }

  const lineItems = fullSession.line_items?.data || [];
  const orderItemsPayload = [];
  const stockUpdates = [];

  for (const li of lineItems) {
    const productMeta = li.price?.product?.metadata || {};
    const productId = productMeta.product_id || null;
    const vendorId = productMeta.vendor_id || null;
    const vendorDistributorId = productMeta.vendor_distributor_id || null;
    const qty = Math.max(1, parseInt(li.quantity || 1, 10));
    const unitPrice = toMoney(li.price?.unit_amount || 0);
    const lineTotal = toMoney(li.amount_total || 0);

    let dbProduct = null;

    if (productId) {
      const { data, error } = await supabase
        .from('products')
        .select(`
          id,
          vendor_id,
          vendor_distributor_id,
          product_name,
          sku,
          brand,
          cost,
          map_price,
          image_url
        `)
        .eq('id', productId)
        .single();

      if (error) {
        console.warn(`Could not load product ${productId}:`, error.message);
      } else {
        dbProduct = data;
      }
    }

    const resolvedVendorId = dbProduct?.vendor_id || vendorId;
    if (!resolvedVendorId) {
      throw new Error(`Missing vendor_id for line item ${li.description}`);
    }

    orderItemsPayload.push({
      order_id: insertedOrder.id,
      product_id: dbProduct?.id || productId || null,
      vendor_id: resolvedVendorId,
      vendor_distributor_id:
        dbProduct?.vendor_distributor_id || vendorDistributorId || null,
      product_name: dbProduct?.product_name || li.description || 'Product',
      sku: dbProduct?.sku || productMeta.sku || null,
      brand: dbProduct?.brand || productMeta.brand || '',
      quantity: qty,
      unit_price: unitPrice,
      unit_cost: dbProduct?.cost != null ? Number(dbProduct.cost) : null,
      map_price: dbProduct?.map_price != null ? Number(dbProduct.map_price) : null,
      shipping_cost: 0,
      line_total: lineTotal,
      image_url: dbProduct?.image_url || null,
      status: 'pending'
    });

    if (dbProduct?.id) {
      stockUpdates.push({
        productId: dbProduct.id,
        qty
      });
    }
  }

  if (orderItemsPayload.length) {
    const { error: itemInsertError } = await supabase
      .from('order_items')
      .insert(orderItemsPayload);

    if (itemInsertError) {
      throw itemInsertError;
    }
  }

  for (const update of stockUpdates) {
    const { data: currentProduct, error: currentError } = await supabase
      .from('products')
      .select('stock_qty')
      .eq('id', update.productId)
      .single();

    if (currentError) {
      console.warn(`Could not fetch stock for ${update.productId}:`, currentError.message);
      continue;
    }

    const newQty = Math.max(0, Number(currentProduct.stock_qty || 0) - update.qty);

    const { error: stockError } = await supabase
      .from('products')
      .update({
        stock_qty: newQty,
        updated_at: new Date().toISOString()
      })
      .eq('id', update.productId);

    if (stockError) {
      console.warn(`Could not update stock for ${update.productId}:`, stockError.message);
    }
  }

  console.log(`Order ${insertedOrder.order_number} created from session ${session.id}`);

  // Send operator notification email.
  // Failure to email must NEVER fail the webhook — the order is already written
  // and the customer has paid. Worst case: we lost a notification, the order
  // sits in supplier_status='queued' until someone notices.
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    const orderShortId = String(insertedOrder.id).substring(0, 8);
    const itemSummary = orderItemsPayload
      .map((it) => `- ${it.quantity}x ${it.sku || '(no sku)'} | ${it.product_name} ($${it.unit_price})`)
      .join('\n');

    await resend.emails.send({
      from: 'BlackStackDiesel <noreply@black-stack-diesel.com>',
      to: 'nick@black-stack-diesel.com', // TODO: move to env var BSD_OPERATOR_EMAIL
      subject: `New BSD order #${orderShortId} - $${total}`,
      text: [
        'New order received on BlackStackDiesel.',
        '',
        `Order ID: ${insertedOrder.id}`,
        `Order #: ${insertedOrder.order_number || '(none)'}`,
        `Total: $${total}`,
        `Customer email: ${customerEmail}`,
        '',
        'Shipping to:',
        `  ${shipName || '(no name)'}`,
        `  ${joinAddressLines(shippingAddress.line1, shippingAddress.line2) || '(no street address)'}`,
        `  ${shippingAddress.city || '?'}, ${shippingAddress.state || '?'} ${shippingAddress.postal_code || '?'}`,
        '',
        'Items:',
        itemSummary,
        '',
        "Payment captured. Order is queued in Supabase with supplier_status='queued'.",
        '',
        'ACTION REQUIRED: log into APG and place this order for drop-ship to the shipping address above.',
        '',
        `Stripe payment intent: ${session.payment_intent || '(none)'}`,
      ].join('\n'),
    });
  } catch (emailErr) {
    console.error('[webhook] Operator notification email failed:', emailErr);
    // Do not throw — webhook still returns 200.
  }

  // Stage 3: Forward to APG. Gated by APG_AUTO_ORDER_ENABLED.
  // Awaited (not fire-and-forget) so the fetch is guaranteed to complete before
  // Vercel reaps the lambda. Bounded by an 8s AbortController so the webhook
  // still acks Stripe well inside its 30s window even if APG is slow. Any APG
  // failure is logged but never blocks the 200 response to Stripe.
  try {
    if (process.env.APG_AUTO_ORDER_ENABLED === 'true') {
      const apgUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}/api/place-apg-order`
        : 'https://www.black-stack-diesel.com/api/place-apg-order';

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const apgPromise = fetch(apgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: insertedOrder.id }),
        signal: controller.signal,
      })
        .then((res) => {
          clearTimeout(timeoutId);
          if (!res.ok) {
            return res.text().then((text) => {
              console.error(
                `[webhook] APG forward returned ${res.status} for order ${insertedOrder.id}:`,
                text
              );
            });
          }
          console.log(`[webhook] APG forward succeeded for order ${insertedOrder.id}`);
        })
        .catch((err) => {
          clearTimeout(timeoutId);
          console.error(
            `[webhook] APG forward failed for order ${insertedOrder.id}:`,
            err.message
          );
        });

      await apgPromise;
    } else {
      console.log('[webhook] APG_AUTO_ORDER_ENABLED is false, skipping APG forward');
    }
  } catch (apgErr) {
    console.error('[webhook] APG forward block error:', apgErr);
    // Do not throw — webhook still returns 200.
  }
}

async function handleCheckoutFailed(session, supabase) {
  if (!session?.id) return;

  const { error } = await supabase
    .from('orders')
    .update({
      payment_status: 'failed',
      status: 'cancelled',
      updated_at: new Date().toISOString()
    })
    .eq('stripe_checkout_session_id', session.id);

  if (error) {
    console.warn(`Failed to mark checkout failure for session ${session.id}:`, error.message);
  }
}

function toMoney(amountInCents) {
  return Number(((amountInCents || 0) / 100).toFixed(2));
}

function joinAddressLines(line1, line2) {
  return [line1, line2].filter(Boolean).join(', ') || null;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '');
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}