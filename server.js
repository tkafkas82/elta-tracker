const http = require('http');
const https = require('https');
const { URLSearchParams } = require('url');

const PORT = process.env.PORT || 3000;
const TRACK_API = 'https://www.elta.gr/trackApi';

// Cyprus (CY) service.
// Cyprus Post has no JSON API; tracking is server-rendered behind a signed,
// expiring results URL. We reproduce what the browser does:
//   1. GET the track page  -> CSRF _token, encrypted valid_from, honeypot
//      field name and a session cookie.
//   2. POST the code to /track-and-trace/find with those + cookies.
//   3. Follow the 302 to the signed results URL (same cookies) and parse it.
// Optionally, CY_RESULTS_URL can pin a signed link with a {code} placeholder
// to bypass the live handshake (mostly for debugging).
const CY_RESULTS_URL = process.env.CY_RESULTS_URL || '';
const CY_TRACK_PAGE = 'https://www.cypruspost.post/en/track-n-trace-results';
const CY_FIND_URL = 'https://www.cypruspost.post/track-and-trace/find';

// Geniki Taxydromiki (GT) service.
// Their track page posts a JSON body to a PHP endpoint that fronts the
// TrackAndTrace backend. Quirk worth keeping: the body is JSON but the request
// is declared as x-www-form-urlencoded, so we reproduce that verbatim.
// Result 0 = voucher found, 9 = unknown voucher (any non-GT code lands there).
const GT_TRACK_API = 'https://taxydromiki.com/external_scripts/track-site.php';
const GT_LANG = 'el';   // matches the Greek statuses ELTA returns

const CY_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
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

// Geniki lookup. Note the deliberate JSON-body / form-urlencoded mismatch.
function trackWithGeniki(code) {
  const payload = JSON.stringify({ lang: GT_LANG, voucherNo: code });
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(payload),
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      'Origin': 'https://taxydromiki.com',
      'Referer': 'https://taxydromiki.com/track/',
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(GT_TRACK_API, options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    // The Geniki backend is genuinely slow: 9-15s is normal, so keep this
    // generous (but under the 30s serverless ceiling in vercel.json).
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('Geniki request timed out')); });
    req.write(payload);
    req.end();
  });
}

function httpGet(url, cookie) {
  return new Promise((resolve, reject) => {
    const headers = { ...CY_HEADERS };
    if (cookie) headers.Cookie = cookie;
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Cyprus Post request timed out')); });
  });
}

function httpPostForm(url, payload, cookie, referer) {
  return new Promise((resolve, reject) => {
    const options = {
      method: 'POST',
      headers: {
        ...CY_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
        'Cookie': cookie,
        'Origin': 'https://www.cypruspost.post',
        'Referer': referer,
      },
    };
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Cyprus Post request timed out')); });
    req.write(payload);
    req.end();
  });
}

// Live Cyprus Post lookup (see the CY_* notes above for the handshake).
async function fetchCyResults(code) {
  if (CY_RESULTS_URL) {
    const url = CY_RESULTS_URL.replace(/\{code\}/g, encodeURIComponent(code));
    return httpGet(url, '');
  }

  const page = await httpGet(CY_TRACK_PAGE, '');
  const tokenM = page.body.match(/name="_token" value="([^"]+)"/);
  const vfM = page.body.match(/name="valid_from"[\s\S]*?value="([^"]+)"/);
  const hpM = page.body.match(/id="(\w+)"\s+name="\1"\s+type="text"/);
  if (!tokenM) throw new Error('Could not read Cyprus Post form token');
  const cookie = (page.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  const form = new URLSearchParams();
  if (hpM) form.append(hpM[1], '');        // honeypot must be sent empty
  if (vfM) form.append('valid_from', vfM[1]);
  form.append('_token', tokenM[1]);
  form.append('code', code);

  const found = await httpPostForm(CY_FIND_URL, form.toString(), cookie, CY_TRACK_PAGE);
  const location = found.headers.location;
  if (!location) return { status: found.status, body: found.body };
  const resultsUrl = location.startsWith('http') ? location : `https://www.cypruspost.post${location}`;
  return httpGet(resultsUrl, cookie);
}

