'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { fork, spawn, execFile } = require('child_process');
const configManager = require('./configManager');

const PORT = parseInt(configManager.get('port') || 3232, 10);
const APP_URL = `http://localhost:${PORT}`;
const START_MINIMIZED = process.argv.includes('--hidden') || process.env.START_MINIMIZED === 'true';

let mainWindow = null;
let tray = null;
let serverProcess = null;
let serverReady = false;
let autoUpdater = null;

function sendToUpdater(status, data = {}) {
  const payload = { status, ...data };
  if (serverProcess) {
    try {
      serverProcess.send({ type: 'updater-event', payload });
    } catch {}
  }
}

// ── Khởi tạo autoUpdater (Fallback cho Full Installer) ────────────────────────
function initAutoUpdater() {
  if (autoUpdater) return autoUpdater;
  try {
    const updaterModule = require('electron-updater');
    autoUpdater = updaterModule.autoUpdater;
    if (autoUpdater) {
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;

      autoUpdater.on('checking-for-update', () => {
        console.log('[UPDATER] Đang kiểm tra bản cập nhật (.exe)...');
        sendToUpdater('checking', { message: 'Đang kiểm tra bản cập nhật...' });
      });

      autoUpdater.on('update-available', (info) => {
        console.log(`[UPDATER] Đã có phiên bản mới: v${info.version}`);
        sendToUpdater('available', {
          version: info.version,
          releaseDate: info.releaseDate,
          releaseNotes: info.releaseNotes,
          message: `Đã có bản cập nhật mới v${info.version}!`,
          isHot: false
        });
      });

      autoUpdater.on('update-not-available', (info) => {
        console.log('[UPDATER] Bạn đang dùng phiên bản mới nhất.');
        sendToUpdater('not-available', {
          version: info && info.version,
          message: 'Bạn đang sử dụng phiên bản mới nhất.'
        });
      });

      autoUpdater.on('download-progress', (progressObj) => {
        const percent = Math.round(progressObj.percent || 0);
        console.log(`[UPDATER] Tiến độ tải: ${percent}%`);
        sendToUpdater('downloading', {
          percent,
          bytesPerSecond: progressObj.bytesPerSecond,
          transferred: progressObj.transferred,
          total: progressObj.total,
          message: `Đang tải: ${percent}%`
        });
      });

      autoUpdater.on('update-downloaded', (info) => {
        console.log(`[UPDATER] Tải bản cập nhật thành công v${info.version}`);
        sendToUpdater('downloaded', {
          version: info.version,
          message: `Bản cập nhật v${info.version} đã sẵn sàng. Bấm để khởi động lại và cập nhật!`
        });
      });

      autoUpdater.on('error', (err) => {
        console.error('[UPDATER] Lỗi cập nhật:', err.message);
        sendToUpdater('error', { message: err.message });
      });
    }
  } catch (e) {
    console.warn('[UPDATER] Không thể khởi tạo autoUpdater:', e.message);
  }
  return autoUpdater;
}

// ── Hot Code Update Engine (~455 KB) ─────────────────────────────────────────
let pendingHotUpdate = null;

function getActiveAppDir() {
  if (!app.isPackaged) {
    return __dirname; // Dev mode
  }
  const hotBundleDir = path.join(app.getPath('userData'), 'app-bundle');
  if (fs.existsSync(path.join(hotBundleDir, 'server.js'))) {
    return hotBundleDir;
  }
  const unpackedDir = path.join(process.resourcesPath, 'app.asar.unpacked');
  if (fs.existsSync(path.join(unpackedDir, 'server.js'))) {
    return unpackedDir;
  }
  return path.join(process.resourcesPath, 'app');
}

function getCurrentAppVersion() {
  try {
    const pkgPath = path.join(getActiveAppDir(), 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.version) return pkg.version;
    }
  } catch {}
  return app.getVersion();
}

