import { findTrails, addElevation, parseGPX, resample, buildRoute, sample, hav, lineLen } from './geo.js';
import { PracticeTreadmill, FtmsTreadmill } from './treadmill.js';

/* ================= Helpers ================= */
const MPH_TO_KMH = 1.609344, M_TO_MI = 1 / 1609.344, M_TO_FT = 3.28084, MS_TO_MPH = 2.23694;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const $ = id => document.getElementById(id);
const TAU = Math.PI * 2;
const fmtTime = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const parseTime = str => { const p = String(str).trim().split(':').map(Number); if (p.some(n => !Number.isFinite(n))) return NaN; return p.reduce((a, n) => a * 60 + n, 0); };
const ytId = s => { s = s.trim(); const m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/); return m ? m[1] : /^[\w-]{11}$/.test(s) ? s : null; };
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { showBanner("Couldn't save on this device (private browsing?)."); } },
};
function show(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id)); window.scrollTo(0, 0); }
function showBanner(t, ms = 7000) { const b = $('banner'); b.textContent = t; b.classList.add('show'); clearTimeout(showBanner.t); showBanner.t = setTimeout(() => b.classList.remove('show'), ms); }
function ask(title, text, buttons) {
  $('askTitle').textContent = title; $('askTxt').textContent = text;
  const row = $('askOv').querySelector('.row'); row.innerHTML = '';
  [...buttons, { label: 'Cancel' }].forEach(b => {
    const el = document.createElement('button'); el.className = 'btn ' + (b.cls || ''); el.textContent = b.label;
    el.onclick = () => { $('askOv').classList.remove('show'); b.fn?.(); }; row.appendChild(el);
  });
  $('askOv').classList.add('show');
}
// cut a trail so it stops at a fraction of its length (video ends before the trail does)
function cutCoords(coords, frac) {
  if (frac >= 0.999) return coords;
  const total = lineLen(coords) * frac, out = [coords[0]]; let d = 0;
  for (let i = 1; i < coords.length && d < total; i++) { d += hav(coords[i - 1], coords[i]); out.push(coords[i]); }
  return out;
}
const routeFor = h => buildRoute(cutCoords(h.coords, h.endFrac ?? 1));

/* ================= Settings & library ================= */
const S = Object.assign({ pace: 2.2, maxSpeed: 3.2, maxIncline: 8, minutes: 15 }, store.get('trailwalk.settings', {}));
const saveS = () => store.set('trailwalk.settings', S);
let hikes = store.get('trailwalk.hikes', []);
const saveHikes = () => store.set('trailwalk.hikes', hikes);
async function loadStarters() { // hikes bundled with the app (library.json), added once
  try {
    const starters = await (await fetch('library.json', { cache: 'no-store' })).json();
    const seen = new Set(store.get('trailwalk.seenStarters', []));
    let added = 0;
    for (const h of starters) {
      const mine = hikes.find(x => x.id === h.id);
      if (!seen.has(h.id)) { seen.add(h.id); if (!mine) { hikes.push(h); added++; } }
      // refresh a built-in hike she hasn't edited (e.g. better hill data), keeping her place in it
      else if (mine && !mine.edited && JSON.stringify(mine.coords) !== JSON.stringify(h.coords)) { Object.assign(mine, h, { resumeAt: mine.resumeAt }); added++; }
    }
    store.set('trailwalk.seenStarters', [...seen]);
    if (added) { saveHikes(); renderHome(); }
  } catch { /* no starter file: fine */ }
}

/* ================= YouTube ================= */
let ytApi;
function loadYT() {
  if (!ytApi) ytApi = new Promise(res => {
    window.onYouTubeIframeAPIReady = () => res(window.YT);
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s);
  });
  return ytApi;
}
async function makePlayer(hostId, videoId, start, onState) {
  const YT = await loadYT();
  const host = $(hostId); host.innerHTML = '<div></div>';
  return new Promise(res => {
    const p = new YT.Player(host.firstChild, { videoId, width: '100%', height: '100%',
      playerVars: { playsinline: 1, rel: 0, start: Math.floor(start || 0) },
      events: { onReady: () => res(p), onStateChange: e => onState?.(e.data) } });
  });
}

