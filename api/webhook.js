const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

// Vercel sends raw body for webhooks when configured correctly
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY // Use service role key for server-side writes
  );

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Verify webhook signature
    const buf = await getRawBody(req);
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature failed' });
  }

  // Handle checkout.session.completed
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    try {
      // Retrieve full session with line items
      const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['line_items', 'line_items.data.price.product'],
      });

      const items = fullSession.line_items.data.map(item => ({
        product_id: item.price.product.metadata?.product_id || null,
        name: item.description,
        brand: item.price.product.metadata?.brand || '',
        qty: item.quantity,
        unit_price: item.price.unit_amount / 100,
        total: item.amount_total / 100,
      }));

      // Create order in Supabase
      const order = {
        stripe_session_id: session.id,
        stripe_payment_intent: session.payment_intent,
        customer_email: session.customer_details?.email || session.customer_email,
        customer_name: session.customer_details?.name || null,
        shipping_address: session.shipping_details?.address || null,
        shipping_name: session.shipping_details?.name || null,
        items: items,
        subtotal: session.amount_subtotal / 100,
        shipping_cost: session.total_details?.amount_shipping ? session.total_details.amount_shipping / 100 : 0,
        total: session.amount_total / 100,
        currency: session.currency,
        vehicle: session.metadata?.vehicle || null,
        status: 'paid',
        created_at: new Date().toISOString(),
      };

      const { error } = await supabase.from('orders').insert(order);
      if (error) console.error('Supabase order insert error:', error);
      else console.log('Order created:', session.id);

      // Update product stock quantities
      for (const item of items) {
        if (item.product_id) {
          await supabase.rpc('decrement_stock', {
            p_id: item.product_id,
            qty: item.qty,
          });
        }
      }

    } catch (err) {
      console.error('Order processing error:', err);
    }
  }

  return res.status(200).json({ received: true });
};

// Helper to get raw body for signature verification
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
