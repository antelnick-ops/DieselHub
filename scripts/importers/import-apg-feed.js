require('dotenv').config({ path: '.env.local' });

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const APG_VENDOR_ID = '013cd9a7-171e-45fe-9421-0320319dce33';
const FEED_PATH = path.join(process.cwd(), 'tmp', 'premier_data_feed_master.csv');
const IMPORT_LIMIT = 0;   // 0 = no limit
const DRY_RUN = true;     // set false to actually write to Supabase

// SKUs with known-bad images in Premier's feed (force null).
// When you find more, add the SKU here.
const IMAGE_BLACKLIST = new Set([
  'BDD1045297',  // Premier has BMW image for BD Diesel S366SXE Dodge Cummins turbo
]);

// =====================================================================
// THE FILTER
// =====================================================================

const HARD_EXCLUDE = [
  // Powersports brands (mostly ATVs, dirt bikes, snowmobiles)
  /\bSuzuki\b/i, /\bKawasaki\b/i, /\bYamaha\b/i, /\bHarley-?Davidson\b/i,
  /\bDucati\b/i, /\bKTM\b/i, /\bHusqvarna\b/i, /\bPolaris\b/i,
  /\bCan-?Am\b/i, /\bArctic\s*Cat\b/i, /\bSea-?Doo\b/i, /\bJet\s*Ski\b/i,
  // Common powersports model patterns
  /\bRMX\d+\b/i, /\bYZ\d+\b/i, /\bCR[FX]?\d+\b/i, /\bKX\d+\b/i,
  /\bKLR\d+\b/i, /\bDR-?Z\d+\b/i, /\bRZR\b/i, /\bRanger\s+XP\b/i,
  /\bHonda\b/i, /\bToyota\b/i, /\bNissan\b/i, /\bSubaru\b/i, /\bHyundai\b/i, /\bKia\b/i,
  /\bMazda\b/i, /\bLexus\b/i, /\bAcura\b/i, /\bInfiniti\b/i, /\bMitsubishi\b/i,
  /\bBMW\b/i, /\bAudi\b/i, /\bVolkswagen\b/i, /\s+VW\s+/i, /\bPorsche\b/i,
  /\bMercedes-Benz\b/i, /\bJaguar\b/i, /\bLand\s*Rover\b/i, /\bRange\s*Rover\b/i,
  /\bMini\s*Cooper\b/i, /\bFiat\b/i, /\bVolvo\b/i, /\bSaab\b/i, /\bSmart\s+Car\b/i,
  /\bGolf\b/i, /\bJetta\b/i, /\bPassat\b/i, /\bTouareg\b/i, /\bAmarok\b/i, /\bBeetle\b/i,
  /\bCayenne\b/i, /\bMacan\b/i, /\bPanamera\b/i, /\bE-?Class\b/i, /\bC-?Class\b/i,
  /\bRanger\b/i, /\bS-?10\b/i, /\bColorado\b/i, /\bCanyon\b/i, /\bDakota\b/i,
  /\bFrontier\b/i, /\bTacoma\b/i, /\bTundra\b/i, /\bTitan\b/i, /\bRidgeline\b/i,
  /\bF-?150\b/i,
  /\bMustang\b/i, /\bCamaro\b/i, /\bCorvette\b/i, /\bChallenger\b/i, /\bCharger\b/i,
  /\bExplorer\b/i, /\bEdge\b/i, /\bEscape\b/i, /\bBronco\b/i,
  /\bLincoln\b/i, /\bMark\s+LT\b/i,
  /\bmotorcycle\b/i, /\bATV\b/i, /\bUTV\b/i, /\bsnowmobile\b/i, /\bside-?by-?side\b/i,
  /\bdirt\s*bike\b/i, /\bquad\b/i,
  /\bNeon\b/i, /\bMiata\b/i, /\bLotus\b/i, /\bFerrari\b/i, /\bLamborghini\b/i,
  // Mercedes sub-models (often appear without "Mercedes-Benz" prefix)
  /\bCLK\b/i, /\bSL-?Class\b/i, /\bSL\d+\b/i, /\bCLS\b/i, /\bCLA\b/i,
  /\bGL[A-Z]?\b/i, /\bML\b/i, /\bGLK\b/i, /\bSmart\b/i,
  // More Euro car models
  /\bSaab\s*\d/i, /\bAlfa\s*Romeo\b/i, /\bBentley\b/i, /\bMaserati\b/i,
  /\bAston\s*Martin\b/i, /\bMaybach\b/i, /\bSmart\s*Car\b/i,
  // More light-duty GM/Ford/Dodge cars
  /\bCavalier\b/i, /\bSonic\b/i, /\bCruze\b/i, /\bImpala\b/i, /\bMalibu\b/i,
  /\bEquinox\b/i, /\bTerrain\b/i, /\bAcadia\b/i, /\bTraverse\b/i,
  /\bCobalt\b/i, /\bAveo\b/i, /\bHHR\b/i, /\bLumina\b/i, /\bMonte\s*Carlo\b/i,
  /\bFocus\b/i, /\bFusion\b/i, /\bTaurus\b/i, /\bFiesta\b/i, /\bContour\b/i,
  /\bExpedition\b/i, /\bFlex\b/i, /\bFive\s*Hundred\b/i,
  /\bCaliber\b/i, /\bAvenger\b/i, /\bStratus\b/i, /\bMagnum\b/i,
  /\bPT\s*Cruiser\b/i, /\bAspen\b/i, /\bCrossfire\b/i,
  // More Japanese/Korean cars that slipped through
  /\bSentra\b/i, /\bAltima\b/i, /\bMaxima\b/i, /\bQuest\b/i, /\bMurano\b/i,
  /\bArmada\b/i, /\bPathfinder\b/i, /\bXterra\b/i, /\bJuke\b/i,
  /\bCamry\b/i, /\bCorolla\b/i, /\bPrius\b/i, /\bRAV4\b/i, /\b4Runner\b/i,
  /\bHighlander\b/i, /\bSequoia\b/i, /\bSienna\b/i, /\bAvalon\b/i,
  /\bCivic\b/i, /\bAccord\b/i, /\bCR-?V\b/i, /\bPilot\b/i, /\bOdyssey\b/i,
  /\bPassport\b/i, /\bFit\b/i, /\bS2000\b/i, /\bNSX\b/i,
  /\bImpreza\b/i, /\bLegacy\b/i, /\bOutback\b/i, /\bForester\b/i, /\bWRX\b/i,
  /\bSonata\b/i, /\bElantra\b/i, /\bTucson\b/i, /\bSantaFe\b/i, /\bSanta\s*Fe\b/i,
  /\bSorento\b/i, /\bSportage\b/i, /\bOptima\b/i, /\bRio\b/i, /\bSoul\b/i,
  // More powersports / non-car brands
  /\bAprilia\b/i, /\bVespa\b/i, /\bMoto\s*Guzzi\b/i, /\bPiaggio\b/i,
  /\bTriumph\b/i, /\bBSA\b/i, /\bVictory\b/i, /\bIndian\s*Motorcycle\b/i,
  /\bHellcat\b/i,
  /\bHemi\b/i,
  /\bPart\s*Alliance\b/i,
];