/* ================= Drawing ================= */
function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); return [g, w, h];
}
const gradeColor = gr => gr > 8 ? '#e5534b' : gr > 4 ? '#f2b84b' : gr > 1.5 ? '#9ad08a' : '#3a9fd8';
function drawMap(c, r, pos, pad = 12) {
  const [g, w, h] = fitCanvas(c); g.clearRect(0, 0, w, h);
  if (!w || !h || !r) return;
  const xs = r.pts.map(p => p.x), ys = r.pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const s = Math.min((w - 2 * pad) / ((maxX - minX) || 1), (h - 2 * pad) / ((maxY - minY) || 1));
  const ox = (w - (maxX - minX) * s) / 2, oy = (h - (maxY - minY) * s) / 2;
  const P = p => [ox + (p.x - minX) * s, h - (oy + (p.y - minY) * s)];
  g.lineCap = 'round'; g.lineJoin = 'round'; g.lineWidth = w > 200 ? 5 : 3;
  for (let i = 1; i < r.pts.length; i++) {
    g.strokeStyle = gradeColor(Math.abs(r.grade[i])); g.globalAlpha = pos && r.pts[i].d > pos.d ? 0.4 : 1;
    const [x0, y0] = P(r.pts[i - 1]), [x1, y1] = P(r.pts[i]); g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
  }
  g.globalAlpha = 1;
  const [sx, sy] = P(r.pts[0]); g.fillStyle = '#eef3f7'; g.beginPath(); g.arc(sx, sy, 4, 0, TAU); g.fill();
  if (pos) { const [px, py] = P(pos); g.fillStyle = '#4cc38a'; g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.beginPath(); g.arc(px, py, 6, 0, TAU); g.fill(); g.stroke(); }
}
function drawElev(c, r, pos) {
  const [g, w, h] = fitCanvas(c); g.clearRect(0, 0, w, h);
  if (!w || !h || !r) return;
  const eles = r.pts.map(p => p.ele), lo = Math.min(...eles), hi = Math.max(...eles), span = Math.max(hi - lo, 20);
  const X = d => 8 + (d / r.length) * (w - 16), Y = e => h - 8 - ((e - lo) / span) * (h - 30);
  const area = () => { g.beginPath(); g.moveTo(X(0), h); r.pts.forEach(p => g.lineTo(X(p.d), Y(p.ele))); g.lineTo(X(r.length), h); g.closePath(); };
  const grad = g.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, 'rgba(58,159,216,.6)'); grad.addColorStop(1, 'rgba(58,159,216,.06)');
  area(); g.fillStyle = grad; g.fill();
  if (pos) {
    g.save(); g.beginPath(); g.rect(0, 0, X(pos.d), h); g.clip(); area(); g.fillStyle = 'rgba(76,195,138,.65)'; g.fill(); g.restore();
    g.fillStyle = '#4cc38a'; g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.arc(X(pos.d), Y(pos.ele), 5.5, 0, TAU); g.fill(); g.stroke();
  }
  g.fillStyle = '#93a4b5'; g.font = '12px -apple-system, sans-serif';
  g.fillText(`${Math.round(lo * M_TO_FT).toLocaleString()}–${Math.round(hi * M_TO_FT).toLocaleString()} ft`, 8, 14);
}

