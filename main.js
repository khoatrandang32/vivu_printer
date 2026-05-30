'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const { fork, spawn } = require('child_process');
const http = require('http');

// Đọc PORT từ .env thủ công (dotenv chưa load ở main process)
function readEnvPort() {
  try {
    const fs = require('fs');
    // Ưu tiên thư mục chứa file thực thi (đối với bản build)
    // Ưu tiên thư mục chứa file thực thi (đối với bản build)
    let envPath = path.join(path.dirname(process.execPath), '.env');
    // Nếu không tìm thấy, thử trong thư mục resources (nơi extraResources được đặt)
    if (!fs.existsSync(envPath) && app.isPackaged) {
      envPath = path.join(process.resourcesPath, '.env');
    }
    // Nếu vẫn không tìm thấy, thử trong thư mục làm việc hiện tại (đối với dev)
    if (!fs.existsSync(envPath)) {
      envPath = path.join(process.cwd(), '.env');
    }
    if (!fs.existsSync(envPath)) {
      console.warn('[ELECTRON] Không tìm thấy file .env, sử dụng cổng mặc định 3000.');
      return 3000;
    }
    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(/^PORT\s*=\s*(\d+)/m);
    return match ? parseInt(match[1], 10) : 3000;
  } catch {
    return 3000;
  }
}

const PORT = readEnvPort();
const APP_URL = `http://localhost:${PORT}`;
const START_MINIMIZED = process.argv.includes('--hidden') || process.env.START_MINIMIZED === 'true';

let mainWindow = null;
let tray = null;
let serverProcess = null;
let serverReady = false;

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
  // Xác định thư mục app (nơi chứa server.js và .env)
  const appDir = app.isPackaged
    ? path.join(process.resourcesPath, 'app')  // resources/app/
    : __dirname;                                 // dev: thư mục project

  const serverPath = path.join(appDir, 'server.js');
  console.log(`[ELECTRON] Khởi động server từ: ${serverPath}, cwd: ${appDir}`);

  serverProcess = fork(serverPath, [], {
    cwd: appDir,
    env: { ...process.env },
    silent: true,
  });

  if (serverProcess.stdout) serverProcess.stdout.on('data', (data) => console.log(`[SERVER OUT] ${data}`));
  if (serverProcess.stderr) serverProcess.stderr.on('data', (data) => console.error(`[SERVER ERR] ${data}`));

  serverProcess.on('error', (err) => {
    console.error('[ELECTRON] Server process lỗi:', err.message);
  });

  serverProcess.on('exit', (code) => {
    console.log(`[ELECTRON] Server process thoát với code ${code}`);
    serverReady = false;
  });
}

// Chờ server sẵn sàng bằng cách poll HTTP
function waitForServer(retries = 30, delayMs = 500) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
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
      if (attempts >= retries) return reject(new Error('Server không khởi động được'));
      setTimeout(check, delayMs);
    };
    check();
  });
}

// ── Tạo cửa sổ chính ────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 550,
    title: 'VIVU Printer',
    icon: path.join(__dirname, 'public', 'icon.png'),
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
    const iconPath = path.join(__dirname, 'public', 'icon.png');
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
