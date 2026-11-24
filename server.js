// NodeJS Print Server cho HPRT N43 (TSPL) trên Windows
// Yêu cầu: CommonJS, Express, không dùng native module phức tạp, gửi RAW qua lệnh Windows (print/copy)

if (process.env.BASE_NODE_MODULES && !module.paths.includes(process.env.BASE_NODE_MODULES)) {
  module.paths.push(process.env.BASE_NODE_MODULES);
}

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { exec } = require('child_process');
const crypto = require('crypto');
const dgram = require('dgram');
const { io } = require('socket.io-client');
const express = require('express');
const puppeteer = require('puppeteer-core');

const configManager = require('./configManager');
const { startMdns, stopMdns } = require('./mdnsService');
const { printReturnToWorkshopSlip, buildReturnToWorkshopSlipHtml } = require('./returnSlipPrint');
const { printOtherCarrierShip, buildOtherCarrierShipHtml } = require('./otherCarrierShipPrint');
const { stampGhtkLabelPdf } = require('./ghtkLabelStamper');

// Cấu hình từ configManager (ưu tiên) hoặc process.env
const cfg = configManager.get();
let PORT = parseInt(cfg.port || process.env.PORT || '3232', 10);
let CURRENT_PRINTER = cfg.printerName || process.env.PRINTER_NAME || 'HPRT N43';
const STARTUP_TASK_NAME = process.env.STARTUP_TASK_NAME || 'VivuPrinter';

function getSocketServerUrl() {
  return String(configManager.get('backendSocketUrl') || process.env.BACKEND_SOCKET_URL || process.env.WS_SERVER_URL || '').trim();
}
function getSocketAuthToken() {
  return String(configManager.get('backendSocketToken') || process.env.BACKEND_SOCKET_TOKEN || process.env.WS_AUTH_TOKEN || '').trim();
}
function getSocketDeviceId() {
  return String(configManager.get('backendSocketDeviceId') || process.env.BACKEND_SOCKET_DEVICE_ID || process.env.WS_DEVICE_ID || '').trim() || getLocalIPv4();
}
function getSocketReconnectMs() {
  return parseInt(configManager.get('backendSocketReconnectMs') || process.env.BACKEND_SOCKET_RECONNECT_MS || process.env.WS_RECONNECT_MS || '1000', 10);
}

// Hàng đợi in đơn giản để tránh in trùng và đảm bảo xử lý tuần tự
const printQueue = [];
let isProcessing = false;
let lastPayloadHash = null;
let lastPayloadAt = 0;
const DEDUP_WINDOW_MS = 3000; // bỏ qua nếu payload giống nhau trong 3s
let socketClient = null;
let socketConnectedAt = 0;
let socketLastMessageAt = 0;
let socketLastError = '';
let syncedGhtkAccounts = Array.isArray(configManager.get('ghtkAccounts')) ? configManager.get('ghtkAccounts') : [];

// Express app
const app = express();
// Nhận TSPL dạng text/plain
app.use(express.text({ type: 'text/plain', limit: '1mb' }));
// Nhận JSON cho /print-json
app.use(express.json({ limit: '1mb' }));

// Xác định thư mục public (hỗ trợ cả dev, pkg exe và Electron build)
const pathsToTry = [
  // Electron asar unpacked: resources/app.asar.unpacked/public
  path.join(__dirname, '..', 'app.asar.unpacked', 'public'),
  // Dev / node trực tiếp
  path.join(__dirname, 'public'),
  // Electron không asar: resources/app/public
  path.join(__dirname, '..', 'app', 'public'),
  // pkg exe: cạnh file exe
  path.join(path.dirname(process.execPath), 'public'),
  // cwd fallback
  path.join(process.cwd(), 'public'),
];

let PUBLIC_DIR = pathsToTry[0];
for (const p of pathsToTry) {
  console.log(`[SERVER] Checking public dir: ${p} -> ${fs.existsSync(p)}`);
  if (fs.existsSync(p)) {
    PUBLIC_DIR = p;
    break;
  }
}

console.log(`[SERVER] Final Public directory: ${PUBLIC_DIR}`);
app.use(express.static(PUBLIC_DIR));

// Route mặc định để phục vụ index.html nếu static không khớp
app.get('/', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Không tìm thấy thư mục public hoặc index.html. Vui lòng kiểm tra cấu trúc thư mục.');
  }
});

// ---------------- Settings endpoints (UI) ----------------
// Helper to get .env path
function getEnvPath() {
  let p = path.join(process.cwd(), '.env');
  if (fs.existsSync(p)) return p;
  p = path.join(path.dirname(process.execPath), '.env');
  if (fs.existsSync(p)) return p;
  p = path.join(__dirname, '.env');
  return p;
}

