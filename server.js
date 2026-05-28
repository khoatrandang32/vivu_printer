// NodeJS Print Server cho HPRT N43 (TSPL) trên Windows
// Yêu cầu: CommonJS, Express, không dùng native module phức tạp, gửi RAW qua lệnh Windows (print/copy)

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { exec } = require('child_process');
const crypto = require('crypto');
const dgram = require('dgram');
const { io } = require('socket.io-client');
const { printReturnToWorkshopSlip } = require('./returnSlipPrint');

// Cấu hình
const PORT = parseInt(process.env.PORT || '3000', 10);
const PRINTER_NAME = process.env.PRINTER_NAME || 'HPRT N43';
let CURRENT_PRINTER = PRINTER_NAME;
const PDF_VIEWER_PATH = process.env.PDF_VIEWER_PATH || '';
const SAVE_PDF_DIR = process.env.SAVE_PDF_DIR || '';
const LABEL_WIDTH_MM = parseInt(process.env.LABEL_WIDTH_MM || '100', 10);
const LABEL_HEIGHT_MM = parseInt(process.env.LABEL_HEIGHT_MM || '150', 10);
const PRINT_FIT = (process.env.PRINT_FIT || 'fit').toLowerCase(); // fit | noscale | shrink
const PRINT_ORIENTATION = (process.env.PRINT_ORIENTATION || 'portrait').toLowerCase(); // portrait | landscape
const PRINT_PADDING_MM = parseInt(process.env.PRINT_PADDING_MM || '0', 10);
const DISCOVERY_ENABLE = String(process.env.DISCOVERY_ENABLE || '1') !== '0';
const DISCOVERY_PORT = parseInt(process.env.DISCOVERY_PORT || '4210', 10);
const DISCOVERY_ADDR = process.env.DISCOVERY_ADDR || '255.255.255.255';
const DISCOVERY_INTERVAL_MS = parseInt(process.env.DISCOVERY_INTERVAL_MS || '2000', 10);
const STARTUP_TASK_NAME = process.env.STARTUP_TASK_NAME || 'VivuPrinter';
const SOCKET_SERVER_URL = String(process.env.BACKEND_SOCKET_URL || process.env.WS_SERVER_URL || '').trim();
const SOCKET_AUTH_TOKEN = String(process.env.BACKEND_SOCKET_TOKEN || process.env.WS_AUTH_TOKEN || '').trim();
const SOCKET_DEVICE_ID = String(process.env.BACKEND_SOCKET_DEVICE_ID || process.env.WS_DEVICE_ID || '').trim();
const SOCKET_RECONNECT_MS = parseInt(process.env.BACKEND_SOCKET_RECONNECT_MS || process.env.WS_RECONNECT_MS || '1000', 10);

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