const HD_DIESEL_TRUCK = [
  /\bF-?250\b/i, /\bF-?350\b/i, /\bF-?450\b/i, /\bF-?550\b/i, /\bSuper\s*Duty\b/i,
  /\bExcursion\b/i,
  /\b[23456]500\b/i,
  /\bE-?series\b/i,
  /\bDodge\s*Ram\b/i, /\bRam\s+Truck\b/i,
  /\bSilverado\s*[23456]500\b/i, /\bSierra\s*[23456]500\b/i,
  /\bKodiak\b/i, /\bTopkick\b/i,
  /\bSuburban\s*[23]500\b/i
];

const DIESEL_ENGINE = [
  /\bcummins\b/i, /\b5\.?9L?\s*(12V|24V|Cummins)/i, /\b6\.?7L?\s*Cummins\b/i,
  /\b12V\b.*\bcummins\b/i, /\b24V\b.*\bcummins\b/i,
  /\bPower\s*Stroke\b/i, /\bPowerstroke\b/i, /\bPSD\b/i,
  /\b7\.?3L?\s*(Power|IDI|Diesel|PSD)/i,
  /\b6\.?0L?\s*(Power|Diesel|PSD)/i,
  /\b6\.?4L?\s*(Power|Diesel|PSD)/i,
  /\b6\.?7L?\s*(Power|Diesel|PSD|Ford)/i,
  /\bDuramax\b/i, /\b6\.?6L?\s*Duramax\b/i,
  /\bLB7\b/i, /\bLLY\b/i, /\bLBZ\b/i, /\bLMM\b/i, /\bLML\b/i, /\bL5P\b/i,
  /\bIDI\b/i, /\bturbo.?diesel\b/i
];

