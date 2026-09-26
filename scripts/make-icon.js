'use strict';

// アプリのアイコン（build/icon.png）を Electron 自身で描いて書き出す。
// 使い方: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="64" y="64" width="896" height="896" rx="200" fill="#2f8f6b"/>
  <g fill="#ffffff" opacity="0.95">
    <rect x="270" y="250" width="300" height="70" rx="22"/>
    <rect x="270" y="360" width="300" height="70" rx="22"/>
    <rect x="270" y="470" width="300" height="70" rx="22"/>
  </g>
  <circle cx="470" cy="450" r="215" fill="none" stroke="#ffffff" stroke-width="56"/>
  <line x1="628" y1="608" x2="790" y2="770" stroke="#ffffff" stroke-width="72" stroke-linecap="round"/>
</svg>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false, transparent: true,
    useContentSize: true, webPreferences: { offscreen: true },
  });
  const html = `<html><body style="margin:0;background:transparent">${SVG}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500));
  let image = await win.webContents.capturePage();
  if (image.getSize().width !== 1024) image = image.resize({ width: 1024, height: 1024 });

  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.toPNG());
  console.log('wrote', out, image.getSize());
  app.quit();
});
