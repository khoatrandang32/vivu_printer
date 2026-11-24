'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const { fork, spawn } = require('child_process');
const http = require('http');
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

function initAutoUpdater() {
  if (autoUpdater) return autoUpdater;
  try {
    const updaterModule = require('electron-updater');
    autoUpdater = updaterModule.autoUpdater;
    if (autoUpdater) {
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;

      autoUpdater.on('checking-for-update', () => {
        console.log('[UPDATER] Đang kiểm tra bản cập nhật...');
        sendToUpdater('checking', { message: 'Đang kiểm tra bản cập nhật...' });
      });

      autoUpdater.on('update-available', (info) => {
        console.log(`[UPDATER] Đã có phiên bản mới: v${info.version}`);
        sendToUpdater('available', {
          version: info.version,
          releaseDate: info.releaseDate,
          releaseNotes: info.releaseNotes,
          message: `Đã có bản cập nhật mới v${info.version}!`
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
  // Xác định thư mục app (nơi chứa server.js)
  // Khi build với electron-builder + asarUnpack, file nằm trong app.asar.unpacked/
  let appDir;
  if (app.isPackaged) {
    const unpackedDir = path.join(process.resourcesPath, 'app.asar.unpacked');
    const fs = require('fs');
    if (fs.existsSync(path.join(unpackedDir, 'server.js'))) {
      appDir = unpackedDir;
    } else {
      // Fallback: thử resources/app/
      appDir = path.join(process.resourcesPath, 'app');
    }
  } else {
    appDir = __dirname; // dev: thư mục project
  }

  const serverPath = path.join(appDir, 'server.js');
  console.log(`[ELECTRON] Khởi động server từ: ${serverPath}, cwd: ${appDir}`);

  let serverStderr = '';
  let serverExitError = null;

  serverProcess = fork(serverPath, [], {
    cwd: appDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(PORT)
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
    const updater = initAutoUpdater();
    if (msg.action === 'check-update') {
      if (!updater || !app.isPackaged) {
        sendToUpdater('not-available', { message: 'Chế độ Dev: Chưa đóng gói installer nên không chạy autoUpdater.' });
      } else {
        updater.checkForUpdates().catch((err) => {
          sendToUpdater('error', { message: err.message });
        });
      }
    } else if (msg.action === 'download-update') {
      if (updater) {
        updater.downloadUpdate().catch((err) => {
          sendToUpdater('error', { message: err.message });
        });
      }
    } else if (msg.action === 'install-update') {
      if (updater) {
        updater.quitAndInstall(false, true);
      }
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
  const fs = require('fs');
  // Khi build: icon nằm trong app.asar.unpacked/public/
  if (app.isPackaged) {
    const unpackedIcon = path.join(process.resourcesPath, 'app.asar.unpacked', 'public', 'icon.png');
    if (fs.existsSync(unpackedIcon)) return unpackedIcon;
  }
  // Dev mode hoặc fallback
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
        const updater = initAutoUpdater();
        if (!updater || !app.isPackaged) {
          dialog.showMessageBox({
            type: 'info',
            title: 'Cập nhật',
            message: 'Ứng dụng đang chạy ở chế độ phát triển (Dev). Tính năng tự động cập nhật hoạt động trên bản cài đặt đóng gói.'
          });
        } else {
          updater.checkForUpdates().catch((err) => {
            dialog.showErrorBox('Lỗi cập nhật', err.message);
          });
        }
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