/* ================= Home / library ================= */
let tm = new PracticeTreadmill();
function hikeStats(h) { return `${(h.lengthM * M_TO_MI).toFixed(1)} mi · ${Math.round(h.climbM * M_TO_FT).toLocaleString()} ft up · ${fmtTime(h.end - h.start)} video`; }
function renderHome() {
  const list = $('hikeList'); list.innerHTML = '';
  if (!hikes.length) list.innerHTML = '<div class="empty">No hikes yet. Tap <b>+ Add a hike from YouTube</b> to add your first one.</div>';
  hikes.forEach(h => {
    const el = document.createElement('div'); el.className = 'hike';
    el.innerHTML = `<button class="thumb"></button><div class="info"><div><b></b><span></span></div><button class="more" aria-label="More">•••</button></div>`;
    const th = el.querySelector('.thumb'); th.style.backgroundImage = `url(https://i.ytimg.com/vi/${h.youtubeId}/hqdefault.jpg)`;
    if (h.resumeAt != null) { const r = document.createElement('span'); r.className = 'resume'; r.textContent = `▶ Continue · ${Math.round(100 * (h.resumeAt - h.start) / (h.end - h.start))}% done`; th.appendChild(r); }
    el.querySelector('b').textContent = h.title;
    el.querySelector('.info span').textContent = hikeStats(h);
    th.onclick = () => openWalk(h);
    el.querySelector('b').onclick = () => openWalk(h);
    el.querySelector('.more').onclick = () => ask(h.title, hikeStats(h), [
      { label: 'Edit', fn: () => openAdd(h) },
      ...(h.resumeAt != null ? [{ label: 'Start from the beginning', fn: () => { h.resumeAt = null; saveHikes(); renderHome(); } }] : []),
      { label: 'Delete', cls: 'danger', fn: () => ask('Delete this hike?', `"${h.title}" will be removed from this phone.`, [
        { label: 'Delete', cls: 'danger', fn: () => { hikes = hikes.filter(x => x !== h); saveHikes(); renderHome(); } }]) },
    ]);
    list.appendChild(el);
  });
  const dl = $('durList'); dl.innerHTML = '';
  [[10, '10 min'], [15, '15 min'], [20, '20 min'], [30, '30 min'], [0, 'Whole hike']].forEach(([m, label]) => {
    const b = document.createElement('button'); b.className = 'chip' + (m === S.minutes ? ' sel' : ''); b.textContent = label;
    b.onclick = () => { S.minutes = m; saveS(); renderHome(); }; dl.appendChild(b);
  });
  const fmtMph = v => v.toFixed(1) + ' mph';
  [['setPace', 'outPace', 'pace', fmtMph], ['setMax', 'outMax', 'maxSpeed', fmtMph], ['setInc', 'outInc', 'maxIncline', v => v + '%']].forEach(([inp, out, key, f]) => {
    const el = $(inp); el.value = S[key]; $(out).textContent = f(S[key]);
    el.oninput = () => {
      S[key] = +el.value;
      if (key === 'pace' && S.pace > S.maxSpeed) S.maxSpeed = S.pace;
      if (key === 'maxSpeed' && S.pace > S.maxSpeed) S.pace = S.maxSpeed;
      ['pace', 'maxSpeed'].forEach((k, i) => { $(['setPace', 'setMax'][i]).value = S[k]; $(['outPace', 'outMax'][i]).textContent = fmtMph(S[k]); });
      $(out).textContent = f(S[key]); saveS();
    };
  });
  const real = tm.kind === 'ftms';
  $('connName').textContent = tm.name;
  $('connSub').textContent = real ? 'Connected over Bluetooth' : FtmsTreadmill.available()
    ? 'Pretend treadmill for trying the app. Tap Connect for the real one.'
    : "Pretend treadmill. This browser can't use Bluetooth (on iPhone, open this page in the Bluefy app).";
  $('connBtn').hidden = real || !FtmsTreadmill.available();
  $('walkConn').textContent = real ? tm.name : 'Practice';
}

