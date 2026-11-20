// Trail geometry: finding a trail on OpenStreetMap, getting its hill heights, and turning it into a route.
const R = 6371000;
const rad = d => d * Math.PI / 180;

export function hav(a, b) { // metres between [lat, lon] points
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export const lineLen = c => c.reduce((s, p, i) => (i ? s + hav(c[i - 1], p) : 0), 0);

// Evenly spaced points every `step` metres (keeps elevation if present).
export function resample(c, step) {
  const out = [c[0].slice()];
  let carry = 0;
  for (let i = 1; i < c.length; i++) {
    const a = c[i - 1], b = c[i], seg = hav(a, b);
    if (!seg) continue;
    let pos = step - carry;
    while (pos <= seg) {
      const f = pos / seg;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f,
        a[2] != null && b[2] != null ? a[2] + (b[2] - a[2]) * f : undefined]);
      pos += step;
    }
    carry = seg - (pos - step);
  }
  const last = c[c.length - 1];
  if (hav(out[out.length - 1], last) > step * 0.3) out.push(last.slice());
  return out;
}

// Join trail pieces (OSM stores a trail as many short ways, some backwards) into one line.
export function stitch(segs, tol = 40) {
  segs = segs.filter(s => s.length > 1).map(s => s.slice());
  const chains = [];
  while (segs.length) {
    let chain = segs.shift(), grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i], head = chain[0], tail = chain[chain.length - 1];
        if (hav(tail, s[0]) < tol) chain = chain.concat(s.slice(1));
        else if (hav(tail, s[s.length - 1]) < tol) chain = chain.concat(s.slice().reverse().slice(1));
        else if (hav(head, s[s.length - 1]) < tol) chain = s.slice(0, -1).concat(chain);
        else if (hav(head, s[0]) < tol) chain = s.slice().reverse().slice(0, -1).concat(chain);
        else continue;
        segs.splice(i, 1); grew = true; break;
      }
    }
    chains.push(chain);
  }
  return chains.sort((a, b) => lineLen(b) - lineLen(a))[0] || [];
}

export async function geocode(place) {
  // try what she typed, then each comma-separated part ("Paradise Inn, Mount Rainier" → "Mount Rainier")
  const tries = [place, ...place.split(',').map(p => p.trim()).filter(Boolean).reverse()];
  let j = [];
  for (const q of [...new Set(tries)]) {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q));
    if (!r.ok) throw new Error('The map search is busy. Try again in a minute.');
    j = await r.json();
    if (j.length) break;
  }
  if (!j.length) throw new Error(`Couldn't find "${place}" on the map. Try a park or town name.`);
  let [s, n, w, e] = j[0].boundingbox.map(Number);
  const cLat = (s + n) / 2, cLon = (w + e) / 2, half = 0.35; // search at least ~75 km across (place names are often a lodge or town nearby)
  if (n - s < 2 * half) { s = cLat - half; n = cLat + half; }
  if (e - w < 2 * half) { w = cLon - half; e = cLon + half; }
  return { s, w, n, e, label: j[0].display_name };
}