// Read .env content
app.get('/settings/env', (req, res) => {
  const envPath = getEnvPath();
  try {
    if (!fs.existsSync(envPath)) return res.json({ content: '' });
    const content = fs.readFileSync(envPath, 'utf8');
    return res.json({ content });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// Write .env content (simple editor)
app.post('/settings/env', express.json(), (req, res) => {
  const content = String((req.body && req.body.content) || '');
  const envPath = getEnvPath();
  try {
    fs.writeFileSync(envPath, content, 'utf8');
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

 // Preview return-to-workshop slip HTML with preview options (font scaling + per-element sizes)
app.post('/settings/preview-return-slip', express.json(), async (req, res) => {
  try {
    const slip = req.body && req.body.slip ? req.body.slip : {};
    // Accept numeric preview parameters; fallback to defaults
    const fontScale = Number(req.body && req.body.fontScale ? Number(req.body.fontScale) : 100);
    const sizeTitle = Number(req.body && Number.isFinite(Number(req.body.sizeTitle)) ? Number(req.body.sizeTitle) : 28);
    const sizeSubtitle = Number(req.body && Number.isFinite(Number(req.body.sizeSubtitle)) ? Number(req.body.sizeSubtitle) : 15);
    const sizeContent = Number(req.body && Number.isFinite(Number(req.body.sizeContent)) ? Number(req.body.sizeContent) : 22);
    const sizeReason = Number(req.body && Number.isFinite(Number(req.body.sizeReason)) ? Number(req.body.sizeReason) : 19);
    const sizeQr = Number(req.body && Number.isFinite(Number(req.body.sizeQr)) ? Number(req.body.sizeQr) : 200);
    const paddingLeft = req.body && Number.isFinite(Number(req.body.paddingLeft)) ? Number(req.body.paddingLeft) : (process.env.RETURN_SLIP_PADDING_LEFT ? Number(process.env.RETURN_SLIP_PADDING_LEFT) : 70);
    const paddingRight = req.body && Number.isFinite(Number(req.body.paddingRight)) ? Number(req.body.paddingRight) : (process.env.RETURN_SLIP_PADDING_RIGHT ? Number(process.env.RETURN_SLIP_PADDING_RIGHT) : 150);

    // basic clamps to avoid crazy values
    const clamp = (v, min, max) => Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
    const sFontScale = clamp(fontScale, 10, 400);
    const sTitle = clamp(sizeTitle, 8, 200);
    const sSubtitle = clamp(sizeSubtitle, 8, 200);
    const sContent = clamp(sizeContent, 8, 200);
    const sReason = clamp(sizeReason, 8, 200);
    const sQr = clamp(sizeQr, 20, 1600);
    const sPaddingLeft = clamp(paddingLeft, 0, 500);
    const sPaddingRight = clamp(paddingRight, 0, 500);

    // Pass explicit size options into the template generator so sizes are applied directly
    const opts = {
      sizeTitle: sTitle,
      sizeSubtitle: sSubtitle,
      sizeContent: sContent,
      sizeReason: sReason,
      sizeQr: sQr,
      paddingLeft: sPaddingLeft,
      paddingRight: sPaddingRight,
    };

    let html = await buildReturnToWorkshopSlipHtml(slip, opts);

    // Inject global zoom for preview if requested (keeps template sizes intact but scales whole preview)
    if (sFontScale && sFontScale !== 100) {
      const zoomStyle = `<style>body{zoom:${sFontScale}%}</style>`;
      html = html.replace('</head>', `${zoomStyle}</head>`);
    }

    res.type('text/html').send(html);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

 // Preview other-carrier ship label HTML with preview options (font scaling + per-element sizes)
app.post('/settings/preview-other-carrier-ship', express.json(), async (req, res) => {
  try {
    const shipLabel = req.body && req.body.shipLabel ? req.body.shipLabel : {};
    const fontScale = Number(req.body && req.body.fontScale ? Number(req.body.fontScale) : 100);
    const sizeTitle = Number(req.body && Number.isFinite(Number(req.body.sizeTitle)) ? Number(req.body.sizeTitle) : 28);
    const sizeSubtitle = Number(req.body && Number.isFinite(Number(req.body.sizeSubtitle)) ? Number(req.body.sizeSubtitle) : 15);
    const sizeContent = Number(req.body && Number.isFinite(Number(req.body.sizeContent)) ? Number(req.body.sizeContent) : 22);
    const sizeLabel = Number(req.body && Number.isFinite(Number(req.body.sizeLabel)) ? Number(req.body.sizeLabel) : 13);
    const sizeOrderCode = Number(req.body && Number.isFinite(Number(req.body.sizeOrderCode)) ? Number(req.body.sizeOrderCode) : 19);

    // basic clamps to avoid crazy values
    const clamp = (v, min, max) => Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
    const sFontScale = clamp(fontScale, 10, 400);
    const sTitle = clamp(sizeTitle, 8, 200);
    const sSubtitle = clamp(sizeSubtitle, 8, 200);
    const sContent = clamp(sizeContent, 8, 200);
    const sLabel = clamp(sizeLabel, 8, 200);
    const sOrderCode = clamp(sizeOrderCode, 8, 200);

    // Pass explicit size options into the template generator so sizes are applied directly
    const opts = {
      sizeTitle: sTitle,
      sizeSubtitle: sSubtitle,
      sizeContent: sContent,
      sizeLabel: sLabel,
      sizeOrderCode: sOrderCode,
    };

    let html = await buildOtherCarrierShipHtml(shipLabel, opts);

    // Inject global zoom for preview if requested (keeps template sizes intact but scales whole preview)
    if (sFontScale && sFontScale !== 100) {
      const zoomStyle = `<style>body{zoom:${sFontScale}%}</style>`;
      html = html.replace('</head>', `${zoomStyle}</head>`);
    }

    res.type('text/html').send(html);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Tiện ích chung
function mmToDots(mm) {
  return Math.round(mm * 8); // 203dpi ~ 8 dots/mm
}

function sanitizePrinterName(name) {
  return String(name || '').trim();
}

function createTempTsplFile(tspl) {
  return new Promise((resolve, reject) => {
    const filename = `tspl_${Date.now()}_${Math.floor(Math.random() * 1e6)}.txt`;
    const filePath = path.join(os.tmpdir(), filename);
    const normalized = String(tspl).replace(/\r?\n/g, '\r\n');
    fs.writeFile(filePath, normalized, { encoding: 'ascii' }, (err) => {
      if (err) return reject(err);
      resolve(filePath);
    });
  });
}

function createTempPdfFile(buffer) {
  return new Promise((resolve, reject) => {
    const filename = `pdf_${Date.now()}_${Math.floor(Math.random() * 1e6)}.pdf`;
    const filePath = path.join(os.tmpdir(), filename);
    fs.writeFile(filePath, buffer, (err) => {
      if (err) return reject(err);
      resolve(filePath);
    });
  });
}

function scheduleTempDelete(filePath, delayMs = 120000) {
  setTimeout(() => {
    fs.unlink(filePath, () => {});
  }, delayMs);
}

function ensureSaveDir() {
  const dir = String(SAVE_PDF_DIR || '').trim();
  if (!dir) return null;
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

function savePdfToDir(buffer, baseName) {
  return new Promise((resolve, reject) => {
    const dir = ensureSaveDir();
    if (!dir) return reject(new Error('SAVE_PDF_DIR không hợp lệ hoặc không thể tạo'));
    const safeName = baseName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
    const filename = `${Date.now()}_${Math.floor(Math.random() * 1e6)}_${safeName}.pdf`;
    const filePath = path.join(dir, filename);
    fs.writeFile(filePath, buffer, (err) => {
      if (err) return reject(err);
      resolve(filePath);
    });
  });
}

function buildSumatraPrintSettings() {
  const currentCfg = configManager.get();
  const parts = [];
  const w = Math.max(10, Math.min(300, currentCfg.labelWidthMm || 100));
  const h = Math.max(10, Math.min(300, currentCfg.labelHeightMm || 150));
  parts.push(`paper=${w}x${h}mm`);
  const orient = (currentCfg.printOrientation || 'portrait').toLowerCase();
  if (orient === 'landscape' || orient === 'portrait') {
    parts.push(orient);
  }
  const paddingMm = currentCfg.printPaddingMm || 0;
  if (paddingMm > 0) {
    const pad = Math.max(0, Math.min(50, paddingMm));
    const availW = Math.max(1, w - 2 * pad);
    const availH = Math.max(1, h - 2 * pad);
    const sx = availW / w;
    const sy = availH / h;
    const scalePercent = Math.max(10, Math.min(100, Math.floor(Math.min(sx, sy) * 100)));
    parts.push('center');
    parts.push(`scale=${scalePercent}`);
  } else {
    const fit = (currentCfg.printFit || 'fit').toLowerCase();
    if (['fit', 'noscale', 'shrink'].includes(fit)) {
      parts.push(fit);
    } else {
      parts.push('fit');
    }
  }
  return parts.join(', ');
}

function getLocalIPv4() {
  const ifs = os.networkInterfaces();
  const ips = [];
  Object.keys(ifs).forEach((k) => {
    for (const i of ifs[k] || []) {
      if (i && i.family === 'IPv4' && !i.internal) ips.push(i.address);
    }
  });
  return ips[0] || '127.0.0.1';
}

function getSocketDeviceId() {
  const customId = String(configManager.get('backendSocketDeviceId') || process.env.BACKEND_SOCKET_DEVICE_ID || process.env.WS_DEVICE_ID || '').trim();
  if (customId) return customId;
  return `${os.hostname()}-${PORT}`.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function getSocketStatus() {
  const url = getSocketServerUrl();
  return {
    enabled: !!url,
    url: url || null,
    deviceId: getSocketDeviceId(),
    connected: !!(socketClient && socketClient.connected),
    connectedAt: socketConnectedAt || null,
    lastMessageAt: socketLastMessageAt || null,
    lastError: socketLastError || null,
    socketId: socketClient && socketClient.id ? socketClient.id : null
  };
}

function emitSocketEvent(eventName, payload) {
  if (!socketClient || !socketClient.connected) return false;
  try {
    socketClient.emit(eventName, payload);
    return true;
  } catch (err) {
    socketLastError = String(err.message || err);
    console.error('[SOCKET] Không thể gửi dữ liệu:', socketLastError);
    return false;
  }
}

function normalizeGhtkPrintJobs(input) {
  let rawList = [];
  if (Array.isArray(input)) {
    rawList = input;
  } else if (typeof input === 'string') {
    rawList = input.split(/[\n,]+/);
  } else if (input && typeof input === 'object') {
    if (Array.isArray(input.orders)) rawList = input.orders;
    else if (Array.isArray(input.tracking_orders)) rawList = input.tracking_orders;
    else if (Array.isArray(input.trackingOrders)) rawList = input.trackingOrders;
    else if (typeof input.tracking_order === 'string') rawList = [input.tracking_order];
    else if (typeof input.trackingOrder === 'string') rawList = [input.trackingOrder];
    else if (typeof input.order_code === 'string') rawList = [input.order_code];
    else if (typeof input.orderCode === 'string') rawList = [input.orderCode];
    else if (typeof input.code === 'string') rawList = [input.code];
    else if (typeof input.message === 'string') rawList = input.message.split(/[\n,]+/);
    else if (input.data) return normalizeGhtkPrintJobs(input.data);
  }

  const jobs = [];
  for (const item of rawList) {
    if (!item) continue;
    if (typeof item === 'string') {
      const code = item.trim();
      if (code) jobs.push({ tracking: code });
    } else if (typeof item === 'object') {
      const code = String(item.tracking || item.trackingOrder || item.tracking_order || item.orderCode || item.code || '').trim();
      if (code) {
        jobs.push({
          tracking: code,
          orderCode: item.orderCode ? String(item.orderCode).trim() : undefined,
          accountName: item.accountName ? String(item.accountName).trim() : undefined,
          token: item.token ? String(item.token).trim() : undefined,
          partnerCode: item.partnerCode ? String(item.partnerCode).trim() : undefined,
        });
      }
    }
  }
  return jobs;
}

function normalizeTrackingOrders(input) {
  return normalizeGhtkPrintJobs(input).map((j) => j.tracking);
}

function buildSocketHelloPayload() {
  return {
    type: 'register_local_printer',
    deviceId: getSocketDeviceId(),
    hostname: os.hostname(),
    ip: getLocalIPv4(),
    port: PORT,
    printerName: CURRENT_PRINTER,
    capabilities: ['print_ghtk_label', 'print_viettelpost', 'print_return_to_workshop_slip', 'print_other_carrier_ship'],
    ts: Date.now()
  };
}

async function handleGatewayCommand(payload) {
  socketLastMessageAt = Date.now();
  if (!payload || typeof payload !== 'object') return;
  const messageType = String(payload.type || payload.event || payload.action || '').trim().toLowerCase();

  // Log raw payload ngay khi nhận
  const ts = new Date().toISOString();
  console.log(`[SOCKET][${ts}] Xử lý lệnh type="${messageType || '(không có type)'}"`);
  console.log(`[SOCKET] Payload: ${JSON.stringify(payload).slice(0, 500)}`);

  if (messageType === 'ping' || messageType === 'heartbeat') {
    console.log('[SOCKET] → Phản hồi pong');
    emitSocketEvent('gateway_status', { type: 'pong', deviceId: getSocketDeviceId(), ts: Date.now() });
    return;
  }

  // ── Xử lý lệnh in ViettelPost (nhận list URL) ──
  const isViettelPost = ['print_viettelpost', 'viettelpost_print', 'vtp_print'].includes(messageType);
  if (isViettelPost) {
    let urls = [];
    if (Array.isArray(payload.urls)) urls = payload.urls;
    else if (Array.isArray(payload.links)) urls = payload.links;
    else if (typeof payload.url === 'string') urls = [payload.url];
    else if (typeof payload.link === 'string') urls = [payload.link];

    const requestId = String(payload.requestId || payload.request_id || payload.id || crypto.randomUUID());
    console.log(`[SOCKET][VTP] ▶ Bắt đầu in ${urls.length} URL ViettelPost | requestId=${requestId}`);
    urls.forEach((u, i) => console.log(`[SOCKET][VTP]   [${i + 1}/${urls.length}] ${u}`));

    emitSocketEvent('gateway_command_ack', {
      type: 'vtp_print_ack',
      requestId,
      deviceId: getSocketDeviceId(),
      status: 'received',
      urlCount: urls.length,
      ts: Date.now()
    });
    try {
      const results = await printViettelPostUrls(urls, `ws:${requestId}`);
      const ok = results.filter(r => r.status === 'success').length;
      const fail = results.filter(r => r.status === 'error').length;
      console.log(`[SOCKET][VTP] ✔ Hoàn thành requestId=${requestId} | Thành công: ${ok}, Lỗi: ${fail}`);
      results.forEach(r => {
        if (r.status === 'success') console.log(`[SOCKET][VTP]   ✔ ${r.url}`);
        else console.error(`[SOCKET][VTP]   ✘ ${r.url} → ${r.message}`);
      });
      emitSocketEvent('gateway_command_result', {
        type: 'vtp_print_result',
        requestId,
        deviceId: getSocketDeviceId(),
        status: 'success',
        count: results.length,
        results,
        ts: Date.now()
      });
    } catch (err) {
      const message = String(err.message || err);
      console.error(`[SOCKET][VTP] ✘ Lỗi requestId=${requestId}: ${message}`);
      emitSocketEvent('gateway_command_result', {
        type: 'vtp_print_result',
        requestId,
        deviceId: getSocketDeviceId(),
        status: 'error',
        message,
        ts: Date.now()
      });
    }
    return;
  }

  // ── Phiếu trả lại xưởng (HTML → PDF → in) ──
  const isReturnSlip = ['print_return_to_workshop_slip', 'return_to_workshop_slip', 'print_return_slip'].includes(messageType);
  if (isReturnSlip) {
    const slip = payload.slip && typeof payload.slip === 'object' ? payload.slip : payload;
    const requestId = String(payload.requestId || payload.request_id || payload.id || crypto.randomUUID());
    console.log(`[SOCKET][RTX] ▶ Bắt đầu in phiếu trả xưởng | requestId=${requestId}`);
    emitSocketEvent('gateway_command_ack', {
      type: 'rtx_slip_print_ack',
      requestId,
      deviceId: getSocketDeviceId(),
      status: 'received',
      ts: Date.now(),
    });
    try {
      const opts = {
        sizeQr: payload.sizeQr || slip.sizeQr,
        sizeTitle: payload.sizeTitle || slip.sizeTitle,
        sizeSubtitle: payload.sizeSubtitle || slip.sizeSubtitle,
        sizeContent: payload.sizeContent || slip.sizeContent,
        sizeReason: payload.sizeReason || slip.sizeReason,
        paddingLeft: payload.paddingLeft ?? slip.paddingLeft ?? (process.env.RETURN_SLIP_PADDING_LEFT ? Number(process.env.RETURN_SLIP_PADDING_LEFT) : undefined),
        paddingRight: payload.paddingRight ?? slip.paddingRight ?? (process.env.RETURN_SLIP_PADDING_RIGHT ? Number(process.env.RETURN_SLIP_PADDING_RIGHT) : undefined),
      };
      Object.keys(opts).forEach(k => { if (opts[k] == null) delete opts[k]; });
      const result = await printReturnToWorkshopSlip(slip, {
        renderDocumentToPdf: (docPath) => {
          const fileUrl = 'file:///' + String(docPath).replace(/\\/g, '/');
          return renderUrlToPdf(fileUrl);
        },
        sendToPrinterPdf,
        printerName: CURRENT_PRINTER,
      }, opts);
      emitSocketEvent('gateway_command_result', {
        type: 'rtx_slip_print_result',
        requestId,
        deviceId: getSocketDeviceId(),
        status: 'success',
        result,
        ts: Date.now(),
      });
      console.log(`[SOCKET][RTX] ✔ In phiếu trả xưởng thành công | requestId=${requestId}`);
    } catch (err) {
      const message = String(err.message || err);
      console.error(`[SOCKET][RTX] ✘ Lỗi in requestId=${requestId}: ${message}`);
      emitSocketEvent('gateway_command_result', {
        type: 'rtx_slip_print_result',
        requestId,
        deviceId: getSocketDeviceId(),
        status: 'error',
        message,
        ts: Date.now(),
      });
    }
    return;
  }

  // ── Đơn vận chuyển khác (HTML → PDF → in) ──
  const isOtherCarrierShip = ['print_other_carrier_ship', 'other_carrier_ship', 'print_ship_label'].includes(messageType);
  if (isOtherCarrierShip) {
    const shipLabel = payload.shipLabel && typeof payload.shipLabel === 'object' ? payload.shipLabel : payload;
    const requestId = String(payload.requestId || payload.request_id || payload.id || crypto.randomUUID());
    console.log(`[SOCKET][SHIP] ▶ Bắt đầu in đơn vận chuyển khác | requestId=${requestId}`);
    emitSocketEvent('gateway_command_ack', {
      type: 'other_carrier_ship_print_ack',
      requestId,
      deviceId: getSocketDeviceId(),
      status: 'received',
      ts: Date.now(),
    });
    try {
      const result = await printOtherCarrierShip(shipLabel, {
        renderDocumentToPdf: (docPath) => {
          const fileUrl = 'file:///' + String(docPath).replace(/\\/g, '/');
          return renderUrlToPdf(fileUrl);
        },
        sendToPrinterPdf,
        printerName: CURRENT_PRINTER,
      });
      emitSocketEvent('gateway_command_result', {
        type: 'other_carrier_ship_print_result',
        requestId,
        deviceId: getSocketDeviceId(),
        status: 'success',
        result,
        ts: Date.now(),
      });
      console.log(`[SOCKET][SHIP] ✔ In đơn vận chuyển thành công | requestId=${requestId}`);
    } catch (err) {
      const message = String(err.message || err);
      console.error(`[SOCKET][SHIP] ✘ Lỗi in requestId=${requestId}: ${message}`);
      emitSocketEvent('gateway_command_result', {
        type: 'other_carrier_ship_print_result',
        requestId,
        deviceId: getSocketDeviceId(),
        status: 'error',
        message,
        ts: Date.now(),
      });
    }
    return;
  }

  // ── Xử lý lệnh in GHTK (tracking orders) ──
  const ghtkJobs = normalizeGhtkPrintJobs(payload);
  const canPrint = ghtkJobs.length > 0 && (!messageType || ['print_ghtk_label', 'ghtk_print', 'print_label', 'print'].includes(messageType));
  if (!canPrint) {
    console.log(`[SOCKET] ✘ Bỏ qua gateway_command không hỗ trợ (type="${messageType}"): ${JSON.stringify(payload).slice(0, 300)}`);
    return;
  }
  const trackingOrders = ghtkJobs.map((j) => j.tracking);
  const requestId = payload && typeof payload === 'object'
    ? String(payload.requestId || payload.request_id || payload.id || crypto.randomUUID())
    : crypto.randomUUID();
  console.log(`[SOCKET][GHTK] ▶ Bắt đầu in ${ghtkJobs.length} mã GHTK | requestId=${requestId}`);
  ghtkJobs.forEach((job, i) => {
    const extra = job.accountName ? ` [TK: ${job.accountName}]` : '';
    console.log(`[SOCKET][GHTK]   [${i + 1}/${ghtkJobs.length}] ${job.tracking}${extra}`);
  });
  emitSocketEvent('gateway_command_ack', {
    type: 'print_ack',
    requestId,
    deviceId: getSocketDeviceId(),
    status: 'received',
    trackingOrders,
    ts: Date.now()
  });
  try {
    const results = await printGhtkLabels(ghtkJobs, `ws:${requestId}`);
    const ok = results.filter(r => r.status === 'success').length;
    const fail = results.filter(r => r.status === 'error').length;
    console.log(`[SOCKET][GHTK] ✔ Hoàn thành requestId=${requestId} | Thành công: ${ok}, Lỗi: ${fail}`);
    results.forEach(r => {
      if (r.status === 'success') console.log(`[SOCKET][GHTK]   ✔ ${r.tracking}`);
      else console.error(`[SOCKET][GHTK]   ✘ ${r.tracking} → ${r.message}`);
    });
    emitSocketEvent('gateway_command_result', {
      type: 'print_result',
      requestId,
      deviceId: getSocketDeviceId(),
      status: 'success',
      count: results.length,
      results,
      ts: Date.now()
    });
  } catch (err) {
    const message = String(err.message || err);
    console.error(`[SOCKET][GHTK] ✘ Lỗi requestId=${requestId}: ${message}`);
    emitSocketEvent('gateway_command_result', {
      type: 'print_result',
      requestId,
      deviceId: getSocketDeviceId(),
      status: 'error',
      message,
      ts: Date.now()
    });
  }
}

function connectSocketIo() {
  const serverUrl = getSocketServerUrl();
  if (!serverUrl) return;
  if (socketClient) return;
  console.log(`[SOCKET] Đang kết nối tới ${serverUrl}`);
  const authToken = getSocketAuthToken();
  const deviceId = getSocketDeviceId();
  socketClient = io(serverUrl, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: Math.max(1000, getSocketReconnectMs()),
    timeout: 20000,
    auth: {
      token: authToken || undefined,
      deviceId: deviceId
    },
    extraHeaders: {
      'x-device-id': deviceId,
      Authorization: authToken ? `Bearer ${authToken}` : ''
    },
    query: {
      deviceId: deviceId
    }
  });
  socketClient.on('connect', () => {
    socketConnectedAt = Date.now();
    socketLastError = '';
    console.log(`[SOCKET] Kết nối thành công ${socketClient.id}`);
    emitSocketEvent('gateway_register', buildSocketHelloPayload());
  });
  socketClient.on('disconnect', (reason) => {
    console.log(`[SOCKET] Mất kết nối: ${reason}`);
  });
  socketClient.on('connect_error', (err) => {
    socketLastError = String(err.message || err);
    console.error('[SOCKET] Lỗi kết nối:', socketLastError);
  });
  socketClient.on('gateway_command', (payload) => {
    const preview = JSON.stringify(payload).slice(0, 300);
    console.log(`[SOCKET] ← Nhận event "gateway_command": ${preview}`);
    handleGatewayCommand(payload).catch((err) => {
      socketLastError = String(err.message || err);
      console.error('[SOCKET] Lỗi xử lý gateway_command:', socketLastError);
    });
  });
  // Lắng nghe event riêng cho ViettelPost
  socketClient.on('viettelpost_print', (payload) => {
    const preview = JSON.stringify(payload).slice(0, 300);
    console.log(`[SOCKET][VTP] ← Nhận event "viettelpost_print": ${preview}`);
    handleGatewayCommand({ ...payload, type: 'viettelpost_print' }).catch((err) => {
      socketLastError = String(err.message || err);
      console.error('[SOCKET][VTP] Lỗi xử lý viettelpost_print:', socketLastError);
    });
  });
  // Lắng nghe đồng bộ danh sách tài khoản GHTK từ backend
  socketClient.on('gateway_accounts_sync', (payload) => {
    if (payload && Array.isArray(payload.accounts)) {
      syncedGhtkAccounts = payload.accounts;
      try {
        configManager.save({ ghtkAccounts: syncedGhtkAccounts });
      } catch (_) {}
      const names = syncedGhtkAccounts.map((a) => a.name).join(', ');
      console.log(`[SOCKET][GHTK] Đã đồng bộ ${syncedGhtkAccounts.length} tài khoản GHTK từ server: ${names || '(trống)'}`);
    }
  });

  socketClient.on('ping', () => {
    socketLastMessageAt = Date.now();
    console.log('[SOCKET] ← Nhận ping từ server');
  });
}

function reconnectSocketIo() {
  if (socketClient) {
    try {
      socketClient.disconnect();
      socketClient.removeAllListeners();
    } catch {}
    socketClient = null;
  }
  startSocketClient();
}

function startSocketClient() {
  const serverUrl = getSocketServerUrl();
  if (!serverUrl) {
    console.log('[SOCKET] Chưa cấu hình backendSocketUrl, bỏ qua kết nối backend');
    return;
  }
  connectSocketIo();
}

function startUdpBroadcast() {
  const currentCfg = configManager.get();
  if (!currentCfg.discoveryEnable) return;
  const sock = dgram.createSocket('udp4');
  sock.bind(0, '0.0.0.0', () => {
    try { sock.setBroadcast(true); } catch {}
    setInterval(() => {
      const cfg = configManager.get();
      if (!cfg.discoveryEnable) return;
      const payload = {
        ip: getLocalIPv4(),
        port: cfg.port || PORT,
        printerName: CURRENT_PRINTER,
        mdnsName: cfg.mdnsName || 'vivu-printer',
        ts: Date.now()
      };
      const buf = Buffer.from(JSON.stringify(payload));
      try { sock.send(buf, 0, buf.length, cfg.discoveryPort || 4210, cfg.discoveryAddr || '255.255.255.255'); } catch {}
    }, Math.max(500, currentCfg.discoveryIntervalMs || 2000));
  });
}

async function detectPrinters() {
  try {
    const psCmd1 = `powershell -NoProfile -Command "[Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8; Get-Printer | Select-Object Name, Default, Shared, ShareName | ConvertTo-Json"`;
    const { stdout: s1 } = await tryExec(psCmd1);
    let arr1 = [];
    try {
      const parsed = JSON.parse(s1);
      arr1 = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    } catch {
      arr1 = [];
    }
    if (arr1.length) {
      return arr1.map((p) => ({
        name: p.Name,
        default: !!p.Default,
        shared: !!p.Shared,
        shareName: p.ShareName || null,
        workOffline: null,
        status: null,
      }));
    }
  } catch {}
  try {
    const psCmd2 = `powershell -NoProfile -Command "[Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8; Get-CimInstance Win32_Printer | Select-Object Name, Default, WorkOffline, PrinterStatus, Shared, ShareName | ConvertTo-Json"`;
    const { stdout } = await tryExec(psCmd2);
    let arr = [];
    try {
      const parsed = JSON.parse(stdout);
      arr = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    } catch {
      arr = [];
    }
    if (arr.length) {
      return arr.map((p) => ({
        name: p.Name,
        default: !!p.Default,
        workOffline: !!p.WorkOffline,
        status: p.PrinterStatus,
        shared: !!p.Shared,
        shareName: p.ShareName || null,
      }));
    }
  } catch {}
  try {
    const { stdout } = await tryExec('wmic printer get Name,Default,WorkOffline /format:list');
    const lines = stdout.split(/\r?\n/);
    const printers = [];
    let cur = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (Object.keys(cur).length) {
          printers.push({
            name: cur.Name || '',
            default: String(cur.Default || '').toLowerCase() === 'true',
            workOffline: String(cur.WorkOffline || '').toLowerCase() === 'true',
            status: null,
            shared: null,
            shareName: null,
          });
          cur = {};
        }
        continue;
      }
      const idx = trimmed.indexOf('=');
      if (idx > -1) {
        const key = trimmed.slice(0, idx);
        const val = trimmed.slice(idx + 1);
        cur[key] = val;
      }
    }
    if (Object.keys(cur).length) {
      printers.push({
        name: cur.Name || '',
        default: String(cur.Default || '').toLowerCase() === 'true',
        workOffline: String(cur.WorkOffline || '').toLowerCase() === 'true',
        status: null,
        shared: null,
        shareName: null,
      });
    }
    return printers;
  } catch {}
  return [];
}

async function getPrintersWithLogs() {
  const logs = [];
  try {
    const cmd = `[Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8; Get-Printer | Select-Object Name, Default, Shared, ShareName | ConvertTo-Json`;
    const { stdout } = await tryExec(`powershell -NoProfile -Command "${cmd}"`);
    let arr = [];
    try {
      const parsed = JSON.parse(stdout);
      arr = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    } catch (e) {
      logs.push({ method: 'Get-Printer', error: 'JSON parse error', detail: String(e.message || e), outputSample: stdout.slice(0, 200) });
      arr = [];
    }
    if (arr.length) {
      logs.push({ method: 'Get-Printer', error: null, count: arr.length });
      return { printers: arr.map((p) => ({ name: p.Name, default: !!p.Default, workOffline: null, status: null, shared: !!p.Shared, shareName: p.ShareName || null })), logs };
    } else {
      logs.push({ method: 'Get-Printer', error: 'No printers found', count: 0 });
    }
  } catch (e) {
    logs.push({ method: 'Get-Printer', error: String(e.message || e) });
  }
  try {
    const cmd = `[Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8; Get-CimInstance Win32_Printer | Select-Object Name, Default, WorkOffline, PrinterStatus, Shared, ShareName | ConvertTo-Json`;
    const { stdout } = await tryExec(`powershell -NoProfile -Command "${cmd}"`);
    let arr = [];
    try {
      const parsed = JSON.parse(stdout);
      arr = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    } catch (e) {
      logs.push({ method: 'Win32_Printer', error: 'JSON parse error', detail: String(e.message || e), outputSample: stdout.slice(0, 200) });
      arr = [];
    }
    if (arr.length) {
      logs.push({ method: 'Win32_Printer', error: null, count: arr.length });
      return { printers: arr.map((p) => ({ name: p.Name, default: !!p.Default, workOffline: !!p.WorkOffline, status: p.PrinterStatus, shared: !!p.Shared, shareName: p.ShareName || null })), logs };
    } else {
      logs.push({ method: 'Win32_Printer', error: 'No printers found', count: 0 });
    }
  } catch (e) {
    logs.push({ method: 'Win32_Printer', error: String(e.message || e) });
  }
  try {
    const { stdout } = await tryExec('wmic printer get Name,Default,WorkOffline /format:list');
    const lines = stdout.split(/\r?\n/);
    const printers = [];
    let cur = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (Object.keys(cur).length) {
          printers.push({
            name: cur.Name || '',
            default: String(cur.Default || '').toLowerCase() === 'true',
            workOffline: String(cur.WorkOffline || '').toLowerCase() === 'true',
            status: null,
          });
          cur = {};
        }
        continue;
      }
      const idx = trimmed.indexOf('=');
      if (idx > -1) {
        const key = trimmed.slice(0, idx);
        const val = trimmed.slice(idx + 1);
        cur[key] = val;
      }
    }
    if (Object.keys(cur).length) {
      printers.push({
        name: cur.Name || '',
        default: String(cur.Default || '').toLowerCase() === 'true',
        workOffline: String(cur.WorkOffline || '').toLowerCase() === 'true',
        status: null,
      });
    }
    if (printers.length) {
      logs.push({ method: 'wmic', error: null, count: printers.length });
      return { printers, logs };
    }
    logs.push({ method: 'wmic', error: 'No printers found', count: 0 });
    return { printers: [], logs };
  } catch (e) {
    logs.push({ method: 'wmic', error: String(e.message || e) });
    return { printers: [], logs };
  }
}
function tryExec(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr || stdout || error.message));
      }
      resolve({ stdout, stderr });
    });
  });
}

async function sendToPrinterRaw(tspl, printerName) {
  const name = sanitizePrinterName(printerName);
  const filePath = await createTempTsplFile(tspl);
  const quotedFile = `"${filePath}"`;
  const quotedPrinter = `"${name}"`;

  try {
    const cmdPrintNamed = `print /D:${quotedPrinter} ${quotedFile}`;
    const out1 = await tryExec(cmdPrintNamed);
    const s1 = `${out1.stdout || ''}${out1.stderr || ''}`;
    if (/Unable to initialize device/i.test(s1) || /not found|cannot find|invalid device/i.test(s1)) {
      throw new Error(s1 || 'print command failed');
    }
    return { method: 'print', target: name, file: filePath, command: cmdPrintNamed, stdout: out1.stdout, stderr: out1.stderr };
  } catch (e1) {
    try {
      const unc = `\\\\localhost\\${name}`;
      const cmdCopyUNC = `copy /B ${quotedFile} "${unc}"`;
      const out2 = await tryExec(cmdCopyUNC);
      return { method: 'copy', target: unc, file: filePath, command: cmdCopyUNC, stdout: out2.stdout, stderr: out2.stderr };
    } catch (e2) {
      try {
        const cmdPrintDefault = `print ${quotedFile}`;
        const out3 = await tryExec(cmdPrintDefault);
        return { method: 'print', target: '(default printer)', file: filePath, command: cmdPrintDefault, stdout: out3.stdout, stderr: out3.stderr };
      } catch (e3) {
        throw new Error(
          `Không thể gửi lệnh tới máy in. Lỗi: ${e3.message}. ` +
          `Gợi ý: Đảm bảo máy in "${name}" là máy in mặc định hoặc đã được share với đúng tên; ` +
          `nên dùng driver "Generic / Text Only" để nhận TSPL RAW.`
        );
      }
    }
  } finally {
    fs.unlink(filePath, () => {});
  }
}

async function sendToPrinterPdf(filePath, printerName, options) {
  const keepFile = !!(options && options.keepFile);
  const paperSize = (options && options.paperSize) || null; // 'a5', 'a4', hoặc null = dùng LABEL size
  const name = sanitizePrinterName(printerName);

  // Normalize path: dùng backslash chuẩn, không có ký tự đặc biệt
  const normalizedPath = path.resolve(filePath);
  const quotedFile = `"${normalizedPath}"`;
  const quotedPrinter = `"${name}"`;

  // Tự động tìm SumatraPDF nếu chưa có hoặc kiểm tra path hiện tại
  let viewerPath = configManager.get('pdfViewerPath');
  if (!viewerPath || !fs.existsSync(viewerPath)) {
    const auto = configManager.detectPdfViewer();
    if (auto.found) {
      viewerPath = auto.path;
      configManager.save({ pdfViewerPath: viewerPath });
    }
  }

  if (viewerPath && fs.existsSync(viewerPath)) {
    const viewer = `"${viewerPath}"`;
    try {
      if (/sumatra/i.test(viewerPath)) {
        let settings;
        if (paperSize === 'a5') {
          settings = `paper=148x210mm, portrait, fit, center`;
        } else if (paperSize === 'a4') {
          settings = `paper=210x297mm, portrait, fit, center`;
        } else {
          settings = buildSumatraPrintSettings();
        }
        // -exit-when-done đảm bảo SumatraPDF thoát sau khi in xong (blocking)
        const cmd = `${viewer} -print-to ${quotedPrinter} -print-settings "${settings}" -silent -exit-when-done ${quotedFile}`;
        console.log(`[PDF] SumatraPDF cmd: ${cmd}`);
        let out;
        try {
          out = await tryExec(cmd);
        } catch (e) {
          // SumatraPDF ghi debug ParseFlags ra stderr dù thành công hay thất bại
          const msg = String(e.message || '');
          const cleanMsg = msg.split('\n').filter(l => !/^ParseFlags:/i.test(l.trim())).join('\n').trim();
          if (!cleanMsg) {
            // Chỉ có ParseFlags debug, coi như thành công
            out = { stdout: '', stderr: msg };
          } else {
            throw new Error(cleanMsg);
          }
        }
        console.log(`[PDF] SumatraPDF stdout: ${out.stdout || '(trống)'} | stderr: ${out.stderr || '(trống)'}`);
        // File đã được in xong (SumatraPDF đã exit), xóa sau 5 giây là đủ
        if (!keepFile) scheduleTempDelete(normalizedPath, 5000);
        return { method: 'SumatraPDF', target: name, file: normalizedPath, command: cmd, stdout: out.stdout, stderr: out.stderr };
      }
      if (/acrord32|acrobat/i.test(viewerPath)) {
        const cmd = `${viewer} /t ${quotedFile} ${quotedPrinter} "" ""`;
        const out = await tryExec(cmd);
        if (!keepFile) scheduleTempDelete(normalizedPath, 60000);
        return { method: 'Acrobat', target: name, file: normalizedPath, command: cmd, stdout: out.stdout, stderr: out.stderr };
      }
    } catch (e) {
      throw new Error(`Không thể in PDF qua viewer tùy chỉnh (${viewerPath}). ${e.message}`);
    }
  }
  try {
    const cmdPrintTo = `powershell -NoProfile -Command "Start-Process -FilePath ${quotedFile} -Verb PrintTo -ArgumentList ${quotedPrinter}"`;
    const out1 = await tryExec(cmdPrintTo);
    if (!keepFile) scheduleTempDelete(normalizedPath, 60000);
    return { method: 'PrintTo', target: name, file: normalizedPath, command: cmdPrintTo, stdout: out1.stdout, stderr: out1.stderr };
  } catch (e1) {
    try {
      const cmdPrint = `powershell -NoProfile -Command "Start-Process -FilePath ${quotedFile} -Verb Print"`;
      const out2 = await tryExec(cmdPrint);
      if (!keepFile) scheduleTempDelete(normalizedPath, 60000);
      return { method: 'Print', target: '(default printer)', file: normalizedPath, command: cmdPrint, stdout: out2.stdout, stderr: out2.stderr };
    } catch (e2) {
      throw new Error(
        `Không thể in PDF qua ứng dụng mặc định. Lỗi: ${e2.message}. ` +
        `Gợi ý: Thiết lập ứng dụng xem PDF mặc định (Adobe Reader, SumatraPDF, Edge). ` +
        `Nếu muốn chọn máy in cụ thể, dùng ứng dụng hỗ trợ shell verb PrintTo.`
      );
    }
  } finally {
    // đã hẹn giờ xoá file ở trên để tránh xoá quá sớm
  }
}

// Template TSPL cho hóa đơn
function buildBillTSPL(bill) {
  // bill: { size: '58'|'80'|number(mm), title, items: [{name, qty, price}], total, qr?: string }
  const widthMm = parseInt(String(bill.size || '58').replace('mm', '').trim(), 10);
  const widthDots = mmToDots(widthMm);
  const marginTopDots = mmToDots(4);
  const lineGapDots = 6;
  const fontCharW = 12; // ước lượng chiều rộng ký tự (dots)
  const fontCharH = 24; // ước lượng chiều cao ký tự (dots)

  let y = marginTopDots;
  const lines = [];

  // Khởi tạo nhãn
  const estimatedLines =
    4 + // title, header, total, print
    (Array.isArray(bill.items) ? bill.items.length : 0) +
    (bill.qr ? 10 : 0);
  const heightMm = Math.max(40, Math.ceil(estimatedLines * 4)); // ước lượng chiều cao

  lines.push(`SIZE ${widthMm} mm, ${heightMm} mm`);
  lines.push(`GAP 2 mm, 0`);
  lines.push(`DIRECTION 1`);
  lines.push(`CLS`);
  lines.push(`DENSITY ${bill.density || 12}`);
  lines.push(`SPEED ${bill.speed || 4}`);
  lines.push(`SET TEAR ON`);

  // Title (center, top)
  const title = String(bill.title || 'HÓA ĐƠN').toUpperCase();
  const titleW = title.length * fontCharW * 2; // bold xmul=2
  const titleX = Math.max(0, Math.round((widthDots - titleW) / 2));
  lines.push(`TEXT ${titleX},${y},0,0,2,2,"${title}"`);
  y += fontCharH * 2 + lineGapDots;

  // Header
  lines.push(`TEXT 10,${y},0,0,1,1,"Sản phẩm"`);
  const rightLabel = 'Giá';
  const rightW = rightLabel.length * fontCharW;
  const rightX = Math.max(10, widthDots - rightW - 10);
  lines.push(`TEXT ${rightX},${y},0,0,1,1,"${rightLabel}"`);
  y += fontCharH + lineGapDots;

  // Items (left-right)
  const items = Array.isArray(bill.items) ? bill.items : [];
  for (const item of items) {
    const name = String(item.name || '').slice(0, 32);
    const qty = Number(item.qty || 1);
    const price = Number(item.price || 0);
    const lineTotal = qty * price;
    const leftText = `${name} x${qty}`;
    const rightText = `${lineTotal.toLocaleString('vi-VN')}`;
    const rightTextW = rightText.length * fontCharW;
    const rightPosX = Math.max(10, widthDots - rightTextW - 10);
    lines.push(`TEXT 10,${y},0,0,1,1,"${leftText}"`);
    lines.push(`TEXT ${rightPosX},${y},0,0,1,1,"${rightText}"`);
    y += fontCharH + lineGapDots;
  }

  // Tổng tiền (bold)
  const total = Number(bill.total || items.reduce((s, it) => s + (Number(it.qty || 1) * Number(it.price || 0)), 0));
  const totalLabel = 'TỔNG TIỀN';
  const totalValue = `${total.toLocaleString('vi-VN')} VND`;
  const totalLabelW = totalLabel.length * fontCharW * 2;
  const totalValueW = totalValue.length * fontCharW * 2;
  const totalLabelX = 10;
  const totalValueX = Math.max(10, widthDots - totalValueW - 10);
  lines.push(`TEXT ${totalLabelX},${y},0,0,2,2,"${totalLabel}"`);
  lines.push(`TEXT ${totalValueX},${y},0,0,2,2,"${totalValue}"`);
  y += fontCharH * 2 + lineGapDots;

  // QR code (nếu có)
  if (bill.qr) {
    const qrSize = 6; // cell size
    const qrText = String(bill.qr);
    const qrW = qrSize * 29; // ước lượng (QR version auto)
    const qrX = Math.max(0, Math.round((widthDots - qrW) / 2));
    lines.push(`QRCODE ${qrX},${y},L,${qrSize},A,0,"${qrText}"`);
    y += fontCharH * 6;
  }

  // In 1 nhãn
  lines.push(`PRINT 1`);

  return lines.join('\r\n') + '\r\n';
}

// Hàng đợi và xử lý in
function enqueuePrint(tspl, source) {
  const hash = crypto.createHash('sha1').update(tspl).digest('hex');
  const now = Date.now();
  if (lastPayloadHash === hash && (now - lastPayloadAt) < DEDUP_WINDOW_MS) {
    return { enqueued: false, reason: 'duplicate_within_window' };
  }
  const jobId = crypto.randomUUID();
  printQueue.push({ id: jobId, tspl, source });
  lastPayloadHash = hash;
  lastPayloadAt = now;
  processQueue();
  return { enqueued: true, jobId };
}

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;
  try {
    while (printQueue.length > 0) {
      const job = printQueue.shift();
      console.log(`[PRINT] Bắt đầu in job ${job.id} từ ${job.source}`);
      try {
        const result = await sendToPrinterRaw(job.tspl, CURRENT_PRINTER);
        console.log(`[PRINT] Thành công job ${job.id} qua ${result.method} -> ${result.target}`);
      } catch (err) {
        console.error(`[PRINT] Lỗi job ${job.id}:`, err.message);
      }
    }
  } finally {
    isProcessing = false;
  }
}

// API: /print (TSPL RAW)
app.post('/print', (req, res) => {
  try {
    const tspl = String(req.body || '').trim();
    if (!tspl) {
      return res.status(400).json({ status: 'error', message: 'Body trống hoặc không hợp lệ (text/plain)' });
    }
    const result = enqueuePrint(tspl, '/print');
    if (!result.enqueued) {
      return res.status(200).json({ status: 'success', message: 'Bỏ qua vì trùng lệnh trong thời gian ngắn', dedup: true });
    }
    return res.status(202).json({ status: 'success', jobId: result.jobId, message: 'Đã đưa vào hàng đợi' });
  } catch (err) {
    console.error('[API /print] Error:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

function fetchGhtkPdf(tracking, token, clientSource, accountName) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'services.giaohangtietkiem.vn',
      path: `/services/label/${encodeURIComponent(tracking)}?original=landscape&page_size=a6`,
      method: 'GET',
      headers: {
        'Token': token,
        'Accept': 'application/pdf',
        'User-Agent': 'vivu-printer/1.0'
      }
    };
    if (clientSource) options.headers['X-Client-Source'] = clientSource;
    const req = https.request(options, (res) => {
      const ctype = String(res.headers['content-type'] || '');
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', async () => {
        let buf = Buffer.concat(chunks);
        if (res.statusCode === 200 && ctype.includes('application/pdf')) {
          try {
            if (accountName) {
              console.log(`[GHTK] Đóng dấu tên tài khoản "${accountName}" lên tem ${tracking}`);
              buf = await stampGhtkLabelPdf(buf, accountName);
            }
            if (ensureSaveDir()) {
              const saved = await savePdfToDir(buf, `GHTK_${tracking}`);
              return resolve({ filePath: saved, persisted: true });
            } else {
              const tmp = await createTempPdfFile(buf);
              return resolve({ filePath: tmp, persisted: false });
            }
          } catch (e) {
            reject(e);
          }
        } else {
          let msg = buf.toString('utf8');
          reject(new Error(`GHTK trả về ${res.statusCode} (${ctype}): ${msg.slice(0, 500)}`));
        }
      });
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(20000, () => {
      req.destroy(new Error('Timeout gọi API GHTK'));
    });
    req.end();
  });
}

function queryBackendForGhtkPrintInfo(trackingCode) {
  return new Promise((resolve) => {
    const serverUrl = getSocketServerUrl();
    if (!serverUrl) return resolve(null);
    const authToken = getSocketAuthToken();
    const deviceId = getSocketDeviceId();
    let targetUrl;
    try {
      targetUrl = new URL(`/api/ghtk/print-info?tracking=${encodeURIComponent(trackingCode)}`, serverUrl);
    } catch (_) {
      return resolve(null);
    }

    const client = targetUrl.protocol === 'https:' ? https : http;
    const req = client.request(
      targetUrl,
      {
        method: 'GET',
        headers: {
          'x-device-id': deviceId,
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
        },
        timeout: 5000
      },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              const parsed = JSON.parse(body);
              if (parsed && parsed.success && parsed.data && parsed.data.token) {
                return resolve(parsed.data);
              }
            }
          } catch (_) {}
          resolve(null);
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

async function printGhtkLabels(input, source) {
  const defaultToken = configManager.get('ghtkApiToken') || process.env.GHTK_API_TOKEN || '';
  const defaultClientSource = configManager.get('ghtkClientSource') || process.env.GHTK_CLIENT_SOURCE || '';
  const jobs = normalizeGhtkPrintJobs(input);
  if (!jobs.length) throw new Error('Thiếu danh sách TRACKING_ORDER');
  const results = [];

  for (const job of jobs) {
    const code = job.tracking;
    let token = job.token || '';
    let clientSource = job.partnerCode || '';
    let accountName = job.accountName || '';

    // 1. Nếu chưa có token (in trực tiếp qua LAN HTTP / UI thủ công), thử tra cứu từ Backend
    if (!token) {
      const backendInfo = await queryBackendForGhtkPrintInfo(code);
      if (backendInfo && backendInfo.token) {
        token = backendInfo.token;
        clientSource = backendInfo.partnerCode || clientSource;
        accountName = backendInfo.accountName || accountName;
        console.log(`[GHTK] Đã tra cứu tài khoản từ backend cho ${code}: "${accountName}"`);
      }
    }

    // 2. Nếu vẫn chưa có token, thử lần lượt qua bể tài khoản đã sync từ server
    let preFetchedResult = null;
    if (!token && syncedGhtkAccounts && syncedGhtkAccounts.length > 0) {
      console.log(`[GHTK] Đang dò tìm tài khoản cho ${code} trong ${syncedGhtkAccounts.length} tài khoản đồng bộ...`);
      for (const acc of syncedGhtkAccounts) {
        if (!acc.token) continue;
        try {
          preFetchedResult = await fetchGhtkPdf(code, acc.token, acc.partnerCode || '', acc.name || '');
          token = acc.token;
          clientSource = acc.partnerCode || '';
          accountName = acc.name || '';
          console.log(`[GHTK] ✔ Dò tìm thành công mã ${code} thuộc tài khoản "${acc.name}"`);
          break;
        } catch (_) {
          // Thử tài khoản kế tiếp
        }
      }
    }

    // 3. Fallback token mặc định cấu hình trên máy in nếu có
    if (!token && !preFetchedResult) {
      token = defaultToken;
      clientSource = clientSource || defaultClientSource;
    }

    if (!token && !preFetchedResult) {
      results.push({ tracking: code, status: 'error', message: 'Không tìm thấy tài khoản GHTK phù hợp để in nhãn' });
      console.error(`[GHTK] Bỏ qua ${code}: Không tìm thấy tài khoản GHTK hợp lệ`);
      continue;
    }

    try {
      console.log(`[GHTK] Bắt đầu in ${code} từ ${source}${accountName ? ` (TK: ${accountName})` : ''}`);
      let fetchResult = preFetchedResult;
      if (!fetchResult) {
        try {
          fetchResult = await fetchGhtkPdf(code, token, clientSource, accountName);
        } catch (initialErr) {
          // Nếu gọi token ban đầu thất bại (ví dụ tài khoản bị lệch), tự động thử dò qua các tài khoản còn lại
          let fallbackSuccess = false;
          if (syncedGhtkAccounts && syncedGhtkAccounts.length > 0) {
            console.warn(`[GHTK] Thử fallback mã ${code} với các tài khoản khác sau khi lỗi: ${initialErr.message}`);
            for (const acc of syncedGhtkAccounts) {
              if (!acc.token || acc.token === token) continue;
              try {
                fetchResult = await fetchGhtkPdf(code, acc.token, acc.partnerCode || '', acc.name || '');
                accountName = acc.name || '';
                fallbackSuccess = true;
                console.log(`[GHTK] ✔ Dò fallback thành công mã ${code} sang tài khoản "${acc.name}"`);
                break;
              } catch (_) {}
            }
          }
          if (!fallbackSuccess) throw initialErr;
        }
      }

      const { filePath, persisted } = fetchResult;
      const printResult = await sendToPrinterPdf(filePath, CURRENT_PRINTER, { keepFile: persisted });
      results.push({ tracking: code, status: 'success', accountName, savedPath: persisted ? filePath : null, result: printResult });
      console.log(`[GHTK] In thành công ${code} từ ${source}${accountName ? ` (TK: ${accountName})` : ''}`);
    } catch (e) {
      const message = String(e.message || e);
      results.push({ tracking: code, status: 'error', message });
      console.error(`[GHTK] In lỗi ${code} từ ${source}: ${message}`);
    }
  }
  return results;
}

// ─── ViettelPost: in URL web với khổ A5 portrait ───────────────────────────

/**
 * Tìm đường dẫn Chromium/Edge/Chrome có thể dùng headless
 */
function findHeadlessBrowser() {
  const candidates = process.platform === 'win32'
    ? [
        // Microsoft Edge (thường có sẵn trên Windows 10/11)
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        // Google Chrome
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        // Chromium
        'C:\\Program Files\\Chromium\\Application\\chrome.exe',
      ]
    : [
        // macOS
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        // Linux
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
      ];
  // Ưu tiên biến môi trường nếu có
  const envBrowser = String(process.env.HEADLESS_BROWSER_PATH || '').trim();
  if (envBrowser) candidates.unshift(envBrowser);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Build CSS override để ép VTP label vừa khổ giấy in (từ LABEL_WIDTH/HEIGHT_MM).
 * VTP gốc thiết kế label A6 (96x148mm) với các element position: absolute
 * tọa độ pixel. Override này giữ nguyên kích thước đó, dùng flexbox center
 * trên khổ giấy thực tế. Không cần scale vì A6 gần bằng 100x150mm.
 */
function buildVtpCss(previewMode) {
  const pw = parseFloat(process.env.LABEL_WIDTH_MM || '100') || 100;
  const ph = parseFloat(process.env.LABEL_HEIGHT_MM || '150') || 150;
  // VTP label gốc là A6 (96x148mm)
  const lw = 96;
  const lh = 148;

  let css = `
@page { size: ${pw}mm ${ph}mm !important; margin: 0 !important; }
.page {
  display: flex !important;
  align-items: center;
  justify-content: center;
  grid-template-columns: none !important;
  gap: 0 !important;
  width: ${pw}mm !important;
  height: ${ph}mm !important;
  margin: 0 !important;
  page-break-after: avoid !important;
  position: relative;
  overflow: hidden;
}
.mainPrints {
  width: ${lw}mm !important;
  height: ${lh}mm !important;
  margin: 0 !important;
  border: none !important;
  flex-shrink: 0;
  position: relative;
}
.group-btn { display: none !important; }
  `.trim();

  if (previewMode) {
    css += `
html, body { margin: 0; padding: 0; }
body {
  background: #e5e7eb;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  min-height: 100vh;
  padding: 24px;
  box-sizing: border-box;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.page {
  background: #fff;
  box-shadow: 0 6px 24px rgba(0,0,0,0.18);
}
@media print {
  body { background: #fff !important; padding: 0 !important; }
  .page { box-shadow: none !important; }
}
    `.trim();
  }
  return css;
}

/** CSS cho in PDF (body do puppeteer lo) */
function getVtpPrintCss() { return buildVtpCss(false); }

/** CSS cho preview (tab mới, có nền xám + shadow + @media print) */
function getVtpPreviewCss() { return buildVtpCss(true); }

/**
 * Khởi động Edge/Chrome headless qua puppeteer-core (dùng browser có sẵn trên máy)
 */
async function launchHeadlessBrowser() {
  const browserPath = findHeadlessBrowser();
  if (!browserPath) {
    throw new Error(
      'Không tìm thấy trình duyệt Chromium/Edge/Chrome để render URL. ' +
      'Cài Microsoft Edge hoặc Google Chrome, hoặc thiết lập HEADLESS_BROWSER_PATH trong .env'
    );
  }
  return await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--run-all-compositor-stages-before-draw',
    ],
  });
}

/**
 * Dùng puppeteer-core render URL VTP thành PDF A5 portrait.
 * Inject CSS override để nhãn VTP vừa đúng khổ A5 (gốc là A4 + grid 2 cột).
 * Trả về filePath của PDF tạm.
 */
async function renderUrlToPdf(url) {
  // Tạo thư mục temp riêng, suffix random để tránh trùng khi in song song
  const tmpDir = path.join(os.tmpdir(), `vtp${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const pdfPath = path.join(tmpDir, 'out.pdf');

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch (e) {
    throw new Error(`Không tạo được thư mục temp: ${e.message}`);
  }

  console.log(`[VTP] Render URL: ${url}`);
  console.log(`[VTP] Output PDF: ${pdfPath}`);

  // Lấy kích thước giấy từ .env (LABEL_WIDTH_MM x LABEL_HEIGHT_MM)
  const pw = parseFloat(process.env.LABEL_WIDTH_MM || '100') || 100;
  const ph = parseFloat(process.env.LABEL_HEIGHT_MM || '150') || 150;

  console.log(`[VTP] PDF paper size: ${pw}x${ph}mm`);

  const browser = await launchHeadlessBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 1200, deviceScaleFactor: 1 });

    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 800));

    await page.addStyleTag({ content: getVtpPrintCss() });
    await new Promise((r) => setTimeout(r, 300));

    await page.pdf({
      path: pdfPath,
      width: `${pw}mm`,
      height: `${ph}mm`,
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });

    const stat = fs.statSync(pdfPath);
    if (stat.size < 100) {
      throw new Error(`PDF tạo ra bị rỗng (${stat.size} bytes) từ URL "${url}"`);
    }
    console.log(`[VTP] PDF tạo thành công: ${pdfPath} (${stat.size} bytes)`);
    return pdfPath;
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * In danh sách URL ViettelPost (A5 portrait)
 */
async function printViettelPostUrls(urls, source) {
  if (!Array.isArray(urls) || !urls.length) throw new Error('Thiếu danh sách URL');
  const validUrls = urls.map(u => String(u || '').trim()).filter(Boolean);
  if (!validUrls.length) throw new Error('Danh sách URL rỗng hoặc không hợp lệ');

  const results = [];
  for (const url of validUrls) {
    try {
      console.log(`[VTP] Bắt đầu in URL: ${url} từ ${source}`);
      const pdfPath = await renderUrlToPdf(url);
      const printResult = await sendToPrinterPdf(pdfPath, CURRENT_PRINTER, { keepFile: true });
      // Xóa PDF sau 60 giây để SumatraPDF kịp đọc và in xong
      setTimeout(() => {
        try { fs.rmSync(path.dirname(pdfPath), { recursive: true, force: true }); } catch {}
      }, 60000);
      results.push({ url, status: 'success', result: printResult });
      console.log(`[VTP] In thành công URL: ${url}`);
    } catch (e) {
      const message = String(e.message || e);
      results.push({ url, status: 'error', message });
      console.error(`[VTP] Lỗi in URL ${url}: ${message}`);
    }
  }
  return results;
}

// ─── REST API: /print-viettelpost ───────────────────────────────────────────
app.post('/print-viettelpost', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const body = req.body || {};
    let urls = [];
    if (Array.isArray(body.urls)) urls = body.urls;
    else if (Array.isArray(body.links)) urls = body.links;
    else if (typeof body.url === 'string') urls = [body.url];
    else if (typeof body.link === 'string') urls = [body.link];
    else if (Array.isArray(body)) urls = body;

    if (!urls.length) {
      return res.status(400).json({ status: 'error', message: 'Thiếu danh sách URL (trường "urls" hoặc "links")' });
    }
    const results = await printViettelPostUrls(urls, '/print-viettelpost');
    return res.json({ status: 'success', count: results.length, results });
  } catch (err) {
    console.error('[API /print-viettelpost] Error:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── Preview VTP: render URL thành HTML với CSS A5, trả về cho client mở tab mới ─

/**
 * Render URL VTP thành HTML đã áp CSS A5, trả về text/html cho client mở tab mới.
 * Inject <base> để relative URL trong HTML VTP (ảnh, script, css) vẫn load đúng từ server VTP.
 */
async function renderVtpUrlToHtml(url) {
  const browser = await launchHeadlessBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 1200, deviceScaleFactor: 1 });

    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 800));

    await page.addStyleTag({ content: getVtpPreviewCss() });
    await new Promise((r) => setTimeout(r, 300));

    let html = await page.content();

    // Inject <base> đầu <head> để URL tương đối (./css/..., images/...) trỏ về VTP server
    let baseHref = '';
    try {
      const u = new URL(url);
      baseHref = u.origin + u.pathname.substring(0, u.pathname.lastIndexOf('/') + 1);
    } catch {}
    if (baseHref) {
      html = html.replace(/<head([^>]*)>/i, `<head$1>\n<base href="${baseHref}">`);
    }
    return html;
  } finally {
    await browser.close().catch(() => {});
  }
}

app.post('/preview-viettelpost', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const url = String(body.url || '').trim();
    if (!url) {
      return res.status(400).type('text/plain').send('Thiếu URL');
    }
    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).type('text/plain').send('URL phải bắt đầu bằng http(s)://');
    }
    console.log(`[API /preview-viettelpost] URL: ${url}`);
    const html = await renderVtpUrlToHtml(url);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(html);
  } catch (err) {
    console.error('[API /preview-viettelpost] Error:', err);
    res.status(500).type('text/plain').send(`Lỗi preview: ${err.message}`);
  }
});

app.post('/print-ghtk-label', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const results = await printGhtkLabels(req.body, '/print-ghtk-label');
    return res.json({ status: 'success', count: results.length, results });
  } catch (err) {
    return res.status(400).json({ status: 'error', message: err.message });
  }
});

app.post('/print-return-to-workshop-slip', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const slip = body.slip && typeof body.slip === 'object' ? body.slip : body;
    const opts = {
      sizeQr: body.sizeQr || slip.sizeQr,
      sizeTitle: body.sizeTitle || slip.sizeTitle,
      sizeSubtitle: body.sizeSubtitle || slip.sizeSubtitle,
      sizeContent: body.sizeContent || slip.sizeContent,
      sizeReason: body.sizeReason || slip.sizeReason,
      paddingLeft: body.paddingLeft ?? slip.paddingLeft ?? (process.env.RETURN_SLIP_PADDING_LEFT ? Number(process.env.RETURN_SLIP_PADDING_LEFT) : undefined),
      paddingRight: body.paddingRight ?? slip.paddingRight ?? (process.env.RETURN_SLIP_PADDING_RIGHT ? Number(process.env.RETURN_SLIP_PADDING_RIGHT) : undefined),
    };
    // Clean undefined keys
    Object.keys(opts).forEach(k => { if (opts[k] == null) delete opts[k]; });
    const result = await printReturnToWorkshopSlip(slip, {
      renderDocumentToPdf: (docPath) => {
        const fileUrl = 'file:///' + String(docPath).replace(/\\/g, '/');
        return renderUrlToPdf(fileUrl);
      },
      sendToPrinterPdf,
      printerName: CURRENT_PRINTER,
    }, opts);
    return res.json({ status: 'success', result });
  } catch (err) {
    console.error('[API /print-return-to-workshop-slip] Error:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/print-other-carrier-ship', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const shipLabel = body.shipLabel && typeof body.shipLabel === 'object' ? body.shipLabel : body;
    const result = await printOtherCarrierShip(shipLabel, {
      renderDocumentToPdf: (docPath) => {
        const fileUrl = 'file:///' + String(docPath).replace(/\\/g, '/');
        return renderUrlToPdf(fileUrl);
      },
      sendToPrinterPdf,
      printerName: CURRENT_PRINTER,
    });
    return res.json({ status: 'success', result });
  } catch (err) {
    console.error('[API /print-other-carrier-ship] Error:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/print-pdf', express.raw({ type: 'application/pdf', limit: '20mb' }), (req, res) => {
  try {
    const data = req.body;
    if (!data || !data.length) {
      return res.status(400).json({ status: 'error', message: 'Body trống hoặc không phải application/pdf' });
    }
    createTempPdfFile(data)
      .then((filePath) => sendToPrinterPdf(filePath, CURRENT_PRINTER))
      .then((result) => {
        console.log(`[PDF PRINT] ${result.method} -> ${result.target}; cmd="${result.command}"`);
        res.status(200).json({ status: 'success', result });
      })
      .catch((err) => {
        console.error('[PDF PRINT] Error:', err.message);
        res.status(500).json({ status: 'error', message: err.message });
      });
  } catch (err) {
    console.error('[API /print-pdf] Error:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// API: /print-json (convert bill -> TSPL)
app.post('/print-json', (req, res) => {
  try {
    const bill = req.body || {};
    const tspl = buildBillTSPL(bill);
    const result = enqueuePrint(tspl, '/print-json');
    if (!result.enqueued) {
      return res.status(200).json({ status: 'success', message: 'Bỏ qua vì trùng lệnh trong thời gian ngắn', dedup: true });
    }
    return res.status(202).json({ status: 'success', jobId: result.jobId, message: 'Đã đưa vào hàng đợi' });
  } catch (err) {
    console.error('[API /print-json] Error:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/print-debug', (req, res) => {
  try {
    const tspl = String(req.body || '').trim();
    if (!tspl) {
      return res.status(400).json({ status: 'error', message: 'Body trống hoặc không hợp lệ (text/plain)' });
    }
    sendToPrinterRaw(tspl, CURRENT_PRINTER)
      .then((result) => {
        console.log(`[DEBUG PRINT] ${result.method} -> ${result.target}; cmd="${result.command}"`);
        res.status(200).json({ status: 'success', result });
      })
      .catch((err) => {
        console.error('[DEBUG PRINT] Error:', err.message);
        res.status(500).json({ status: 'error', message: err.message });
      });
  } catch (err) {
    console.error('[API /print-debug] Error:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/printers', async (req, res) => {
  try {
    const { printers, logs } = await getPrintersWithLogs();
    res.json({ printers, currentPrinter: CURRENT_PRINTER, logs });
  } catch (err) {
    res.json({ printers: [], currentPrinter: CURRENT_PRINTER, logs: [{ method: 'unknown', error: String(err.message || err) }] });
  }
});

app.post('/printer', express.json(), async (req, res) => {
  try {
    const name = sanitizePrinterName(req.body && req.body.name);
    if (!name) return res.status(400).json({ status: 'error', message: 'Thiếu tên máy in' });
    const printers = await detectPrinters();
    const found = printers.find((p) => p.name === name);
    if (!found) return res.status(404).json({ status: 'error', message: `Không tìm thấy máy in "${name}"` });
    CURRENT_PRINTER = name;
    configManager.save({ printerName: name });
    startMdns(configManager.get());
    console.log(`[CONFIG] Chọn máy in: ${CURRENT_PRINTER}`);
    return res.json({ status: 'success', currentPrinter: CURRENT_PRINTER });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/config', (req, res) => {
  const socket = getSocketStatus();
  const cfg = configManager.get();
  res.json({
    ...cfg,
    port: cfg.port || PORT,
    printerName: CURRENT_PRINTER,
    socket,
    websocket: socket,
    pdfViewerDetected: configManager.detectPdfViewer()
  });
});

// Full API config endpoints
app.get('/api/config', (req, res) => {
  const cfg = configManager.get();
  const socket = getSocketStatus();
  let appVersion = '1.0.1';
  try {
    appVersion = require('./package.json').version;
  } catch {}
  res.json({
    ...cfg,
    port: cfg.port || PORT,
    printerName: CURRENT_PRINTER,
    socket,
    pdfViewerDetected: configManager.detectPdfViewer(),
    version: appVersion
  });
});

app.post('/api/config', express.json(), (req, res) => {
  try {
    const updates = req.body || {};
    const result = configManager.save(updates);
    if (!result.success) {
      return res.status(500).json({ status: 'error', message: result.error });
    }
    if (updates.printerName) {
      CURRENT_PRINTER = updates.printerName;
      console.log(`[CONFIG] Cập nhật CURRENT_PRINTER: ${CURRENT_PRINTER}`);
    }
    startMdns(configManager.get());
    if (updates.backendSocketUrl !== undefined || updates.backendSocketToken !== undefined || updates.backendSocketDeviceId !== undefined) {
      reconnectSocketIo();
    }
    res.json({ status: 'success', config: configManager.get(), currentPrinter: CURRENT_PRINTER });
  } catch (err) {
    res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

// Setup complete endpoint
app.post('/api/setup/complete', express.json(), (req, res) => {
  try {
    const data = req.body || {};
    const updates = {
      ...data,
      isConfigured: true
    };
    const result = configManager.save(updates);
    if (!result.success) {
      return res.status(500).json({ status: 'error', message: result.error });
    }
    if (updates.printerName) {
      CURRENT_PRINTER = updates.printerName;
    }
    startMdns(configManager.get());
    reconnectSocketIo();
    console.log(`[SETUP] Thiết lập ban đầu hoàn tất! Máy in: ${CURRENT_PRINTER}, mDNS: ${configManager.get('mdnsName')}`);
    res.json({ status: 'success', message: 'Thiết lập ban đầu hoàn tất', config: configManager.get() });
  } catch (err) {
    res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

// PDF engine detection & download
app.get('/api/pdf-engine/status', (req, res) => {
  const detected = configManager.detectPdfViewer();
  res.json({
    ...detected,
    currentConfigPath: configManager.get('pdfViewerPath')
  });
});

app.post('/api/pdf-engine/download', async (req, res) => {
  try {
    console.log('[PDF] Đang bắt đầu tải SumatraPDF Portable...');
    const targetPath = await configManager.downloadPortableSumatra();
    console.log(`[PDF] Đã tải thành công SumatraPDF Portable tại: ${targetPath}`);
    res.json({ status: 'success', path: targetPath, message: 'Đã tải thành công SumatraPDF Portable' });
  } catch (err) {
    console.error('[PDF] Tải SumatraPDF Portable lỗi:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Updater endpoints
let latestUpdaterStatus = {
  status: 'idle',
  message: 'Chưa kiểm tra cập nhật'
};

if (process.on) {
  process.on('message', (msg) => {
    if (msg && msg.type === 'updater-event' && msg.payload) {
      latestUpdaterStatus = msg.payload;
      console.log(`[UPDATER EVENT] ${latestUpdaterStatus.status}: ${latestUpdaterStatus.message || ''}`);
    }
  });
}

app.get('/api/update/status', (req, res) => {
  res.json(latestUpdaterStatus);
});

app.post('/api/update/check', (req, res) => {
  if (process.send) {
    process.send({ action: 'check-update' });
    latestUpdaterStatus = { status: 'checking', message: 'Đang kiểm tra cập nhật...' };
    res.json({ status: 'sent', message: 'Đang kiểm tra cập nhật...' });
  } else {
    res.json({ status: 'standalone', message: 'Server đang chạy độc lập không qua Electron' });
  }
});

app.post('/api/update/download', (req, res) => {
  if (process.send) {
    process.send({ action: 'download-update' });
    latestUpdaterStatus = { status: 'downloading', percent: 0, message: 'Đang bắt đầu tải...' };
    res.json({ status: 'sent', message: 'Bắt đầu tải bản cập nhật' });
  } else {
    res.json({ status: 'standalone', message: 'Server đang chạy độc lập không qua Electron' });
  }
});

app.post('/api/update/install', (req, res) => {
  if (process.send) {
    process.send({ action: 'install-update' });
    res.json({ status: 'sent', message: 'Đang khởi động lại để cài đặt...' });
  } else {
    res.json({ status: 'standalone', message: 'Server đang chạy độc lập không qua Electron' });
  }
});

// Print test endpoint
app.post('/api/print-test', express.json(), async (req, res) => {
  try {
    const printerName = sanitizePrinterName(req.body && req.body.printerName) || CURRENT_PRINTER;
    if (!printerName) {
      return res.status(400).json({ status: 'error', message: 'Chưa chọn máy in để in thử' });
    }
    const nowStr = new Date().toLocaleString('vi-VN');
    const tspl = [
      'SIZE 100 mm, 50 mm',
      'GAP 2 mm, 0',
      'CLS',
      'DIRECTION 1',
      'TEXT 50,30,"TSS24.BF2",0,2,2,"VIVU PRINTER"',
      'TEXT 50,90,"TSS24.BF2",0,1,1,"KET NOI MAY IN THANH CONG"',
      `TEXT 50,130,"TSS24.BF2",0,1,1,"May in: ${printerName}"`,
      `TEXT 50,170,"TSS24.BF2",0,1,1,"Thoi gian: ${nowStr}"`,
      'PRINT 1'
    ].join('\r\n');

    const result = await sendToPrinterRaw(tspl, printerName);
    res.json({ status: 'success', message: 'Đã gửi lệnh in thử tới máy in!', result });
  } catch (err) {
    res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

// Reconnect socket backend
app.post('/socket/reconnect', (req, res) => {
  const url = getSocketServerUrl();
  if (!url) {
    return res.json({ status: 'error', message: 'Chưa cấu hình Backend Socket URL' });
  }
  try {
    reconnectSocketIo();
    res.json({ status: 'success', message: 'Đang kết nối lại...' });
  } catch (err) {
    res.json({ status: 'error', message: String(err.message || err) });
  }
});

function getExeCommandForStartup() {
  const exe = process.execPath;
  const workDir = path.dirname(exe);
  const ps = `powershell -WindowStyle Hidden -NoProfile -Command \"Start-Process -WindowStyle Hidden -FilePath '${exe.replace(/'/g, "''")}' -WorkingDirectory '${workDir.replace(/'/g, "''")}'\"`;
  return ps;
}

async function installStartupTask() {
  const cmd = `schtasks /Create /SC ONLOGON /TN "${STARTUP_TASK_NAME}" /TR "${getExeCommandForStartup().replace(/"/g, '\\"')}" /RL LIMITED /F`;
  return tryExec(cmd);
}

async function uninstallStartupTask() {
  const cmd = `schtasks /Delete /TN "${STARTUP_TASK_NAME}" /F`;
  return tryExec(cmd);
}

async function checkStartupTask() {
  try {
    const out = await tryExec(`schtasks /Query /TN "${STARTUP_TASK_NAME}"`);
    const ok = /Ready|Running|Disabled/i.test(out.stdout || '') || /TaskName/i.test(out.stdout || '');
    return { exists: ok, detail: out.stdout };
  } catch (e) {
    return { exists: false, detail: String(e.message || e) };
  }
}

function getRunKeyPath() {
  return `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`;
}

async function installStartupRegistry() {
  const cmd = getExeCommandForStartup();
  const regCmd = `reg add "${getRunKeyPath()}" /v "${STARTUP_TASK_NAME}" /t REG_SZ /d "${cmd.replace(/"/g, '\\"')}" /f`;
  return tryExec(regCmd);
}

async function uninstallStartupRegistry() {
  const regCmd = `reg delete "${getRunKeyPath()}" /v "${STARTUP_TASK_NAME}" /f`;
  return tryExec(regCmd);
}

async function checkStartupRegistry() {
  try {
    const out = await tryExec(`reg query "${getRunKeyPath()}" /v "${STARTUP_TASK_NAME}"`);
    const ok = new RegExp(`\\s${STARTUP_TASK_NAME}\\s`).test(out.stdout || '');
    return { exists: ok, detail: out.stdout };
  } catch (e) {
    return { exists: false, detail: String(e.message || e) };
  }
}

function getStartupFolder() {
  const appData = process.env.APPDATA || '';
  if (!appData) return '';
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function getShortcutPath() {
  return path.join(getStartupFolder(), `${STARTUP_TASK_NAME}.lnk`);
}

async function installStartupShortcut() {
  const exe = process.execPath.replace(/'/g, "''");
  const workDir = path.dirname(process.execPath).replace(/'/g, "''");
  const lnk = getShortcutPath().replace(/'/g, "''");
  const ps = [
    "$w = New-Object -ComObject WScript.Shell",
    `$s = $w.CreateShortcut('${lnk}')`,
    `$s.TargetPath = '${exe}'`,
    `$s.WorkingDirectory = '${workDir}'`,
    "$s.WindowStyle = 7",
    "$s.IconLocation = $s.TargetPath",
    "$s.Save()"
  ].join('; ');
  const cmd = `powershell -NoProfile -WindowStyle Hidden -Command "${ps}"`;
  return tryExec(cmd);
}

async function uninstallStartupShortcut() {
  const lnk = getShortcutPath();
  if (fs.existsSync(lnk)) {
    try { fs.unlinkSync(lnk); } catch {}
    return { stdout: '', stderr: '' };
  }
  return { stdout: '', stderr: '' };
}

async function checkStartupShortcut() {
  const lnk = getShortcutPath();
  return { exists: fs.existsSync(lnk), detail: lnk };
}

app.get('/startup/status', async (req, res) => {
  const t = await checkStartupTask();
  const r = await checkStartupRegistry();
  const s = await checkStartupShortcut();
  res.json({ status: 'success', name: STARTUP_TASK_NAME, task: t.exists, registry: r.exists, shortcut: s.exists });
});

app.post('/startup/install', async (req, res) => {
  try {
    try {
      const r1 = await installStartupTask();
      return res.json({ status: 'success', method: 'task', name: STARTUP_TASK_NAME, stdout: r1.stdout, stderr: r1.stderr });
    } catch (e1) {
      try {
        const r2 = await installStartupRegistry();
        return res.json({ status: 'success', method: 'registry', name: STARTUP_TASK_NAME, stdout: r2.stdout, stderr: r2.stderr });
      } catch (e2) {
        const r3 = await installStartupShortcut();
        return res.json({ status: 'success', method: 'shortcut', name: STARTUP_TASK_NAME, stdout: r3.stdout, stderr: r3.stderr });
      }
    }
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/startup/uninstall', async (req, res) => {
  try {
    try { await uninstallStartupTask(); } catch {}
    try { await uninstallStartupRegistry(); } catch {}
    try { await uninstallStartupShortcut(); } catch {}
    res.json({ status: 'success', name: STARTUP_TASK_NAME });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ── Khởi động server ────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`Print Server chạy tại http://localhost:${PORT}/`);
  console.log(`Printer name: "${CURRENT_PRINTER}" (có thể đổi qua .env hoặc /printer)`);
  detectPrinters()
    .then((list) => {
      const def = list.find((p) => p.default);
      if (def && !CURRENT_PRINTER) {
        CURRENT_PRINTER = def.name;
        console.log(`[CONFIG] Auto chọn máy in mặc định: ${CURRENT_PRINTER}`);
      } else {
        const names = list.map((p) => p.name).join(', ');
        console.log(`[INFO] Máy in khả dụng: ${names || '(không phát hiện được)'}`);
      }
    })
    .catch(() => {});
  startUdpBroadcast();
  startMdns(configManager.get());
  startSocketClient();
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[SERVER] Cổng ${PORT} đã bị ứng dụng khác chiếm giữ!`);
    const nextPort = PORT + 1;
    console.log(`[SERVER] Đang thử khởi động lại tại cổng dự phòng: ${nextPort}...`);
    configManager.save({ port: nextPort });
    try {
      const fallbackServer = app.listen(nextPort, () => {
        PORT = nextPort;
        console.log(`Print Server chạy thành công tại cổng dự phòng http://localhost:${PORT}/`);
        if (process.send) {
          process.send({ type: 'port-changed', port: nextPort });
        }
        startUdpBroadcast();
        startMdns(configManager.get());
        startSocketClient();
      });
      fallbackServer.on('error', (err2) => {
        console.error(`[SERVER] Cổng dự phòng ${nextPort} cũng bị chiếm hoặc lỗi: ${err2.message}`);
        process.exit(1);
      });
      return;
    } catch (errFallback) {
      console.error(`[SERVER] Không thể mở cổng dự phòng: ${errFallback.message}`);
      process.exit(1);
    }
  }
  console.error(`[SERVER] Lỗi khởi động server: ${e.message}`);
  process.exit(1);
});
