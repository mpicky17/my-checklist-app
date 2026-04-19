export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing query' });

  const apiKey = req.query.key || process.env.SERPAPI_KEY;
  if (!apiKey) return res.status(500).json({ error: 'SERPAPI_KEY not configured' });

  const url = 'https://serpapi.com/search.json?engine=google_shopping'
    + '&q=' + encodeURIComponent(q)
    + '&num=100'
    + '&api_key=' + encodeURIComponent(apiKey);

  try {
    const response = await fetch(url);
    const data = await response.json();

    const results = (data.shopping_results || [])
      .slice(0, 100)
      .map(r => ({
        title:  r.title        || '',
        price:  r.price        || '',
        source: r.source       || '',
        link:   r.product_link || r.link || '',
      }));

    res.status(200).json({ results });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
}
