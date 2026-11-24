let globalConfig = {};

async function fetchConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    globalConfig = data;
    const el = document.getElementById('config');
    if (el) el.textContent = `(${data.printerName || 'Chưa chọn máy in'} • http://localhost:${data.port || 3232})`;

    const versionBadge = document.getElementById('appVersionBadge');
    if (versionBadge && data.version) {
      versionBadge.textContent = `v${data.version}`;
    }

    const mdnsBadge = document.getElementById('mdnsBadge');
    if (mdnsBadge) {
      mdnsBadge.textContent = `${data.mdnsName || 'vivu-printer'}.local`;
    }

    // Cập nhật badge kết nối backend
    const badge = document.getElementById('socketBadge');
    const btnReconnect = document.getElementById('btnReconnect');
    if (badge && data.socket) {
      if (data.socket.connected) {
        badge.textContent = '● Backend: Đã kết nối';
        badge.style.background = '#10b981';
        badge.style.color = '#fff';
        if (btnReconnect) btnReconnect.style.display = 'none';
      } else if (data.socket.enabled) {
        badge.textContent = '○ Backend: Mất kết nối';
        badge.style.background = '#ef4444';
        badge.style.color = '#fff';
        if (btnReconnect) btnReconnect.style.display = 'inline-block';
      } else {
        badge.textContent = '○ Backend: Chưa cấu hình';
        badge.style.background = '#6b7280';
        badge.style.color = '#fff';
        if (btnReconnect) btnReconnect.style.display = 'none';
      }
    }

    // Tự động mở Setup Wizard nếu chưa cấu hình ban đầu
    if (!data.isConfigured && !window._wizardDismissed) {
      openSetupWizard();
    }
  } catch {}
}

