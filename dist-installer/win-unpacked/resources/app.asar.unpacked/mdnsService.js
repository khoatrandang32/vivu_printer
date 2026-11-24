'use strict';

const { spawn } = require('child_process');

let instance = null;
let publishedService = null;
let darwinDnsSdProcess = null;

function startMdns(config) {
  stopMdns();
  const mdnsName = (config.mdnsName || 'vivu-printer').trim();
  const port = parseInt(config.port || 3232, 10);
  const mdnsType = (config.mdnsType || 'http').trim();

  // Trên macOS (Darwin): sử dụng lệnh dns-sd gốc của hệ thống để đăng ký trực tiếp với mDNSResponder.
  // Điều này tránh xung đột cổng multicast 5353 dẫn đến cảnh báo trùng tên hostname máy tính trên macOS.
  if (process.platform === 'darwin') {
    try {
      const txt = [
        `printer=${config.printerName || ''}`,
        `deviceId=${config.backendSocketDeviceId || ''}`,
        'app=vivu-printer'
      ];
      darwinDnsSdProcess = spawn('dns-sd', [
        '-R',
        mdnsName,
        `_${mdnsType}._tcp`,
        'local',
        String(port),
        ...txt
      ], {
        stdio: 'ignore'
      });
      darwinDnsSdProcess.on('error', (err) => {
        console.warn('[mDNS][macOS] dns-sd lỗi:', err.message);
      });
      console.log(`[mDNS][macOS] Đang quảng bá dịch vụ "${mdnsName}" (${mdnsType}) qua dns-sd tại cổng ${port}`);
      return;
    } catch (e) {
      console.warn('[mDNS][macOS] Không thể chạy dns-sd:', e.message);
    }
  }

  // Trên Windows / Linux: sử dụng thư viện bonjour-service
  try {
    const { Bonjour } = require('bonjour-service');
    instance = new Bonjour();
    publishedService = instance.publish({
      name: mdnsName,
      type: mdnsType,
      port: port,
      txt: {
        printer: config.printerName || '',
        deviceId: config.backendSocketDeviceId || '',
        app: 'vivu-printer'
      }
    });

    console.log(`[mDNS] Đang quảng bá dịch vụ "${mdnsName}" (${mdnsType}) tại cổng ${port}`);
  } catch (err) {
    console.warn('[mDNS] Không thể khởi động mDNS:', err.message);
  }
}

function stopMdns() {
  if (darwinDnsSdProcess) {
    try {
      darwinDnsSdProcess.kill();
    } catch {}
    darwinDnsSdProcess = null;
  }
  if (publishedService) {
    try {
      publishedService.stop();
    } catch {}
    publishedService = null;
  }
  if (instance) {
    try {
      instance.destroy();
    } catch {}
    instance = null;
  }
}

module.exports = {
  startMdns,
  stopMdns
};
