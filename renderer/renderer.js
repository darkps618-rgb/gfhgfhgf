'use strict';
const $ = id => document.getElementById(id);
const api = window.halo;
const app = $('app'), cv = $('cv'), sv = $('sv'), cvid = $('cvid'), stage = $('stage');
const c2d = cv.getContext('2d');
const pad = x => String(x).padStart(2, '0');
const fmtT = s => `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(Math.floor(s % 60))}`;
const wait = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const PLATFORMS = {
  twitch: 'rtmp://live.twitch.tv/app',
  youtube: 'rtmp://a.rtmp.youtube.com/live2',
  facebook: 'rtmps://live-api-s.facebook.com:443/rtmp',
  custom: ''
};

const S = {
  stream: null, srcName: '', ctx: null, dest: null, sysGain: null, micGain: null, sysNode: null,
  micStream: null, micNode: null, an: null, composite: null, camStream: null, camOn: false,
  cam: { x: 0.87, y: 0.76 }, raf: 0, last: 0, interval: 33,
  rec: null, recTick: 0, recT0: 0, recAcc: 0, recBytes: 0,
  live: null, liveTick: 0, liveT0: 0, drag: null, srcList: [], tab: 'screen', meterOn: false
};

/* ---------- small UI helpers ---------- */
const showErr = m => { const e = $('err'); e.textContent = m || ''; e.style.display = m ? 'block' : 'none'; };
let toastTimer;
function toast(msg, path) {
  $('toastMsg').textContent = msg;
  $('toastLink').style.display = path ? 'inline' : 'none';
  $('toastLink').onclick = () => api.show(path);
  $('toast').style.display = 'flex';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').style.display = 'none', 7000);
}
function setClasses() {
  const paused = S.rec && S.rec.state === 'paused';
  app.className = 'app' + (S.stream ? ' has-src' : '') + (S.camOn ? ' has-cam' : '') +
    (S.rec ? (paused ? ' paused' : ' rec') : '') + (S.live ? ' live' : '');
  $('state').textContent = S.rec ? (paused ? 'Paused' : 'Recording') : 'Ready';
  const busy = !!(S.rec || S.live);
  $('quality').disabled = busy;
  api.setBusy(busy);
}

/* ---------- preferences ---------- */
const PREF_IDS = ['quality', 'fmt', 'cd', 'sys', 'mic', 'cur', 'camShape', 'camSize', 'camMirror', 'camBorder',
  'sysVol', 'micVol', 'platform', 'customUrl', 'vbr', 'remember'];
function loadPrefs() {
  let p = {}; try { p = JSON.parse(localStorage.getItem('halo.prefs') || '{}'); } catch {}
  for (const id of PREF_IDS) {
    const el = $(id); if (!el || p[id] === undefined) continue;
    if (el.type === 'checkbox') el.checked = p[id]; else el.value = p[id];
  }
  if (p.cam) S.cam = p.cam;
}
function savePrefs() {
  const p = { cam: S.cam };
  for (const id of PREF_IDS) { const el = $(id); p[id] = el.type === 'checkbox' ? el.checked : el.value; }
  try { localStorage.setItem('halo.prefs', JSON.stringify(p)); } catch {}
}

function profile() {
  const [h, fps] = $('quality').value.split('-').map(Number);
  return { h, fps, bps: h >= 2160 ? 25e6 : fps === 60 ? 12e6 : h === 720 ? 5e6 : 8e6 };
}

