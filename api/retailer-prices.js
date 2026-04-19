export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing query' });

  const retailer = (req.query.retailer || '').toLowerCase();
  if (!retailer) return res.status(400).json({ error: 'Missing retailer param (amazon, costco, jewel)' });

  const apiKey = req.query.key || process.env.SCRAPERAPI_KEY;
  if (!apiKey) return res.status(500).json({ error: 'SCRAPERAPI_KEY not configured' });

  const encodedQuery = encodeURIComponent(q);

  const targets = {
    amazon: {
      retailer: 'Amazon',
      url: `https://www.amazon.com/s?k=${encodedQuery}`,
      parse: parseAmazon,
    },
    costco: {
      retailer: 'Costco',
      url: `https://www.instacart.com/store/costco/search/${encodedQuery}`,
      parse: parseInstacart,
    },
    jewel: {
      retailer: 'Jewel-Osco',
      url: `https://www.instacart.com/store/jewel-osco/search/${encodedQuery}`,
      parse: parseInstacart,
    },
  };

  const t = targets[retailer];
  if (!t) return res.status(400).json({ error: 'Unknown retailer. Use: amazon, costco, jewel' });

  try {
    const scraperUrl =
      `https://api.scraperapi.com?api_key=${encodeURIComponent(apiKey)}` +
      `&url=${encodeURIComponent(t.url)}&render=true`;
    const resp = await fetch(scraperUrl, { signal: AbortSignal.timeout(9000) });
    if (!resp.ok) {
      return res.status(200).json({ retailer: t.retailer, products: [], error: `ScraperAPI HTTP ${resp.status}` });
    }
    const html = await resp.text();
    const products = t.parse(html, t.retailer);
    return res.status(200).json({ retailer: t.retailer, products });
  } catch (err) {
    return res.status(200).json({ retailer: t.retailer, products: [], error: err.message || 'fetch failed' });
  }
}

// ── Amazon Parser ────────────────────────────────────────────────────────────

function parseAmazon(html, retailer) {
  const products = [];
  const cards = html.split('data-component-type="s-search-result"');
  for (let i = 1; i < cards.length && products.length < 10; i++) {
    const card = cards[i];
    try {
      // Brand
      const brandMatch = card.match(/a-size-base-plus a-color-base">([^<]+)/);
      const brand = brandMatch ? brandMatch[1].trim() : '';

      // Title — try span inside h2, then h2 aria-label
      let title = '';
      const titleMatch = card.match(/a-size-base-plus a-spacing-none a-color-base a-text-normal"><span>([^<]+)/);
      if (titleMatch) {
        title = titleMatch[1].trim();
      } else {
        const ariaMatch = card.match(/aria-label="([^"]+)"[^>]*class="a-size-base-plus[^"]*a-text-normal/);
        if (ariaMatch) title = ariaMatch[1].trim();
      }
      if (!title) continue;

      // Also try image alt for fuller title with size info
      const imgAltMatch = card.match(/alt="([^"]{10,})"[^>]*class="s-image"/);
      const imgAlt = imgAltMatch ? imgAltMatch[1].trim() : '';
      // Use whichever is longer (image alt often has more size detail)
      const fullTitle = imgAlt.length > title.length ? imgAlt : (brand && !title.startsWith(brand) ? `${brand} ${title}` : title);

      // Link
      const linkMatch = card.match(/href="(\/[^"]*\/dp\/[^"]+)"/);
      const link = linkMatch ? 'https://www.amazon.com' + linkMatch[1].split('&amp;').join('&').split('?')[0] : '';

      // Price — first a-offscreen in the price area
      const priceMatch = card.match(/<span class="a-price"[^>]*data-a-size="xl"[^>]*>.*?<span class="a-offscreen">([^<]+)/s);
      const priceStr = priceMatch ? priceMatch[1].trim() : '';
      const price = parsePrice(priceStr);
      if (!price) continue;

      // Unit price — Amazon shows e.g. "($2.28/100 Sheets)" or "($0.05/Count)"
      const unitMatch = card.match(/\(.*?<span class="a-offscreen">([^<]+)<\/span>[^)]*\/([\w\s]+)\)/s);
      let unitPrice = null;
      let unitLabel = '';
      if (unitMatch) {
        unitPrice = parsePrice(unitMatch[1]);
        unitLabel = normalizeUnitLabel(unitMatch[2].trim());
        // Normalize Amazon's unit price to match our standard labels
        const normalized = normalizeAmazonUnit(unitPrice, unitLabel);
        unitPrice = normalized.unitPrice;
        unitLabel = normalized.unitLabel;
      }

      // If no explicit unit price, calculate from title
      if (!unitPrice) {
        const calc = calcUnitPrice(fullTitle, price);
        if (calc) {
          unitPrice = calc.unitPrice;
          unitLabel = calc.unitLabel;
        }
      }

      products.push({
        retailer,
        title: fullTitle,
        price: priceStr,
        priceNum: price,
        unitPrice: unitPrice ? unitPrice.toFixed(4) : null,
        unitLabel: unitLabel || null,
        link,
      });
    } catch (e) {
      // Skip malformed card
    }
  }
  return products;
}

