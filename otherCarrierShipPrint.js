const fs = require('fs');
const path = require('path');
const os = require('os');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function buildOtherCarrierShipHtml(shipLabel, opts = {}) {
  const senderInfo = escapeHtml(shipLabel.senderInfo || '—');
  const receiverName = escapeHtml(shipLabel.receiverName || '—');
  const receiverPhone = escapeHtml(shipLabel.receiverPhone || '—');
  const receiverAddress = escapeHtml(shipLabel.receiverAddress || '—');
  const coachPhone = escapeHtml(shipLabel.coachPhone || '—');
  const orderCode = escapeHtml(shipLabel.orderCode || '');

  // Allow preview overrides for font sizes (used by settings preview)
  const sizeTitle = Number(opts.sizeTitle ?? 28);
  const sizeSubtitle = Number(opts.sizeSubtitle ?? 15);
  const sizeContent = Number(opts.sizeContent ?? 22);
  const sizeLabel = Number(opts.sizeLabel ?? 13);
  const sizeOrderCode = Number(opts.sizeOrderCode ?? 19);

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <title>Đơn vận chuyển ${orderCode}</title>
  <style>
    @page { size: A5 portrait; margin: 10mm; }
    * { box-sizing: border-box; }
    body {
      font-family: "Segoe UI", Arial, sans-serif;
      color: #111827;
      margin: 0;
      padding: 0;
    }
    .sheet { padding: 6px 2px; }
    h1 {
      font-size: ${sizeTitle}px;
      font-weight: 900;
      margin: 0 0 4px;
      letter-spacing: 0.5px;
    }
    .subtitle {
      font-size: ${sizeSubtitle}px;
      font-weight: 500;
      color: #6b7280;
      margin-bottom: 18px;
    }
    .row {
      border-bottom: 1px solid #e5e7eb;
      padding: 13px 0;
    }
    .row:last-of-type { border-bottom: none; }
    .label {
      font-size: ${sizeLabel}px;
      font-weight: 600;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 5px;
    }
    .value {
      font-size: ${sizeContent}px;
      font-weight: 800;
      line-height: 1.3;
      word-break: break-word;
    }
    .order-code {
      margin-top: 18px;
      padding-top: 12px;
      border-top: 2px dashed #e5e7eb;
      text-align: center;
    }
    .order-code .label {
      margin-bottom: 4px;
    }
    .order-code .value {
      font-size: ${sizeOrderCode}px;
      font-weight: 900;
      color: #374151;
      letter-spacing: 1px;
    }
  </style>
</head>
<body>
  <div class="sheet">
    <h1>ĐƠN VẬN CHUYỂN</h1>
    <div class="subtitle">Dán lên kiện hàng</div>

    <div class="row">
      <div class="label">Người gửi</div>
      <div class="value">${senderInfo}</div>
    </div>
    <div class="row">
      <div class="label">Người nhận</div>
      <div class="value">${receiverName}</div>
    </div>
    <div class="row">
      <div class="label">SĐT người nhận</div>
      <div class="value">${receiverPhone}</div>
    </div>
    <div class="row">
      <div class="label">Địa chỉ người nhận</div>
      <div class="value">${receiverAddress}</div>
    </div>
    <div class="row">
      <div class="label">SĐT xe khách</div>
      <div class="value">${coachPhone}</div>
    </div>

    ${orderCode ? `
    <div class="order-code">
      <div class="label">Mã đơn hàng</div>
      <div class="value">${orderCode}</div>
    </div>
    ` : ''}
  </div>
</body>
</html>`;
}

async function printOtherCarrierShip(shipLabel, deps) {
  const { renderDocumentToPdf, sendToPrinterPdf, printerName } = deps;
  if (!shipLabel || typeof shipLabel !== 'object') {
    throw new Error('Thiếu dữ liệu đơn vận chuyển');
  }
  if (!String(shipLabel.senderInfo || '').trim()) {
    throw new Error('Thiếu thông tin người gửi');
  }

  const html = await buildOtherCarrierShipHtml(shipLabel);
  const htmlPath = path.join(
    os.tmpdir(),
    `other_carrier_ship_${Date.now()}_${Math.floor(Math.random() * 1e6)}.html`,
  );
  await fs.promises.writeFile(htmlPath, html, 'utf8');

  let pdfPath;
  try {
    pdfPath = await renderDocumentToPdf(htmlPath);
    fs.unlink(htmlPath, () => {});

    const printResult = await sendToPrinterPdf(pdfPath, printerName, { keepFile: true, paperSize: 'a5' });

    setTimeout(() => { fs.unlink(pdfPath, () => {}); }, 60000);

    return {
      status: 'success',
      orderCode: shipLabel.orderCode || '',
      result: printResult,
    };
  } catch (err) {
    fs.unlink(htmlPath, () => {});
    if (pdfPath) setTimeout(() => { fs.unlink(pdfPath, () => {}); }, 5000);
    throw err;
  }
}

module.exports = {
  buildOtherCarrierShipHtml,
  printOtherCarrierShip,
};