/* ---------- compositor: screen + webcam drawn onto one canvas ---------- */
function applySize() {
  const p = profile();
  const vw = sv.videoWidth || 16, vh = sv.videoHeight || 9;
  const H = Math.round(p.h / 2) * 2, W = Math.round((H * vw / vh) / 2) * 2;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  stage.style.setProperty('--ar', (W / H).toFixed(4));
  S.interval = 1000 / p.fps;
}
function camRect() {
  const W = cv.width, H = cv.height, shape = $('camShape').value;
  const s = (+$('camSize').value / 100) * H;
  const asp = shape === 'wide' ? (cvid.videoWidth / cvid.videoHeight || 16 / 9) : 1;
  const w = s * asp, h = s;
  return { x: clamp(S.cam.x * W - w / 2, 0, W - w), y: clamp(S.cam.y * H - h / 2, 0, H - h), w, h };
}
function camPath(c, r, shape) {
  c.beginPath();
  if (shape === 'circle') c.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
  else c.roundRect(r.x, r.y, r.w, r.h, r.h * 0.14);
}
function drawCam(c, W, H) {
  const r = camRect(), shape = $('camShape').value;
  c.save(); c.shadowColor = 'rgba(0,0,0,.5)'; c.shadowBlur = H * 0.02; c.shadowOffsetY = H * 0.006;
  c.fillStyle = '#000'; camPath(c, r, shape); c.fill(); c.restore();
  c.save(); camPath(c, r, shape); c.clip();
  const vw = cvid.videoWidth, vh = cvid.videoHeight, ta = r.w / r.h, va = vw / vh;
  let sx, sy, sw, sh;
  if (va > ta) { sh = vh; sw = vh * ta; sx = (vw - sw) / 2; sy = 0; } else { sw = vw; sh = vw / ta; sx = 0; sy = (vh - sh) / 2; }
  if ($('camMirror').checked) { c.translate(r.x + r.w, 0); c.scale(-1, 1); c.drawImage(cvid, sx, sy, sw, sh, 0, r.y, r.w, r.h); }
  else c.drawImage(cvid, sx, sy, sw, sh, r.x, r.y, r.w, r.h);
  c.restore();
  if ($('camBorder').checked) {
    const g = c.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
    g.addColorStop(0, '#8b5cf6'); g.addColorStop(1, '#ff4d8d');
    c.save(); c.lineWidth = Math.max(3, H * 0.006); c.strokeStyle = g; camPath(c, r, shape); c.stroke(); c.restore();
  }
}
function frame(ts) {
  S.raf = requestAnimationFrame(frame);
  if (ts - S.last < S.interval - 3) return;
  S.last = ts;
  const W = cv.width, H = cv.height;
  c2d.imageSmoothingQuality = 'high';
  c2d.fillStyle = '#000'; c2d.fillRect(0, 0, W, H);
  if (sv.readyState >= 2 && sv.videoWidth) {
    const k = Math.min(W / sv.videoWidth, H / sv.videoHeight), w = sv.videoWidth * k, h = sv.videoHeight * k;
    c2d.drawImage(sv, (W - w) / 2, (H - h) / 2, w, h);
  }
  if (S.camOn && cvid.readyState >= 2 && cvid.videoWidth) drawCam(c2d, W, H);
}

/* webcam: left-click drag to move, wheel to resize */
const toCanvas = e => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height }; };
function hitCam(p) {
  if (!S.camOn || !S.stream) return false;
  const r = camRect();
  if ($('camShape').value === 'circle') {
    const dx = (p.x - (r.x + r.w / 2)) / (r.w / 2), dy = (p.y - (r.y + r.h / 2)) / (r.h / 2);
    return dx * dx + dy * dy <= 1;
  }
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}
cv.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const p = toCanvas(e);
  if (hitCam(p)) {
    S.drag = { dx: p.x - S.cam.x * cv.width, dy: p.y - S.cam.y * cv.height };
    cv.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing';
  }
});
cv.addEventListener('pointermove', e => {
  const p = toCanvas(e);
  if (S.drag) {
    S.cam.x = clamp((p.x - S.drag.dx) / cv.width, 0, 1);
    S.cam.y = clamp((p.y - S.drag.dy) / cv.height, 0, 1);
  } else cv.style.cursor = hitCam(p) ? 'grab' : 'default';
});
const endDrag = () => { if (S.drag) { S.drag = null; cv.style.cursor = 'grab'; savePrefs(); } };
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', endDrag);
cv.addEventListener('wheel', e => {
  if (!hitCam(toCanvas(e))) return;
  e.preventDefault();
  const s = $('camSize'); s.value = clamp(+s.value + (e.deltaY < 0 ? 2 : -2), +s.min, +s.max); savePrefs();
}, { passive: false });
$('camReset').onclick = () => { S.cam = { x: 0.87, y: 0.76 }; savePrefs(); };

