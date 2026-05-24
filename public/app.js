async function fetchConfig() {
  try {
    const res = await fetch('/config');
    const data = await res.json();
    const el = document.getElementById('config');
    el.textContent = `(${data.printerName} • http://localhost:${data.port})`;
  } catch {}
}

async function loadPrinters() {
  const sel = document.getElementById('printerSelect');
  const statusEl = document.getElementById('printerStatus');
  statusEl.textContent = 'Đang tải danh sách máy in...';
  try {
    const res = await fetch('/printers');
    const data = await res.json();
    const { printers = [], currentPrinter, error, logs = [] } = data;
    sel.innerHTML = '';
    for (const p of printers) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name + (p.default ? ' (mặc định)' : '');
      if (p.name === currentPrinter) opt.selected = true;
      sel.appendChild(opt);
    }
    if (error) statusEl.textContent = `Lỗi: ${error}`;
    const errLog = logs.find(l => l && l.error);
    if (errLog) {
      statusEl.textContent = `Lỗi: ${errLog.method} - ${errLog.error}${errLog.detail ? ' - ' + errLog.detail : ''}`;
    }
    if (!errLog && !error) {
      statusEl.textContent = printers.length ? `Đã tải ${printers.length} máy in` : 'Không phát hiện máy in';
    }
  } catch (e) {
    statusEl.textContent = 'Lỗi tải máy in';
  }
}

async function setPrinter(name) {
  const statusEl = document.getElementById('printerStatus');
  statusEl.textContent = 'Đang chọn...';
  try {
    const res = await fetch('/printer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (data.status === 'success') {
      statusEl.textContent = `Đã chọn: ${data.currentPrinter}`;
      fetchConfig();
    } else {
      statusEl.textContent = data.message || 'Không thể chọn máy in';
    }
  } catch (e) {
    statusEl.textContent = 'Lỗi chọn máy in';
  }
}

async function printPdf() {
  const fileInput = document.getElementById('pdfFile');
  const statusEl = document.getElementById('statusPdf');
  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    statusEl.textContent = 'Chưa chọn file PDF';
    return;
  }
  statusEl.textContent = 'Đang gửi PDF...';
  try {
    const res = await fetch('/print-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: await file.arrayBuffer()
    });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await res.json();
      statusEl.textContent = JSON.stringify(data);
    } else {
      const text = await res.text();
      statusEl.textContent = text;
    }
  } catch (e) {
    statusEl.textContent = e.message || String(e);
  }
}

async function printTspl() {
  const btn = document.getElementById('btnPrintTspl');
  const statusEl = document.getElementById('statusTspl');
  const tspl = document.getElementById('tspl').value;
  btn.disabled = true;
  statusEl.textContent = 'Đang gửi...';
  try {
    const res = await fetch('/print', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: tspl
    });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await res.json();
      statusEl.textContent = JSON.stringify(data);
    } else {
      const text = await res.text();
      statusEl.textContent = text;
    }
  } catch (e) {
    statusEl.textContent = e.message || String(e);
  } finally {
    btn.disabled = false;
  }
}

async function debugPrintTspl() {
  const btn = document.getElementById('btnDebugTspl');
  const statusEl = document.getElementById('statusTspl');
  const tspl = document.getElementById('tspl').value;
  btn.disabled = true;
  statusEl.textContent = 'Đang thử in trực tiếp...';
  try {
    const res = await fetch('/print-debug', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: tspl
    });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await res.json();
      statusEl.textContent = JSON.stringify(data);
    } else {
      const text = await res.text();
      statusEl.textContent = text;
    }
  } catch (e) {
    statusEl.textContent = e.message || String(e);
  } finally {
    btn.disabled = false;
  }
}

async function printJson() {
  const btn = document.getElementById('btnPrintJson');
  const statusEl = document.getElementById('statusJson');
  const size = document.getElementById('sizeSelect').value;
  const title = document.getElementById('titleInput').value;
  const qr = document.getElementById('qrInput').value;
  const totalRaw = document.getElementById('totalInput').value;
  const total = totalRaw ? Number(totalRaw) : undefined;
  let items = [];
  try {
    items = JSON.parse(document.getElementById('itemsJson').value || '[]');
  } catch (e) {
    statusEl.textContent = 'JSON sản phẩm không hợp lệ';
    return;
  }
  const payload = { size, title, items, total, qr };
  btn.disabled = true;
  statusEl.textContent = 'Đang gửi...';
  try {
    const res = await fetch('/print-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    statusEl.textContent = JSON.stringify(data);
  } catch (e) {
    statusEl.textContent = e.message || String(e);
  } finally {
    btn.disabled = false;
  }
}
async function printGhtk() {
  const ta = document.getElementById('ghtkList');
  const statusEl = document.getElementById('statusGhtk');
  const raw = ta.value || '';
  const list = raw
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (!list.length) {
    statusEl.textContent = 'Chưa nhập TRACKING_ORDER';
    return;
  }
  statusEl.textContent = 'Đang gửi...';
  try {
    const res = await fetch('/print-ghtk-label', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracking_orders: list })
    });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await res.json();
      statusEl.textContent = JSON.stringify(data);
    } else {
      const text = await res.text();
      statusEl.textContent = text;
    }
  } catch (e) {
    statusEl.textContent = e.message || String(e);
  }
}

async function printVtp() {
  const ta = document.getElementById('vtpList');
  const statusEl = document.getElementById('statusVtp');
  const raw = ta.value || '';
  const urls = raw
    .split(/\n+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (!urls.length) {
    statusEl.textContent = 'Chưa nhập URL';
    return;
  }
  statusEl.textContent = `Đang gửi ${urls.length} URL...`;
  try {
    const res = await fetch('/print-viettelpost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls })
    });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await res.json();
      const ok = (data.results || []).filter(r => r.status === 'success').length;
      const fail = (data.results || []).filter(r => r.status === 'error').length;
      statusEl.textContent = `Thành công: ${ok}, Lỗi: ${fail} | ${JSON.stringify(data)}`;
    } else {
      const text = await res.text();
      statusEl.textContent = text;
    }
  } catch (e) {
    statusEl.textContent = e.message || String(e);
  }
}


function bindEvents() {
  document.getElementById('btnPrintTspl').addEventListener('click', printTspl);
  document.getElementById('btnClearTspl').addEventListener('click', () => {
    document.getElementById('tspl').value = '';
  });
  document.getElementById('btnDebugTspl').addEventListener('click', debugPrintTspl);
  document.getElementById('btnPrintJson').addEventListener('click', printJson);
  document.getElementById('btnClearJson').addEventListener('click', () => {
    document.getElementById('itemsJson').value = '';
    document.getElementById('totalInput').value = '';
    document.getElementById('titleInput').value = '';
    document.getElementById('qrInput').value = '';
    document.getElementById('statusJson').textContent = '';
  });
  document.getElementById('printerSelect').addEventListener('change', (e) => {
    const name = e.target.value;
    setPrinter(name);
  });
  document.getElementById('btnRefreshPrinters').addEventListener('click', () => {
    loadPrinters();
  });
  document.getElementById('btnPrintPdf').addEventListener('click', printPdf);
  document.getElementById('btnPrintGhtk').addEventListener('click', printGhtk);
  document.getElementById('btnPrintVtp').addEventListener('click', printVtp);
}

bindEvents();
fetchConfig();
loadPrinters();
