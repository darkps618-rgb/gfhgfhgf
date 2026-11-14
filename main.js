'use strict';
const { app, BrowserWindow, ipcMain, desktopCapturer, session, globalShortcut,
        shell, dialog, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Keep rendering (and the canvas compositor) alive when Halo is minimised or covered.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null, selectedId = null, busy = false;
const recs = new Map();
let live = null;

const ffbin = () => {
  try { const p = require('ffmpeg-static'); return p ? p.replace('app.asar', 'app.asar.unpacked') : null; }
  catch { return null; }
};
const videoDir = () => path.join(app.getPath('videos'), 'Halo');
const picDir = () => path.join(app.getPath('pictures'), 'Halo');
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const send = (ch, d) => { if (win && !win.isDestroyed()) win.webContents.send(ch, d); };

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 980, minHeight: 640,
    backgroundColor: '#0f1024', title: 'Halo', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', e => {
    if (!busy) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Keep recording', 'Quit anyway'], defaultId: 0, cancelId: 0,
      title: 'Halo', message: 'A recording or live stream is still running.',
      detail: 'Quitting now will cut it off.'
    });
    if (r === 0) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

app.whenReady().then(() => {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'display-capture'].includes(perm)));
  ses.setPermissionCheckHandler((_wc, perm) => ['media', 'display-capture'].includes(perm));

  // The renderer picks a screen/window in Halo's own picker; this hands that choice to getDisplayMedia.
  ses.setDisplayMediaRequestHandler(async (req, cb) => {
    try {
      const srcs = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const s = srcs.find(x => x.id === selectedId);
      if (!s) return cb({});
      const out = { video: s };
      if (req.audioRequested && process.platform === 'win32') out.audio = 'loopback'; // system sound
      cb(out);
    } catch { cb({}); }
  }, { useSystemPicker: false });

  createWindow();

  const keys = { 'Alt+R': 'record', 'Alt+P': 'pause', 'Alt+L': 'live', 'Alt+C': 'camera' };
  for (const [acc, name] of Object.entries(keys)) globalShortcut.register(acc, () => send('shortcut', name));
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (live) try { live.proc.kill(); } catch {} });
app.on('window-all-closed', () => app.quit());

/* ---------- sources ---------- */
ipcMain.handle('sources:list', async () => {
  const own = win ? win.getMediaSourceId() : '';
  const list = await desktopCapturer.getSources({
    types: ['screen', 'window'], thumbnailSize: { width: 360, height: 210 }, fetchWindowIcons: true
  });
  return list.filter(s => s.id !== own && (s.id.startsWith('screen') || s.name.trim())).map(s => ({
    id: s.id, name: s.name, type: s.id.startsWith('screen') ? 'screen' : 'window',
    thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
    icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : ''
  }));
});
ipcMain.handle('source:select', (_e, id) => { selectedId = id; return true; });

