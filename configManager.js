'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');

const DEFAULT_CONFIG = {
  isConfigured: false,
  port: 3232,
  printerName: '',
  mdnsName: 'vivu-printer',
  mdnsPort: 3001,
  mdnsType: 'http',
  ghtkApiToken: '',
  ghtkClientSource: '',
  ghtkAccounts: [],
  labelWidthMm: 100,
  labelHeightMm: 150,
  printOrientation: 'portrait',
  printFit: 'fit',
  printPaddingMm: 0,
  pdfViewerPath: '',
  backendSocketUrl: 'https://api.vaycuoivivu.com',
  backendSocketToken: 'your-token',
  backendSocketDeviceId: 'vivu_printer1',
  backendSocketReconnectMs: 1000,
  discoveryEnable: true,
  discoveryPort: 4210,
  discoveryAddr: '255.255.255.255',
  discoveryIntervalMs: 2000,
  returnSlipPaddingLeft: 70,
  returnSlipPaddingRight: 150
};

class ConfigManager extends EventEmitter {
  constructor() {
    super();
    this.configPath = this._determineConfigPath();
    this.config = { ...DEFAULT_CONFIG };
    this._load();
  }

  _determineConfigPath() {
    // 1. Thư mục APPDATA (Windows tiêu chuẩn)
    if (process.platform === 'win32' && process.env.APPDATA) {
      const appDataDir = path.join(process.env.APPDATA, 'vivu-printer');
      if (!fs.existsSync(appDataDir)) {
        try { fs.mkdirSync(appDataDir, { recursive: true }); } catch {}
      }
      return path.join(appDataDir, 'config.json');
    }
    // 2. macOS / Linux
    const baseDir = process.env.HOME
      ? path.join(process.env.HOME, '.config', 'vivu-printer')
      : path.join(os.tmpdir(), 'vivu-printer');
    if (!fs.existsSync(baseDir)) {
      try { fs.mkdirSync(baseDir, { recursive: true }); } catch {}
    }
    return path.join(baseDir, 'config.json');
  }

