const fs = require('fs');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatVnd(value) {
  const amount = Math.round(Number(value) || 0);
  return `${amount.toLocaleString('vi-VN')} đ`;
}

async function buildQrDataUrl(data, width = 240) {
  const text = String(data || '').trim();
  if (!text) return '';
  try {
    return await QRCode.toDataURL(text, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: Math.round(width),
    });
  } catch (_) {
    return '';
  }
}

async function buildReturnToWorkshopSlipHtml(slip, opts = {}) {
  const workshopName = escapeHtml(slip.workshopName || '—');
  const workshopCode = escapeHtml(slip.workshopCode || '');
  const returnDate = escapeHtml(slip.returnDate || '—');
  const totalValue = escapeHtml(formatVnd(slip.totalValue));
  const reason = escapeHtml(slip.reason || '—');
  const code = escapeHtml(slip.code || '');

  const sizeTitle = Number(opts.sizeTitle ?? 28);
  const sizeSubtitle = Number(opts.sizeSubtitle ?? 15);
  const sizeContent = Number(opts.sizeContent ?? 22);
  const sizeReason = Number(opts.sizeReason ?? 19);
  const sizeQr = Number(opts.sizeQr ?? 200);
  let configManager;
  try { configManager = require('./configManager'); } catch {}
  const cfgPadLeft = configManager ? configManager.get('returnSlipPaddingLeft') : undefined;
  const cfgPadRight = configManager ? configManager.get('returnSlipPaddingRight') : undefined;

  const paddingLeft = Number(opts.paddingLeft ?? (cfgPadLeft != null ? cfgPadLeft : (process.env.RETURN_SLIP_PADDING_LEFT != null ? process.env.RETURN_SLIP_PADDING_LEFT : 70)));
  const paddingRight = Number(opts.paddingRight ?? (cfgPadRight != null ? cfgPadRight : (process.env.RETURN_SLIP_PADDING_RIGHT != null ? process.env.RETURN_SLIP_PADDING_RIGHT : 150)));

  const qrDataUrl = await buildQrDataUrl(slip.qrData || slip.code, sizeQr);

  const workshopLine = workshopCode
    ? `${workshopName} <span class="muted">(${workshopCode})</span>`
    : workshopName;

  const qrBlock = qrDataUrl
    ? `<div class="qr"><img src="${qrDataUrl}" alt="QR phiếu trả" /><div class="code">${code}</div></div>`
    : `<div class="qr missing">Không có mã QR</div>`;

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <title>Phiếu trả lại xưởng ${code}</title>
  <style>
    @page { size: A5 portrait; margin: 8mm 5mm; }
    * { box-sizing: border-box; }
    body {
      font-family: "Segoe UI", Arial, sans-serif;
      color: #111827;
      margin: 0;
      padding: 0;
    }
    .sheet {
      padding-top: 2px;
      padding-bottom: 2px;
      padding-left: ${paddingLeft}px;
      padding-right: ${paddingRight}px;
    }
    h1 {
      font-size: ${sizeTitle}px;
      font-weight: 900;
      margin: 0 0 2px;
      letter-spacing: 0.3px;
    }
    .subtitle {
      font-size: ${sizeSubtitle}px;
      font-weight: 500;
      color: #6b7280;
      margin-bottom: 8px;
    }
    .grid2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0 16px;
    }
    .cell {
      border-bottom: 1px solid #e5e7eb;
      padding: 6px 0;
      min-width: 0;
      overflow-wrap: break-word;
    }
    .label {
      font-size: 11px;
      font-weight: 600;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      margin-bottom: 2px;
    }
    .value {
      font-size: ${sizeContent}px;
      font-weight: 800;
      line-height: 1.2;
      word-break: break-word;
    }
    .value.reason {
      font-size: ${sizeReason}px;
      font-weight: 700;
    }
    .muted { color: #6b7280; font-weight: 600; }
    .qr {
      margin-top: 8px;
      text-align: center;
      padding-top: 4px;
    }
    .qr img {
      width: ${sizeQr}px;
      height: ${sizeQr}px;
      object-fit: contain;
    }
    .qr .code {
      margin-top: 4px;
      font-size: 14px;
      font-weight: 800;
      color: #374151;
    }
    .qr.missing {
      font-size: 13px;
      color: #9ca3af;
      padding: 12px 0;
    }
  </style>
</head>
<body>
  <div class="sheet">
    <h1>PHIẾU TRẢ LẠI XƯỞNG</h1>
    <div class="subtitle">Dán lên kiện trả hàng</div>

    <div class="grid2">
      <div class="cell">
        <div class="label">Xưởng sản xuất</div>
        <div class="value">${workshopLine}</div>
      </div>
      <div class="cell">
        <div class="label">Ngày trả hàng</div>
        <div class="value">${returnDate}</div>
      </div>
      <div class="cell">
        <div class="label">Tổng giá trị phiếu</div>
        <div class="value">${totalValue}</div>
      </div>
      <div class="cell">
        <div class="label">Lý do trả hàng</div>
        <div class="value reason">${reason}</div>
      </div>
    </div>

    ${qrBlock}
  </div>
</body>
</html>`;
}

async function printReturnToWorkshopSlip(slip, deps, opts = {}) {
  const { renderDocumentToPdf, sendToPrinterPdf, printerName } = deps;
  if (!slip || typeof slip !== 'object') {
    throw new Error('Thiếu dữ liệu phiếu trả xưởng');
  }
  if (!String(slip.workshopName || '').trim()) {
    throw new Error('Thiếu tên xưởng sản xuất');
  }

  const html = await buildReturnToWorkshopSlipHtml(slip, opts);
  const htmlPath = path.join(
    os.tmpdir(),
    `rtx_slip_${Date.now()}_${Math.floor(Math.random() * 1e6)}.html`,
  );
  await fs.promises.writeFile(htmlPath, html, 'utf8');

  let pdfPath;
  try {
    pdfPath = await renderDocumentToPdf(htmlPath);
    // Xóa HTML sau khi Edge đã render xong PDF (không cần nữa)
    fs.unlink(htmlPath, () => {});

    const printResult = await sendToPrinterPdf(pdfPath, printerName, { keepFile: true, paperSize: 'a5' });

    // Xóa PDF sau 60 giây để SumatraPDF kịp đọc và in xong
    setTimeout(() => { fs.unlink(pdfPath, () => {}); }, 60000);

    return {
      status: 'success',
      code: slip.code || '',
      result: printResult,
    };
  } catch (err) {
    // Dọn dẹp khi lỗi
    fs.unlink(htmlPath, () => {});
    if (pdfPath) setTimeout(() => { fs.unlink(pdfPath, () => {}); }, 5000);
    throw err;
  }
}

module.exports = {
  buildReturnToWorkshopSlipHtml,
  printReturnToWorkshopSlip,
};