// ── Instacart Parser ─────────────────────────────────────────────────────────

function parseInstacart(html, retailer) {
  const products = [];

  const cardParts = html.split(/href="(\/products\/[^"]+)"/);
  for (let i = 1; i < cardParts.length && products.length < 10; i += 2) {
    const href = cardParts[i];
    const after = cardParts[i + 1] || '';
    const before = cardParts[i - 1] || '';

    try {
      // Title from heading div
      const titleMatch = after.match(/role="heading"[^>]*>([^<]+)/);
      let title = titleMatch ? titleMatch[1].trim() : '';

      // Fallback: image alt
      if (!title) {
        const altMatch = before.match(/alt="([^"]+)"\s*class="e-/);
        title = altMatch ? altMatch[1].trim() : '';
      }
      if (!title) continue;

      // Price from screen-reader-only text
      const priceMatch = after.match(/Current price:\s*\$([0-9]+\.[0-9]{2})/);
      const priceStr = priceMatch ? '$' + priceMatch[1] : '';
      const price = parsePrice(priceStr);
      if (!price) continue;

      // Size info
      const sizeMatch = after.match(/class="e-cauxk8">([^<]+)/);
      const sizeText = sizeMatch ? sizeMatch[1].trim() : '';

      const link = 'https://www.instacart.com' + href.split('"')[0];

      // Calculate unit price from title + size
      const combined = title + (sizeText ? ', ' + sizeText : '');
      const calc = calcUnitPrice(combined, price);

      products.push({
        retailer,
        title,
        price: priceStr,
        priceNum: price,
        unitPrice: calc ? calc.unitPrice.toFixed(4) : null,
        unitLabel: calc ? calc.unitLabel : null,
        link,
      });
    } catch (e) {
      // Skip malformed card
    }
  }
  return products;
}

// ── Unit Price Calculation ───────────────────────────────────────────────────
// All weights normalize to $/oz. All counts normalize to $/ct.
// Paper products normalize to $/100 sheets when possible, else $/roll.