/* ---------- devices ---------- */
async function listDevices() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind, def) => {
      const cur = sel.value; sel.innerHTML = `<option value="">${def}</option>`;
      devs.filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').forEach((d, i) => {
        const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || `${def} ${i + 1}`; sel.appendChild(o);
      });
      if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
    };
    fill($('camDev'), 'videoinput', 'Default camera'); fill($('micDev'), 'audioinput', 'Default microphone');
  } catch {}
}
navigator.mediaDevices.addEventListener('devicechange', listDevices);

async function setCam(on) {
  S.camOn = on;
  if (S.camStream) { S.camStream.getTracks().forEach(t => t.stop()); S.camStream = null; cvid.srcObject = null; }
  if (on) {
    try {
      const dev = $('camDev').value;
      S.camStream = await navigator.mediaDevices.getUserMedia({ video: {
        deviceId: dev ? { exact: dev } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
      cvid.srcObject = S.camStream; await cvid.play(); listDevices();
    } catch (e) {
      S.camOn = false; showErr('Halo could not open the camera. Check that no other app is using it and that camera access is allowed in Windows privacy settings.');
    }
  }
  $('camOn').checked = S.camOn; $('camBtn').classList.toggle('on', S.camOn); setClasses();
}
$('camOn').onchange = e => setCam(e.target.checked);
$('camBtn').onclick = () => setCam(!S.camOn);
$('camDev').onchange = () => { if (S.camOn) setCam(true); };

/* ---------- audio mixer (system + mic -> one track) ---------- */
function ensureAudio() {
  if (S.ctx) return;
  S.ctx = new AudioContext(); S.dest = S.ctx.createMediaStreamDestination();
  S.sysGain = S.ctx.createGain(); S.sysGain.connect(S.dest);
  S.micGain = S.ctx.createGain(); S.micGain.connect(S.dest);
  S.an = S.ctx.createAnalyser(); S.an.fftSize = 256; S.micGain.connect(S.an);
  applyGains();
}
function applyGains() {
  if (!S.ctx) return;
  S.sysGain.gain.value = $('sys').checked ? $('sysVol').value / 100 : 0;
  S.micGain.gain.value = $('micVol').value / 100;
}
async function setMic(on) {
  if (S.micStream) { S.micStream.getTracks().forEach(t => t.stop()); if (S.micNode) S.micNode.disconnect(); S.micStream = S.micNode = null; }
  S.meterOn = false; $('meterbox').style.display = 'none';
  if (!on || !S.ctx) return;
  try {
    const dev = $('micDev').value;
    S.micStream = await navigator.mediaDevices.getUserMedia({ audio: {
      deviceId: dev ? { exact: dev } : undefined, echoCancellation: true, noiseSuppression: true } });
    S.micNode = S.ctx.createMediaStreamSource(S.micStream); S.micNode.connect(S.micGain);
    $('meterbox').style.display = 'grid'; S.meterOn = true; meterLoop(); listDevices();
  } catch { $('mic').checked = false; showErr('Microphone access was blocked, so Halo is recording without it.'); }
}
function meterLoop() {
  const d = new Uint8Array(S.an.frequencyBinCount);
  (function loop() {
    if (!S.meterOn || !S.an) return;
    S.an.getByteFrequencyData(d); let m = 0; d.forEach(v => m = Math.max(m, v));
    $('meter').style.width = Math.min(100, m / 2.2) + '%'; requestAnimationFrame(loop);
  })();
}
$('sys').onchange = applyGains; $('sysVol').oninput = applyGains; $('micVol').oninput = applyGains;
$('mic').onchange = e => setMic(e.target.checked);
$('micDev').onchange = () => { if ($('mic').checked) setMic(true); };

/* ---------- source picker ---------- */
const dlg = $('dlg');
async function openPicker() {
  if (S.rec || S.live) { showErr('Stop recording and streaming before switching source.'); return; }
  dlg.showModal(); await loadSources();
}
async function loadSources() {
  $('srcGrid').innerHTML = '<p class="hint">Looking for screens and apps…</p>';
  try { S.srcList = await api.sources(); } catch { S.srcList = []; }
  renderSources();
}
function renderSources() {
  const g = $('srcGrid'); g.innerHTML = '';
  const items = S.srcList.filter(s => s.type === S.tab);
  if (!items.length) { g.innerHTML = '<p class="hint">Nothing found here.</p>'; return; }
  for (const s of items) {
    const b = document.createElement('button'); b.className = 'src';
    const th = document.createElement('img'); th.className = 'th'; th.alt = ''; if (s.thumb) th.src = s.thumb;
    const row = document.createElement('span');
    if (s.icon) { const ic = document.createElement('img'); ic.src = s.icon; ic.alt = ''; row.appendChild(ic); }
    const nm = document.createElement('em'); nm.textContent = s.name; nm.title = s.name; row.appendChild(nm);
    b.append(th, row); b.onclick = () => { dlg.close(); startCapture(s); };
    g.appendChild(b);
  }
}
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  S.tab = t.dataset.t; document.querySelectorAll('.tab').forEach(x => x.setAttribute('aria-selected', x === t)); renderSources();
});
$('dRefresh').onclick = loadSources; $('dClose').onclick = () => dlg.close();
dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
['pickBtn', 'srcBtn', 'srcBtn2'].forEach(id => $(id).onclick = openPicker);

/* ---------- capture session ---------- */
function buildComposite() {
  if (!S.dest) return;
  if (S.composite) S.composite.getVideoTracks().forEach(t => t.stop());
  const v = cv.captureStream(profile().fps).getVideoTracks();
  S.composite = new MediaStream([...v, ...S.dest.stream.getAudioTracks()]);
}
async function startCapture(src) {
  await endCapture();
  showErr('');
  await api.selectSource(src.id);
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: profile().fps, max: profile().fps }, cursor: $('cur').checked ? 'always' : 'never' }, audio: true });
  } catch { return showErr('Halo could not capture that source. If it is a window, make sure it is not minimised.'); }
  S.stream = stream; S.srcName = src.name;
  $('srcName').textContent = src.name;
  sv.srcObject = stream; await sv.play().catch(() => {});
  if (!sv.videoWidth) await new Promise(r => sv.addEventListener('loadedmetadata', r, { once: true }));
  ensureAudio();
  const aud = stream.getAudioTracks();
  if (aud.length) { S.sysNode = S.ctx.createMediaStreamSource(new MediaStream(aud)); S.sysNode.connect(S.sysGain); }
  else if ($('sys').checked) showErr('System audio is not available for this source on this computer, so only the microphone will be recorded.');
  if ($('mic').checked) await setMic(true);
  applySize(); buildComposite();
  stream.getVideoTracks()[0].addEventListener('ended', () => { showErr('The captured screen or app was closed.'); endCapture(); });
  S.last = 0; cancelAnimationFrame(S.raf); S.raf = requestAnimationFrame(frame);
  $('main').disabled = false; $('snap').disabled = false; setClasses();
}
async function endCapture() {
  if (S.rec) await stopRec();
  if (S.live) await stopLive();
  cancelAnimationFrame(S.raf);
  S.meterOn = false;
  if (S.micStream) { S.micStream.getTracks().forEach(t => t.stop()); S.micStream = S.micNode = null; }
  if (S.composite) { S.composite.getVideoTracks().forEach(t => t.stop()); S.composite = null; }
  if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
  if (S.ctx) { S.ctx.close(); S.ctx = S.dest = S.sysNode = S.an = null; }
  sv.srcObject = null; $('meterbox').style.display = 'none';
  $('snap').disabled = true; $('pause').disabled = true; $('srcName').textContent = 'Nothing selected';
  setClasses();
}
$('quality').onchange = () => { if (S.stream && !S.rec && !S.live) { applySize(); buildComposite(); } };

