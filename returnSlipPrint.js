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

async function buildQrDataUrl(data) {
  const text = String(data || '').trim();
  if (!text) return '';
  try {
    return await QRCode.toDataURL(text, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 240,
    });
  } catch (_) {
    return '';
  }
}

async function buildReturnToWorkshopSlipHtml(slip) {
  const workshopName = escapeHtml(slip.workshopName || '—');
  const workshopCode = escapeHtml(slip.workshopCode || '');
  const returnDate = escapeHtml(slip.returnDate || '—');
  const totalValue = escapeHtml(formatVnd(slip.totalValue));
  const reason = escapeHtml(slip.reason || '—');
  const code = escapeHtml(slip.code || '');
  const qrDataUrl = await buildQrDataUrl(slip.qrData);

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
    @page { size: A5 portrait; margin: 12mm; }
    * { box-sizing: border-box; }
    body {
      font-family: "Segoe UI", Arial, sans-serif;
      color: #111827;
      margin: 0;
      padding: 0;
    }
    .sheet { padding: 8px 4px; }
    h1 {
      font-size: 22px;
      margin: 0 0 4px;
      letter-spacing: 0.5px;
    }
    .subtitle {
      font-size: 13px;
      color: #6b7280;
      margin-bottom: 20px;
    }
    .row {
      border-bottom: 1px solid #e5e7eb;
      padding: 12px 0;
    }
    .row:last-of-type { border-bottom: none; }
    .label {
      font-size: 12px;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      margin-bottom: 4px;
    }
    .value {
      font-size: 17px;
      font-weight: 700;
      line-height: 1.35;
      word-break: break-word;
    }
    .value.reason { font-size: 15px; font-weight: 600; }
    .muted { color: #6b7280; font-weight: 500; }
    .qr {
      margin-top: 20px;
      text-align: center;
      padding-top: 8px;
    }
    .qr img {
      width: 180px;
      height: 180px;
      object-fit: contain;
    }
    .qr .code {
      margin-top: 8px;
      font-size: 14px;
      font-weight: 700;
      color: #374151;
    }
    .qr.missing {
      font-size: 14px;
      color: #9ca3af;
      padding: 24px 0;
    }
  </style>
</head>
<body>
  <div class="sheet">
    <h1>PHIẾU TRẢ LẠI XƯỞNG</h1>
    <div class="subtitle">Dán lên kiện trả hàng</div>

    <div class="row">
      <div class="label">Xưởng sản xuất</div>
      <div class="value">${workshopLine}</div>
    </div>
    <div class="row">
      <div class="label">Ngày trả hàng</div>
      <div class="value">${returnDate}</div>
    </div>
    <div class="row">
      <div class="label">Tổng giá trị phiếu</div>
      <div class="value">${totalValue}</div>
    </div>
    <div class="row">
      <div class="label">Lý do trả hàng</div>
      <div class="value reason">${reason}</div>
    </div>

    ${qrBlock}
  </div>
</body>
</html>`;
}

async function printReturnToWorkshopSlip(slip, deps) {
  const { renderDocumentToPdf, sendToPrinterPdf, printerName } = deps;
  if (!slip || typeof slip !== 'object') {
    throw new Error('Thiếu dữ liệu phiếu trả xưởng');
  }
  if (!String(slip.workshopName || '').trim()) {
    throw new Error('Thiếu tên xưởng sản xuất');
  }

  const html = await buildReturnToWorkshopSlipHtml(slip);
  const htmlPath = path.join(
    os.tmpdir(),
    `rtx_slip_${Date.now()}_${Math.floor(Math.random() * 1e6)}.html`,
  );
  await fs.promises.writeFile(htmlPath, html, 'utf8');

  let pdfPath;
  try {
    pdfPath = await renderDocumentToPdf(htmlPath);
    const printResult = await sendToPrinterPdf(pdfPath, printerName, { keepFile: false });
    return {
      status: 'success',
      code: slip.code || '',
      result: printResult,
    };
  } finally {
    fs.unlink(htmlPath, () => {});
    if (pdfPath) fs.unlink(pdfPath, () => {});
  }
}

module.exports = {
  buildReturnToWorkshopSlipHtml,
  printReturnToWorkshopSlip,
};