/* ================= Add / edit a hike ================= */
let draft = null, prevPlayer = null;
function openAdd(h) {
  draft = h ? { ...h, coords: h.coords.map(c => c.slice()) } : { endFrac: 1 };
  $('addTitle').textContent = h ? 'Edit hike' : 'Add a hike';
  $('ytUrl').value = h ? 'https://youtu.be/' + h.youtubeId : '';
  $('hikeTitle').value = h?.title || ''; $('hikeTitle').hidden = !h;
  $('trailName').value = h?.trailName || ''; $('trailNear').value = h?.near || '';
  $('results').innerHTML = ''; $('findMsg').textContent = '';
  $('tStart').value = fmtTime(h?.start || 0); $('tEnd').value = fmtTime(h?.end || 0);
  $('endPct').value = Math.round((h?.endFrac ?? 1) * 100); updateEndPct();
  $('ytBox').hidden = true; $('trailStep').hidden = !h;
  show('add');
  if (h) { loadPreview(h.youtubeId); requestAnimationFrame(showTrail); }
}
async function loadPreview(id) {
  $('ytBox').hidden = false;
  prevPlayer = await makePlayer('ytPreview', id, 0);
  const dur = prevPlayer.getDuration?.() || 0;
  if (dur && !(parseTime($('tEnd').value) > 0)) { $('tEnd').value = fmtTime(dur); updatePace(); }
}
$('ytUrl').addEventListener('input', async () => {
  const id = ytId($('ytUrl').value);
  if (!id || id === draft.youtubeId) return;
  draft.youtubeId = id; $('tEnd').value = '0:00';
  $('hikeTitle').hidden = false;
  loadPreview(id);
  try {
    const j = await (await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`)).json();
    if (!$('hikeTitle').value) $('hikeTitle').value = j.title;
  } catch { /* she can type a name */ }
});
$('findBtn').onclick = async () => {
  const name = $('trailName').value, near = $('trailNear').value;
  if (!name.trim() || !near.trim()) return ($('findMsg').textContent = 'Type the trail name and the park or town it’s near.');
  $('findMsg').textContent = 'Looking for the trail…'; $('results').innerHTML = '';
  try {
    const found = await findTrails(name, near);
    if (!found.length) { $('findMsg').textContent = 'No trail with that name there. Try a shorter name (e.g. just "Angels Landing"), a bigger area, or use a GPX file.'; return; }
    $('findMsg').textContent = `Found ${found.length}. Tap the one in the video:`;
    found.forEach(t => {
      const b = document.createElement('button'); b.className = 'result';
      b.innerHTML = '<b></b><span></span>'; b.querySelector('b').textContent = t.name;
      b.querySelector('span').textContent = `${t.kind} · ${(t.lengthM * M_TO_MI).toFixed(1)} mi`;
      b.onclick = async () => {
        document.querySelectorAll('.result').forEach(x => x.classList.toggle('sel', x === b));
        draft.trailName = t.name; draft.near = near;
        await useTrail(resample(t.coords, 20));
      };
      $('results').appendChild(b);
    });
  } catch (e) { $('findMsg').textContent = e.message; }
};
$('gpxFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return; e.target.value = '';
  try {
    const g = parseGPX(await f.text());
    draft.trailName = g.name || f.name.replace(/\.gpx$/i, ''); draft.near = '';
    const hasEle = g.coords.every(c => c[2] != null);
    await useTrail(resample(g.coords, 20), hasEle);
  } catch (err) { $('findMsg').textContent = err.message; }
};
async function useTrail(coords, hasEle = false) {
  try {
    if (!hasEle) coords = await addElevation(coords, (p, waiting) => { $('findMsg').textContent = waiting
      ? `Long trail! The free map service needs a short break. Waiting a minute… (${Math.round(p * 100)}% done)`
      : `Reading the hills along the trail… ${Math.round(p * 100)}%`; });
    draft.coords = coords.map(c => [+c[0].toFixed(5), +c[1].toFixed(5), Math.round(c[2] * 10) / 10]);
    $('findMsg').textContent = 'Got it. Check the trail below.';
    $('trailStep').hidden = false; showTrail();
    $('trailStep').scrollIntoView({ behavior: 'smooth' });
  } catch (e) { $('findMsg').textContent = e.message; }
}
function showTrail() {
  if (!draft.coords) return;
  const r = buildRoute(cutCoords(draft.coords, draft.endFrac ?? 1));
  draft.lengthM = r.length; draft.climbM = r.climb; draft.maxGrade = r.maxGrade;
  drawMap($('pMap'), r, null, 18); drawElev($('pElev'), r, null);
  $('trailInfo').textContent = `${draft.trailName}: ${(r.length * M_TO_MI).toFixed(2)} mi, ${Math.round(r.climb * M_TO_FT).toLocaleString()} ft of climbing, steepest bit about ${Math.round(r.maxGrade)}%` +
    (r.maxGrade > S.maxIncline ? ` (your treadmill will stop at ${S.maxIncline}%)` : '') + '.';
  updatePace();
}
function updatePace() {
  const span = parseTime($('tEnd').value) - parseTime($('tStart').value);
  if (!draft?.lengthM || !(span > 0)) { $('paceMsg').textContent = ''; return; }
  const mph = draft.lengthM / span * MS_TO_MPH;
  $('paceMsg').textContent = `The hiker covers ${(draft.lengthM * M_TO_MI).toFixed(2)} mi in ${fmtTime(span)}, about ${mph.toFixed(1)} mph. ` +
    (mph > 4.5 ? 'That’s fast: the video is probably sped up or skips parts, so the hills may not line up well. Check the start/end times or the slider.' :
     mph < 0.6 ? 'That’s very slow: maybe the video stops before the end of the trail? Try the slider.' : 'Looks right.');
}
function updateEndPct() { const v = +$('endPct').value; $('endPctOut').textContent = v >= 100 ? 'end of trail' : v + '% along'; }
$('endPct').oninput = () => { updateEndPct(); draft.endFrac = +$('endPct').value / 100; showTrail(); };
$('tStart').onchange = $('tEnd').onchange = updatePace;
$('setStart').onclick = () => { if (prevPlayer) { $('tStart').value = fmtTime(prevPlayer.getCurrentTime()); updatePace(); } };
$('setEnd').onclick = () => { if (prevPlayer) { $('tEnd').value = fmtTime(prevPlayer.getCurrentTime()); updatePace(); } };
$('flipBtn').onclick = () => { draft.coords.reverse(); showTrail(); };
$('saveBtn').onclick = () => {
  const start = parseTime($('tStart').value), end = parseTime($('tEnd').value);
  if (!draft.youtubeId) return showBanner('Paste the YouTube link first.');
  if (!draft.coords) return showBanner('Find the trail first.');
  if (!(end > start)) return showBanner('The trail has to end later in the video than it starts.');
  const h = { id: draft.id || 'h' + Date.now(), title: $('hikeTitle').value.trim() || draft.trailName, youtubeId: draft.youtubeId,
    start, end, endFrac: draft.endFrac ?? 1, trailName: draft.trailName, near: draft.near, coords: draft.coords,
    lengthM: draft.lengthM, climbM: draft.climbM, maxGrade: draft.maxGrade, resumeAt: null, added: draft.added || new Date().toISOString(), edited: !!draft.id };
  const i = hikes.findIndex(x => x.id === h.id); if (i >= 0) hikes[i] = h; else hikes.unshift(h);
  saveHikes(); prevPlayer?.destroy?.(); prevPlayer = null; show('home'); renderHome(); showBanner(`Saved "${h.title}".`, 3000);
};
$('addBack').onclick = () => { prevPlayer?.destroy?.(); prevPlayer = null; show('home'); };
$('addBtn').onclick = () => openAdd(null);

/* ================= Walking ================= */
const WARMUP = 30, COOLDOWN = 30, SPEED_RAMP = 0.1, INC_STEP = 1, INC_EVERY = 4;
let W = null, H = null, route = null, player = null, timer = null, wakeLock = null;

async function openWalk(h) {
  H = h; route = routeFor(h); W = null;
  $('walkTitle').textContent = h.title; show('walk');
  $('startCover').classList.remove('hide'); $('goBtn').disabled = true; $('goBtn').textContent = 'Loading…';
  $('goSub').textContent = h.resumeAt != null ? `Continues ${Math.round(100 * (h.resumeAt - h.start) / (h.end - h.start))}% of the way along` : hikeStats(h);
  const at = h.resumeAt ?? h.start;
  renderIdle(at);
  player = await makePlayer('ytWalk', h.youtubeId, at, onVideoState);
  $('goBtn').disabled = false; $('goBtn').textContent = 'Start walking';
}
function trailPos(t) { const frac = clamp((t - H.start) / (H.end - H.start), 0, 1); return sample(route, frac * route.length); }
function renderIdle(t) {
  const pos = trailPos(t);
  drawMap($('mapCanvas'), route, pos, 8); drawElev($('elevCanvas'), route, pos);
  $('sSpeed').textContent = '0.0'; $('sInc').textContent = '0'; $('sDist').textContent = '0.00';
  $('sTime').textContent = S.minutes ? fmtTime(S.minutes * 60) : fmtTime(H.end - t); $('sTrail').textContent = `${Math.round(100 * pos.d / route.length)}% of trail`;
  $('ahead').textContent = ''; $('sSpeedT').textContent = $('sIncT').textContent = $('sPhase').textContent = ' ';
}
function onVideoState(s) {
  if (!W) return;
  const YT = window.YT;
  if (s === YT.PlayerState.PAUSED) {
    if (W.selfPause) { W.selfPause = false; return; }
    if (W.state === 'running') togglePause(); // she paused the video herself: pause the belt too
  }
  if (s === YT.PlayerState.PLAYING && W.state === 'countdown') vidPause(); // hold the video until the belt moves
  if (s === YT.PlayerState.ENDED && W.state === 'running' && !W.cooling) W.cooling = W.elapsed;
}
function vidPause() { if (player.getPlayerState() === window.YT.PlayerState.PLAYING) { W.selfPause = true; player.pauseVideo(); } }
function vidPlay() { if (player.getPlayerState() !== window.YT.PlayerState.PLAYING) player.playVideo(); }

$('goBtn').onclick = async () => {
  player.playVideo(); // inside the tap, so iPhone lets the video play
  $('startCover').classList.add('hide');
  W = { state: 'countdown', elapsed: 0, belt: 0, climbed: 0, nudge: 0, cmdSpeed: 1.0, sentSpeed: 1.0, sentSpeedAt: 0, sentInc: 0, sentIncAt: 0,
        last: performance.now(), actual: { speed: 0, incline: 0 }, pos: trailPos(H.resumeAt ?? H.start), rateAt: 0, savedAt: 0, cooling: null, selfPause: false };
  W.lastEle = W.pos.ele;
  W.hikerMph = route.length / (H.end - H.start) * MS_TO_MPH;
  if (tm.kind === 'practice') await tm.connect();
  tm.onData = d => { if (W) W.actual = d; };
  tm.onLost = () => { showBanner('Lost connection to the treadmill. Use its remote or stop button if you need to stop.', 15000); if (W && W.state === 'running') togglePause(); };
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* fine without */ }
  await countdown();
  await tm.setIncline(0); await tm.setSpeed(1.0 * MPH_TO_KMH); await tm.start();
  W.state = 'running'; W.last = performance.now();
  clearInterval(timer); timer = setInterval(tick, 200);
};
function countdown() {
  return new Promise(res => {
    let n = 3; $('countNum').textContent = n; $('countOv').classList.add('show');
    const iv = setInterval(() => { n--; if (n === 0) { clearInterval(iv); $('countOv').classList.remove('show'); res(); } else $('countNum').textContent = n; }, 1000);
  });
}

function tick() {
  const now = performance.now(), dt = Math.min(0.5, (now - W.last) / 1000); W.last = now;
  const actualMph = (W.actual.speed || 0) / MPH_TO_KMH;
  const t = player.getCurrentTime() || 0;
  W.pos = trailPos(t);
  // count climbing only while walking along, not when she skips around in the video
  if (W.state === 'running' && Math.abs(W.pos.d - (W.lastD ?? W.pos.d)) < 40 && W.pos.ele > W.lastEle) W.climbed += W.pos.ele - W.lastEle;
  W.lastEle = W.pos.ele; W.lastD = W.pos.d;
  W.belt += actualMph / MS_TO_MPH * dt;
  if (W.state === 'running') {
    W.elapsed += dt;
    if (!W.cooling && ((S.minutes && W.elapsed >= S.minutes * 60) || t >= H.end - 0.5)) W.cooling = W.elapsed;
    const ahead = sample(route, W.pos.d + 15);           // look a little ahead: the belt takes a few seconds to tilt
    let inc = clamp(Math.round(ahead.grade * 2) / 2, 0, S.maxIncline);   // treadmill can't go downhill
    let spd = S.pace + W.nudge;
    if (ahead.grade > 4) spd -= 0.08 * (ahead.grade - 4);                // ease off on steep bits
    if (W.elapsed < WARMUP) { const f = W.elapsed / WARMUP; spd = 1.0 + (spd - 1.0) * f; inc = Math.min(inc, 3 * f); }
    if (W.cooling != null) {
      const f = clamp((W.elapsed - W.cooling) / COOLDOWN, 0, 1); spd = spd + (1.0 - spd) * f; inc = 0;
      if (f >= 1) return finish();
    }
    spd = clamp(spd, 0.8, S.maxSpeed);
    W.cmdSpeed += clamp(spd - W.cmdSpeed, -SPEED_RAMP * dt * 2, SPEED_RAMP * dt);
    if (Math.abs(W.cmdSpeed - W.sentSpeed) >= 0.1 && now - W.sentSpeedAt > 1000) {
      W.sentSpeed = Math.round(W.cmdSpeed * 10) / 10; W.sentSpeedAt = now; tm.setSpeed(W.sentSpeed * MPH_TO_KMH);
    }
    if (Math.abs(inc - W.sentInc) >= 0.5 && now - W.sentIncAt > INC_EVERY * 1000) {
      W.sentInc = Math.round((W.sentInc + clamp(inc - W.sentInc, -INC_STEP, INC_STEP)) * 2) / 2; W.sentIncAt = now; tm.setIncline(W.sentInc);
    }
    // the video moves at her pace: hiker's speed × (her belt speed / hiker's speed), snapped to YouTube's speeds
    if (actualMph < 0.3) vidPause();
    else {
      vidPlay();
      if (now - W.rateAt > 3000) {
        W.rateAt = now;
        const want = clamp(actualMph / W.hikerMph, 0.5, 2);
        const rates = (player.getAvailablePlaybackRates?.() || [0.5, 0.75, 1, 1.25, 1.5, 2]).filter(r => r >= 0.5 && r <= 2);
        const best = rates.reduce((a, r) => Math.abs(r - want) < Math.abs(a - want) ? r : a, 1);
        if (best !== player.getPlaybackRate()) player.setPlaybackRate(best);
      }
    }
    if (now - W.savedAt > 10000) { W.savedAt = now; saveResume(t); }
  }
  if (W.state === 'pausing' && actualMph < 0.05) W.state = 'paused';
  render(actualMph, t);
}
function render(actualMph, t) {
  $('sSpeed').textContent = actualMph.toFixed(1);
  $('sSpeedT').textContent = W.state === 'running' ? `video ×${player.getPlaybackRate()}` : W.state === 'paused' ? 'paused' : W.state === 'pausing' ? 'slowing…' : ' ';
  $('sInc').textContent = (W.actual.incline || 0).toFixed(0);
  $('sIncT').textContent = `trail ${Math.round(W.pos.grade)}%` + (W.pos.grade > S.maxIncline ? ' (capped)' : '');
  const left = W.cooling != null ? COOLDOWN - (W.elapsed - W.cooling) : S.minutes ? S.minutes * 60 - W.elapsed : (H.end - t) / Math.max(0.5, player.getPlaybackRate());
  $('sTime').textContent = fmtTime(left);
  $('sPhase').textContent = W.elapsed < WARMUP ? 'warm‑up' : W.cooling != null ? 'cool‑down' : ' ';
  $('sDist').textContent = (W.belt * M_TO_MI).toFixed(2);
  $('sTrail').textContent = `${Math.round(100 * W.pos.d / route.length)}% · ${Math.round(W.climbed * M_TO_FT)} ft up`;
  $('ahead').textContent = lookAhead();
  $('hSpeed').textContent = $('sSpeed').textContent; $('hInc').textContent = $('sInc').textContent;
  $('hTime').textContent = $('sTime').textContent; $('hAhead').textContent = $('ahead').textContent;
  drawMap($('mapCanvas'), route, W.pos, 8); drawElev($('elevCanvas'), route, W.pos);
}
function lookAhead() {
  const here = W.pos.grade;
  for (let a = 20; a <= 400; a += 10) {
    const g = sample(route, W.pos.d + a).grade;
    if (g >= 4 && here < 3) return `Climb in ${Math.round(a * M_TO_FT / 10) * 10} ft`;
    if (g < 1.5 && here >= 4) return `Top in ${Math.round(a * M_TO_FT / 10) * 10} ft`;
  }
  return here >= 4 ? 'Climbing' : here <= -3 ? 'Downhill' : '';
}
function saveResume(t) { H.resumeAt = t < H.end - 20 ? t : null; saveHikes(); }

async function togglePause() {
  if (!W) return;
  if (W.state === 'running') {
    W.state = 'pausing'; await tm.pause(); vidPause();
    setPauseLabel(true);
  } else if (W.state === 'paused' || W.state === 'pausing') {
    W.state = 'countdown'; await countdown();
    W.cmdSpeed = W.sentSpeed = 1.0; await tm.setSpeed(1.0 * MPH_TO_KMH); await tm.start(); // restart gently
    W.state = 'running'; W.last = performance.now();
    setPauseLabel(false);
  }
}
async function finish() {
  clearInterval(timer); await tm.stop(); setTV(false);
  const t = player.getCurrentTime() || 0; vidPause();
  W.state = 'done'; saveResume(t);
  const whole = H.resumeAt == null;
  $('doneTxt').textContent = `${(W.belt * M_TO_MI).toFixed(2)} miles in ${fmtTime(W.elapsed)}, climbing about ${Math.round(W.climbed * M_TO_FT)} ft on ${H.title}. ` +
    (whole ? 'You finished the whole trail!' : `You're ${Math.round(100 * (t - H.start) / (H.end - H.start))}% of the way along. Next time it picks up from here.`);
  $('doneOv').classList.add('show');
  try { await wakeLock?.release(); } catch { /* already released */ }
}
function setPauseLabel(paused) {
  for (const id of ['pauseBtn', 'hPause']) { $(id).textContent = paused ? 'RESUME' : 'PAUSE'; $(id).classList.toggle('resume', paused); }
}
// Full screen: the video covers the whole screen; iPad/Mac browsers also hide their own bars
function setTV(on) {
  $('walk').classList.toggle('tv', on); document.documentElement.classList.toggle('tvmode', on);
  if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
$('fsBtn').onclick = () => setTV(true);
$('hExit').onclick = () => setTV(false);
$('hPause').onclick = () => togglePause();
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) { $('walk').classList.remove('tv'); document.documentElement.classList.remove('tvmode'); } });
function leaveWalk() {
  clearInterval(timer); W = null; player?.destroy?.(); player = null; setTV(false);
  setPauseLabel(false);
  show('home'); renderHome();
}
$('pauseBtn').onclick = togglePause;
$('slowerBtn').onclick = () => { if (W?.state === 'running') W.nudge = clamp(W.nudge - 0.2, -1.5, 1.5); };
$('fasterBtn').onclick = () => { if (W?.state === 'running') W.nudge = clamp(W.nudge + 0.2, -1.5, 1.5); };
$('endBtn').onclick = () => { if (W && W.state !== 'done') finish(); else leaveWalk(); };
$('walkBack').onclick = () => { if (W && W.state !== 'done') finish(); else leaveWalk(); };
$('doneBtn').onclick = () => { $('doneOv').classList.remove('show'); leaveWalk(); };
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('walk').classList.contains('tv')) return setTV(false);
  if (!W || e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  if (e.key === 'ArrowUp') $('fasterBtn').click();
  if (e.key === 'ArrowDown') $('slowerBtn').click();
});