// Parse the server-rendered Cyprus Post results HTML for a given code.
// Events come as a table: Time | Country | Location | Event | Next Office | Extra.
function parseCyHtml(html, code) {
  const startTag = `collapse_${code}`;
  const idx = html.indexOf(startTag);
  const slice = idx >= 0 ? html.slice(idx) : html;
  // Bound the panel so we don't bleed into modals / other tracked items.
  const endIdx = slice.indexOf('space-30');
  const panel = endIdx >= 0 ? slice.slice(0, endIdx) : slice;

  // Service type lives in the first <h4>, after dropping the "Options" dropdown.
  let service = '';
  const serviceMatch = panel.match(/<h4>([\s\S]*?)<\/h4>/);
  if (serviceMatch) {
    service = serviceMatch[1]
      .replace(/<div class="dropdown[\s\S]*?<\/div>\s*<\/div>/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (/There is no information for this item/i.test(panel)) {
    return { service, events: [], noInfo: true };
  }

  const events = [];
  const tbody = panel.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  if (tbody) {
    const rowRe = /<tr>([\s\S]*?)<\/tr>/gi;
    let row;
    while ((row = rowRe.exec(tbody[1])) !== null) {
      const cells = [];
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let c;
      while ((c = cellRe.exec(row[1])) !== null) {
        cells.push(c[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim());
      }
      if (cells.some(Boolean)) {
        events.push({
          time: cells[0] || '',
          country: cells[1] || '',
          location: cells[2] || '',
          event: cells[3] || '',
          nextOffice: cells[4] || '',
          extra: cells[5] || '',
        });
      }
    }
  }

  return { service, events, noInfo: false };
}

// Parse the Geniki JSON. The payload is keyed by the voucher number, and the
// checkpoint list collapses to a bare object when there is only one event.
function parseGtJson(body, code) {
  let json;
  try { json = JSON.parse(body); } catch { return { error: 'Could not read Geniki response.' }; }

  const result = json && json[code] && json[code].TrackAndTraceResult;
  if (!result) return { error: 'Geniki returned no result for this code.' };
  if (Number(result.Result) !== 0) return { notFound: true, events: [] };

  const raw = result.Checkpoints && result.Checkpoints.Checkpoint;
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);

  const events = list
    .map((c, i) => ({
      status: c.Status || '',
      statusCode: c.StatusCode || '',
      when: formatIso(c.StatusDate),
      where: c.Shop || '',
      key: isoKey(c.StatusDate),
      i,
    }))
    .sort((a, b) => (a.key === b.key ? a.i - b.i : a.key < b.key ? -1 : 1));

  return {
    events,
    status: result.Status || '',
    consignee: result.Consignee || '',
    deliveredAt: result.DeliveredAt || '',
    // Only a real delivery stamps a date; pending comes back as 1900-01-01.
    // The Status text is no use here ("ΠΡΟΣ ΠΑΡΑΔΟΣΗ" contains "παραδο").
    deliveryDate: hasRealDate(result.DeliveryDate) ? formatIso(result.DeliveryDate) : '',
    delivered: hasRealDate(result.DeliveryDate),
  };
}

// Lowercase + strip Greek accents so matching is tolerant of casing/tonos.
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ELTA returns statuses newest-first. Sort them chronologically (oldest ->
// newest) so the timeline reads top-down and the last item is the current one.
function eltaStatuses(entry) {
  const arr = (entry?.response?.out_status || [])
    .filter((s) => s.out_status_name && s.out_status_name.trim() !== '')
    .map((s, i) => ({ s, i }));
  arr.sort((a, b) => {
    const ka = (a.s.out_date || '') + (a.s.out_time || '');
    const kb = (b.s.out_date || '') + (b.s.out_time || '');
    if (ka !== kb) return ka < kb ? -1 : 1;
    return b.i - a.i; // equal timestamps: reverse the newest-first source order
  });
  return arr.map((x) => x.s);
}

// Latest status only drives the "Delivered" badge; CY is always queried now.
function eltaFinalStatus(entry) {
  const statuses = eltaStatuses(entry);
  const last = statuses[statuses.length - 1];
  const lastName = norm(last?.out_status_name);
  const delivered = lastName.includes('παραδο') || lastName.includes('παραλαβ') ||
    lastName.includes('delivered') || lastName.includes('received');
  return { delivered, last };
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

// Geniki timestamps are ISO-ish local strings ("2026-08-26T13:03:48").
function formatIso(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return '';
  return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
}

function isoKey(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? m[1] + m[2] + m[3] + m[4] + m[5] : '';
}

// Placeholder stamps (0001-01-01 / 1900-01-01) mean "not delivered yet".
function hasRealDate(iso) {
  return Number(String(iso || '').slice(0, 4)) > 1900;
}

// --- Latest-known-status helpers (used for the top summary banner) ---

// Normalise a CY "DD/MM/YYYY HH:MM" stamp to a sortable YYYYMMDDHHMM key.
function cyKey(timeStr) {
  const m = String(timeStr || '').match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  if (!m) return '';
  return m[3] + m[2] + m[1] + (m[4] || '00') + (m[5] || '00');
}

function eltaLatest(entry) {
  const statuses = eltaStatuses(entry);
  const s = statuses[statuses.length - 1];
  if (!s) return null;
  return {
    source: 'ELTA', label: 'ELTA (GR)', badge: 'elta',
    status: s.out_status_name,
    where: s.out_station || '',
    when: formatDateTime(s.out_date, s.out_time),
    key: (s.out_date || '') + String(s.out_time || '').padEnd(4, '0'),
  };
}

function cyLatest(parsed) {
  if (!parsed || parsed.noInfo || !parsed.events.length) return null;
  const e = parsed.events[parsed.events.length - 1];
  return {
    source: 'CY', label: 'Cyprus (CY)', badge: 'cy',
    status: e.event || '—',
    where: [e.location, e.country].filter(Boolean).join(', '),
    when: e.time || '',
    key: cyKey(e.time),
  };
}

function gtLatest(parsed) {
  if (!parsed || parsed.error || parsed.notFound || !parsed.events.length) return null;
  const e = parsed.events[parsed.events.length - 1];
  return {
    source: 'GT', label: 'Geniki (GR)', badge: 'gt',
    status: e.status || parsed.status || '—',
    where: e.where || '',
    when: e.when || '',
    key: e.key,
  };
}

// Only used to break exact-timestamp ties: the downstream leg wins (e.g. the
// shared Athens airport handoff shows up on both the GR and the CY side).
const SOURCE_RANK = { ELTA: 0, GT: 0, CY: 1 };

function pickLatest(...candidates) {
  return candidates.filter(Boolean).reduce((best, c) => {
    if (!best) return c;
    if (c.key !== best.key) return c.key > best.key ? c : best;
    return (SOURCE_RANK[c.source] || 0) > (SOURCE_RANK[best.source] || 0) ? c : best;
  }, null);
}

function renderSummary(latest) {
  if (!latest) return '';
  const meta = [latest.where, latest.when].filter(Boolean).map(esc).join(' · ');
  return `
    <div class="summary">
      <div class="summary-top">
        <span class="summary-label">Latest status</span>
        <span class="badge ${latest.badge}">${esc(latest.label)}</span>
      </div>
      <div class="summary-status">${esc(latest.status)}</div>
      ${meta ? `<div class="summary-meta">${meta}</div>` : ''}
    </div>`;
}

function renderElta(entry) {
  const statuses = eltaStatuses(entry);

  const rows = statuses.map((s, i) => `
    <li class="${i === statuses.length - 1 ? 'current' : ''}">
      <div class="dot"></div>
      <div class="ev">
        <div class="status">${esc(s.out_status_name)}</div>
        <div class="meta">${esc(s.out_station)}${s.out_station ? ' · ' : ''}${esc(formatDateTime(s.out_date, s.out_time))}</div>
      </div>
    </li>`).join('');

  const { delivered } = eltaFinalStatus(entry);
  const hint = statuses.length ? statuses[statuses.length - 1].out_status_name : 'No events yet';

  return `
    <details class="card section" open>
      <summary class="card-head">
        <span class="chev">▸</span>
        <span class="badge elta">ELTA (GR)</span>
        <span class="code">${esc(entry.code)}</span>
        ${delivered ? '<span class="badge done">Delivered</span>' : ''}
        <span class="summary-hint">${esc(hint)}</span>
      </summary>
      <ol class="timeline">${rows || '<li>No tracking events yet.</li>'}</ol>
    </details>`;
}

function renderCy(parsed, code) {
  const hasEvents = !parsed.noInfo && parsed.events.length > 0;
  const hint = parsed.noInfo
    ? 'No information yet'
    : (hasEvents ? parsed.events[parsed.events.length - 1].event : 'No events listed');

  let body;
  if (parsed.noInfo) {
    body = `<div class="cy-note">No information for this item in Cyprus yet. It has likely not arrived / been scanned by Cyprus Post.</div>`;
  } else {
    const rows = parsed.events.map((e, i) => {
      const meta = [e.location, e.country, e.time].filter(Boolean).map(esc).join(' · ');
      const extra = e.extra ? `<div class="meta">${esc(e.extra)}</div>` : '';
      return `
      <li class="${i === parsed.events.length - 1 ? 'current' : ''}">
        <div class="dot"></div>
        <div class="ev">
          <div class="status">${esc(e.event || '—')}</div>
          ${meta ? `<div class="meta">${meta}</div>` : ''}
          ${extra}
        </div>
      </li>`;
    }).join('');
    body = rows ? `<ol class="timeline">${rows}</ol>` : '<div class="cy-note">No tracking events listed.</div>';
  }

  return `
    <details class="card section" ${hasEvents ? 'open' : ''}>
      <summary class="card-head">
        <span class="chev">▸</span>
        <span class="badge cy">Cyprus (CY)</span>
        <span class="code">${esc(code)}</span>
        ${parsed.service ? `<span class="service">${esc(parsed.service)}</span>` : ''}
        <span class="summary-hint">${esc(hint)}</span>
      </summary>
      ${body}
    </details>`;
}

function renderGeniki(parsed, code) {
  if (parsed.error) {
    return `
    <div class="card">
      <div class="card-head"><span class="badge gt">Geniki (GR)</span></div>
      <p class="error">${esc(parsed.error)}</p>
    </div>`;
  }

  const hasEvents = !parsed.notFound && parsed.events.length > 0;
  const hint = parsed.notFound
    ? 'Unknown voucher'
    : (hasEvents ? parsed.events[parsed.events.length - 1].status : 'No events listed');

  let body;
  if (parsed.notFound) {
    body = '<div class="gt-note">Geniki Taxydromiki does not know this number — it is either not a Geniki voucher or has not been registered yet.</div>';
  } else {
    const rows = parsed.events.map((e, i) => {
      const meta = [e.where, e.when].filter(Boolean).map(esc).join(' · ');
      return `
      <li class="${i === parsed.events.length - 1 ? 'current' : ''}">
        <div class="dot"></div>
        <div class="ev">
          <div class="status">${esc(e.status || '—')}</div>
          ${meta ? `<div class="meta">${meta}</div>` : ''}
        </div>
      </li>`;
    }).join('');
    const foot = [
      parsed.consignee ? `Consignee: ${esc(parsed.consignee)}` : '',
      parsed.deliveredAt ? `Delivered at: ${esc(parsed.deliveredAt)}` : '',
      parsed.deliveryDate ? `Delivery date: ${esc(parsed.deliveryDate)}` : '',
    ].filter(Boolean).join(' · ');
    body = (rows ? `<ol class="timeline">${rows}</ol>` : '<div class="gt-note">No tracking events listed.</div>')
      + (foot ? `<div class="gt-foot meta">${foot}</div>` : '');
  }

  return `
    <details class="card section" ${hasEvents ? 'open' : ''}>
      <summary class="card-head">
        <span class="chev">▸</span>
        <span class="badge gt">Geniki (GR)</span>
        <span class="code">${esc(code)}</span>
        ${parsed.delivered ? '<span class="badge done">Delivered</span>' : ''}
        ${!parsed.notFound && parsed.status ? `<span class="service">${esc(parsed.status)}</span>` : ''}
        <span class="summary-hint">${esc(hint)}</span>
      </summary>
      ${body}
    </details>`;
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
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#0a6cff">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="ELTA Tracker">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='%230a6cff' rx='20'/><path d='M20 40 L50 65 L80 40' fill='none' stroke='white' stroke-width='8' stroke-linecap='round' stroke-linejoin='round'/><rect x='20' y='40' width='60' height='45' fill='none' stroke='white' stroke-width='8'/></svg>" type="image/svg+xml">
  <style>
    :root { --blue:#0a6cff; --grey:#666; --line:#e3e3e3; --bg:#fff; --card-bg:#fff; --text:#1c1c1c; --input-bg:#fff; --input-border:#ccc; --pre-bg:#f6f6f6; }
    [data-theme="dark"] { --line:#333; --bg:#0f1115; --card-bg:#1a1d23; --text:#e6e6e6; --grey:#aaa; --input-bg:#1a1d23; --input-border:#333; --pre-bg:#15171c; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color:var(--text); background:var(--bg); }
    h1 { font-size:1.4rem; margin-bottom:.2rem; }
    .sub { color: var(--grey); margin: 0 0 1.2rem; font-size:.9rem; }
    form { display:flex; gap:.5rem; margin:1rem 0; }
    input { flex:1; padding:.6rem .7rem; border:1px solid var(--input-border); border-radius:8px; font-size:1rem; background:var(--input-bg); color:var(--text); }
    button { padding:.6rem 1.1rem; border:0; border-radius:8px; background: var(--blue); color:#fff; font-weight:600; cursor:pointer; }
    button:hover { filter:brightness(.95); }
    .card { border:1px solid var(--line); border-radius:12px; padding:1rem 1.1rem; margin:.9rem 0; box-shadow:0 1px 2px rgba(0,0,0,.04); background:var(--card-bg); }
    .card-head { display:flex; align-items:center; gap:.5rem; margin-bottom:.8rem; flex-wrap:wrap; }
    /* Collapsible carrier sections */
    details.section { padding-top:.85rem; }
    details.section > summary { list-style:none; cursor:pointer; margin-bottom:0; user-select:none; }
    details.section > summary::-webkit-details-marker { display:none; }
    details.section[open] > summary { margin-bottom:.8rem; }
    .chev { display:inline-block; transition:transform .15s ease; color:var(--grey); font-size:.9rem; }
    details.section[open] > summary .chev { transform:rotate(90deg); }
    .summary-hint { margin-left:auto; color:var(--grey); font-size:.85rem; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:45%; }
    details.section[open] > summary .summary-hint { display:none; }
    /* Latest-known-status banner */
    .summary { border:1px solid var(--line); border-left:4px solid var(--blue); border-radius:12px; padding:.9rem 1.1rem; margin:.9rem 0; background:var(--card-bg); }
    .summary-top { display:flex; align-items:center; gap:.5rem; margin-bottom:.35rem; }
    .summary-label { font-size:.72rem; text-transform:uppercase; letter-spacing:.05em; color:var(--grey); font-weight:700; }
    .summary-status { font-size:1.15rem; font-weight:700; }
    .summary-meta { color:var(--grey); font-size:.88rem; margin-top:.15rem; }
    .service { color:var(--grey); font-size:.85rem; }
    .code { font-family:ui-monospace,monospace; font-weight:600; }
    .badge { font-size:.72rem; text-transform:uppercase; letter-spacing:.04em; padding:.2rem .5rem; border-radius:999px; background:#eee; color:#444; font-weight:700; }
    [data-theme="dark"] .badge { background:#2a2d35; color:#d1d5db; }
    .badge.elta { background:#e7f0ff; color:#0a6cff; }
    [data-theme="dark"] .badge.elta { background:#0f1f40; color:#93bfff; }
    .badge.cy { background:#fff0e6; color:#d97706; }
    [data-theme="dark"] .badge.cy { background:#3b2718; color:#f5b97a; }
    .badge.gt { background:#fde8e8; color:#c0392b; }
    [data-theme="dark"] .badge.gt { background:#3a1c1c; color:#f5a3a3; }
    .badge.done { background:#e6f7ec; color:#12924a; }
    [data-theme="dark"] .badge.done { background:#122e1f; color:#6ee7a5; }
    .timeline { list-style:none; margin:0; padding:0 0 0 .2rem; }
    .timeline li { position:relative; padding:0 0 1rem 1.4rem; border-left:2px solid var(--line); }
    .timeline li:last-child { border-left-color:transparent; padding-bottom:0; }
    .timeline .dot { position:absolute; left:-7px; top:2px; width:12px; height:12px; border-radius:50%; background:#bbb; border:2px solid var(--card-bg); }
    .timeline li.current .dot { background:var(--blue); }
    .timeline .status { font-weight:600; }
    .timeline .meta { color:var(--grey); font-size:.85rem; margin-top:.1rem; }
    .cy-note { margin-top:.6rem; font-size:.85rem; color:#d97706; background:#fff7ed; padding:.5rem .7rem; border-radius:8px; }
    [data-theme="dark"] .cy-note { background:#3b2718; color:#f5b97a; }
    .gt-note { margin-top:.6rem; font-size:.85rem; color:#c0392b; background:#fdecec; padding:.5rem .7rem; border-radius:8px; }
    [data-theme="dark"] .gt-note { background:#3a1c1c; color:#f5a3a3; }
    .gt-foot { margin-top:.7rem; }
    pre { background:var(--pre-bg); padding:.9rem; border-radius:8px; overflow:auto; font-size:.82rem; color:var(--text); }
    .error { color:#c0392b; }
    .section-title { font-size:.8rem; text-transform:uppercase; letter-spacing:.05em; color:var(--grey); margin:1.2rem 0 .3rem; }
    .theme-toggle { margin-left:auto; background:transparent; border:1px solid var(--line); color:var(--text); padding:.35rem .6rem; border-radius:8px; font-size:.85rem; }
  </style>
</head>
<body>
  <div style="display:flex;align-items:center;gap:.5rem;">
    <h1>ELTA Package Tracker</h1>
    <button class="theme-toggle" id="themeToggle" type="button" aria-label="Toggle dark mode">🌙</button>
  </div>
  <p class="sub">Tracks one code against ELTA, Geniki Taxydromiki and Cyprus Post at once. A Geniki voucher is shown on its own; anything else lists the ELTA and Cyprus Post legs together.</p>
  <form method="get">
    <input name="code" placeholder="Tracking code or voucher (e.g. RE574578316GR, 5177779390)" value="${esc(value)}">
    <button type="submit">Track</button>
  </form>
  ${contentHtml}
  <script>
    const themeToggle = document.getElementById('themeToggle');
    const root = document.documentElement;
    const saved = localStorage.getItem('theme');
    if (saved === 'light') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', 'dark');
    if (themeToggle) {
      themeToggle.textContent = root.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';
      themeToggle.addEventListener('click', () => {
        const isDark = root.getAttribute('data-theme') === 'dark';
        if (isDark) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', 'dark');
        themeToggle.textContent = isDark ? '🌙' : '☀️';
        localStorage.setItem('theme', isDark ? 'light' : 'dark');
      });
    }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  </script>
</body>
</html>`;
}

const handler = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: 'ELTA Package Tracker',
      short_name: 'ELTA Tracker',
      start_url: '/',
      display: 'standalone',
      background_color: '#0f1115',
      theme_color: '#0a6cff',
      icons: [
        { src: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="%230a6cff" rx="20"/><path d="M20 40 L50 65 L80 40" fill="none" stroke="white" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><rect x="20" y="40" width="60" height="45" fill="none" stroke="white" stroke-width="8"/></svg>', sizes: '192x192', type: 'image/svg+xml' },
        { src: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="%230a6cff" rx="20"/><path d="M20 40 L50 65 L80 40" fill="none" stroke="white" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><rect x="20" y="40" width="60" height="45" fill="none" stroke="white" stroke-width="8"/></svg>', sizes: '512x512', type: 'image/svg+xml' }
      ]
    }));
    return;
  }

  if (pathname === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end("self.addEventListener('install', e => self.skipWaiting()); self.addEventListener('activate', e => e.waitUntil(self.clients.claim())); self.addEventListener('fetch', event => { event.respondWith(fetch(event.request).catch(() => new Response('Offline'))); });");
    return;
  }

  const code = (url.searchParams.get('code') || '').trim();

  if (!code) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('', ''));
    return;
  }

  // Query every carrier in parallel — we cannot tell from the code alone which
  // one owns it, and Geniki (the slow leg) would gate the others if we chained
  // them. A parcel to Cyprus is tracked by ELTA inside Greece and by Cyprus
  // Post once it arrives, so those two legs belong together; Geniki is a
  // separate courier altogether and its vouchers are never known to the
  // others, so a Geniki hit is rendered on its own (see gtKnowsCode below).
  let html = '';
  const [eltaRes, gtRes, cyRes] = await Promise.allSettled([
    trackWithElta(code),
    trackWithGeniki(code),
    fetchCyResults(code),
  ]);

  // Build each carrier section and its latest-status candidate.
  let eltaHtml = '', gtHtml = '', cyHtml = '';
  let eltaLatestVal = null, gtLatestVal = null, cyLatestVal = null;
  let gtKnowsCode = false;

  if (eltaRes.status === 'fulfilled') {
    try {
      const parsed = JSON.parse(eltaRes.value.body);
      const entry = Array.isArray(parsed) ? parsed[0] : parsed;
      eltaLatestVal = eltaLatest(entry);
      eltaHtml = renderElta(entry);
    } catch {
      eltaHtml = `<div class="card"><div class="card-head"><span class="badge elta">ELTA (GR)</span></div><p class="error">Could not read ELTA response.</p></div>`;
    }
  } else {
    eltaHtml = `<div class="card"><div class="card-head"><span class="badge elta">ELTA (GR)</span></div><p class="error">ELTA request failed: ${esc(eltaRes.reason?.message || 'unknown error')}</p></div>`;
  }

  if (gtRes.status === 'fulfilled') {
    const parsed = parseGtJson(gtRes.value.body, code);
    gtKnowsCode = !parsed.error && !parsed.notFound;   // Result 0 = real voucher
    gtLatestVal = gtLatest(parsed);
    gtHtml = renderGeniki(parsed, code);
  } else {
    gtHtml = `<div class="card"><div class="card-head"><span class="badge gt">Geniki (GR)</span></div><p class="error">Geniki request failed: ${esc(gtRes.reason?.message || 'unknown error')}</p></div>`;
  }

  if (cyRes.status === 'fulfilled') {
    const parsed = parseCyHtml(cyRes.value.body, code);
    cyLatestVal = cyLatest(parsed);
    cyHtml = renderCy(parsed, code);
  } else {
    cyHtml = `<div class="card"><div class="card-head"><span class="badge cy">Cyprus (CY)</span></div><p class="error">CY request failed: ${esc(cyRes.reason?.message || 'unknown error')}</p></div>`;
  }

  // A voucher Geniki recognises is a Geniki parcel, full stop: ELTA and Cyprus
  // Post can only ever answer "no information" for it, so drop their sections
  // rather than showing two empty timelines next to the real one.
  if (gtKnowsCode) {
    html += renderSummary(gtLatestVal);
    html += gtHtml;
  } else {
    html += renderSummary(pickLatest(eltaLatestVal, gtLatestVal, cyLatestVal));
    html += eltaHtml;
    html += gtHtml;
    html += cyHtml;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page(code, html));
};

// Vercel (and any other serverless host) imports this module and calls the
// handler per request. Running the file directly still starts a real server,
// so `npm start` keeps working locally and on a VPS.
module.exports = handler;

if (require.main === module) {
  http.createServer(handler).listen(PORT, () => console.log(`ELTA tracker running at http://localhost:${PORT}`));
}
