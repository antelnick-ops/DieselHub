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

  if (
    !process.env.STRIPE_SECRET_KEY ||
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

  try {
    const { items, customer_email, customer_id, vehicle, shipping_method } = req.body;

    if (!items || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'No items in cart' });
    }

    const productIds = items.map((i) => i.id).filter(Boolean);

    if (!productIds.length) {
      return res.status(400).json({ error: 'No valid product IDs provided' });
    }

    const { data: dbProducts, error: productsError } = await supabase
      .from('products')
      .select(`
        id,
        vendor_id,
        product_name,
        sku,
        brand,
        price,
        cost,
        map_price,
        image_url,
        shipping_cost,
        status,
        stock_qty,
        core_charge,
        has_core
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
        name: db.product_name,
        sku: db.sku || '',
        brand: db.brand || '',
        price: unitPrice,
        cost: Number(db.cost || 0),
        map_price: db.map_price != null ? Number(db.map_price) : null,
        image_url: db.image_url || null,
        shipping_cost: Number(db.shipping_cost || 0),
        core_charge: Number(db.core_charge || 0),
        has_core: Boolean(db.has_core),
        qty
      };
    });

    const line_items = normalizedItems.flatMap((item) => {
      const lines = [{
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
              sku: item.sku,
              brand: item.brand,
              line_type: 'product'
            }
          },
          unit_amount: Math.round(item.price * 100)
        },
        quantity: item.qty
      }];

      if (item.has_core && item.core_charge > 0) {
        lines.push({
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Core Deposit: ${item.name}`,
              description: 'Refundable when old part is returned within 30 days.',
              metadata: {
                product_id: item.id,
                vendor_id: item.vendor_id,
                  sku: item.sku,
                brand: item.brand,
                line_type: 'core_deposit',
                parent_product_id: item.id
              }
            },
            unit_amount: Math.round(item.core_charge * 100)
          },
          quantity: item.qty
        });
      }

      return lines;
    });

    const coreTotal = normalizedItems.reduce((sum, item) => {
      return sum + (item.has_core && item.core_charge > 0 ? item.core_charge * item.qty : 0);
    }, 0);

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
        shipping_method: shipping_method || '',
        core_total: coreTotal.toFixed(2),
        has_cores: coreTotal > 0 ? 'true' : 'false'
      },
      success_url: `${origin}/app/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/app/?checkout=cancelled`
    });

    return res.status(200).json({
      url: session.url,
      session_id: session.id
    });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    return res.status(500).json({ error: err.message });
  }
};