/* ---------- local recording ---------- */
const MIME_MP4 = ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
const MIME_WEBM = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
const pickMime = list => list.find(m => MediaRecorder.isTypeSupported(m)) || '';
async function countdown(s) {
  if (!s) return;
  $('count').style.display = 'grid';
  for (let i = s; i > 0; i--) { $('cnum').textContent = i; await wait(1000); }
  $('count').style.display = 'none';
}
function queueWriter(send) {
  let q = Promise.resolve();
  return { push: blob => { q = q.then(() => blob.arrayBuffer()).then(send).catch(() => {}); }, done: () => q };
}
async function startRec() {
  if (!S.stream) return openPicker();
  if (S.rec) return;
  $('main').disabled = true;
  await countdown(+$('cd').value);
  if (!S.stream) { $('main').disabled = false; return; }
  const container = $('fmt').value, p = profile();
  const mime = pickMime(container === 'mp4' ? MIME_MP4 : MIME_WEBM);
  const id = await api.recOpen();
  const w = queueWriter(buf => api.recChunk(id, buf));
  const r = new MediaRecorder(S.composite, { mimeType: mime, videoBitsPerSecond: p.bps, audioBitsPerSecond: 192000 });
  S.recBytes = 0; S.recAcc = 0;
  r.ondataavailable = e => {
    if (!e.data.size) return;
    S.recBytes += e.data.size; $('size').textContent = (S.recBytes / 1048576).toFixed(1) + ' MB'; w.push(e.data);
  };
  r.onstop = async () => {
    await w.done();
    $('state').textContent = 'Saving…';
    const res = await api.recClose(id, { container, h264: /h264|avc/i.test(mime) });
    $('timer').textContent = '00:00:00'; $('size').textContent = '0.0 MB';
    if (res && res.ok) toast(`Saved ${(res.size / 1048576).toFixed(1)} MB${res.warn ? '. ' + res.warn : ''}`, res.path);
    else showErr('Halo could not save the recording.');
    refreshLib(); setClasses();
  };
  r.start(1000); S.rec = r; S.recT0 = Date.now();
  S.recTick = setInterval(() => $('timer').textContent = fmtT(S.recAcc + (Date.now() - S.recT0) / 1000), 250);
  $('main').disabled = false; $('main').setAttribute('aria-label', 'Stop recording'); $('pause').disabled = false;
  setClasses();
}
function togglePause() {
  const r = S.rec; if (!r) return;
  if (r.state === 'recording') {
    r.pause(); S.recAcc += (Date.now() - S.recT0) / 1000; clearInterval(S.recTick);
    $('pico').innerHTML = '<path d="M8 5v14l11-7z"/>'; $('pause').setAttribute('aria-label', 'Resume recording');
  } else if (r.state === 'paused') {
    r.resume(); S.recT0 = Date.now();
    S.recTick = setInterval(() => $('timer').textContent = fmtT(S.recAcc + (Date.now() - S.recT0) / 1000), 250);
    $('pico').innerHTML = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>'; $('pause').setAttribute('aria-label', 'Pause recording');
  }
  setClasses();
}
async function stopRec() {
  const r = S.rec; if (!r) return;
  clearInterval(S.recTick); S.rec = null;
  $('pico').innerHTML = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';
  $('pause').disabled = true; $('main').setAttribute('aria-label', 'Start recording');
  await new Promise(res => { const prev = r.onstop; r.onstop = async () => { await prev(); res(); }; try { r.stop(); } catch { res(); } });
  setClasses();
}
$('main').onclick = () => S.rec ? stopRec() : startRec();
$('pause').onclick = togglePause;

