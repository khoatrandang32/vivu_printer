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

  // Settings modal controls
  const btnSettings = document.getElementById('btnSettings');
  const btnCloseSettings = document.getElementById('btnCloseSettings');
  const settingsModal = document.getElementById('settingsModal');
  const btnLoadEnv = document.getElementById('btnLoadEnv');
  const btnSaveEnv = document.getElementById('btnSaveEnv');
  const btnAddEnvVar = document.getElementById('btnAddEnvVar');
  const envList = document.getElementById('envList');
  const envRowTemplate = document.getElementById('envRowTemplate');
  const envStatus = document.getElementById('envStatus');
  const btnRenderPreview = document.getElementById('btnRenderPreview');
  const btnOpenPreviewWindow = document.getElementById('btnOpenPreviewWindow');
  const slipJsonEl = document.getElementById('slipJson');
  const previewIframe = document.getElementById('previewIframe');
  const previewStatus = document.getElementById('previewStatus');
  const fontScale = document.getElementById('fontScale');
  const fontScaleLabel = document.getElementById('fontScaleLabel');
  const shipLabelJson = document.getElementById('shipLabelJson');
  const shipPreviewIframe = document.getElementById('shipPreviewIframe');
  const shipPreviewStatus = document.getElementById('shipPreviewStatus');
  const shipFontScale = document.getElementById('shipFontScale');
  const shipFontScaleLabel = document.getElementById('shipFontScaleLabel');
  const btnRenderShipPreview = document.getElementById('btnRenderShipPreview');
  const btnOpenShipPreviewWindow = document.getElementById('btnOpenShipPreviewWindow');

  function showSettings() {
    if (settingsModal) {
      settingsModal.style.display = 'flex';
      // load env content when opening
      loadEnv().catch(() => {});
    }
  }
  function hideSettings() {
    if (settingsModal) settingsModal.style.display = 'none';
  }

  function createEnvRow(key = '', value = '', masked = true) {
    const node = envRowTemplate.cloneNode(true);
    node.style.display = 'flex';
    node.removeAttribute('id');
    const inputKey = node.querySelector('.envKey');
    const inputVal = node.querySelector('.envValue');
    const btnToggle = node.querySelector('.envToggleValue');
    const btnRemove = node.querySelector('.envRemove');

    inputKey.value = key || '';
    inputVal.value = value || '';
    inputVal.type = masked ? 'password' : 'text';
    btnToggle.textContent = masked ? 'Hiện' : 'Ẩn';

    btnToggle.addEventListener('click', () => {
      const isMasked = inputVal.type === 'password';
      inputVal.type = isMasked ? 'text' : 'password';
      btnToggle.textContent = isMasked ? 'Ẩn' : 'Hiện';
    });

    btnRemove.addEventListener('click', () => {
      node.remove();
    });

    return node;
  }

  function clearEnvList() {
    if (envList) envList.innerHTML = '';
  }

  async function loadEnv() {
    if (!envList || !envStatus) return;
    envStatus.textContent = 'Đang tải...';
    try {
      const res = await fetch('/settings/env');
      const data = await res.json();
      const content = data.content || '';
      clearEnvList();
      const lines = content.split(/\r?\n/);
      for (const ln of lines) {
        if (!ln) continue;
        const idx = ln.indexOf('=');
        if (idx > -1) {
          const k = ln.slice(0, idx);
          const v = ln.slice(idx + 1);
          envList.appendChild(createEnvRow(k, v, true));
        } else {
          envList.appendChild(createEnvRow(ln, '', true));
        }
      }
      envStatus.textContent = 'Đã tải';
      setTimeout(() => { envStatus.textContent = ''; }, 1500);
    } catch (e) {
      envStatus.textContent = 'Lỗi tải .env';
      setTimeout(() => { envStatus.textContent = ''; }, 1500);
    }
  }

  async function saveEnv() {
    if (!envList || !envStatus) return;
    envStatus.textContent = 'Đang lưu...';
    try {
      const rows = Array.from(envList.children);
      const lines = rows.map((r) => {
        const kEl = r.querySelector('.envKey');
        const vEl = r.querySelector('.envValue');
        if (!kEl) return null;
        const k = String(kEl.value || '').trim();
        const v = String(vEl ? vEl.value : '');
        if (!k) return null;
        return `${k}=${v}`;
      }).filter(Boolean).join('\n');
      const res = await fetch('/settings/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: lines })
      });
      const data = await res.json();
      if (data && data.status === 'ok') {
        envStatus.textContent = 'Đã lưu';
      } else if (data && data.error) {
        envStatus.textContent = 'Lỗi: ' + data.error;
      } else {
        envStatus.textContent = 'Lỗi không xác định';
      }
    } catch (e) {
      envStatus.textContent = 'Lỗi lưu .env';
    } finally {
      setTimeout(() => { envStatus.textContent = ''; }, 1500);
    }
  }

  function updateFontLabel(v) {
    if (fontScaleLabel) fontScaleLabel.textContent = `${v}%`;
  }

  async function renderPreview() {
    if (!previewIframe || !slipJsonEl || !previewStatus || !fontScale) return;
    previewStatus.textContent = 'Đang tạo preview...';
    let slip = {};
    try {
      slip = slipJsonEl.value ? JSON.parse(slipJsonEl.value) : {};
    } catch (e) {
      previewStatus.textContent = 'JSON không hợp lệ';
      setTimeout(() => { previewStatus.textContent = ''; }, 1500);
      return;
    }

    const payload = {
      slip,
      fontScale: Number(fontScale.value || 100),
      sizeTitle: Number(document.getElementById('sizeTitle').value || 28),
      sizeSubtitle: Number(document.getElementById('sizeSubtitle').value || 15),
      sizeContent: Number(document.getElementById('sizeContent').value || 22),
      sizeReason: Number(document.getElementById('sizeReason').value || 19),
      sizeQr: Number(document.getElementById('sizeQr').value || 200)
    };

    try {
      const res = await fetch('/settings/preview-return-slip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const html = await res.text();
      // Use srcdoc for iframe preview
      previewIframe.srcdoc = html;
      previewStatus.textContent = 'Xong';
      setTimeout(() => { previewStatus.textContent = ''; }, 1500);
    } catch (e) {
      previewStatus.textContent = 'Lỗi render preview';
      setTimeout(() => { previewStatus.textContent = ''; }, 1500);
    }
  }

  function openPreviewWindow() {
    if (!slipJsonEl || !fontScale) return;
    let slip = {};
    try {
      slip = slipJsonEl.value ? JSON.parse(slipJsonEl.value) : {};
    } catch (e) {
      previewStatus.textContent = 'JSON không hợp lệ';
      setTimeout(() => { previewStatus.textContent = ''; }, 1500);
      return;
    }

    const payload = {
      slip,
      fontScale: Number(fontScale.value || 100),
      sizeTitle: Number(document.getElementById('sizeTitle').value || 28),
      sizeSubtitle: Number(document.getElementById('sizeSubtitle').value || 15),
      sizeContent: Number(document.getElementById('sizeContent').value || 22),
      sizeReason: Number(document.getElementById('sizeReason').value || 19),
      sizeQr: Number(document.getElementById('sizeQr').value || 200)
    };

    // Request HTML then open in new window as blob URL
    previewStatus.textContent = 'Đang mở cửa sổ preview...';
    fetch('/settings/preview-return-slip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(r => r.text()).then(html => {
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      previewStatus.textContent = '';
      setTimeout(() => { previewStatus.textContent = ''; }, 500);
    }).catch(() => {
      previewStatus.textContent = 'Lỗi mở preview';
      setTimeout(() => { previewStatus.textContent = ''; }, 500);
    });
  }

  function updateShipFontLabel(v) {
    if (shipFontScaleLabel) shipFontScaleLabel.textContent = `${v}%`;
  }

  async function renderShipPreview() {
    if (!shipPreviewIframe || !shipLabelJson || !shipPreviewStatus || !shipFontScale) return;
    shipPreviewStatus.textContent = 'Đang tạo preview...';
    let shipLabel = {};
    try {
      shipLabel = shipLabelJson.value ? JSON.parse(shipLabelJson.value) : {};
    } catch (e) {
      shipPreviewStatus.textContent = 'JSON không hợp lệ';
      setTimeout(() => { shipPreviewStatus.textContent = ''; }, 1500);
      return;
    }

    const payload = {
      shipLabel,
      fontScale: Number(shipFontScale.value || 100),
      sizeTitle: Number(document.getElementById('shipSizeTitle').value || 28),
      sizeSubtitle: Number(document.getElementById('shipSizeSubtitle').value || 15),
      sizeContent: Number(document.getElementById('shipSizeContent').value || 22),
      sizeLabel: Number(document.getElementById('shipSizeLabel').value || 13),
      sizeOrderCode: Number(document.getElementById('shipSizeOrderCode').value || 19)
    };

    try {
      const res = await fetch('/settings/preview-other-carrier-ship', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const html = await res.text();
      shipPreviewIframe.srcdoc = html;
      shipPreviewStatus.textContent = 'Xong';
      setTimeout(() => { shipPreviewStatus.textContent = ''; }, 1500);
    } catch (e) {
      shipPreviewStatus.textContent = 'Lỗi render preview';
      setTimeout(() => { shipPreviewStatus.textContent = ''; }, 1500);
    }
  }

  function openShipPreviewWindow() {
    if (!shipLabelJson || !shipFontScale) return;
    let shipLabel = {};
    try {
      shipLabel = shipLabelJson.value ? JSON.parse(shipLabelJson.value) : {};
    } catch (e) {
      shipPreviewStatus.textContent = 'JSON không hợp lệ';
      setTimeout(() => { shipPreviewStatus.textContent = ''; }, 1500);
      return;
    }

    const payload = {
      shipLabel,
      fontScale: Number(shipFontScale.value || 100),
      sizeTitle: Number(document.getElementById('shipSizeTitle').value || 28),
      sizeSubtitle: Number(document.getElementById('shipSizeSubtitle').value || 15),
      sizeContent: Number(document.getElementById('shipSizeContent').value || 22),
      sizeLabel: Number(document.getElementById('shipSizeLabel').value || 13),
      sizeOrderCode: Number(document.getElementById('shipSizeOrderCode').value || 19)
    };

    shipPreviewStatus.textContent = 'Đang mở cửa sổ preview...';
    fetch('/settings/preview-other-carrier-ship', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(r => r.text()).then(html => {
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      shipPreviewStatus.textContent = '';
      setTimeout(() => { shipPreviewStatus.textContent = ''; }, 500);
    }).catch(() => {
      shipPreviewStatus.textContent = 'Lỗi mở preview';
      setTimeout(() => { shipPreviewStatus.textContent = ''; }, 500);
    });
  }

  // attach listeners
  if (btnSettings) btnSettings.addEventListener('click', showSettings);
  if (btnCloseSettings) btnCloseSettings.addEventListener('click', hideSettings);
  if (btnLoadEnv) btnLoadEnv.addEventListener('click', loadEnv);
  if (btnSaveEnv) btnSaveEnv.addEventListener('click', saveEnv);
  if (btnAddEnvVar) btnAddEnvVar.addEventListener('click', () => {
    if (envList) envList.appendChild(createEnvRow('', '', true));
  });
  if (btnRenderPreview) btnRenderPreview.addEventListener('click', renderPreview);
  if (btnOpenPreviewWindow) btnOpenPreviewWindow.addEventListener('click', openPreviewWindow);
  if (fontScale) {
    fontScale.addEventListener('input', (e) => {
      updateFontLabel(e.target.value);
    });
    updateFontLabel(fontScale.value || 100);
  }
  if (btnRenderShipPreview) btnRenderShipPreview.addEventListener('click', renderShipPreview);
  if (btnOpenShipPreviewWindow) btnOpenShipPreviewWindow.addEventListener('click', openShipPreviewWindow);
  if (shipFontScale) {
    shipFontScale.addEventListener('input', (e) => {
      updateShipFontLabel(e.target.value);
    });
    updateShipFontLabel(shipFontScale.value || 100);
  }
}

bindEvents();
fetchConfig();
loadPrinters();