async function reconnectBackend() {
  const badge = document.getElementById('socketBadge');
  const btnReconnect = document.getElementById('btnReconnect');
  if (btnReconnect) btnReconnect.disabled = true;
  if (badge) {
    badge.textContent = '◌ Đang kết nối lại...';
    badge.style.background = '#f59e0b';
    badge.style.color = '#fff';
  }
  try {
    const res = await fetch('/socket/reconnect', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'error') {
      if (badge) {
        badge.textContent = '✕ ' + data.message;
        badge.style.background = '#ef4444';
      }
    }
    // Chờ 2 giây rồi refresh trạng thái
    setTimeout(fetchConfig, 2000);
  } catch (e) {
    if (badge) {
      badge.textContent = '✕ Lỗi kết nối';
      badge.style.background = '#ef4444';
    }
  } finally {
    if (btnReconnect) btnReconnect.disabled = false;
  }
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

async function previewVtp() {
  const ta = document.getElementById('vtpList');
  const statusEl = document.getElementById('statusVtp');
  const btn = document.getElementById('btnPreviewVtp');
  const raw = ta.value || '';
  const firstUrl = raw
    .split(/\n+/)
    .map(s => s.trim())
    .filter(Boolean)[0];
  if (!firstUrl) {
    statusEl.textContent = 'Chưa nhập URL để preview';
    return;
  }
  if (!/^https?:\/\//i.test(firstUrl)) {
    statusEl.textContent = 'URL phải bắt đầu bằng http(s)://';
    return;
  }
  btn.disabled = true;
  statusEl.textContent = 'Đang tạo preview (lần đầu có thể mất 5-10s)...';
  try {
    const res = await fetch('/preview-viettelpost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: firstUrl })
    });
    if (!res.ok) {
      const text = await res.text();
      statusEl.textContent = `Lỗi: ${text}`;
      return;
    }
    const html = await res.text();
    const blob = new Blob([html], { type: 'text/html; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank', 'noopener');
    if (!win) {
      statusEl.textContent = 'Trình duyệt chặn popup — hãy cho phép popup cho localhost';
    } else {
      statusEl.textContent = 'Đã mở preview ở tab mới';
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  } catch (e) {
    statusEl.textContent = 'Lỗi: ' + (e.message || String(e));
  } finally {
    btn.disabled = false;
    setTimeout(() => {
      if (statusEl.textContent && statusEl.textContent.startsWith('Đã mở')) statusEl.textContent = '';
    }, 3000);
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
  const btnReconnect = document.getElementById('btnReconnect');
  if (btnReconnect) btnReconnect.addEventListener('click', reconnectBackend);
  document.getElementById('btnPrintPdf').addEventListener('click', printPdf);
  document.getElementById('btnPrintGhtk').addEventListener('click', printGhtk);
  document.getElementById('btnPrintVtp').addEventListener('click', printVtp);
  document.getElementById('btnPreviewVtp').addEventListener('click', previewVtp);

  // Settings modal controls
  const btnSettings = document.getElementById('btnSettings');
  const btnCloseSettings = document.getElementById('btnCloseSettings');
  const settingsModal = document.getElementById('settingsModal');
  const btnLoadEnv = document.getElementById('btnLoadEnv');
  const btnSaveEnv = document.getElementById('btnSaveEnv');
  const btnImportEnv = document.getElementById('btnImportEnv');
  const importEnvFile = document.getElementById('importEnvFile');
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

  function saveReturnSlipSettings() {
    try {
      const data = {
        sizeTitle: document.getElementById('sizeTitle')?.value,
        sizeSubtitle: document.getElementById('sizeSubtitle')?.value,
        sizeContent: document.getElementById('sizeContent')?.value,
        sizeReason: document.getElementById('sizeReason')?.value,
        sizeQr: document.getElementById('sizeQr')?.value,
        paddingLeft: document.getElementById('paddingLeft')?.value,
        paddingRight: document.getElementById('paddingRight')?.value,
        fontScale: fontScale?.value,
      };
      localStorage.setItem('vivu_return_slip_settings', JSON.stringify(data));
    } catch {}
  }

  function loadReturnSlipSettings() {
    try {
      const raw = localStorage.getItem('vivu_return_slip_settings');
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.sizeTitle && document.getElementById('sizeTitle')) document.getElementById('sizeTitle').value = data.sizeTitle;
      if (data.sizeSubtitle && document.getElementById('sizeSubtitle')) document.getElementById('sizeSubtitle').value = data.sizeSubtitle;
      if (data.sizeContent && document.getElementById('sizeContent')) document.getElementById('sizeContent').value = data.sizeContent;
      if (data.sizeReason && document.getElementById('sizeReason')) document.getElementById('sizeReason').value = data.sizeReason;
      if (data.sizeQr && document.getElementById('sizeQr')) document.getElementById('sizeQr').value = data.sizeQr;
      if (data.paddingLeft && document.getElementById('paddingLeft')) document.getElementById('paddingLeft').value = data.paddingLeft;
      if (data.paddingRight && document.getElementById('paddingRight')) document.getElementById('paddingRight').value = data.paddingRight;
      if (data.fontScale && fontScale) {
        fontScale.value = data.fontScale;
        updateFontLabel(data.fontScale);
      }
    } catch {}
  }

  // --- Setup Wizard & Settings Logic ---
  const setupWizardModal = document.getElementById('setupWizardModal');
  const wizardPrinterSelect = document.getElementById('wizardPrinterSelect');
  const wizardPrinterStatus = document.getElementById('wizardPrinterStatus');
  const wizardMdnsName = document.getElementById('wizardMdnsName');
  const wizardPort = document.getElementById('wizardPort');
  const wizardMdnsPreview = document.getElementById('wizardMdnsPreview');
  const wizardPdfEngineText = document.getElementById('wizardPdfEngineText');
  const btnWizardDownloadPdf = document.getElementById('btnWizardDownloadPdf');
  const wizardPdfViewerPath = document.getElementById('wizardPdfViewerPath');
  const wizardDeviceId = document.getElementById('wizardDeviceId');
  const wizardGhtkToken = document.getElementById('wizardGhtkToken');
  const wizardStatus = document.getElementById('wizardStatus');

  async function openSetupWizard() {
    if (!setupWizardModal) return;
    setupWizardModal.style.display = 'flex';
    if (wizardStatus) wizardStatus.textContent = '';
    await loadWizardData();
  }

  function closeSetupWizard() {
    if (setupWizardModal) setupWizardModal.style.display = 'none';
    window._wizardDismissed = true;
  }

  async function loadWizardData() {
    try {
      const pRes = await fetch('/printers');
      const pData = await pRes.json();
      const { printers = [], currentPrinter } = pData;
      if (wizardPrinterSelect) {
        wizardPrinterSelect.innerHTML = '';
        for (const p of printers) {
          const opt = document.createElement('option');
          opt.value = p.name;
          opt.textContent = p.name + (p.default ? ' (mặc định)' : '');
          if (p.name === currentPrinter) opt.selected = true;
          wizardPrinterSelect.appendChild(opt);
        }
      }

      if (wizardMdnsName) wizardMdnsName.value = globalConfig.mdnsName || 'vivu-printer';
      if (wizardPort) wizardPort.value = globalConfig.port || 3232;
      updateWizardMdnsPreview();
      if (wizardDeviceId) wizardDeviceId.value = globalConfig.backendSocketDeviceId || 'vivu_printer1';
      if (wizardGhtkToken) wizardGhtkToken.value = globalConfig.ghtkApiToken || '';

      await checkPdfEngine(wizardPdfEngineText, btnWizardDownloadPdf, wizardPdfViewerPath);
    } catch (e) {
      console.warn('Lỗi load wizard:', e);
    }
  }

  function updateWizardMdnsPreview() {
    if (wizardMdnsPreview && wizardMdnsName && wizardPort) {
      const name = (wizardMdnsName.value || 'vivu-printer').trim();
      const port = wizardPort.value || 3232;
      wizardMdnsPreview.textContent = `http://${name}.local:${port}`;
    }
  }

  async function checkPdfEngine(textEl, btnDownload, inputPathEl) {
    if (!textEl) return;
    textEl.textContent = 'Đang kiểm tra công cụ PDF...';
    try {
      const res = await fetch('/api/pdf-engine/status');
      const data = await res.json();
      if (data.found) {
        textEl.innerHTML = `✓ <strong>Đã phát hiện SumatraPDF:</strong> <span style="font-family:monospace; font-size:11px;">${data.path}</span>`;
        textEl.parentElement.style.background = '#dcfce7';
        textEl.parentElement.style.color = '#15803d';
        if (btnDownload) btnDownload.style.display = 'none';
        if (inputPathEl) inputPathEl.value = data.path;
      } else {
        textEl.innerHTML = `⚠️ <strong>Chưa có SumatraPDF</strong> (Khuyên dùng để in nhãn sắc nét và chuẩn tỷ lệ)`;
        textEl.parentElement.style.background = '#fef3c7';
        textEl.parentElement.style.color = '#b45309';
        if (btnDownload) btnDownload.style.display = 'inline-block';
        if (inputPathEl && data.currentConfigPath) inputPathEl.value = data.currentConfigPath;
      }
    } catch (e) {
      textEl.textContent = 'Lỗi kiểm tra công cụ PDF';
    }
  }

  async function downloadPdfEngine(textEl, btnDownload, inputPathEl) {
    if (!textEl || !btnDownload) return;
    btnDownload.disabled = true;
    textEl.textContent = '⏳ Đang tải SumatraPDF Portable chính thức (~10MB)...';
    try {
      const res = await fetch('/api/pdf-engine/download', { method: 'POST' });
      const data = await res.json();
      if (data.status === 'success') {
        textEl.innerHTML = `✓ <strong>Đã tải SumatraPDF thành công:</strong> <span style="font-family:monospace; font-size:11px;">${data.path}</span>`;
        textEl.parentElement.style.background = '#dcfce7';
        textEl.parentElement.style.color = '#15803d';
        btnDownload.style.display = 'none';
        if (inputPathEl) inputPathEl.value = data.path;
      } else {
        textEl.textContent = 'Lỗi tải: ' + (data.message || 'Thất bại');
        btnDownload.disabled = false;
      }
    } catch (e) {
      textEl.textContent = 'Lỗi kết nối tải SumatraPDF';
      btnDownload.disabled = false;
    }
  }

  async function completeSetupWizard() {
    if (wizardStatus) wizardStatus.textContent = '';
    const printerName = wizardPrinterSelect ? wizardPrinterSelect.value : '';
    if (!printerName) {
      if (wizardStatus) wizardStatus.textContent = 'Vui lòng chọn máy in để tiếp tục!';
      return;
    }

    const payload = {
      printerName,
      mdnsName: (wizardMdnsName ? wizardMdnsName.value : 'vivu-printer').trim(),
      port: parseInt(wizardPort ? wizardPort.value : 3232, 10) || 3232,
      pdfViewerPath: wizardPdfViewerPath ? wizardPdfViewerPath.value.trim() : '',
      backendSocketDeviceId: wizardDeviceId ? wizardDeviceId.value.trim() : 'vivu_printer1',
      ghtkApiToken: wizardGhtkToken ? wizardGhtkToken.value.trim() : ''
    };

    try {
      const res = await fetch('/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.status === 'success') {
        closeSetupWizard();
        await fetchConfig();
        await loadPrinters();
        alert('🎉 Thiết lập ban đầu hoàn tất! VIVU Printer đã sẵn sàng phục vụ in.');
      } else {
        if (wizardStatus) wizardStatus.textContent = data.message || 'Lỗi lưu cấu hình';
      }
    } catch (e) {
      if (wizardStatus) wizardStatus.textContent = 'Lỗi gửi yêu cầu thiết lập';
    }
  }

  // --- Settings Modal Logic ---
  async function showSettings() {
    if (settingsModal) {
      settingsModal.style.display = 'flex';
      await loadSettingsData();
      loadReturnSlipSettings();
    }
  }

  function hideSettings() {
    if (settingsModal) settingsModal.style.display = 'none';
  }

  async function loadSettingsData() {
    try {
      const res = await fetch('/api/config');
      const cfg = await res.json();
      globalConfig = cfg;

      // Populate printers
      const pRes = await fetch('/printers');
      const pData = await pRes.json();
      const cfgPrinterSelect = document.getElementById('cfgPrinterSelect');
      if (cfgPrinterSelect) {
        cfgPrinterSelect.innerHTML = '';
        for (const p of (pData.printers || [])) {
          const opt = document.createElement('option');
          opt.value = p.name;
          opt.textContent = p.name + (p.default ? ' (mặc định)' : '');
          if (p.name === (cfg.printerName || pData.currentPrinter)) opt.selected = true;
          cfgPrinterSelect.appendChild(opt);
        }
      }

      // Fields
      if (document.getElementById('cfgLabelWidth')) document.getElementById('cfgLabelWidth').value = cfg.labelWidthMm || 100;
      if (document.getElementById('cfgLabelHeight')) document.getElementById('cfgLabelHeight').value = cfg.labelHeightMm || 150;
      if (document.getElementById('cfgPrintOrientation')) document.getElementById('cfgPrintOrientation').value = cfg.printOrientation || 'portrait';
      if (document.getElementById('cfgPrintFit')) document.getElementById('cfgPrintFit').value = cfg.printFit || 'fit';
      if (document.getElementById('cfgPrintPadding')) document.getElementById('cfgPrintPadding').value = cfg.printPaddingMm || 0;
      if (document.getElementById('cfgMdnsName')) document.getElementById('cfgMdnsName').value = cfg.mdnsName || 'vivu-printer';
      if (document.getElementById('cfgPort')) document.getElementById('cfgPort').value = cfg.port || 3232;
      if (document.getElementById('cfgPdfViewerPath')) document.getElementById('cfgPdfViewerPath').value = cfg.pdfViewerPath || '';
      if (document.getElementById('cfgSocketUrl')) document.getElementById('cfgSocketUrl').value = cfg.backendSocketUrl || '';
      if (document.getElementById('cfgSocketDeviceId')) document.getElementById('cfgSocketDeviceId').value = cfg.backendSocketDeviceId || '';
      if (document.getElementById('cfgSocketToken')) document.getElementById('cfgSocketToken').value = cfg.backendSocketToken || '';
      if (document.getElementById('cfgCurrentVersion')) document.getElementById('cfgCurrentVersion').textContent = cfg.version || '1.0.3';
      if (document.getElementById('appVersionBadge')) document.getElementById('appVersionBadge').textContent = 'v' + (cfg.version || '1.0.3');
      const accounts = Array.isArray(cfg.ghtkAccounts) ? cfg.ghtkAccounts : [];
      const accountsInfoEl = document.getElementById('cfgGhtkAccountsInfo');
      if (accountsInfoEl) {
        if (accounts.length > 0) {
          accountsInfoEl.style.display = 'block';
          accountsInfoEl.style.color = '#059669';
          accountsInfoEl.style.background = '#ecfdf5';
          accountsInfoEl.style.borderColor = '#a7f3d0';
          accountsInfoEl.innerHTML = `<strong>✔ Đa tài khoản:</strong> Đã đồng bộ <strong>${accounts.length}</strong> tài khoản GHTK từ server (${accounts.map(a => a.name).join(', ')}). Hệ thống tự động chọn đúng tài khoản khi in.`;
        } else {
          accountsInfoEl.style.display = 'block';
          accountsInfoEl.style.color = '#3b82f6';
          accountsInfoEl.style.background = '#eff6ff';
          accountsInfoEl.style.borderColor = '#bfdbfe';
          accountsInfoEl.innerHTML = `<strong>ℹ Đa tài khoản GHTK:</strong> Sẽ tự động đồng bộ từ Backend khi máy in kết nối Socket. Không cần nhập token thủ công.`;
        }
      }

      await checkPdfEngine(document.getElementById('cfgPdfEngineText'), document.getElementById('btnCfgDownloadPdf'), document.getElementById('cfgPdfViewerPath'));
    } catch (e) {
      console.warn('Lỗi load settings:', e);
    }
  }

  async function saveSettingsData() {
    const noticeEl = document.getElementById('settingsNotice');
    if (noticeEl) {
      noticeEl.style.display = 'block';
      noticeEl.style.background = '#e0f2fe';
      noticeEl.style.color = '#0369a1';
      noticeEl.textContent = 'Đang lưu cấu hình...';
    }

    const updates = {
      printerName: document.getElementById('cfgPrinterSelect')?.value || '',
      labelWidthMm: parseFloat(document.getElementById('cfgLabelWidth')?.value) || 100,
      labelHeightMm: parseFloat(document.getElementById('cfgLabelHeight')?.value) || 150,
      printOrientation: document.getElementById('cfgPrintOrientation')?.value || 'portrait',
      printFit: document.getElementById('cfgPrintFit')?.value || 'fit',
      printPaddingMm: parseInt(document.getElementById('cfgPrintPadding')?.value, 10) || 0,
      mdnsName: document.getElementById('cfgMdnsName')?.value.trim() || 'vivu-printer',
      port: parseInt(document.getElementById('cfgPort')?.value, 10) || 3232,
      pdfViewerPath: document.getElementById('cfgPdfViewerPath')?.value.trim() || '',
      backendSocketUrl: document.getElementById('cfgSocketUrl')?.value.trim() || '',
      backendSocketDeviceId: document.getElementById('cfgSocketDeviceId')?.value.trim() || '',
      backendSocketToken: document.getElementById('cfgSocketToken')?.value.trim() || ''
    };

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      const data = await res.json();
      if (data.status === 'success') {
        if (noticeEl) {
          noticeEl.style.background = '#dcfce7';
          noticeEl.style.color = '#15803d';
          noticeEl.textContent = '✓ Đã lưu cài đặt thành công và áp dụng ngay!';
        }
        await fetchConfig();
        await loadPrinters();
        setTimeout(() => {
          if (noticeEl) noticeEl.style.display = 'none';
        }, 3000);
      } else {
        if (noticeEl) {
          noticeEl.style.background = '#fee2e2';
          noticeEl.style.color = '#b91c1c';
          noticeEl.textContent = 'Lỗi: ' + (data.message || 'Không thể lưu');
        }
      }
    } catch (e) {
      if (noticeEl) {
        noticeEl.style.background = '#fee2e2';
        noticeEl.style.color = '#b91c1c';
        noticeEl.textContent = 'Lỗi kết nối khi lưu';
      }
    }
  }

  // --- Test Print Helper ---
  async function runTestPrint(printerName, statusEl) {
    if (statusEl) statusEl.textContent = 'Đang gửi lệnh in thử...';
    try {
      const res = await fetch('/api/print-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ printerName })
      });
      const data = await res.json();
      if (data.status === 'success') {
        if (statusEl) {
          statusEl.textContent = '✔ In thử thành công!';
          statusEl.style.color = '#15803d';
        }
      } else {
        if (statusEl) {
          statusEl.textContent = '✘ Lỗi: ' + (data.message || 'Không thể in');
          statusEl.style.color = '#b91c1c';
        }
      }
    } catch (e) {
      if (statusEl) {
        statusEl.textContent = '✘ Lỗi kết nối máy in';
        statusEl.style.color = '#b91c1c';
      }
    }
    setTimeout(() => {
      if (statusEl) statusEl.textContent = '';
    }, 4000);
  }

  // --- Auto-Updater Client Logic ---
  let updaterPollTimer = null;

  async function checkUpdate(userInitiated = false) {
    const banner = document.getElementById('updateBanner');
    const bannerText = document.getElementById('updateBannerText');
    const cfgStatus = document.getElementById('cfgUpdateStatus');
    if (banner && userInitiated) {
      banner.style.display = 'flex';
      bannerText.textContent = 'Đang kiểm tra bản cập nhật mới trên GitHub...';
    }
    if (cfgStatus) cfgStatus.textContent = 'Đang kiểm tra...';

    try {
      await fetch('/api/update/check', { method: 'POST' });
      startPollingUpdateStatus(userInitiated);
    } catch (e) {
      if (cfgStatus) cfgStatus.textContent = 'Lỗi gửi yêu cầu kiểm tra cập nhật';
    }
  }

  function startPollingUpdateStatus(userInitiated = false) {
    if (updaterPollTimer) clearInterval(updaterPollTimer);
    let attempts = 0;
    updaterPollTimer = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch('/api/update/status');
        const data = await res.json();
        const banner = document.getElementById('updateBanner');
        const bannerText = document.getElementById('updateBannerText');
        const btnDownload = document.getElementById('btnDownloadUpdate');
        const btnInstall = document.getElementById('btnInstallUpdate');
        const progressWrapper = document.getElementById('updateProgressWrapper');
        const progressBar = document.getElementById('updateProgressBar');
        const cfgStatus = document.getElementById('cfgUpdateStatus');

        if (data.status === 'available') {
          if (banner) banner.style.display = 'flex';
          if (bannerText) bannerText.textContent = `Đã có bản cập nhật mới v${data.version}!`;
          if (btnDownload) btnDownload.style.display = 'inline-block';
          if (btnInstall) btnInstall.style.display = 'none';
          if (progressWrapper) progressWrapper.style.display = 'none';
          if (cfgStatus) cfgStatus.textContent = `Đã có bản cập nhật mới v${data.version}!`;
          clearInterval(updaterPollTimer);
        } else if (data.status === 'downloading') {
          if (banner) banner.style.display = 'flex';
          if (bannerText) bannerText.textContent = `Đang tải bản cập nhật: ${data.percent || 0}%`;
          if (btnDownload) btnDownload.style.display = 'none';
          if (btnInstall) btnInstall.style.display = 'none';
          if (progressWrapper) progressWrapper.style.display = 'inline-block';
          if (progressBar) progressBar.style.width = `${data.percent || 0}%`;
          if (cfgStatus) cfgStatus.textContent = `Đang tải: ${data.percent || 0}%`;
        } else if (data.status === 'downloaded') {
          if (banner) banner.style.display = 'flex';
          if (bannerText) bannerText.textContent = `Bản cập nhật v${data.version} đã tải xong!`;
          if (btnDownload) btnDownload.style.display = 'none';
          if (btnInstall) btnInstall.style.display = 'inline-block';
          if (progressWrapper) progressWrapper.style.display = 'none';
          if (cfgStatus) cfgStatus.textContent = `Bản cập nhật v${data.version} đã sẵn sàng cài đặt.`;
          clearInterval(updaterPollTimer);
        } else if (data.status === 'not-available') {
          if (userInitiated) {
            if (bannerText) bannerText.textContent = data.message || 'Bạn đang sử dụng phiên bản mới nhất.';
            setTimeout(() => { if (banner) banner.style.display = 'none'; }, 4000);
          }
          if (cfgStatus) cfgStatus.textContent = data.message || 'Bạn đang ở phiên bản mới nhất.';
          clearInterval(updaterPollTimer);
        } else if (data.status === 'error') {
          if (bannerText) bannerText.textContent = 'Lỗi cập nhật: ' + data.message;
          if (cfgStatus) cfgStatus.textContent = 'Lỗi cập nhật: ' + data.message;
          clearInterval(updaterPollTimer);
        }

        if (attempts > 30) {
          clearInterval(updaterPollTimer);
        }
      } catch (e) {
        clearInterval(updaterPollTimer);
      }
    }, 2000);
  }

  async function downloadUpdate() {
    const bannerText = document.getElementById('updateBannerText');
    const btnDownload = document.getElementById('btnDownloadUpdate');
    const progressWrapper = document.getElementById('updateProgressWrapper');
    if (bannerText) bannerText.textContent = 'Bắt đầu tải bản cập nhật...';
    if (btnDownload) btnDownload.style.display = 'none';
    if (progressWrapper) progressWrapper.style.display = 'inline-block';
    try {
      await fetch('/api/update/download', { method: 'POST' });
      startPollingUpdateStatus(true);
    } catch (e) {
      if (bannerText) bannerText.textContent = 'Lỗi khi bắt đầu tải bản cập nhật';
    }
  }

  async function installUpdate() {
    const bannerText = document.getElementById('updateBannerText');
    if (bannerText) bannerText.textContent = 'Đang khởi động lại ứng dụng để áp dụng bản cập nhật...';
    try {
      await fetch('/api/update/install', { method: 'POST' });
    } catch (e) {}
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
      sizeQr: Number(document.getElementById('sizeQr').value || 200),
      paddingLeft: Number(document.getElementById('paddingLeft')?.value ?? 70),
      paddingRight: Number(document.getElementById('paddingRight')?.value ?? 150)
    };
    saveReturnSlipSettings();

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
      sizeQr: Number(document.getElementById('sizeQr').value || 200),
      paddingLeft: Number(document.getElementById('paddingLeft')?.value ?? 70),
      paddingRight: Number(document.getElementById('paddingRight')?.value ?? 150)
    };
    saveReturnSlipSettings();

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

  const btnSaveConfig = document.getElementById('btnSaveConfig');
  if (btnSaveConfig) btnSaveConfig.addEventListener('click', saveSettingsData);

  const btnOpenSetupWizard = document.getElementById('btnOpenSetupWizard');
  if (btnOpenSetupWizard) btnOpenSetupWizard.addEventListener('click', openSetupWizard);

  const btnReopenWizard = document.getElementById('btnReopenWizard');
  if (btnReopenWizard) btnReopenWizard.addEventListener('click', () => {
    hideSettings();
    openSetupWizard();
  });

  const btnCompleteSetup = document.getElementById('btnCompleteSetup');
  if (btnCompleteSetup) btnCompleteSetup.addEventListener('click', completeSetupWizard);

  const btnWizardRefreshPrinters = document.getElementById('btnWizardRefreshPrinters');
  if (btnWizardRefreshPrinters) btnWizardRefreshPrinters.addEventListener('click', loadWizardData);

  const btnWizardTestPrint = document.getElementById('btnWizardTestPrint');
  if (btnWizardTestPrint) {
    btnWizardTestPrint.addEventListener('click', () => {
      runTestPrint(wizardPrinterSelect?.value, wizardPrinterStatus);
    });
  }

  const btnSettingsTestPrint = document.getElementById('btnSettingsTestPrint');
  if (btnSettingsTestPrint) {
    btnSettingsTestPrint.addEventListener('click', () => {
      const p = document.getElementById('cfgPrinterSelect')?.value;
      const notice = document.getElementById('settingsNotice');
      if (notice) notice.style.display = 'block';
      runTestPrint(p, notice);
    });
  }

  const btnQuickTestPrint = document.getElementById('btnQuickTestPrint');
  if (btnQuickTestPrint) {
    btnQuickTestPrint.addEventListener('click', () => {
      const p = document.getElementById('printerSelect')?.value;
      runTestPrint(p, document.getElementById('printerStatus'));
    });
  }

  if (btnWizardDownloadPdf) {
    btnWizardDownloadPdf.addEventListener('click', () => {
      downloadPdfEngine(wizardPdfEngineText, btnWizardDownloadPdf, wizardPdfViewerPath);
    });
  }

  const btnCfgDownloadPdf = document.getElementById('btnCfgDownloadPdf');
  if (btnCfgDownloadPdf) {
    btnCfgDownloadPdf.addEventListener('click', () => {
      downloadPdfEngine(document.getElementById('cfgPdfEngineText'), btnCfgDownloadPdf, document.getElementById('cfgPdfViewerPath'));
    });
  }

  if (wizardMdnsName) wizardMdnsName.addEventListener('input', updateWizardMdnsPreview);
  if (wizardPort) wizardPort.addEventListener('input', updateWizardMdnsPreview);

  // Update handlers
  const btnCheckUpdateHeader = document.getElementById('btnCheckUpdateHeader');
  if (btnCheckUpdateHeader) btnCheckUpdateHeader.addEventListener('click', () => checkUpdate(true));

  const btnSettingsCheckUpdate = document.getElementById('btnSettingsCheckUpdate');
  if (btnSettingsCheckUpdate) btnSettingsCheckUpdate.addEventListener('click', () => checkUpdate(true));

  const btnDownloadUpdate = document.getElementById('btnDownloadUpdate');
  if (btnDownloadUpdate) btnDownloadUpdate.addEventListener('click', downloadUpdate);

  const btnInstallUpdate = document.getElementById('btnInstallUpdate');
  if (btnInstallUpdate) btnInstallUpdate.addEventListener('click', installUpdate);

  const btnCloseUpdateBanner = document.getElementById('btnCloseUpdateBanner');
  if (btnCloseUpdateBanner) {
    btnCloseUpdateBanner.addEventListener('click', () => {
      const banner = document.getElementById('updateBanner');
      if (banner) banner.style.display = 'none';
    });
  }
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
  const padLeftEl = document.getElementById('paddingLeft');
  const padRightEl = document.getElementById('paddingRight');
  if (padLeftEl) padLeftEl.addEventListener('change', saveReturnSlipSettings);
  if (padRightEl) padRightEl.addEventListener('change', saveReturnSlipSettings);
  loadReturnSlipSettings();
}

bindEvents();
fetchConfig();
loadPrinters();

// Tự động cập nhật trạng thái kết nối backend mỗi 5 giây
setInterval(fetchConfig, 5000);