/* ================= Treadmill, backup, help ================= */
$('connBtn').onclick = async () => {
  const t = new FtmsTreadmill();
  try { await t.connect(); tm = t; renderHome(); showBanner(`Connected to ${t.name}.`, 3000); }
  catch (e) { showBanner(e.name === 'NotFoundError' ? 'No treadmill picked.' : "Couldn't connect: " + e.message); }
};
$('exportBtn').onclick = () => {
  const blob = new Blob([JSON.stringify({ app: 'trailwalk', version: 1, hikes }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'cheryles-hikes-backup.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$('importFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return; e.target.value = '';
  try {
    const j = JSON.parse(await f.text()); const list = Array.isArray(j) ? j : j.hikes;
    if (!Array.isArray(list)) throw new Error('not a hikes file');
    let n = 0; for (const h of list) if (h.youtubeId && h.coords && !hikes.some(x => x.id === h.id)) { hikes.push(h); n++; }
    saveHikes(); renderHome(); showBanner(`Added ${n} hike${n === 1 ? '' : 's'}.`, 3000);
  } catch (err) { showBanner("That file didn't work: " + err.message); }
};
$('helpBtn').onclick = () => $('helpOv').classList.add('show');
$('helpClose').onclick = () => $('helpOv').classList.remove('show');
window.addEventListener('resize', () => { if (W) render((W.actual.speed || 0) / MPH_TO_KMH, player.getCurrentTime()); else if (draft && $('add').classList.contains('active')) showTrail(); });

renderHome();
loadStarters();
window.TW = { get draft() { return draft; }, get W() { return W; }, get H() { return H; }, get hikes() { return hikes; }, S, get player() { return player; } }; // for testing
