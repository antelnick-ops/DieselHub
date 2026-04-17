const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  if (!stripeSecretKey) {
    console.error('Missing STRIPE_SECRET_KEY');
    return res.status(500).json({ error: 'Stripe key not configured' });
  }

  const stripe = new Stripe(stripeSecretKey);

  console.log('CREATE_CHECKOUT host:', req.headers.host);
  console.log('CREATE_CHECKOUT origin:', req.headers.origin);
  console.log('CREATE_CHECKOUT stripe prefix:', stripeSecretKey.slice(0, 8));

  try {
    const { items, customer_email, customer_id, vehicle, shipping_method } = req.body;

    if (!items || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'No items in cart' });
    }

    const productIds = items.map((i) => i.id).filter(Boolean);

    const { data: dbProducts, error: productsError } = await supabase
      .from('products')
      .select(`
        id,
        vendor_id,
        vendor_distributor_id,
        product_name,
        sku,
        brand,
        price,
        cost,
        map_price,
        image_url,
        shipping_cost,
        status,
        stock_qty
      `)
      .in('id', productIds);

    if (productsError) {
      console.error('Supabase product fetch error:', productsError);
      return res.status(500).json({ error: 'Failed to load product data' });
    }

    const productMap = new Map((dbProducts || []).map((p) => [p.id, p]));

    const normalizedItems = items.map((item) => {
      const db = productMap.get(item.id);

      if (!db) {
        throw new Error(`Product not found: ${item.id}`);
      }

      if (db.status !== 'active') {
        throw new Error(`Product is not active: ${db.product_name}`);
      }

      const qty = Math.max(1, parseInt(item.qty || 1, 10));
      const unitPrice = Number(db.price || 0);

      return {
        id: db.id,
        vendor_id: db.vendor_id,
        vendor_distributor_id: db.vendor_distributor_id || null,
        name: db.product_name,
        sku: db.sku || '',
        brand: db.brand || '',
        price: unitPrice,
        cost: Number(db.cost || 0),
        map_price: db.map_price != null ? Number(db.map_price) : null,
        image_url: db.image_url || null,
        shipping_cost: Number(db.shipping_cost || 0),
        qty
      };
    });

    const line_items = normalizedItems.map((item) => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name,
          description: [item.brand, vehicle ? `Fits: ${vehicle}` : '']
            .filter(Boolean)
            .join(' | '),
          images: item.image_url ? [item.image_url] : undefined,
          metadata: {
            product_id: item.id,
            vendor_id: item.vendor_id,
            vendor_distributor_id: item.vendor_distributor_id || '',
            sku: item.sku,
            brand: item.brand
          }
        },
        unit_amount: Math.round(item.price * 100)
      },
      quantity: item.qty
    }));

    const shippingOptions = [
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: 0, currency: 'usd' },
          display_name: 'Standard Shipping',
          delivery_estimate: {
            minimum: { unit: 'business_day', value: 5 },
            maximum: { unit: 'business_day', value: 10 }
          }
        }
      },
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: 1999, currency: 'usd' },
          display_name: 'Express Shipping',
          delivery_estimate: {
            minimum: { unit: 'business_day', value: 2 },
            maximum: { unit: 'business_day', value: 4 }
          }
        }
      }
    ];

    const origin =
      req.headers.origin ||
      `https://${req.headers.host}` ||
      process.env.APP_URL ||
      'https://black-stack-diesel.com';

    console.log('CREATE_CHECKOUT success_url origin:', origin);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: customer_email || undefined,
      line_items,
      shipping_address_collection: {
        allowed_countries: ['US']
      },
      shipping_options: shippingOptions,
      metadata: {
        customer_id: customer_id || '',
        customer_email: customer_email || '',
        vehicle: vehicle || '',
        source: 'bsd_app',
        shipping_method: shipping_method || ''
      },
      success_url: `${origin}/app/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/app/?checkout=cancelled`
    });

    console.log('CREATE_CHECKOUT session id:', session.id);

    return res.status(200).json({
      url: session.url,
      session_id: session.id
    });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    return res.status(500).json({ error: err.message });
  }
};