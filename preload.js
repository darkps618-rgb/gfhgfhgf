'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('halo', {
  platform: process.platform,
  sources: inv('sources:list'),
  selectSource: inv('source:select'),
  recOpen: inv('rec:open'),
  recChunk: (id, buf) => ipcRenderer.send('rec:chunk', id, buf),
  recClose: inv('rec:close'),
  liveStart: inv('live:start'),
  liveChunk: (buf) => ipcRenderer.send('live:chunk', buf),
  liveStop: inv('live:stop'),
  onLiveStats: (cb) => ipcRenderer.on('live:stats', (_e, d) => cb(d)),
  onLiveEnded: (cb) => ipcRenderer.on('live:ended', (_e, d) => cb(d)),
  keyGet: inv('key:get'), keySet: inv('key:set'),
  shotSave: inv('shot:save'),
  libList: inv('lib:list'), libDelete: inv('lib:delete'), libOpen: inv('lib:open'),
  show: inv('shell:show'), openFolder: inv('shell:folder'),
  setBusy: (b) => ipcRenderer.send('busy', b),
  onShortcut: (cb) => ipcRenderer.on('shortcut', (_e, n) => cb(n))
});
