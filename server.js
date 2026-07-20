const http = require('http');
const https = require('https');
const { URLSearchParams } = require('url');

const PORT = process.env.PORT || 3000;
const TRACK_API = 'https://www.elta.gr/trackApi';

// Cyprus (CY) fallback service.
// Cyprus Post does not expose a simple JSON API like ELTA; the tracking data
// is server-rendered. The public results page is a signed URL of the form:
//   https://www.cypruspost.post/en/track-n-trace-results?code=<CODE>&expires=<TS>&signature=<SIG>
// The signature/expiry are generated per request (the link you shared expires).
// Provide a template via env var CY_RESULTS_URL with a {code} placeholder, e.g.:
//   https://www.cypruspost.post/en/track-n-trace-results?code={code}&expires=...&signature=...
// If empty, the CY section shows a hint instead of failing.
const CY_RESULTS_URL = process.env.CY_RESULTS_URL || '';

const CY_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; EltaTracker/1.0)',
  'Accept': 'text/html,application/xhtml+xml',
};

function postForm(apiUrl, fields) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);

  const payload = body.toString();

  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(payload),
      'User-Agent': 'Mozilla/5.0 (compatible; EltaTracker/1.0)',
      'Accept': 'application/json, text/plain, */*',
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(apiUrl, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function trackWithElta(code) {
  return postForm(TRACK_API, { 'code[]': code, in_lang: '1' });
}

function fetchCyResults(code) {
  if (!CY_RESULTS_URL) {
    return Promise.reject(new Error('CY_RESULTS_URL not configured'));
  }
  const url = CY_RESULTS_URL.replace(/\{code\}/g, encodeURIComponent(code));
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: CY_HEADERS }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
  });
}

// Parse the server-rendered Cyprus Post results HTML for a given code.
function parseCyHtml(html, code) {
  const startTag = `collapse_${code}`;
  const idx = html.indexOf(startTag);
  const slice = idx >= 0 ? html.slice(idx) : html;

  const serviceMatch = slice.match(/<h4>([\s\S]*?)<\/h4>/);
  let service = '';
  if (serviceMatch) {
    service = serviceMatch[1]
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .replace(/Letter Post|Parcel Post|EMS.*$/i, (m) => m)
      .trim();
  }

  const noInfo = /There is no information for this item/i.test(slice);
  if (noInfo) {
    return { service, events: [], noInfo: true };
  }

  const events = [];
  const panelRe = /<div class="panel-body">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
  const block = slice.match(/<div class="panel-body">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/);
  if (block) {
    const inner = block[1];
    const rowRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
    let m;
    while ((m = rowRe.exec(inner)) !== null) {
      const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) events.push(text);
    }
  }

  return { service, events, noInfo: false };
}