function isNewerVersion(remote, local) {
  const r = (remote || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const l = (local || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const ri = r[i] || 0;
    const li = l[i] || 0;
    if (ri > li) return true;
    if (ri < li) return false;
  }
  return false;
}

function fetchLatestGithubRelease() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/khoatrandang32/vivu_printer/releases/latest',
      method: 'GET',
      headers: {
        'User-Agent': 'VIVU-Printer-Desktop',
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Phản hồi từ GitHub không đúng định dạng JSON'));
          }
        } else {
          reject(new Error(`GitHub API trả về mã HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function downloadFileWithRedirects(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const doDownload = (curUrl, redirectCount = 0) => {
      if (redirectCount > 8) return reject(new Error('Quá nhiều chuyển hướng (redirect)'));

      let parsed;
      try {
        parsed = new URL(curUrl);
      } catch (err) {
        return reject(new Error(`URL không hợp lệ: ${curUrl}`));
      }

      const reqModule = parsed.protocol === 'http:' ? http : https;
      const options = {
        headers: {
          'User-Agent': 'VIVU-Printer-Desktop',
          'Accept': 'application/octet-stream'
        }
      };

      const req = reqModule.get(curUrl, options, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          let nextUrl = res.headers.location;
          if (!nextUrl.startsWith('http://') && !nextUrl.startsWith('https://')) {
            nextUrl = new URL(nextUrl, curUrl).toString();
          }
          res.resume();
          return doDownload(nextUrl, redirectCount + 1);
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Tải file thất bại với mã HTTP: ${res.statusCode}`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;
        const fileStream = fs.createWriteStream(destPath);

        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0 && onProgress) {
            const percent = Math.min(99, Math.round((downloadedBytes / totalBytes) * 100));
            onProgress(percent, downloadedBytes, totalBytes);
          }
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close(() => resolve());
        });

        fileStream.on('error', (err) => {
          try { fs.unlinkSync(destPath); } catch {}
          reject(err);
        });
      });

      req.on('error', (err) => {
        try { fs.unlinkSync(destPath); } catch {}
        reject(err);
      });
    };

    doDownload(url, 0);
  });
}

function extractZipArchive(zipPath, targetDir) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    if (process.platform === 'win32') {
      const psCmd = `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${targetDir}" -Force`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], (err, stdout, stderr) => {
        if (err) {
          console.error('[UPDATER] PowerShell extract error:', stderr || err.message);
          return reject(new Error(`Giải nén thất bại: ${stderr || err.message}`));
        }
        resolve();
      });
    } else {
      execFile('unzip', ['-o', zipPath, '-d', targetDir], (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`Giải nén thất bại: ${stderr || err.message}`));
        }
        resolve();
      });
    }
  });
}

async function checkAppUpdates(isManual = false) {
  sendToUpdater('checking', { message: 'Đang kiểm tra bản cập nhật...' });
  pendingHotUpdate = null;

  try {
    const release = await fetchLatestGithubRelease();
    const currentVersion = getCurrentAppVersion();
    const remoteVersion = (release.tag_name || release.name || '').replace(/^v/, '');

    console.log(`[UPDATER] Bản hiện tại: ${currentVersion}, bản mới nhất trên GitHub: ${remoteVersion}`);

    if (isNewerVersion(remoteVersion, currentVersion)) {
      const bundleAsset = (release.assets || []).find(a => a.name === 'bundle.zip');
      if (bundleAsset) {
        const sizeKB = Math.round((bundleAsset.size || 0) / 1024);
        pendingHotUpdate = {
          version: remoteVersion,
          downloadUrl: bundleAsset.browser_download_url,
          size: bundleAsset.size,
          isHot: true,
          downloaded: false
        };
        console.log(`[UPDATER] Tìm thấy Hot Update v${remoteVersion} (~${sizeKB} KB)`);
        sendToUpdater('available', {
          version: remoteVersion,
          message: `Đã có bản cập nhật mới v${remoteVersion} (~${sizeKB} KB - Tải siêu tốc)!`,
          isHot: true
        });
        if (isManual) {
          dialog.showMessageBox({
            type: 'info',
            title: 'Cập nhật VIVU Printer',
            message: `Đã có bản cập nhật mới v${remoteVersion} (~${sizeKB} KB).\n\nVui lòng mở giao diện VIVU Printer để cập nhật ngay trong vài giây!`
          });
        }
        return;
      }

      // Không có bundle.zip -> Fallback dùng autoUpdater installer (.exe)
      const updater = initAutoUpdater();
      if (updater && app.isPackaged) {
        updater.checkForUpdates().catch(err => {
          sendToUpdater('error', { message: err.message });
        });
      } else {
        sendToUpdater('available', {
          version: remoteVersion,
          message: `Đã có bản cập nhật v${remoteVersion} trên GitHub.`,
          isHot: false
        });
        if (isManual) {
          dialog.showMessageBox({
            type: 'info',
            title: 'Cập nhật VIVU Printer',
            message: `Đã có bản cập nhật mới v${remoteVersion}. Vui lòng tải bộ cài đặt từ GitHub.`
          });
        }
      }
    } else {
      sendToUpdater('not-available', {
        version: currentVersion,
        message: 'Bạn đang sử dụng phiên bản mới nhất.'
      });
      if (isManual) {
        dialog.showMessageBox({
          type: 'info',
          title: 'Cập nhật VIVU Printer',
          message: `Bạn đang sử dụng phiên bản mới nhất (v${currentVersion}).`
        });
      }
    }
  } catch (err) {
    console.warn('[UPDATER] Kiểm tra qua GitHub API không thành công:', err.message);
    const updater = initAutoUpdater();
    if (updater && app.isPackaged) {
      updater.checkForUpdates().catch(e => {
        sendToUpdater('error', { message: e.message });
      });
    } else {
      sendToUpdater('error', { message: `Lỗi kiểm tra cập nhật: ${err.message}` });
      if (isManual) {
        dialog.showErrorBox('Lỗi cập nhật', `Không thể kiểm tra bản cập nhật:\n${err.message}`);
      }
    }
  }
}

