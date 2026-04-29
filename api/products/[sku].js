import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'edge' };

const SITE = 'https://black-stack-diesel.com';
const DEFAULT_OG_IMAGE = SITE + '/app/icon-512.png';

// SKU URL-safety: must not contain /, ?, #, &, %, +, or whitespace.
// 0.17% of catalog (83 SKUs as of 2026-04-29) fails this check; those
// products stay on legacy /app/?p= URLs and aren't in the sitemap.
function isSafeSku(sku) {
  return typeof sku === 'string' && sku.length > 0 && !/[/?#&%+\s]/.test(sku);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// JSON inside a <script> block needs </ escaping to prevent script-tag breakout
function escapeJsonInScript(json) {
  return json.replace(/</g, '\\u003c');
}

// Strip the structured metadata block that BSD's `description` field
// often appends after the free-text portion (Brand:/MFG/UPC/Category/
// Subcategory/Type). Cuts at the first newline OR the first metadata
// label, whichever comes earlier. Collapses whitespace.
//
// Also dedupes the product name when it appears as a prefix — APG's
// description field typically starts with the product name, which
// would otherwise produce "Brand Name. Name. Available at..." in
// the rendered meta description.
function cleanDescription(rawDesc, name) {
  if (!rawDesc) return '';
  const cutoff = rawDesc.search(/\n|\bBrand:|\bMFG\b|\bUPC:|\bCategory:|\bSubcategory:|\bType:/i);
  let cleaned = (cutoff > 0 ? rawDesc.slice(0, cutoff) : rawDesc)
    .replace(/\s+/g, ' ')
    .trim();

  if (name && cleaned) {
    const lowerCleaned = cleaned.toLowerCase();
    const lowerName = String(name).toLowerCase().trim();
    if (lowerName && lowerCleaned.startsWith(lowerName)) {
      cleaned = cleaned.slice(lowerName.length).replace(/^[\s.,;:\-]+/, '').trim();
    }
  }

  return cleaned;
}

// Hard char limit but cut at the previous space when one is within the
// last 50 chars. Avoids "Available at Black Stac" mid-word truncation.
function truncateAtWordBoundary(text, maxLen) {
  if (!text || text.length <= maxLen) return text || '';
  const window = text.slice(0, maxLen);
  const lastSpace = window.lastIndexOf(' ');
  return (lastSpace > maxLen - 50 ? window.slice(0, lastSpace) : window).trim() + '…';
}

export default async function handler(req) {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const sku = decodeURIComponent(parts[parts.length - 1] || '');

  if (!isSafeSku(sku)) {
    return htmlResponse(notFoundShell(), 404);
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY
  );

  let product = null;
  try {
    const { data } = await supabase
      .from('products')
      .select('id, sku, product_name, brand, price, image_url, mfg_sku, upc, stock_qty, short_description, description')
      .eq('sku', sku)
      .eq('status', 'active')
      .eq('is_visible', true)
      .maybeSingle();
    product = data;
  } catch (err) {
    console.error('[BSD] Product fetch failed:', err && err.message);
    // Degrade to 404 rather than 500 — keeps crawlers from caching errors
  }

  if (!product) return htmlResponse(notFoundShell(), 404);

  return htmlResponse(productShell(product), 200);
}

function htmlResponse(body, status) {
  return new Response(body, {
    status: status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=86400'
    }
  });
}

function productShell(p) {
  // fullName for dedup + meta description (truncateAtWordBoundary handles overflow);
  // name (sliced) is for title display where char budget is tighter.
  const fullName = String(p.product_name || 'Product');
  const name = fullName.slice(0, 100);
  const brand = String(p.brand || '').slice(0, 60);
  const sku = String(p.sku);
  const price = parseFloat(p.price) || 0;
  const cleanedDesc = cleanDescription(p.short_description || p.description, fullName);
  const image = (p.image_url && /^https:\/\/images\.black-stack-diesel\.com\//.test(p.image_url))
    ? p.image_url
    : DEFAULT_OG_IMAGE;
  const stockOk = p.stock_qty != null && p.stock_qty > 0;
  const canonical = SITE + '/products/' + encodeURIComponent(sku);

  const titleParts = [name];
  if (brand) titleParts.push(brand);
  titleParts.push('Black Stack Diesel');
  const title = titleParts.join(' | ').slice(0, 160);

  const baseDescription = (brand ? brand + ' ' : '') + fullName + '.' +
    (cleanedDesc ? ' ' + cleanedDesc : '') +
    ' Available at Black Stack Diesel.';
  const description = truncateAtWordBoundary(baseDescription, 300);

  const jsonLd = {
    '@context': 'https://schema.org/',
    '@type': 'Product',
    name: name,
    sku: sku,
    brand: { '@type': 'Brand', name: brand || 'Black Stack Diesel' },
    description: truncateAtWordBoundary(cleanedDesc || (brand + ' ' + fullName), 500),
    image: image
  };
  if (p.mfg_sku) jsonLd.mpn = p.mfg_sku;
  if (p.upc) jsonLd.gtin12 = p.upc;
  if (price > 0) {
    jsonLd.offers = {
      '@type': 'Offer',
      url: canonical,
      priceCurrency: 'USD',
      price: price.toFixed(2),
      availability: stockOk ? 'https://schema.org/InStock' : 'https://schema.org/InStock',
      itemCondition: 'https://schema.org/NewCondition'
    };
  }

  const skuParam = encodeURIComponent(sku);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#07070A">
<link rel="manifest" href="/app/manifest.json">
<link rel="apple-touch-icon" href="/app/icon-192.png">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="product">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(image)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<script type="application/ld+json">${escapeJsonInScript(JSON.stringify(jsonLd))}</script>
<script>
// Redirect JS-enabled humans to the PWA. Bots don't execute this.
// Preserves fbclid, UTM, and any other query params through the navigation.
(function(){
  var qs = location.search || '';
  var sep = qs ? '&' : '?';
  location.replace('/app/' + qs + sep + 'p=${skuParam}');
})();
</script>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#07070A;color:#F1F5F9;padding:24px;max-width:720px}img{max-width:100%;height:auto;border-radius:8px}a{color:#EDAE0A}</style>
</head>
<body>
  <noscript>
    <h1>${escapeHtml(name)}</h1>
    ${brand ? `<p><strong>${escapeHtml(brand)}</strong></p>` : ''}
    <img src="${escapeHtml(image)}" alt="${escapeHtml(name)}">
    <p>${escapeHtml(description)}</p>
    ${price > 0 ? `<p><strong>$${price.toFixed(2)}</strong></p>` : ''}
    <p><a href="/app/?p=${skuParam}">Open in Black Stack Diesel app</a></p>
  </noscript>
</body>
</html>`;
}

function notFoundShell() {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Product not found — Black Stack Diesel</title>
<meta name="description" content="This product is no longer available. Browse our catalog of Cummins, Duramax, and Power Stroke parts.">
<meta name="robots" content="noindex">
<link rel="canonical" href="${SITE}/app/">
<style>body{margin:0;font-family:system-ui,sans-serif;background:#07070A;color:#F1F5F9;padding:48px 24px;text-align:center}a{color:#EDAE0A}</style>
</head><body>
<h1>Product not found</h1>
<p>This product may have been discontinued or is temporarily unavailable.</p>
<p><a href="/app/">Browse the catalog</a></p>
</body></html>`;
}