  _load() {
    let exists = false;
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        const parsed = JSON.parse(raw);
        this.config = { ...DEFAULT_CONFIG, ...parsed };
        exists = true;
      }
    } catch (e) {
      console.warn('[CONFIG] Lỗi đọc config.json:', e.message);
    }

    // Nếu config chưa tồn tại hoặc chưa cấu hình, thử migrate từ .env
    if (!exists || !this.config.isConfigured) {
      this._migrateFromEnv();
    }

    // Tự động kiểm tra phát hiện SumatraPDF nếu chưa có đường dẫn
    if (!this.config.pdfViewerPath || !fs.existsSync(this.config.pdfViewerPath)) {
      const autoViewer = this.detectPdfViewer();
      if (autoViewer.found) {
        this.config.pdfViewerPath = autoViewer.path;
      }
    }
  }

  _migrateFromEnv() {
    const candidates = [
      path.join(process.cwd(), '.env'),
      path.join(__dirname, '.env'),
      path.join(path.dirname(process.execPath), '.env')
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, 'utf8');
          const lines = content.split('\n');
          let hasPrinter = false;

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx === -1) continue;
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim();

            switch (key) {
              case 'PORT': this.config.port = parseInt(val, 10) || 3232; break;
              case 'PRINTER_NAME':
                this.config.printerName = val;
                if (val) hasPrinter = true;
                break;
              case 'MDNS_NAME': this.config.mdnsName = val; break;
              case 'MDNS_PORT': this.config.mdnsPort = parseInt(val, 10) || 3001; break;
              case 'MDNS_TYPE': this.config.mdnsType = val; break;
              case 'GHTK_API_TOKEN': this.config.ghtkApiToken = val; break;
              case 'GHTK_CLIENT_SOURCE': this.config.ghtkClientSource = val; break;
              case 'LABEL_WIDTH_MM': this.config.labelWidthMm = parseFloat(val) || 100; break;
              case 'LABEL_HEIGHT_MM': this.config.labelHeightMm = parseFloat(val) || 150; break;
              case 'PRINT_ORIENTATION': this.config.printOrientation = val.toLowerCase(); break;
              case 'PRINT_FIT': this.config.printFit = val.toLowerCase(); break;
              case 'PRINT_PADDING_MM': this.config.printPaddingMm = parseInt(val, 10) || 0; break;
              case 'PDF_VIEWER_PATH': this.config.pdfViewerPath = val; break;
              case 'BACKEND_SOCKET_URL':
              case 'WS_SERVER_URL':
                this.config.backendSocketUrl = val; break;
              case 'BACKEND_SOCKET_TOKEN':
              case 'WS_AUTH_TOKEN':
                this.config.backendSocketToken = val; break;
              case 'BACKEND_SOCKET_DEVICE_ID':
              case 'WS_DEVICE_ID':
                this.config.backendSocketDeviceId = val; break;
              case 'BACKEND_SOCKET_RECONNECT_MS':
              case 'WS_RECONNECT_MS':
                this.config.backendSocketReconnectMs = parseInt(val, 10) || 1000; break;
            }
          }

          if (hasPrinter) {
            this.config.isConfigured = true;
          }
          console.log(`[CONFIG] Đã tự động di chuyển cấu hình từ .env (${p}) sang config.json`);
          this.save(this.config);
          return;
        } catch (e) {
          console.warn('[CONFIG] Di chuyển từ .env lỗi:', e.message);
        }
      }
    }
  }

  detectPdfViewer() {
    const candidates = [];

    // 1. Thư mục bin đi kèm app
    candidates.push(path.join(__dirname, 'bin', 'SumatraPDF.exe'));
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'bin', 'SumatraPDF.exe'));
      candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'bin', 'SumatraPDF.exe'));
    }

    // 2. Thư mục UserData bin
    if (process.env.APPDATA) {
      candidates.push(path.join(process.env.APPDATA, 'vivu-printer', 'bin', 'SumatraPDF.exe'));
    }

    // 3. Đường dẫn Local AppData của user (nơi SumatraPDF installer thường cài)
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'SumatraPDF', 'SumatraPDF.exe'));
    }

    // 4. Các đường dẫn chuẩn Windows
    candidates.push('C:\\Program Files\\SumatraPDF\\SumatraPDF.exe');
    candidates.push('C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe');

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return { found: true, path: p, type: 'sumatra' };
      }
    }

    // Kiểm tra Adobe Acrobat nếu không có SumatraPDF
    const acrobatCandidates = [
      'C:\\Program Files\\Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe',
      'C:\\Program Files (x86)\\Adobe\\Acrobat Reader DC\\Reader\\AcroRd32.exe'
    ];
    for (const p of acrobatCandidates) {
      if (fs.existsSync(p)) {
        return { found: true, path: p, type: 'acrobat' };
      }
    }

    return { found: false, path: '', type: 'none' };
  }

  get(key) {
    if (key) return this.config[key];
    return { ...this.config };
  }

  save(newValues) {
    this.config = { ...this.config, ...newValues };
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
      this.emit('change', this.config);
      return { success: true, config: this.config };
    } catch (e) {
      console.error('[CONFIG] Lỗi ghi config.json:', e.message);
      return { success: false, error: e.message };
    }
  }

  // Tải SumatraPDF Portable tự động vào thư mục appdata/bin
  downloadPortableSumatra(onProgress) {
    return new Promise((resolve, reject) => {
      const targetDir = process.env.APPDATA
        ? path.join(process.env.APPDATA, 'vivu-printer', 'bin')
        : path.join(__dirname, 'bin');
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      const targetPath = path.join(targetDir, 'SumatraPDF.exe');

      // Link tải SumatraPDF 64-bit portable chính thức
      const downloadUrl = 'https://www.sumatrapdfreader.org/dl/rel/3.5.2/SumatraPDF-3.5.2-64.exe';

      const doDownload = (url) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return doDownload(res.headers.location);
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`Tải SumatraPDF thất bại (HTTP ${res.statusCode})`));
          }

          const total = parseInt(res.headers['content-length'] || '0', 10);
          let downloaded = 0;
          const fileStream = fs.createWriteStream(targetPath);

          res.on('data', (chunk) => {
            downloaded += chunk.length;
            if (total && onProgress) {
              onProgress(Math.round((downloaded / total) * 100));
            }
          });

          res.pipe(fileStream);

          fileStream.on('finish', () => {
            fileStream.close();
            this.save({ pdfViewerPath: targetPath });
            resolve(targetPath);
          });

          fileStream.on('error', (err) => {
            fs.unlink(targetPath, () => {});
            reject(err);
          });
        }).on('error', reject);
      };

      doDownload(downloadUrl);
    });
  }
}

const configManager = new ConfigManager();
module.exports = configManager;