async function downloadAppUpdate() {
  if (pendingHotUpdate && pendingHotUpdate.isHot) {
    try {
      sendToUpdater('downloading', { percent: 1, message: 'Bắt đầu tải gói Hot Update...' });
      const tempZip = path.join(app.getPath('temp'), `vivu_hot_update_${pendingHotUpdate.version}.zip`);
      const targetDir = path.join(app.getPath('userData'), 'app-bundle');

      await downloadFileWithRedirects(pendingHotUpdate.downloadUrl, tempZip, (percent, transferred, total) => {
        sendToUpdater('downloading', {
          percent,
          transferred,
          total,
          message: `Đang tải: ${percent}% (${Math.round(transferred / 1024)} KB / ${Math.round(total / 1024)} KB)`
        });
      });

      sendToUpdater('downloading', { percent: 98, message: 'Đang áp dụng bản cập nhật...' });
      await extractZipArchive(tempZip, targetDir);

      try { fs.unlinkSync(tempZip); } catch {}

      pendingHotUpdate.downloaded = true;
      console.log(`[UPDATER] Đã cài đặt Hot Update v${pendingHotUpdate.version} thành công!`);
      sendToUpdater('downloaded', {
        version: pendingHotUpdate.version,
        message: `Bản cập nhật v${pendingHotUpdate.version} đã tải xong! Bấm để khởi động lại ngay.`
      });
    } catch (err) {
      console.error('[UPDATER] Lỗi tải Hot Update:', err);
      sendToUpdater('error', { message: `Lỗi tải Hot Update: ${err.message}` });
    }
  } else {
    const updater = initAutoUpdater();
    if (updater) {
      updater.downloadUpdate().catch(err => {
        sendToUpdater('error', { message: err.message });
      });
    }
  }
}

function installAppUpdate() {
  if (pendingHotUpdate && pendingHotUpdate.downloaded) {
    console.log('[UPDATER] Khởi động lại ứng dụng để hoàn tất cập nhật...');
    app.relaunch();
    app.exit(0);
  } else {
    const updater = initAutoUpdater();
    if (updater) {
      updater.quitAndInstall(false, true);
    }
  }
}

//
// Windows: set AppUserModelId for proper shortcuts/notifications
//
if (process.platform === 'win32' && app && app.setAppUserModelId) {
  try {
    app.setAppUserModelId('com.vivu.printer');
  } catch {}
}

