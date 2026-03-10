const Stripe = require('stripe');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const { vendor_email, vendor_id, business_name } = req.body;

    if (!vendor_email || !vendor_id) {
      return res.status(400).json({ error: 'Missing vendor info' });
    }

    // Create a Stripe Connect Express account for the vendor
    const account = await stripe.accounts.create({
      type: 'express',
      email: vendor_email,
      business_type: 'company',
      company: {
        name: business_name || undefined,
      },
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: {
        vendor_id: vendor_id,
        platform: 'black_stack_diesel',
      },
    });

    // Create onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${req.headers.origin || 'https://black-stack-diesel.com'}/vendors/?stripe=refresh`,
      return_url: `${req.headers.origin || 'https://black-stack-diesel.com'}/vendors/?stripe=complete&account=${account.id}`,
      type: 'account_onboarding',
    });

    return res.status(200).json({
      url: accountLink.url,
      account_id: account.id,
    });
  } catch (err) {
    console.error('Stripe Connect error:', err);
    return res.status(500).json({ error: err.message });
  }
};