const TRULY_UNIVERSAL_SUBCATEGORIES = new Set([
  'Functional Fluid Lubricant Grease (including Additives)',
  'Cleaning Products',
  'Hand Tools',
  'Shop Equipment',
  'Fuel System Service',
  'Air Tools',
  'Engine Service',
  'Safety Products',
  'Clothing',
  'Fasteners',
  'Electrical Connectors',
  'Wire Cable and Related Components',
  'Flasher Units Fuses and Circuit Breakers'
]);

const DIESEL_AGNOSTIC_CATEGORIES = new Set([
  'Electrical Charging and Starting',
  'Heating and Air Conditioning',
  'Interior Accessories',
  'Exterior Accessories',
  'Safety and Security',
  'Heat and Sound Management',
  'Lighting and Electrical Body',
]);

const UNIVERSAL_PART_KEYWORDS = [
  /\balternator\b/i,
  /\bstarter\s+(motor|drive|solenoid)?/i,
  /\bbattery\s+(terminal|cable|tray|hold.?down|post|isolator)?/i,
  /\bstereo\b/i, /\bhead\s*unit\b/i, /\bsubwoofer\b/i, /\bamplifier\b/i,
  /\bspeaker\b/i, /\btweeter\b/i,
  /\bgauge\s+(set|kit|cluster|pod)?/i,
  /\blight\s*bar\b/i, /\brock\s*light/i,
  /\bwinch\b/i,
  /\bbull\s*bar\b/i, /\bgrille\s+guard\b/i,
  /\bbed\s*liner\b/i, /\bbed\s*mat\b/i,
  /\bfloor\s*mat\b/i, /\bseat\s*cover\b/i,
  /\btool\s*box\b/i,
  /\bfifth\s*wheel\b/i, /\bgooseneck\b/i,
  /\btrailer\s+(hitch|brake|plug)/i,
  /\bair\s*compressor\b/i,
  /\bfire\s+extinguisher\b/i,
  /\bfirst\s+aid\b/i,
  /\bcb\s+radio\b/i, /\bham\s+radio\b/i,
  /\bgps\b/i, /\bdash\s*cam\b/i,
];

const TRUCK_SPECIFIC_CATEGORIES = new Set([
  'Body', 'Engine', 'Driveline and Axles', 'Air and Fuel Delivery',
  'Exhaust', 'Suspension', 'Brake', 'Transmission', 'Belts and Cooling',
  'Steering', 'Transfer Case', 'Emission Control', 'HVAC', 'Ignition',
  'Wiper and Washer', 'Tire and Wheel'
]);

// =====================================================================
// HELPERS
// =====================================================================