export async function findTrails(name, place) {
  const b = await geocode(place);
  const nm = name.trim().replace(/[^\p{L}\p{N} '\-]/gu, '.');
  if (!nm) throw new Error('Type the trail name.');
  const bb = `${b.s},${b.w},${b.n},${b.e}`;
  const q = `[out:json][timeout:45];(
    relation["route"~"^(hiking|foot|walking)$"]["name"~"${nm}",i](${bb});
    way["highway"~"^(path|footway|track|steps|bridleway|pedestrian)$"]["name"~"${nm}",i](${bb});
  );out geom;`;
  const j = await overpass(q);
  const out = [], groups = new Map();
  for (const el of j.elements) {
    if (el.type === 'relation') {
      const segs = el.members.filter(m => m.type === 'way' && m.geometry).map(m => m.geometry.map(g => [g.lat, g.lon]));
      const line = stitch(segs);
      if (line.length > 1) out.push({ name: el.tags.name, kind: 'Marked hiking route', coords: line });
    } else if (el.type === 'way' && el.geometry) {
      const k = el.tags.name;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(el.geometry.map(g => [g.lat, g.lon]));
    }
  }
  for (const [k, segs] of groups) {
    const line = stitch(segs);
    if (line.length > 1) out.push({ name: k, kind: 'Trail path', coords: line });
  }
  out.forEach(t => { t.lengthM = lineLen(t.coords); t.near = b.label; });
  return out.filter(t => t.lengthM > 200).sort((a, b2) => b2.lengthM - a.lengthM).slice(0, 12);
}

// The free OpenStreetMap query service is sometimes busy: retry, then try a second server.
async function overpass(q) {
  const servers = ['https://overpass-api.de/api/interpreter', 'https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  for (let i = 0; i < servers.length; i++) {
    try {
      const r = await fetch(servers[i], { method: 'POST', body: new URLSearchParams({ data: q }) });
      if (r.ok) return await r.json();
    } catch { /* try the next one */ }
    await new Promise(res => setTimeout(res, 4000));
  }
  throw new Error('The trail map service is busy. Try again in a minute.');
}

// Hill heights from Open-Meteo's free elevation service (90 m terrain model), 100 points per request.
export async function addElevation(coords, onProgress) {
  const out = [];
  for (let i = 0; i < coords.length; i += 100) {
    const chunk = coords.slice(i, i + 100);
    const url = 'https://api.open-meteo.com/v1/elevation?latitude=' + chunk.map(c => c[0].toFixed(5)).join(',') +
      '&longitude=' + chunk.map(c => c[1].toFixed(5)).join(',');
    const r = await fetch(url);
    if (!r.ok) throw new Error("Couldn't get the hill heights right now. Try again in a minute.");
    const j = await r.json();
    chunk.forEach((c, k) => out.push([c[0], c[1], j.elevation[k]]));
    onProgress?.(out.length / coords.length);
  }
  return out;
}

export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const nodes = [...doc.querySelectorAll('trkpt, rtept')];
  if (nodes.length < 2) throw new Error('No trail points found in this file.');
  const coords = nodes.map(n => {
    const e = parseFloat(n.querySelector('ele')?.textContent);
    return [+n.getAttribute('lat'), +n.getAttribute('lon'), Number.isFinite(e) ? e : undefined];
  });
  const name = doc.querySelector('trk > name, rte > name, metadata > name')?.textContent?.trim();
  return { name, coords };
}

// Route used while walking: local x/y metres, distance along, smoothed elevation and grade (%).
export function buildRoute(coords) {
  const lat0 = rad(coords[0][0]);
  let d = 0;
  const pts = coords.map((p, i) => {
    if (i) d += hav(coords[i - 1], p);
    return { x: rad(p[1] - coords[0][1]) * R * Math.cos(lat0), y: rad(p[0] - coords[0][0]) * R, d, ele: p[2] ?? 0 };
  });
  const win = (i, m, f) => { let a = i, b = i; while (a > 0 && pts[i].d - pts[a - 1].d <= m) a--; while (b < pts.length - 1 && pts[b + 1].d - pts[i].d <= m) b++; return f(a, b); };
  // ±100 m smoothing: the free 90 m terrain data is bumpy; this matched 10 m survey data within ~10% of total climb on a test trail
  const sm = pts.map((p, i) => win(i, 100, (a, b) => { let s = 0; for (let k = a; k <= b; k++) s += pts[k].ele; return s / (b - a + 1); }));
  pts.forEach((p, i) => { p.ele = sm[i]; });
  const grade = pts.map((p, i) => win(i, 60, (a, b) => { const dd = pts[b].d - pts[a].d; return dd > 0 ? (pts[b].ele - pts[a].ele) / dd * 100 : 0; }));
  let climb = 0;
  for (let i = 1; i < pts.length; i++) climb += Math.max(0, pts[i].ele - pts[i - 1].ele);
  return { pts, grade, length: d, climb, maxGrade: Math.max(...grade) };
}

export function sample(route, dist) {
  const p = route.pts, d = Math.min(Math.max(dist, 0), route.length);
  let lo = 0, hi = p.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m].d <= d) lo = m; else hi = m; }
  const f = (d - p[lo].d) / ((p[hi].d - p[lo].d) || 1);
  return { d, x: p[lo].x + (p[hi].x - p[lo].x) * f, y: p[lo].y + (p[hi].y - p[lo].y) * f,
    ele: p[lo].ele + (p[hi].ele - p[lo].ele) * f, grade: route.grade[lo] + (route.grade[hi] - route.grade[lo]) * f };
}
