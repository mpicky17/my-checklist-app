export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing query' });

  const apiKey = req.query.key || process.env.SCRAPERAPI_KEY;
  if (!apiKey) return res.status(500).json({ error: 'SCRAPERAPI_KEY not configured' });

  const encodedQuery = encodeURIComponent(q);
  const targets = [
    {
      retailer: 'Amazon',
      url: `https://www.amazon.com/s?k=${encodedQuery}`,
      parse: parseAmazon,
    },
    {
      retailer: 'Costco',
      url: `https://www.instacart.com/store/costco/search/${encodedQuery}`,
      parse: parseInstacart,
      storeName: 'Costco',
    },
    {
      retailer: 'Jewel-Osco',
      url: `https://www.instacart.com/store/jewel-osco/search/${encodedQuery}`,
      parse: parseInstacart,
      storeName: 'Jewel-Osco',
    },
  ];

  const results = await Promise.allSettled(
    targets.map(async (t) => {
      try {
        const scraperUrl =
          `https://api.scraperapi.com?api_key=${encodeURIComponent(apiKey)}` +
          `&url=${encodeURIComponent(t.url)}&render=true`;
        const resp = await fetch(scraperUrl, { signal: AbortSignal.timeout(45000) });
        if (!resp.ok) return { retailer: t.retailer, products: [], error: `HTTP ${resp.status}` };
        const html = await resp.text();
        const products = t.parse(html, t.retailer, t.storeName);
        return { retailer: t.retailer, products };
      } catch (err) {
        return { retailer: t.retailer, products: [], error: err.message || 'fetch failed' };
      }
    })
  );

  const output = results.map((r) => (r.status === 'fulfilled' ? r.value : { retailer: 'Unknown', products: [], error: r.reason }));
  res.status(200).json({ retailers: output });
}

// ── Amazon Parser ────────────────────────────────────────────────────────────