//
// Single-instance lock: prevent multiple copies running.
// If a second instance is started, focus the existing window.
//
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Another instance is already running — exit this one.
  app.quit();
} else {
  app.on('second-instance', (event, argv, workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

// ── Khởi động Express server trong process con ──────────────────────────────
function startServer() {
  const appDir = getActiveAppDir();
  const serverPath = path.join(appDir, 'server.js');
  console.log(`[ELECTRON] Khởi động server từ: ${serverPath}, cwd: ${appDir}`);

  let serverStderr = '';
  let serverExitError = null;

  const baseNodeModules = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    : path.join(__dirname, 'node_modules');

  serverProcess = fork(serverPath, [], {
    cwd: appDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(PORT),
      BASE_NODE_MODULES: baseNodeModules,
      NODE_PATH: [
        path.join(appDir, 'node_modules'),
        baseNodeModules,
        process.env.NODE_PATH || ''
      ].filter(Boolean).join(path.delimiter)
    },
    silent: true,
  });

  if (serverProcess.stdout) serverProcess.stdout.on('data', (data) => console.log(`[SERVER OUT] ${data}`));
  if (serverProcess.stderr) {
    serverProcess.stderr.on('data', (data) => {
      serverStderr += data.toString();
      console.error(`[SERVER ERR] ${data}`);
    });
  }

  serverProcess.on('message', (msg) => {
    if (!msg) return;
    if (msg.action === 'check-update') {
      checkAppUpdates(false);
    } else if (msg.action === 'download-update') {
      downloadAppUpdate();
    } else if (msg.action === 'install-update') {
      installAppUpdate();
    }
  });

  serverProcess.on('error', (err) => {
    console.error('[ELECTRON] Server process lỗi:', err.message);
    serverExitError = err.message;
  });

  serverProcess.on('exit', (code) => {
    console.log(`[ELECTRON] Server process thoát với code ${code}`);
    serverReady = false;
    if (code !== 0 && code !== null) {
      serverExitError = `Server process thoát (mã ${code}).\n${serverStderr.trim() || 'Không có log lỗi'}`;
    }
  });
}

// Chờ server sẵn sàng bằng cách poll HTTP
function waitForServer(retries = 40, delayMs = 500) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      if (!serverProcess || serverProcess.killed || serverProcess.exitCode !== null) {
        const detail = serverStderr ? `\n\nChi tiết lỗi từ server:\n${serverStderr.trim()}` : '';
        return reject(new Error(`Server process đã dừng hoạt động.${detail}`));
      }
      http.get(`${APP_URL}/config`, (res) => {
        if (res.statusCode === 200) {
          serverReady = true;
          resolve();
        } else {
          retry();
        }
        res.resume();
      }).on('error', retry);
    };
    const retry = () => {
      attempts++;
      if (attempts >= retries) {
        const detail = serverStderr ? `\n\nChi tiết lỗi từ server:\n${serverStderr.trim()}` : '';
        return reject(new Error(`Server không phản hồi sau ${Math.round(retries * delayMs / 1000)}s.${detail}`));
      }
      setTimeout(check, delayMs);
    };
    check();
  });
}

// ── Tạo cửa sổ chính ────────────────────────────────────────────────────────
function getIconPath() {
  const hotIcon = path.join(getActiveAppDir(), 'public', 'icon.png');
  if (fs.existsSync(hotIcon)) return hotIcon;
  if (app.isPackaged) {
    const unpackedIcon = path.join(process.resourcesPath, 'app.asar.unpacked', 'public', 'icon.png');
    if (fs.existsSync(unpackedIcon)) return unpackedIcon;
  }
  return path.join(__dirname, 'public', 'icon.png');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 550,
    title: 'VIVU Printer',
    icon: getIconPath(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false, // ẩn cho đến khi load xong
    backgroundColor: '#f7f7f8',
  });

  mainWindow.loadURL(APP_URL);

  mainWindow.once('ready-to-show', () => {
    if (!START_MINIMIZED) {
      mainWindow.show();
    }
  });

  // Mở link ngoài bằng trình duyệt hệ thống
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Ẩn xuống tray thay vì đóng
  mainWindow.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Tray icon ────────────────────────────────────────────────────────────────
function createTray() {
  // Dùng icon mặc định nếu không có file icon
  let icon;
  try {
    const iconPath = getIconPath();
    const fs = require('fs');
    if (fs.existsSync(iconPath)) {
      icon = nativeImage.createFromPath(iconPath);
    } else {
      icon = nativeImage.createEmpty();
    }
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip(`VIVU Printer — http://localhost:${PORT}`);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Mở VIVU Printer',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    {
      label: `Mở trong trình duyệt (localhost:${PORT})`,
      click: () => shell.openExternal(APP_URL),
    },
    {
      label: 'Khởi động cùng Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings ? app.getLoginItemSettings().openAtLogin : false,
      click: (menuItem) => {
        const openAtLogin = !!menuItem.checked;
        if (app.setLoginItemSettings) {
          app.setLoginItemSettings({
            openAtLogin,
            path: process.execPath,
            args: openAtLogin ? ['--hidden'] : []
          });
        }
      },
    },
    {
      label: 'Kiểm tra bản cập nhật',
      click: () => {
        checkAppUpdates(true);
      },
    },
    { type: 'separator' },
    {
      label: 'Thoát',
      click: () => {
        app.isQuiting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

// ── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Khởi động server trước
  startServer();

  // Tạo tray ngay
  createTray();

  // Chờ server sẵn sàng rồi mở cửa sổ
  try {
    await waitForServer(40, 500);
    createWindow();
  } catch (err) {
    dialog.showErrorBox(
      'VIVU Printer — Lỗi khởi động',
      `Không thể khởi động print server tại cổng ${PORT}.\n\n${err.message}\n\nKiểm tra file .env và đảm bảo cổng ${PORT} chưa bị chiếm.`
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // Không thoát khi đóng cửa sổ — vẫn chạy ở tray
  // Chỉ thoát khi user chọn "Thoát" từ tray
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

app.on('before-quit', () => {
  app.isQuiting = true;
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
