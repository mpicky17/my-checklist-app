export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing query' });

  const keyPresent = !!process.env.SERPAPI_KEY;
  const keyLength  = (process.env.SERPAPI_KEY || '').length;
  const envKeys    = Object.keys(process.env).filter(k => !k.startsWith('npm_')).join(', ');
  console.log('SERPAPI_KEY present:', keyPresent, '| length:', keyLength, '| env keys:', envKeys);

  if (!process.env.SERPAPI_KEY) {
    return res.status(500).json({ error: 'SERPAPI_KEY not configured', keyPresent, keyLength, envKeys });
  }

  const url = 'https://serpapi.com/search.json?engine=google_shopping'
    + '&q=' + encodeURIComponent(q)
    + '&api_key=' + process.env.SERPAPI_KEY;

  try {
    const response = await fetch(url);
    const data = await response.json();

    const results = (data.shopping_results || []).slice(0, 10).map(r => ({
      title:  r.title  || '',
      price:  r.price  || '',
      source: r.source || '',
      link:   r.link   || '',
    }));

    res.status(200).json({ results });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
}
