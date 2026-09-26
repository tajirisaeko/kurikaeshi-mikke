'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { createClient, NotionError, CancelledError } = require('./src/notion');
const { createBreadcrumbResolver } = require('./src/breadcrumb');
const { runScan } = require('./src/scanner');

let mainWindow = null;
let currentScan = null; // { controller, resolver }
let lastResolver = null; // 「詳細を見る」で同じキャッシュを使い回す

// ---------- 設定（トークンはこの端末の userData/config.json にだけ保存） ----------

const configPath = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

function looksLikeToken(token) {
  return /^(ntn_|secret_)[A-Za-z0-9]+$/.test(token);
}

function errorPayload(err) {
  if (err instanceof CancelledError) return { ok: false, cancelled: true, error: err.message };
  if (err instanceof NotionError) return { ok: false, code: err.code, error: err.message };
  return { ok: false, error: `うまくいきませんでした：${err.message}` };
}

// ---------- ウィンドウ ----------

function isSafeExternalUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)notion\.(so|com)$/.test(u.hostname);
  } catch (_) {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 780,
    minWidth: 640,
    minHeight: 560,
    title: 'くりかえしみっけ',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // アプリ内でページ遷移させない。Notionのリンクだけ、既定のブラウザで開く
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('config:status', () => {
    const { token, workspaceName, botName } = readConfig();
    return { hasToken: Boolean(token), workspaceName: workspaceName || null, botName: botName || null };
  });

  ipcMain.handle('auth:connect', async (_event, rawToken) => {
    const token = String(rawToken || '').trim();
    if (!looksLikeToken(token)) {
      return {
        ok: false,
        error: 'トークンの形が違うようです。「ntn_」から始まる文字列を、そのまま貼り付けてください。',
      };
    }
    try {
      const me = await createClient({ token }).getMe();
      writeConfig({ token, workspaceName: me.workspaceName, botName: me.botName });
      return { ok: true, workspaceName: me.workspaceName, botName: me.botName };
    } catch (err) {
      return errorPayload(err);
    }
  });

  ipcMain.handle('auth:disconnect', () => {
    writeConfig({});
    lastResolver = null;
    return { ok: true };
  });

  ipcMain.handle('scan:start', async (event) => {
    if (currentScan) return { ok: false, error: 'すでにスキャン中です。' };
    const { token } = readConfig();
    if (!token) return { ok: false, code: 'unauthorized', error: '先にNotionと接続してください。' };

    const controller = new AbortController();
    const client = createClient({ token, signal: controller.signal });
    const resolver = createBreadcrumbResolver(client);
    currentScan = { controller };

    try {
      const data = await runScan({
        client,
        resolver,
        onProgress: (p) => {
          if (!event.sender.isDestroyed()) event.sender.send('scan:progress', p);
        },
      });
      lastResolver = resolver;
      return { ok: true, ...data };
    } catch (err) {
      return errorPayload(err);
    } finally {
      currentScan = null;
    }
  });

  ipcMain.handle('scan:cancel', () => {
    if (currentScan) currentScan.controller.abort();
    return { ok: true };
  });

  // 「詳細を見る」: DBの親をたどってフルパスを返す
  ipcMain.handle('path:full', async (_event, { dbId, dbTitle, parent }) => {
    try {
      const resolver = lastResolver;
      if (!resolver) return { ok: false, error: 'もう一度スキャンしてください。' };
      const ancestors = await resolver.ancestorNames(parent);
      return { ok: true, path: [...ancestors, dbTitle] };
    } catch (err) {
      return errorPayload(err);
    }
  });

  ipcMain.handle('open:external', (_event, url) => {
    if (!isSafeExternalUrl(url)) return { ok: false };
    shell.openExternal(url);
    return { ok: true };
  });
}

// ---------- 起動 ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
