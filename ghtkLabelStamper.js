const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

let cachedFontBytes = null;

function removeVietnameseDiacritics(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function loadUnicodeFontBytes() {
  if (cachedFontBytes) return cachedFontBytes;

  const candidatePaths = [
    path.join(__dirname, 'public', 'fonts', 'Arial-Bold.ttf'),
    path.join(__dirname, 'public', 'fonts', 'arial.ttf'),
    'C:\\Windows\\Fonts\\arialbd.ttf',
    'C:\\Windows\\Fonts\\arial.ttf',
    'C:\\Windows\\Fonts\\tahomabd.ttf',
    'C:\\Windows\\Fonts\\tahoma.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/Library/Fonts/Arial Unicode.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  ];

  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        cachedFontBytes = fs.readFileSync(p);
        console.log(`[GHTK Stamper] Đã nạp font Unicode từ: ${p}`);
        return cachedFontBytes;
      }
    } catch (_) {}
  }

  return null;
}

/**
 * Đóng dấu tên tài khoản GHTK lên nhãn PDF
 * @param {Buffer|Uint8Array} pdfBuffer - File PDF gốc từ GHTK
 * @param {string} accountName - Tên tài khoản GHTK (ví dụ: "Kho Hà Nội")
 * @returns {Promise<Buffer>} - Buffer PDF sau khi đã đóng dấu
 */
async function stampGhtkLabelPdf(pdfBuffer, accountName) {
  const cleanAccountName = String(accountName || '').trim();
  if (!cleanAccountName) {
    return Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
  }

  try {
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();
    if (!pages || pages.length === 0) {
      return Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
    }

    const firstPage = pages[0];
    const pageWidth = firstPage.getWidth();
    const pageHeight = firstPage.getHeight();

    let font;
    let mainText = cleanAccountName.toUpperCase();

    const fontBytes = loadUnicodeFontBytes();
    if (fontBytes) {
      try {
        pdfDoc.registerFontkit(fontkit);
        font = await pdfDoc.embedFont(fontBytes);
      } catch (fontErr) {
        console.warn('[GHTK Stamper] Không thể embed font Unicode, fallback về StandardFont:', fontErr.message);
      }
    }

    if (!font) {
      // Fallback: font chuẩn Helvetica không hỗ trợ dấu tiếng Việt, cần khử dấu
      font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      mainText = removeVietnameseDiacritics(mainText);
    }

    const fontSizeMain = 10.5;
    const textWidth = font.widthOfTextAtSize(mainText, fontSizeMain);

    const boxPaddingX = 8;
    const boxPaddingY = 4;
    const boxWidth = textWidth + boxPaddingX * 2;
    const boxHeight = fontSizeMain + boxPaddingY * 2;

    // Vị trí: Góc trên cùng bên phải của tem
    const marginRight = 10;
    const marginTop = 8;
    const boxX = Math.max(10, pageWidth - boxWidth - marginRight);
    const boxY = Math.max(10, pageHeight - boxHeight - marginTop);

    // Vẽ khung nền trắng viền đen
    firstPage.drawRectangle({
      x: boxX,
      y: boxY,
      width: boxWidth,
      height: boxHeight,
      color: rgb(1, 1, 1),
      borderColor: rgb(0, 0, 0),
      borderWidth: 1.5,
    });

    // Vẽ tên tài khoản (căn giữa khung)
    firstPage.drawText(mainText, {
      x: boxX + (boxWidth - textWidth) / 2,
      y: boxY + (boxHeight - 0.72 * fontSizeMain) / 2,
      size: fontSizeMain,
      font,
      color: rgb(0, 0, 0),
    });

    const modifiedBytes = await pdfDoc.save();
    return Buffer.from(modifiedBytes);
  } catch (error) {
    console.error('[GHTK Stamper] Lỗi khi đóng dấu tên tài khoản lên PDF:', error);
    // Khi có lỗi, fallback trả về buffer gốc để không làm gián đoạn việc in
    return Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
  }
}

module.exports = {
  stampGhtkLabelPdf,
  removeVietnameseDiacritics,
};
