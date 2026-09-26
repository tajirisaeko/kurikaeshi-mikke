'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  version: () => ipcRenderer.invoke('app:version'),
  status: () => ipcRenderer.invoke('config:status'),
  connect: (token) => ipcRenderer.invoke('auth:connect', token),
  disconnect: () => ipcRenderer.invoke('auth:disconnect'),
  startScan: () => ipcRenderer.invoke('scan:start'),
  cancelScan: () => ipcRenderer.invoke('scan:cancel'),
  onProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('scan:progress', listener);
    return () => ipcRenderer.removeListener('scan:progress', listener);
  },
  fullPath: (args) => ipcRenderer.invoke('path:full', args),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
});