/* ---------- local recording (streamed to disk, then remuxed with ffmpeg) ---------- */
ipcMain.handle('rec:open', () => {
  fs.mkdirSync(videoDir(), { recursive: true });
  const base = path.join(videoDir(), `Halo-${stamp()}`);
  const raw = base + '.recording.webm';
  const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
  recs.set(id, { base, raw, ws: fs.createWriteStream(raw) });
  return id;
});
ipcMain.on('rec:chunk', (_e, id, buf) => { const r = recs.get(id); if (r) r.ws.write(Buffer.from(buf)); });
ipcMain.handle('rec:close', async (_e, id, o) => {
  const r = recs.get(id); if (!r) return { ok: false };
  recs.delete(id);
  await new Promise(res => r.ws.end(res));
  const ext = o.container === 'webm' ? 'webm' : 'mp4';
  const out = r.base + '.' + ext, bin = ffbin();
  const keepRaw = (warn) => {
    const fb = r.base + '.webm'; try { fs.renameSync(r.raw, fb); } catch {}
    return { ok: true, path: fb, size: fs.existsSync(fb) ? fs.statSync(fb).size : 0, warn };
  };
  if (!bin || !fs.existsSync(bin)) return keepRaw('ffmpeg was not found, so the clip was saved as WebM.');
  const args = ['-y', '-loglevel', 'error', '-i', r.raw];
  if (ext === 'webm') args.push('-c', 'copy');
  else {
    if (o.h264) args.push('-c:v', 'copy');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
    args.push('-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
  }
  args.push(out);
  const code = await new Promise(res => {
    const p = spawn(bin, args, { windowsHide: true });
    p.on('error', () => res(-1)); p.on('close', res);
  });
  if (code === 0 && fs.existsSync(out)) {
    fs.unlink(r.raw, () => {});
    return { ok: true, path: out, size: fs.statSync(out).size };
  }
  try { fs.unlinkSync(out); } catch {}
  return keepRaw('Conversion failed, so the clip was saved as WebM.');
});

/* ---------- live streaming: renderer chunks -> ffmpeg -> RTMP/RTMPS ---------- */
ipcMain.handle('live:start', (_e, o) => {
  if (live) return { ok: false, error: 'A stream is already running.' };
  const bin = ffbin();
  if (!bin || !fs.existsSync(bin)) return { ok: false, error: 'ffmpeg was not found. Reinstall Halo.' };
  const fps = Math.max(10, Math.min(60, +o.fps || 30));
  const vb = Math.max(500, +o.vkbps || 4500);
  const target = o.url.replace(/\/+$/, '') + (o.key ? '/' + o.key : '');
  const args = [
    '-hide_banner', '-fflags', 'nobuffer', '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-r', String(fps), '-g', String(fps * 2),
    '-b:v', vb + 'k', '-maxrate', vb + 'k', '-bufsize', vb * 2 + 'k',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
    '-flvflags', 'no_duration_filesize', '-f', 'flv', target
  ];
  const proc = spawn(bin, args, { windowsHide: true });
  const st = { proc, tail: [] };
  const scrub = s => (o.key ? s.split(o.key).join('***') : s);
  proc.stdin.on('error', () => {});
  proc.stderr.on('data', d => {
    for (const line of scrub(d.toString()).split(/[\r\n]+/)) {
      if (!line.trim()) continue;
      const m = /fps=\s*([\d.]+).*?bitrate=\s*([\d.]+)kbits\/s.*?speed=\s*([\d.]+)x/.exec(line);
      if (m) send('live:stats', { fps: +m[1], kbps: +m[2], speed: +m[3] });
      else { st.tail.push(line.trim()); if (st.tail.length > 6) st.tail.shift(); }
    }
  });
  proc.on('error', err => { send('live:ended', { code: -1, tail: String(err.message) }); live = null; });
  proc.on('close', code => { send('live:ended', { code, tail: st.tail.slice(-3).join('\n') }); live = null; });
  live = st;
  return { ok: true };
});
ipcMain.on('live:chunk', (_e, buf) => {
  if (live && live.proc.stdin.writable) live.proc.stdin.write(Buffer.from(buf));
});
ipcMain.handle('live:stop', () => {
  if (!live) return true;
  const p = live.proc;
  try { p.stdin.end(); } catch {}
  setTimeout(() => { try { p.kill(); } catch {} }, 2500);
  return true;
});

/* ---------- stream keys (encrypted with the OS keystore) ---------- */
const keyFile = () => path.join(app.getPath('userData'), 'keys.json');
const readKeys = () => { try { return JSON.parse(fs.readFileSync(keyFile(), 'utf8')); } catch { return {}; } };
ipcMain.handle('key:get', (_e, name) => {
  try {
    const v = readKeys()[name];
    return v && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(v, 'base64')) : '';
  } catch { return ''; }
});
ipcMain.handle('key:set', (_e, name, key) => {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const k = readKeys();
  if (key) k[name] = safeStorage.encryptString(key).toString('base64'); else delete k[name];
  fs.writeFileSync(keyFile(), JSON.stringify(k));
  return true;
});

/* ---------- screenshots, library, misc ---------- */
ipcMain.handle('shot:save', (_e, buf) => {
  fs.mkdirSync(picDir(), { recursive: true });
  const p = path.join(picDir(), `Halo-screenshot-${stamp()}.png`);
  fs.writeFileSync(p, Buffer.from(buf));
  return p;
});
ipcMain.handle('lib:list', () => {
  try {
    return fs.readdirSync(videoDir())
      .filter(f => /\.(mp4|webm)$/i.test(f) && !f.endsWith('.recording.webm'))
      .map(f => { const p = path.join(videoDir(), f), s = fs.statSync(p); return { path: p, name: f, size: s.size, mtime: s.mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime).slice(0, 40);
  } catch { return []; }
});
const inLib = p => path.dirname(path.resolve(p)) === path.resolve(videoDir());
ipcMain.handle('lib:delete', async (_e, p) => { if (!inLib(p)) return false; try { await shell.trashItem(p); return true; } catch { return false; } });
ipcMain.handle('lib:open', (_e, p) => inLib(p) ? shell.openPath(p) : '');
ipcMain.handle('shell:show', (_e, p) => { shell.showItemInFolder(p); return true; });
ipcMain.handle('shell:folder', () => { fs.mkdirSync(videoDir(), { recursive: true }); return shell.openPath(videoDir()); });
ipcMain.on('busy', (_e, b) => { busy = !!b; });