function clean(value) {
  if (value === null || value === undefined) return null;
  let v = String(value).trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1).trim();
  }
  if (!v.length) return null;
  if (v === 'NA' || v === 'N/A' || v === 'null' || v === 'NULL') return null;
  return v;
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).trim().replace(/[$,"]/g, '');
  if (!cleaned || cleaned === 'NA') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toInt(value) {
  const n = toNumber(value);
  return n === null ? 0 : Math.max(0, Math.floor(n));
}

function parseCoreCharge(value) {
  const n = toNumber(value);
  if (n === null || n <= 0) return 0;
  // Cores over $5000 are almost always CSV parse errors (UPCs read as prices).
  // Real cores max out around $2500 (Allison transmissions).
  if (n > 5000) return 0;
  return roundMoney(n);
}

function roundMoney(n) {
  return Number(Number(n).toFixed(2));
}

function totalStock(row) {
  return toInt(row['NV whse']) + toInt(row['KY whse']) + toInt(row['WA whse']) + toInt(row['MFG Invt']);
}

function pickPrice(row) {
  const map = toNumber(row['MAP']);
  const retail = toNumber(row['Retail']);
  const customerPrice = toNumber(row['Customer Price']);
  const jobber = toNumber(row['Jobber']);
  if (map && map > 0) return roundMoney(map);
  if (retail && retail > 0) return roundMoney(retail);
  if (customerPrice && customerPrice > 0) return roundMoney(customerPrice);
  if (jobber && jobber > 0) return roundMoney(jobber * 1.3);
  return 0;
}

function productStatus(row) {
  const inventoryStatus = clean(row['Inventory Status'])?.toLowerCase() || '';
  if (inventoryStatus.includes('discontinued')) return 'archived';
  return 'active';
}

function matchesAnyPattern(text, patterns) {
  if (!text) return false;
  return patterns.some(p => p.test(text));
}

function rewriteImageUrl(url, sku) {
  if (!url) return null;
  if (sku && IMAGE_BLACKLIST.has(sku)) return null;
  return url.replace(
    'https://dealer.premierwd.com/ManagedResources/Images/ProductImages',
    'https://images.black-stack-diesel.com'
  );
}

// =====================================================================
// FITMENT PARSER
// =====================================================================

function parseFitment(productName, description) {
  const text = [productName, description].filter(Boolean).join(' ');
  const makes = new Set();
  const engines = new Set();
  const years = new Set();

  if (/\bF-?[2345]50\b|\bSuper\s*Duty\b|\bExcursion\b/i.test(text)) makes.add('Ford');
  if (/\bRam\s*[23456]500\b|\bDodge\s*Ram\b/i.test(text)) {
    if (/\bRam\b/i.test(text)) makes.add('Ram');
    if (/\bDodge\b/i.test(text)) makes.add('Dodge');
  }
  if (/\bSilverado\s*[234]500\b/i.test(text) || (/\bChevrolet\b/i.test(text) && /[234]500|duramax|LB7|LLY|LBZ|LMM|LML|L5P/i.test(text))) {
    makes.add('Chevrolet');
  }
  if (/\bSierra\s*[234]500\b/i.test(text) || (/\bGMC\b/i.test(text) && /[234]500|duramax|LB7|LLY|LBZ|LMM|LML|L5P/i.test(text))) {
    makes.add('GMC');
  }

  if (/\b7\.?3L?\b.*\b(Power\s*Stroke|PSD|Ford|IDI)/i.test(text)) {
    if (/\bIDI\b/i.test(text)) engines.add('7.3L IDI Turbo Diesel');
    else engines.add('7.3L Power Stroke');
  }
  if (/\b6\.?0L?\b.*\b(Power\s*Stroke|PSD)/i.test(text)) engines.add('6.0L Power Stroke');
  if (/\b6\.?4L?\b.*\b(Power\s*Stroke|PSD)/i.test(text)) engines.add('6.4L Power Stroke');
  if (/\b6\.?7L?\b.*\b(Power\s*Stroke|PSD|Ford)/i.test(text)) engines.add('6.7L Power Stroke');
  if (/\b5\.?9L?\b.*\bCummins\b/i.test(text)) {
    if (/\b12V\b/i.test(text) || /\b94-?98|\b199[4-8]\b/.test(text)) engines.add('5.9L 12V Cummins');
    else engines.add('5.9L 24V Cummins ISB');
  }
  if (/\b6\.?7L?\b.*\bCummins\b/i.test(text)) engines.add('6.7L Cummins ISB');
  if (/\bLB7\b/i.test(text)) engines.add('6.6L Duramax LB7');
  if (/\bLLY\b/i.test(text)) engines.add('6.6L Duramax LLY');
  if (/\bLBZ\b/i.test(text)) engines.add('6.6L Duramax LBZ');
  if (/\bLMM\b/i.test(text)) engines.add('6.6L Duramax LMM');
  if (/\bLML\b/i.test(text)) engines.add('6.6L Duramax LML');
  if (/\bL5P\b/i.test(text)) engines.add('6.6L Duramax L5P');

  const fourDigitMatches = text.matchAll(/\b(19[89]\d|20[0-2]\d)\b/g);
  for (const m of fourDigitMatches) {
    const y = parseInt(m[1], 10);
    if (y >= 1988 && y <= 2026) years.add(y);
  }
  const rangeMatches = text.matchAll(/\b(\d{2})-(\d{2})\b/g);
  for (const m of rangeMatches) {
    let start = parseInt(m[1], 10);
    let end = parseInt(m[2], 10);
    start = start >= 88 ? 1900 + start : 2000 + start;
    end = end >= 88 ? 1900 + end : 2000 + end;
    if (start >= 1988 && end <= 2026 && end - start < 30 && end >= start) {
      for (let y = start; y <= end; y++) years.add(y);
    }
  }

  return {
    makes: Array.from(makes),
    engines: Array.from(engines),
    years: Array.from(years).sort((a, b) => a - b)
  };
}

// =====================================================================
// FILTER LOGIC
// =====================================================================

function shouldImport(row) {
  const sku = clean(row['Premier Part Number']);
  const productName = clean(row['Long Description']);
  const category = clean(row['Part Category']);
  const subcategory = clean(row['Part Subcategory']);
  const terminology = clean(row['Part Terminology']);
  const approvedLine = clean(row['Approved Line']);

  if (!sku || !productName) return false;
  if (approvedLine && approvedLine.toLowerCase() === 'no') return false;

  const fullText = [productName, category, subcategory, terminology].filter(Boolean).join(' ');

  if (matchesAnyPattern(fullText, HARD_EXCLUDE)) return false;

  const hasHDTruck = matchesAnyPattern(fullText, HD_DIESEL_TRUCK);
  const hasDieselEngine = matchesAnyPattern(fullText, DIESEL_ENGINE);
  if (hasHDTruck || hasDieselEngine) return true;

  if (subcategory && TRULY_UNIVERSAL_SUBCATEGORIES.has(subcategory)) return true;

  if (category && DIESEL_AGNOSTIC_CATEGORIES.has(category)) return true;

  if (productName && matchesAnyPattern(productName, UNIVERSAL_PART_KEYWORDS)) {
    return true;
  }

  if (category && TRUCK_SPECIFIC_CATEGORIES.has(category)) return false;

  return false;
}

function buildDescription(row) {
  const external = clean(row['External Long Description']);
  const longDesc = clean(row['Long Description']);
  const category = clean(row['Part Category']);
  const subcategory = clean(row['Part Subcategory']);
  const terminology = clean(row['Part Terminology']);
  const brand = clean(row['Brand']);
  const mfgPart = clean(row['Mfg Part Number']);
  const upc = clean(row['Upc']);

  return [
    external,
    !external ? longDesc : null,
    brand ? `Brand: ${brand}` : null,
    mfgPart ? `MFG Part #: ${mfgPart}` : null,
    upc ? `UPC: ${upc}` : null,
    category ? `Category: ${category}` : null,
    subcategory ? `Subcategory: ${subcategory}` : null,
    terminology ? `Type: ${terminology}` : null
  ].filter(Boolean).join('\n');
}

function mapRow(row) {
  const sku = clean(row['Premier Part Number']);
  const productName = clean(row['Long Description']) || sku;
  const brand = clean(row['Brand']);
  const stockQty = totalStock(row);
  const weight = toNumber(row['Weight']);
  const shippingCost = roundMoney((toNumber(row['Freight Cost']) || 0) + (toNumber(row['Drop Ship Fee']) || 0));
  const coreCharge = parseCoreCharge(row['Core Charge']);
  const hasCore = coreCharge > 0 || clean(row['ItemWithCores'])?.toLowerCase() === 'yes';
  const price = pickPrice(row);
  const status = productStatus(row);
  const description = buildDescription(row);

  const fitment = parseFitment(productName, description);

  const fitmentText = [
    clean(row['Part Category']),
    clean(row['Part Subcategory']),
    clean(row['Part Terminology'])
  ].filter(Boolean).join(' | ') || null;

  return {
    vendor_id: APG_VENDOR_ID,
    product_name: productName,
    sku,
    brand,
    price,
    core_charge: coreCharge,
    has_core: hasCore,
    shipping_cost: shippingCost,
    stock_qty: stockQty,
    category: clean(row['Part Category']),
    condition: 'new',
    fitment_text: fitmentText,
    fitment_makes: fitment.makes,
    fitment_engines: fitment.engines,
    fitment_years: fitment.years,
    description,
    image_url: rewriteImageUrl(clean(row['ImageURL']), sku),
    weight_lbs: weight,
    source: 'distributor',
    source_ref: sku,
    status,
    is_visible: true
  };
}

// =====================================================================
// MAIN
// =====================================================================

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local');
  }
  if (!fs.existsSync(FEED_PATH)) {
    throw new Error(`Feed file not found: ${FEED_PATH}`);
  }

  console.log('Reading feed...');
  const csvText = fs.readFileSync(FEED_PATH, 'utf8');

  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    trim: true,
    quote: false
  });

  console.log(`Parsed ${rows.length} rows from feed`);

  const filtered = rows.filter(shouldImport);
  console.log(`${filtered.length} rows pass diesel filter (${((filtered.length / rows.length) * 100).toFixed(1)}%)`);

  const limited = IMPORT_LIMIT > 0 ? filtered.slice(0, IMPORT_LIMIT) : filtered;
  const mapped = limited.map(mapRow);

  const withMakes = mapped.filter(m => m.fitment_makes.length > 0).length;
  const withEngines = mapped.filter(m => m.fitment_engines.length > 0).length;
  const withYears = mapped.filter(m => m.fitment_years.length > 0).length;
  console.log(`Fitment parsed: ${withMakes} with makes, ${withEngines} with engines, ${withYears} with years`);

  if (DRY_RUN) {
    console.log('\nDRY RUN — no writes to Supabase.');
    console.log('\n=== 15 random samples ===');
    const shuffled = [...mapped].sort(() => Math.random() - 0.5);
    for (let i = 0; i < Math.min(15, shuffled.length); i++) {
      const p = shuffled[i];
      console.log(`\n${i + 1}. ${p.product_name.substring(0, 90)}`);
      const coreDisplay = p.has_core ? ` | Core: $${p.core_charge}` : '';
      console.log(`   Brand: ${p.brand} | Category: ${p.category} | $${p.price}${coreDisplay}`);
      console.log(`   Makes: [${p.fitment_makes.join(', ')}] | Engines: [${p.fitment_engines.join(', ')}]`);
    }
    const withCoreData = mapped.filter(m => m.has_core).length;
    const coreChargeTotal = mapped.reduce((sum, m) => sum + (m.core_charge || 0), 0);
    console.log(`Core charge products: ${withCoreData} (avg $${(coreChargeTotal / Math.max(withCoreData, 1)).toFixed(2)})`);
    console.log(`\nWould import ${mapped.length} products. Set DRY_RUN=false to actually write.`);
    return;
  }

  console.log(`Prepared ${mapped.length} rows for import`);
  const chunkSize = 500;

  for (let i = 0; i < mapped.length; i += chunkSize) {
    const chunk = mapped.slice(i, i + chunkSize);
    const { error } = await supabase
      .from('products')
      .upsert(chunk, { onConflict: 'vendor_id,sku' });

    if (error) {
      console.error('Upsert failed on chunk starting at row', i, error);
      throw error;
    }

    console.log(`Upserted ${Math.min(i + chunk.length, mapped.length)} / ${mapped.length}`);
  }

  console.log('\n✅ APG import complete');
}

main().catch((err) => {
  console.error('❌ Import failed:', err.message);
  process.exit(1);
});