// Inspect ELTA response. Returns a hint about whether the parcel is still
// moving inside Greece or has reached a final status.
function eltaFinalStatus(entry) {
  const statuses = entry?.response?.out_status || [];
  const filled = statuses.filter((s) => s.out_status_name && s.out_status_name.trim() !== '');
  const last = filled[filled.length - 1];
  if (!last) return { done: false, last };

  const name = last.out_status_name.toLowerCase();
  const delivered = name.includes('παράδοση') || name.includes('παραλαβ') || name.includes('delivered') || name.includes('received');
  const departed = name.includes('αναχώρηση') || name.includes('αποστολή') || name.includes('από ελλάδα') || name.includes('departure') || name.includes('departed');
  return { done: delivered || departed, last };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function esc(s) { return escapeHtml(s ?? ''); }

function formatDateTime(date, time) {
  if (!date) return '';
  const y = date.slice(0, 4), m = date.slice(4, 6), d = date.slice(6, 8);
  let t = '';
  if (time) {
    t = ` ${time.slice(0, 2)}:${time.slice(2, 4)}`;
  }
  return `${d}/${m}/${y}${t}`.trim();
}

function renderElta(entry) {
  const head = entry?.response ?? {};
  const statuses = (head.out_status || []).filter((s) => s.out_status_name && s.out_status_name.trim() !== '');

  const rows = statuses.map((s, i) => `
    <li class="${i === statuses.length - 1 ? 'current' : ''}">
      <div class="dot"></div>
      <div class="ev">
        <div class="status">${esc(s.out_status_name)}</div>
        <div class="meta">${esc(s.out_station)}${s.out_station ? ' · ' : ''}${esc(formatDateTime(s.out_date, s.out_time))}</div>
      </div>
    </li>`).join('');

  const { done } = eltaFinalStatus(entry);

  return `
    <div class="card">
      <div class="card-head">
        <span class="badge elta">ELTA (GR)</span>
        <span class="code">${esc(entry.code)}</span>
        ${done ? '<span class="badge done">Delivered</span>' : ''}
      </div>
      <ol class="timeline">${rows || '<li>No tracking events yet.</li>'}</ol>
      ${done ? `<div class="cy-note">Parcel reached a final status in Greece. Use the Cyprus (CY) tracker below to continue.</div>` : ''}
    </div>`;
}

function renderCy(parsed, code) {
  if (parsed.noInfo) {
    return `
      <div class="card">
        <div class="card-head">
          <span class="badge cy">Cyprus (CY)</span>
          <span class="code">${esc(code)}</span>
        </div>
        <div class="cy-note">No information for this item in Cyprus yet. It has likely not arrived / been scanned by Cyprus Post.</div>
      </div>`;
  }

  const rows = parsed.events.map((e, i) => `
    <li class="${i === parsed.events.length - 1 ? 'current' : ''}">
      <div class="dot"></div>
      <div class="ev"><div class="status">${esc(e)}</div></div>
    </li>`).join('');

  return `
    <div class="card">
      <div class="card-head">
        <span class="badge cy">Cyprus (CY)</span>
        <span class="code">${esc(code)}</span>
        ${parsed.service ? `<span class="service">${esc(parsed.service)}</span>` : ''}
      </div>
      ${rows ? `<ol class="timeline">${rows}</ol>` : '<div class="cy-note">No tracking events listed.</div>'}
    </div>`;
}

function renderRaw(label, status, body) {
  let pretty = body;
  try { pretty = JSON.stringify(JSON.parse(body), null, 2); } catch {}
  return `
    <div class="card">
      <div class="card-head"><span class="badge">${esc(label)}</span><span>Status ${esc(status)}</span></div>
      <pre>${esc(pretty)}</pre>
    </div>`;
}

function page(value, contentHtml) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ELTA Tracker</title>
  <style>
    :root { --blue:#0a6cff; --grey:#666; --line:#e3e3e3; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color:#1c1c1c; }
    h1 { font-size:1.4rem; margin-bottom:.2rem; }
    .sub { color: var(--grey); margin: 0 0 1.2rem; font-size:.9rem; }
    form { display:flex; gap:.5rem; margin:1rem 0; }
    input { flex:1; padding:.6rem .7rem; border:1px solid #ccc; border-radius:8px; font-size:1rem; }
    button { padding:.6rem 1.1rem; border:0; border-radius:8px; background: var(--blue); color:#fff; font-weight:600; cursor:pointer; }
    button:hover { filter:brightness(.95); }
    .card { border:1px solid var(--line); border-radius:12px; padding:1rem 1.1rem; margin:.9rem 0; box-shadow:0 1px 2px rgba(0,0,0,.04); }
    .card-head { display:flex; align-items:center; gap:.5rem; margin-bottom:.8rem; flex-wrap:wrap; }
    .code { font-family:ui-monospace,monospace; font-weight:600; }
    .badge { font-size:.72rem; text-transform:uppercase; letter-spacing:.04em; padding:.2rem .5rem; border-radius:999px; background:#eee; color:#444; font-weight:700; }
    .badge.elta { background:#e7f0ff; color:#0a6cff; }
    .badge.cy { background:#fff0e6; color:#d97706; }
    .badge.done { background:#e6f7ec; color:#12924a; }
    .timeline { list-style:none; margin:0; padding:0 0 0 .2rem; }
    .timeline li { position:relative; padding:0 0 1rem 1.4rem; border-left:2px solid var(--line); }
    .timeline li:last-child { border-left-color:transparent; padding-bottom:0; }
    .timeline .dot { position:absolute; left:-7px; top:2px; width:12px; height:12px; border-radius:50%; background:#bbb; border:2px solid #fff; }
    .timeline li.current .dot { background:var(--blue); }
    .timeline .status { font-weight:600; }
    .timeline .meta { color:var(--grey); font-size:.85rem; margin-top:.1rem; }
    .cy-note { margin-top:.6rem; font-size:.85rem; color:#d97706; background:#fff7ed; padding:.5rem .7rem; border-radius:8px; }
    pre { background:#f6f6f6; padding:.9rem; border-radius:8px; overflow:auto; font-size:.82rem; }
    .error { color:#c0392b; }
    .section-title { font-size:.8rem; text-transform:uppercase; letter-spacing:.05em; color:var(--grey); margin:1.2rem 0 .3rem; }
  </style>
</head>
<body>
  <h1>ELTA Package Tracker</h1>
  <p class="sub">Track Greek parcels via ELTA. When delivered in Greece, continue with the Cyprus (CY) service.</p>
  <form method="get">
    <input name="code" placeholder="Tracking code (e.g. RE574578316GR)" value="${esc(value)}">
    <button type="submit">Track</button>
  </form>
  ${contentHtml}
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const code = (url.searchParams.get('code') || '').trim();

  if (!code) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('', ''));
    return;
  }

  let html = '';
  try {
    const elta = await trackWithElta(code);
    const parsed = JSON.parse(elta.body);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    html += renderElta(entry);

    const { done } = eltaFinalStatus(entry);
    if (done) {
      html += `<div class="section-title">Continued in Cyprus</div>`;
      if (!CY_RESULTS_URL) {
        html += `<div class="card"><div class="card-head"><span class="badge cy">Cyprus (CY)</span></div><div class="cy-note">Set CY_RESULTS_URL (signed results link with {code}) to enable Cyprus tracking.</div></div>`;
      } else {
        try {
          const cy = await fetchCyResults(code);
          const parsed = parseCyHtml(cy.body, code);
          html += renderCy(parsed, code);
        } catch (cyErr) {
          html += `<div class="card"><div class="card-head"><span class="badge cy">Cyprus (CY)</span></div><p class="error">CY request failed: ${esc(cyErr.message)}</p></div>`;
        }
      }
    }
  } catch (err) {
    html += `<p class="error">Request failed: ${esc(err.message)}</p>`;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page(code, html));
});

server.listen(PORT, () => console.log(`ELTA tracker running at http://localhost:${PORT}`));