function parseAmazon(html, retailer) {
  const products = [];
  // Split by search result cards
  const cards = html.split('data-component-type="s-search-result"');
  // Skip first chunk (before first result)
  for (let i = 1; i < cards.length && products.length < 10; i++) {
    const card = cards[i];
    try {
      // Brand
      const brandMatch = card.match(/a-size-base-plus a-color-base">([^<]+)/);
      const brand = brandMatch ? brandMatch[1].trim() : '';

      // Title from h2 aria-label or span text
      const titleMatch = card.match(/a-size-base-plus a-spacing-none a-color-base a-text-normal"><span>([^<]+)/);
      const title = titleMatch ? titleMatch[1].trim() : '';
      if (!title) continue;

      const fullTitle = brand ? `${brand} ${title}` : title;

      // Link
      const linkMatch = card.match(/href="(\/[^"]*\/dp\/[^"]+)"/);
      const link = linkMatch ? 'https://www.amazon.com' + linkMatch[1].split('&amp;').join('&').split('?')[0] : '';

      // Price — first a-offscreen in the price area
      const priceMatch = card.match(/<span class="a-price"[^>]*data-a-size="xl"[^>]*>.*?<span class="a-offscreen">([^<]+)/s);
      const priceStr = priceMatch ? priceMatch[1].trim() : '';
      const price = parsePrice(priceStr);
      if (!price) continue;

      // Unit price — Amazon shows e.g. "($2.28/100 Sheets)"
      const unitMatch = card.match(/\(.*?<span class="a-offscreen">([^<]+)<\/span>[^)]*\/([\w\s]+)\)/s);
      let unitPrice = null;
      let unitLabel = '';
      if (unitMatch) {
        unitPrice = parsePrice(unitMatch[1]);
        unitLabel = unitMatch[2].trim();
      }

      // If no explicit unit price, try to calculate from title
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
        unitPrice: unitPrice ? unitPrice.toFixed(2) : null,
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

  // Find product cards by the product link pattern
  const cardParts = html.split(/href="(\/products\/[^"]+)"/);
  // cardParts: [before, href1, after1, href2, after2, ...]
  for (let i = 1; i < cardParts.length && products.length < 10; i += 2) {
    const href = cardParts[i];
    const after = cardParts[i + 1] || '';
    // Also look back at the chunk before this href for image alt
    const before = cardParts[i - 1] || '';

    try {
      // Title from heading div or image alt
      const titleMatch = after.match(/role="heading"[^>]*>([^<]+)/);
      let title = titleMatch ? titleMatch[1].trim() : '';

      // Fallback: image alt from before this link
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

      // Size info from the size div
      const sizeMatch = after.match(/class="e-cauxk8">([^<]+)/);
      const sizeText = sizeMatch ? sizeMatch[1].trim() : '';

      // Build link
      const link = 'https://www.instacart.com' + href.split('"')[0];

      // Calculate unit price from title + size
      const combined = title + (sizeText ? ', ' + sizeText : '');
      const calc = calcUnitPrice(combined, price);

      products.push({
        retailer,
        title,
        price: priceStr,
        priceNum: price,
        unitPrice: calc ? calc.unitPrice.toFixed(2) : null,
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

function calcUnitPrice(title, totalPrice) {
  const t = title.toLowerCase();

  // Paper products: sheets × count
  const sheetsMatch = t.match(/(\d+)\s*sheets/);
  const countMatch = t.match(/(\d+)\s*[-\s]?\s*(count|ct|pk|pack|rolls)\b/);

  if (sheetsMatch && countMatch) {
    const sheets = parseInt(sheetsMatch[1]);
    const count = parseInt(countMatch[1]);
    const totalSheets = sheets * count;
    if (totalSheets > 0) {
      return { unitPrice: (totalPrice / totalSheets) * 100, unitLabel: '100sh' };
    }
  }

  // Rolls only (no sheet count)
  if (!sheetsMatch && countMatch && /roll/i.test(countMatch[2])) {
    const count = parseInt(countMatch[1]);
    if (count > 0) {
      return { unitPrice: totalPrice / count, unitLabel: 'roll' };
    }
  }

  // Weight: oz, lb, fl oz, gal
  const ozMatch = t.match(/([\d.]+)\s*(fl\s*oz|oz)\b/);
  if (ozMatch) {
    const oz = parseFloat(ozMatch[1]);
    if (oz > 0) return { unitPrice: totalPrice / oz, unitLabel: 'oz' };
  }

  const lbMatch = t.match(/([\d.]+)\s*(lbs?)\b/);
  if (lbMatch) {
    const oz = parseFloat(lbMatch[1]) * 16;
    if (oz > 0) return { unitPrice: totalPrice / oz, unitLabel: 'oz' };
  }

  const galMatch = t.match(/([\d.]+)\s*(gallons?|gal)\b/);
  if (galMatch) {
    const oz = parseFloat(galMatch[1]) * 128;
    if (oz > 0) return { unitPrice: totalPrice / oz, unitLabel: 'oz' };
  }

  const literMatch = t.match(/([\d.]+)\s*(liters?|l)\b/);
  if (literMatch) {
    const oz = parseFloat(literMatch[1]) * 33.814;
    if (oz > 0) return { unitPrice: totalPrice / oz, unitLabel: 'oz' };
  }

  // Count/pack (non-roll)
  if (countMatch && !/roll/i.test(countMatch[2])) {
    const count = parseInt(countMatch[1]);
    if (count > 0) {
      return { unitPrice: totalPrice / count, unitLabel: 'ct' };
    }
  }

  // Pods, bags, etc.
  const miscMatch = t.match(/(\d+)\s*[-\s]?\s*(pods?|bags?|capsules?|tablets?|bars?|cans?)\b/);
  if (miscMatch) {
    const count = parseInt(miscMatch[1]);
    if (count > 0) {
      return { unitPrice: totalPrice / count, unitLabel: 'ct' };
    }
  }

  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parsePrice(str) {
  if (!str) return null;
  const m = str.replace(/[^0-9.]/g, '');
  const n = parseFloat(m);
  return isNaN(n) ? null : n;
}