// Express app
const app = express();
// Nhận TSPL dạng text/plain
app.use(express.text({ type: 'text/plain', limit: '1mb' }));
// Nhận JSON cho /print-json
app.use(express.json({ limit: '1mb' }));
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

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
  const parts = [];
  const w = Math.max(10, Math.min(300, LABEL_WIDTH_MM || 100));
  const h = Math.max(10, Math.min(300, LABEL_HEIGHT_MM || 150));
  parts.push(`paper=${w}x${h}mm`);
  if (PRINT_ORIENTATION === 'landscape' || PRINT_ORIENTATION === 'portrait') {
    parts.push(PRINT_ORIENTATION);
  }
  if (PRINT_PADDING_MM > 0) {
    const pad = Math.max(0, Math.min(50, PRINT_PADDING_MM));
    const availW = Math.max(1, w - 2 * pad);
    const availH = Math.max(1, h - 2 * pad);
    const sx = availW / w;
    const sy = availH / h;
    const scalePercent = Math.max(10, Math.min(100, Math.floor(Math.min(sx, sy) * 100)));
    parts.push('center');
    parts.push(`scale=${scalePercent}`);
  } else {
    if (['fit', 'noscale', 'shrink'].includes(PRINT_FIT)) {
      parts.push(PRINT_FIT);
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
  if (SOCKET_DEVICE_ID) return SOCKET_DEVICE_ID;
  return `${os.hostname()}-${PORT}`.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function getSocketStatus() {
  return {
    enabled: !!SOCKET_SERVER_URL,
    url: SOCKET_SERVER_URL || null,
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

function normalizeTrackingOrders(input) {
  let list = [];
  if (Array.isArray(input)) {
    list = input;
  } else if (typeof input === 'string') {
    list = input.split(/[\n,]+/);
  } else if (input && typeof input === 'object') {
    if (Array.isArray(input.tracking_orders)) list = input.tracking_orders;
    else if (Array.isArray(input.trackingOrders)) list = input.trackingOrders;
    else if (Array.isArray(input.orders)) list = input.orders;
    else if (typeof input.tracking_order === 'string') list = [input.tracking_order];
    else if (typeof input.trackingOrder === 'string') list = [input.trackingOrder];
    else if (typeof input.order_code === 'string') list = [input.order_code];
    else if (typeof input.orderCode === 'string') list = [input.orderCode];
    else if (typeof input.code === 'string') list = [input.code];
    else if (typeof input.message === 'string') list = input.message.split(/[\n,]+/);
    else if (input.data) return normalizeTrackingOrders(input.data);
  }
  return list.map((value) => String(value || '').trim()).filter(Boolean);
}

function buildSocketHelloPayload() {
  return {
    type: 'register_local_printer',
    deviceId: getSocketDeviceId(),
    hostname: os.hostname(),
    ip: getLocalIPv4(),
    port: PORT,
    printerName: CURRENT_PRINTER,
    capabilities: ['print_ghtk_label', 'print_viettelpost', 'print_return_to_workshop_slip'],
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
      const result = await printReturnToWorkshopSlip(slip, {
        renderDocumentToPdf: (docPath) => {
          const fileUrl = 'file:///' + String(docPath).replace(/\\/g, '/');
          return renderUrlToPdf(fileUrl);
        },
        sendToPrinterPdf,
        printerName: CURRENT_PRINTER,
      });
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

  // ── Xử lý lệnh in GHTK (tracking orders) ──
  const trackingOrders = normalizeTrackingOrders(payload);
  const canPrint = trackingOrders.length > 0 && (!messageType || ['print_ghtk_label', 'ghtk_print', 'print_label', 'print'].includes(messageType));
  if (!canPrint) {
    console.log(`[SOCKET] ✘ Bỏ qua gateway_command không hỗ trợ (type="${messageType}"): ${JSON.stringify(payload).slice(0, 300)}`);
    return;
  }
  const requestId = payload && typeof payload === 'object'
    ? String(payload.requestId || payload.request_id || payload.id || crypto.randomUUID())
    : crypto.randomUUID();
  console.log(`[SOCKET][GHTK] ▶ Bắt đầu in ${trackingOrders.length} mã GHTK | requestId=${requestId}`);
  trackingOrders.forEach((code, i) => console.log(`[SOCKET][GHTK]   [${i + 1}/${trackingOrders.length}] ${code}`));
  emitSocketEvent('gateway_command_ack', {
    type: 'print_ack',
    requestId,
    deviceId: getSocketDeviceId(),
    status: 'received',
    trackingOrders,
    ts: Date.now()
  });
  try {
    const results = await printGhtkLabels(trackingOrders, `ws:${requestId}`);
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
  if (!SOCKET_SERVER_URL) return;
  if (socketClient) return;
  console.log(`[SOCKET] Đang kết nối tới ${SOCKET_SERVER_URL}`);
  socketClient = io(SOCKET_SERVER_URL, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: Math.max(1000, SOCKET_RECONNECT_MS),
    timeout: 20000,
    auth: {
      token: SOCKET_AUTH_TOKEN || undefined,
      deviceId: getSocketDeviceId()
    },
    extraHeaders: {
      'x-device-id': getSocketDeviceId(),
      Authorization: SOCKET_AUTH_TOKEN ? `Bearer ${SOCKET_AUTH_TOKEN}` : ''
    },
    query: {
      deviceId: getSocketDeviceId()
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
  socketClient.on('ping', () => {
    socketLastMessageAt = Date.now();
    console.log('[SOCKET] ← Nhận ping từ server');
  });
}

function startSocketClient() {
  if (!SOCKET_SERVER_URL) {
    console.log('[SOCKET] Chưa cấu hình BACKEND_SOCKET_URL, bỏ qua kết nối backend');
    return;
  }
  connectSocketIo();
}

function startUdpBroadcast() {
  if (!DISCOVERY_ENABLE) return;
  const sock = dgram.createSocket('udp4');
  sock.bind(0, '0.0.0.0', () => {
    try { sock.setBroadcast(true); } catch {}
    setInterval(() => {
      const payload = {
        ip: getLocalIPv4(),
        port: PORT,
        printerName: CURRENT_PRINTER,
        ts: Date.now()
      };
      const buf = Buffer.from(JSON.stringify(payload));
      try { sock.send(buf, 0, buf.length, DISCOVERY_PORT, DISCOVERY_ADDR); } catch {}
    }, Math.max(500, DISCOVERY_INTERVAL_MS));
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

  if (PDF_VIEWER_PATH && fs.existsSync(PDF_VIEWER_PATH)) {
    const viewer = `"${PDF_VIEWER_PATH}"`;
    try {
      if (/sumatra/i.test(PDF_VIEWER_PATH)) {
        let settings;
        if (paperSize === 'a5') {
          const orient = 'portrait';
          settings = `paper=148x210mm, ${orient}, fit`;
        } else if (paperSize === 'a4') {
          settings = `paper=210x297mm, portrait, fit`;
        } else {
          settings = buildSumatraPrintSettings();
        }
        // -exit-when-done đảm bảo SumatraPDF thoát sau khi in xong (blocking)
        const cmd = `${viewer} -print-to ${quotedPrinter} -print-settings "${settings}" -silent -exit-when-done ${quotedFile}`;
        console.log(`[PDF] SumatraPDF cmd: ${cmd}`);
        const out = await tryExec(cmd);
        console.log(`[PDF] SumatraPDF stdout: ${out.stdout || '(trống)'} | stderr: ${out.stderr || '(trống)'}`);
        // File đã được in xong (SumatraPDF đã exit), xóa sau 5 giây là đủ
        if (!keepFile) scheduleTempDelete(normalizedPath, 5000);
        return { method: 'SumatraPDF', target: name, file: normalizedPath, command: cmd, stdout: out.stdout, stderr: out.stderr };
      }
      if (/acrord32|acrobat/i.test(PDF_VIEWER_PATH)) {
        const cmd = `${viewer} /t ${quotedFile} ${quotedPrinter} "" ""`;
        const out = await tryExec(cmd);
        if (!keepFile) scheduleTempDelete(normalizedPath, 60000);
        return { method: 'Acrobat', target: name, file: normalizedPath, command: cmd, stdout: out.stdout, stderr: out.stderr };
      }
    } catch (e) {
      throw new Error(`Không thể in PDF qua viewer tùy chỉnh (${PDF_VIEWER_PATH}). ${e.message}`);
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

function fetchGhtkPdf(tracking, token, clientSource) {
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
        const buf = Buffer.concat(chunks);
        if (res.statusCode === 200 && ctype.includes('application/pdf')) {
          try {
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

async function printGhtkLabels(input, source) {
  const token = process.env.GHTK_API_TOKEN;
  const clientSource = process.env.GHTK_CLIENT_SOURCE || '';
  if (!token) throw new Error('Thiếu GHTK_API_TOKEN trong .env');
  if (!clientSource) throw new Error('Thiếu GHTK_CLIENT_SOURCE trong .env');
  const list = normalizeTrackingOrders(input);
  if (!list.length) throw new Error('Thiếu danh sách TRACKING_ORDER');
  const results = [];
  for (const code of list) {
    try {
      console.log(`[GHTK] Bắt đầu in ${code} từ ${source}`);
      const { filePath, persisted } = await fetchGhtkPdf(code, token, clientSource);
      const printResult = await sendToPrinterPdf(filePath, CURRENT_PRINTER, { keepFile: persisted });
      results.push({ tracking: code, status: 'success', savedPath: persisted ? filePath : null, result: printResult });
      console.log(`[GHTK] In thành công ${code} từ ${source}`);
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
  const candidates = [
    // Microsoft Edge (thường có sẵn trên Windows 10/11)
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // Google Chrome
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    // Chromium
    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
  ];
  // Kiểm tra biến môi trường
  const envBrowser = String(process.env.HEADLESS_BROWSER_PATH || '').trim();
  if (envBrowser) candidates.unshift(envBrowser);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Dùng Edge/Chrome headless để render URL thành PDF (A5 portrait)
 * Trả về filePath của PDF tạm
 */
function renderUrlToPdf(url) {
  return new Promise((resolve, reject) => {
    const browserPath = findHeadlessBrowser();
    if (!browserPath) {
      return reject(new Error(
        'Không tìm thấy trình duyệt Chromium/Edge/Chrome để render URL. ' +
        'Cài Microsoft Edge hoặc Google Chrome, hoặc thiết lập HEADLESS_BROWSER_PATH trong .env'
      ));
    }

    // Tạo thư mục temp riêng, dùng tên ngắn để tránh long-path issues
    const tmpDir = path.join(os.tmpdir(), `vtp${Date.now()}`);
    const pdfPath = path.join(tmpDir, 'out.pdf');

    try {
      fs.mkdirSync(tmpDir, { recursive: true });
    } catch (e) {
      return reject(new Error(`Không tạo được thư mục temp: ${e.message}`));
    }

    // A5 portrait: 148x210mm → inches: 5.827 x 8.268
    const args = [
      '--headless',           // dùng --headless (legacy) thay vì --headless=new để tương thích rộng hơn
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
      '--run-all-compositor-stages-before-draw',
      '--virtual-time-budget=10000',
      `--print-to-pdf=${pdfPath}`,
      '--print-to-pdf-no-header',
      '--no-pdf-header-footer',
      '--paper-width=5.827',
      '--paper-height=8.268',
      '--margin-top=0.4',
      '--margin-bottom=0.4',
      '--margin-left=0.4',
      '--margin-right=0.4',
      url
    ];

    const { spawn } = require('child_process');
    console.log(`[VTP] Render URL: ${url}`);
    console.log(`[VTP] Browser: ${browserPath}`);
    console.log(`[VTP] Output PDF: ${pdfPath}`);
    console.log(`[VTP] Args: ${args.join(' ')}`);

    const child = spawn(browserPath, args, {
      windowsHide: true,
      cwd: tmpDir,   // đặt cwd = tmpDir để Edge ghi output.pdf vào đây nếu bỏ qua path
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    let stdout = '';
    child.stdout && child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr && child.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timeout render URL "${url}" sau 30 giây`));
    }, 30000);

    child.on('close', (code) => {
      clearTimeout(timer);
      console.log(`[VTP] Edge exit code: ${code}`);
      if (stderr) console.log(`[VTP] Edge stderr: ${stderr.slice(0, 500)}`);
      if (stdout) console.log(`[VTP] Edge stdout: ${stdout.slice(0, 200)}`);

      // Đợi 800ms để OS flush file xuống disk
      setTimeout(() => {
        // Tìm PDF theo thứ tự ưu tiên:
        // 1. Path chỉ định (out.pdf trong tmpDir)
        // 2. Bất kỳ .pdf nào trong tmpDir (Edge đôi khi đặt tên khác)
        // 3. output.pdf trong thư mục home user (Edge legacy behavior)
        const searchPaths = [
          pdfPath,
          path.join(tmpDir, 'output.pdf'),
          path.join(os.homedir(), 'out.pdf'),
          path.join(os.homedir(), 'output.pdf'),
          path.join(process.cwd(), 'out.pdf'),
          path.join(process.cwd(), 'output.pdf'),
        ];

        let foundPath = null;

        // Tìm trong searchPaths
        for (const p of searchPaths) {
          if (fs.existsSync(p)) { foundPath = p; break; }
        }

        // Tìm bất kỳ .pdf nào trong tmpDir
        if (!foundPath) {
          try {
            const files = fs.readdirSync(tmpDir).filter(f => f.toLowerCase().endsWith('.pdf'));
            if (files.length > 0) foundPath = path.join(tmpDir, files[0]);
          } catch {}
        }

        if (!foundPath) {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
          const errDetail = [
            stderr ? `stderr: ${stderr.slice(0, 300)}` : '',
            `exit code ${code}`,
            `tmpDir contents: ${(() => { try { return fs.readdirSync(tmpDir).join(', ') || '(trống)'; } catch { return '(không đọc được)'; } })()}`
          ].filter(Boolean).join(' | ');
          return reject(new Error(`Không tạo được PDF từ URL "${url}". ${errDetail}`));
        }

        // Kiểm tra file có nội dung không (> 100 bytes)
        try {
          const stat = fs.statSync(foundPath);
          if (stat.size < 100) {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
            return reject(new Error(`PDF tạo ra bị rỗng (${stat.size} bytes) từ URL "${url}"`));
          }
          console.log(`[VTP] PDF tạo thành công: ${foundPath} (${stat.size} bytes)`);
        } catch (e) {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
          return reject(new Error(`Không đọc được file PDF: ${e.message}`));
        }

        resolve(foundPath);
      }, 800);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      reject(new Error(`Không thể khởi động browser: ${err.message}`));
    });
  });
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
      const printResult = await sendToPrinterPdf(pdfPath, CURRENT_PRINTER, { keepFile: true, paperSize: 'a5' });
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
    const result = await printReturnToWorkshopSlip(slip, {
      renderDocumentToPdf: (docPath) => {
        const fileUrl = 'file:///' + String(docPath).replace(/\\/g, '/');
        return renderUrlToPdf(fileUrl);
      },
      sendToPrinterPdf,
      printerName: CURRENT_PRINTER,
    });
    return res.json({ status: 'success', result });
  } catch (err) {
    console.error('[API /print-return-to-workshop-slip] Error:', err);
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
    console.log(`[CONFIG] Chọn máy in: ${CURRENT_PRINTER}`);
    return res.json({ status: 'success', currentPrinter: CURRENT_PRINTER });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/config', (req, res) => {
  const socket = getSocketStatus();
  res.json({ port: PORT, printerName: CURRENT_PRINTER, socket, websocket: socket });
});

// Khởi động server
app.listen(PORT, () => {
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
  startSocketClient();
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