function calcUnitPrice(title, totalPrice) {
  const t = title.toLowerCase();

  // Paper products: sheets × count → per 100 sheets
  const sheetsMatch = t.match(/(\d+)\s*sheets/);
  const countMatch = t.match(/(\d+)\s*[-\s]?\s*(count|ct|pk|pack|rolls?)\b/);

  if (sheetsMatch && countMatch) {
    const sheets = parseInt(sheetsMatch[1]);
    const count = parseInt(countMatch[1]);
    const totalSheets = sheets * count;
    if (totalSheets > 0) {
      return { unitPrice: (totalPrice / totalSheets) * 100, unitLabel: '100sh' };
    }
  }

  // Rolls only (no sheet count)
  if (!sheetsMatch && countMatch && /rolls?/i.test(countMatch[2])) {
    const count = parseInt(countMatch[1]);
    if (count > 0) {
      return { unitPrice: totalPrice / count, unitLabel: 'roll' };
    }
  }

  // ── Weight: normalize everything to $/oz ──

  // fl oz first (before oz to avoid "fl oz" matching just "oz")
  const flozMatch = t.match(/([\d.]+)\s*fl\.?\s*oz\b/);
  if (flozMatch) {
    const floz = parseFloat(flozMatch[1]);
    if (floz > 0) return { unitPrice: totalPrice / floz, unitLabel: 'fl oz' };
  }

  // oz (not preceded by "fl")
  const ozMatch = t.match(/([\d.]+)\s*oz\b/);
  if (ozMatch && !t.match(new RegExp(ozMatch[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(ozMatch[1], '[\\d.]+\\s*fl\\.?\\s*')))) {
    const oz = parseFloat(ozMatch[1]);
    if (oz > 0) return { unitPrice: totalPrice / oz, unitLabel: 'oz' };
  }

  // lb → oz
  const lbMatch = t.match(/([\d.]+)\s*lbs?\b/);
  if (lbMatch) {
    const oz = parseFloat(lbMatch[1]) * 16;
    if (oz > 0) return { unitPrice: totalPrice / oz, unitLabel: 'oz' };
  }

  // kg → oz
  const kgMatch = t.match(/([\d.]+)\s*kg\b/);
  if (kgMatch) {
    const oz = parseFloat(kgMatch[1]) * 35.274;
    if (oz > 0) return { unitPrice: totalPrice / oz, unitLabel: 'oz' };
  }

  // g → oz (but not "gallon" — require word boundary)
  const gMatch = t.match(/([\d.]+)\s*g\b(?!al)/);
  if (gMatch) {
    const oz = parseFloat(gMatch[1]) / 28.3495;
    if (oz > 0) return { unitPrice: totalPrice / oz, unitLabel: 'oz' };
  }

  // gallon → fl oz
  const galMatch = t.match(/([\d.]+)\s*(gallons?|gal)\b/);
  if (galMatch) {
    const floz = parseFloat(galMatch[1]) * 128;
    if (floz > 0) return { unitPrice: totalPrice / floz, unitLabel: 'fl oz' };
  }

  // liter → fl oz
  const literMatch = t.match(/([\d.]+)\s*(liters?|l)\b/);
  if (literMatch) {
    const floz = parseFloat(literMatch[1]) * 33.814;
    if (floz > 0) return { unitPrice: totalPrice / floz, unitLabel: 'fl oz' };
  }

  // ml → fl oz
  const mlMatch = t.match(/([\d.]+)\s*ml\b/);
  if (mlMatch) {
    const floz = parseFloat(mlMatch[1]) / 29.5735;
    if (floz > 0) return { unitPrice: totalPrice / floz, unitLabel: 'fl oz' };
  }

  // ── Count-based ──

  if (countMatch && !/rolls?/i.test(countMatch[2])) {
    const count = parseInt(countMatch[1]);
    if (count > 0) {
      return { unitPrice: totalPrice / count, unitLabel: 'ct' };
    }
  }

  const miscMatch = t.match(/(\d+)\s*[-\s]?\s*(pods?|bags?|capsules?|tablets?|bars?|cans?|ea|each)\b/);
  if (miscMatch) {
    const count = parseInt(miscMatch[1]);
    if (count > 0) {
      return { unitPrice: totalPrice / count, unitLabel: 'ct' };
    }
  }

  return null;
}

// ── Normalize Amazon's unit labels to match our standard ────────────────────

function normalizeAmazonUnit(unitPrice, label) {
  const l = label.toLowerCase().trim();

  // Already standard
  if (l === 'oz' || l === 'ounce') return { unitPrice, unitLabel: 'oz' };
  if (l === 'fl oz' || l === 'fluid ounce') return { unitPrice, unitLabel: 'fl oz' };
  if (l === 'count' || l === 'ct' || l === 'each') return { unitPrice, unitLabel: 'ct' };
  if (l === '100 sheets') return { unitPrice, unitLabel: '100sh' };

  // Pound → convert to $/oz
  if (l === 'pound' || l === 'lb') return { unitPrice: unitPrice / 16, unitLabel: 'oz' };

  // Keep as-is for anything else
  return { unitPrice, unitLabel: l };
}

function normalizeUnitLabel(label) {
  return label.replace(/\s+/g, ' ').trim();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parsePrice(str) {
  if (!str) return null;
  const m = str.replace(/[^0-9.]/g, '');
  const n = parseFloat(m);
  return isNaN(n) ? null : n;
}