/* ---------- screenshot ---------- */
$('snap').onclick = () => cv.toBlob(async b => {
  if (!b) return;
  const p = await api.shotSave(await b.arrayBuffer()); toast('Screenshot saved', p);
}, 'image/png');

/* ---------- live streaming ---------- */
function syncPlatformUi() { $('urlBox').style.display = $('platform').value === 'custom' ? 'grid' : 'none'; }
async function loadKey() { $('key').value = $('remember').checked ? await api.keyGet($('platform').value) : ''; }
$('platform').onchange = () => { syncPlatformUi(); loadKey(); };
async function goLive() {
  if (!S.stream) return openPicker();
  if (S.live) return stopLive();
  showErr('');
  const plat = $('platform').value, key = $('key').value.trim();
  const url = plat === 'custom' ? $('customUrl').value.trim() : PLATFORMS[plat];
  if (!/^rtmps?:\/\//i.test(url)) return showErr('Enter a server URL that starts with rtmp:// or rtmps://');
  if (!key && plat !== 'custom') return showErr('Paste your stream key first. You can find it in your ' + plat + ' dashboard.');
  const p = profile();
  const res = await api.liveStart({ url, key, fps: p.fps, vkbps: +$('vbr').value });
  if (!res.ok) return showErr(res.error);
  if ($('remember').checked) api.keySet(plat, key); else api.keySet(plat, '');
  const mime = pickMime(['video/webm;codecs=vp8,opus', 'video/webm']);
  const w = queueWriter(buf => api.liveChunk(buf));
  const r = new MediaRecorder(S.composite, { mimeType: mime, videoBitsPerSecond: +$('vbr').value * 1000, audioBitsPerSecond: 160000 });
  r.ondataavailable = e => { if (e.data.size) w.push(e.data); };
  r.start(250); S.live = r; S.liveT0 = Date.now();
  S.liveTick = setInterval(() => $('liveState').textContent = 'LIVE ' + fmtT((Date.now() - S.liveT0) / 1000), 500);
  $('liveLbl').textContent = 'End stream'; $('liveStats').textContent = 'Connecting…'; setClasses();
}
async function stopLive() {
  const r = S.live; if (!r) return;
  S.live = null; clearInterval(S.liveTick);
  try { r.stop(); } catch {}
  await api.liveStop();
  $('liveLbl').textContent = 'Go live'; $('liveStats').textContent = 'Not live'; $('liveState').textContent = 'LIVE'; setClasses();
}
api.onLiveStats(s => { if (S.live) $('liveStats').textContent = `${s.kbps.toFixed(0)} kbps · ${s.fps.toFixed(0)} fps · speed ${s.speed.toFixed(2)}x`; });
api.onLiveEnded(d => {
  if (S.live) {
    try { S.live.stop(); } catch {} S.live = null; clearInterval(S.liveTick);
    $('liveLbl').textContent = 'Go live'; $('liveStats').textContent = 'Not live'; setClasses();
    showErr('The stream ended unexpectedly.' + (d.tail ? '\n' + d.tail : '') + '\nCheck your stream key and internet connection.');
  }
});
$('liveBtn').onclick = goLive;

/* ---------- library ---------- */
const fileUrl = p => 'file:///' + encodeURI(p.replace(/\\/g, '/')).replace(/#/g, '%23');
async function refreshLib() {
  const list = await api.libList(), shelf = $('shelf');
  shelf.innerHTML = ''; $('emptylib').style.display = list.length ? 'none' : 'block';
  for (const f of list) {
    const el = document.createElement('article'); el.className = 'card clip';
    const v = document.createElement('video'); v.src = fileUrl(f.path); v.controls = true; v.muted = true; v.preload = 'metadata';
    const info = document.createElement('div'); info.className = 'info';
    const d = document.createElement('div'); const b = document.createElement('b'); b.textContent = f.name;
    const sm = document.createElement('small'); sm.textContent = `${(f.size / 1048576).toFixed(1)} MB · ${new Date(f.mtime).toLocaleString()}`;
    d.append(b, sm);
    const acts = document.createElement('div'); acts.className = 'acts';
    const show = document.createElement('button'); show.className = 'btn p'; show.textContent = 'Show'; show.onclick = () => api.show(f.path);
    const del = document.createElement('button'); del.className = 'btn'; del.textContent = 'Delete';
    del.onclick = async () => { if (confirm('Move this recording to the Recycle Bin?')) { await api.libDelete(f.path); refreshLib(); } };
    acts.append(show, del); info.append(d, acts); el.append(v, info); shelf.appendChild(el);
  }
}
$('openFolder').onclick = () => api.openFolder();

/* ---------- global shortcuts, boot ---------- */
api.onShortcut(n => {
  if (n === 'record') $('main').click();
  else if (n === 'pause') togglePause();
  else if (n === 'live') goLive();
  else if (n === 'camera') setCam(!S.camOn);
});
PREF_IDS.forEach(id => { const el = $(id); el.addEventListener('change', savePrefs); el.addEventListener('input', savePrefs); });
loadPrefs(); syncPlatformUi(); loadKey(); listDevices(); refreshLib(); setClasses();
$('main').disabled = false;
