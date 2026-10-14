// core/dnsResolver.js
// 针对国家智慧教育平台 CDN (cbern.com.cn / smartedu.cn) 的专用安全直连解析器
// 特性：
// 1. 内置官方国内 Anycast 高防及移动多线 VIP CDN IP 映射表
// 2. 彻底穿透并绕过 macOS 本地 Clash / Surge / Mihomo 等代理工具的 Fake-IP (198.18.0.0/15) 与海外节点拦截
// 3. 支持后台基于 AliDNS DoH (DNS-over-HTTPS) 动态刷新缓存，安全抗污染且无惧 CDN 节点变更
// 4. 完美兼容 Node.js 18+ 原生 https.request lookup 参数

const https = require('https');
const dns = require('dns');

// 官方国内移动高防 Anycast 与多线 VIP 直连 IP 静态池
const STATIC_CDN_MAP = {
  'r1-ndr-oversea.ykt.cbern.com.cn': ['103.198.200.200', '103.198.200.201'],
  'r2-ndr-oversea.ykt.cbern.com.cn': ['103.198.200.200', '103.198.200.201'],
  'r3-ndr-oversea.ykt.cbern.com.cn': ['103.198.200.200', '103.198.200.201'],
  's-file-1.ykt.cbern.com.cn': ['39.137.59.61', '39.137.59.62'],
  's-file-2.ykt.cbern.com.cn': ['39.137.59.61', '39.137.59.62'],
  's-file-3.ykt.cbern.com.cn': ['39.136.228.57', '39.136.228.76'],
  'r1-ndr-private.ykt.cbern.com.cn': ['39.136.228.80', '39.136.228.52'],
  'r2-ndr-private.ykt.cbern.com.cn': ['39.136.228.76', '39.136.228.73'],
  'r3-ndr-private.ykt.cbern.com.cn': ['39.136.228.56', '39.136.228.80'],
};

const dynamicCache = new Map();

/**
 * 通过 DNS-over-HTTPS (DoH) 查询域名的真实 A 记录
 */
async function resolveViaDoH(hostname) {
  return new Promise((resolve) => {
    const dohUrl = `https://dns.alidns.com/resolve?name=${encodeURIComponent(hostname)}&type=A`;
    const req = https.get(dohUrl, { timeout: 3500 }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          const ips = (json.Answer || [])
            .filter(a => a.type === 1 && a.data && !a.data.startsWith('198.18.'))
            .map(a => a.data);
          resolve(ips.length > 0 ? ips : null);
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/**
 * 刷新核心域名 DNS 缓存
 */
async function refreshDnsCache() {
  const hosts = Object.keys(STATIC_CDN_MAP);
  for (const h of hosts) {
    try {
      const freshIps = await resolveViaDoH(h);
      if (freshIps && freshIps.length > 0) {
        dynamicCache.set(h, freshIps);
      }
    } catch (e) {}
  }
}

// 启动时后台非阻塞预热
refreshDnsCache().catch(() => {});
// 每小时自动后台静默保活刷新一次
setInterval(() => { refreshDnsCache().catch(() => {}); }, 3600000).unref();

/**
 * 兼容 Node.js 标准 dns.lookup 签名的自定义解析器
 */
function customDnsLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }

  // 1. 优先从动态缓存或预置静态池匹配
  const cachedIps = dynamicCache.get(hostname) || STATIC_CDN_MAP[hostname];
  if (cachedIps && cachedIps.length > 0) {
    const ip = cachedIps[Math.floor(Math.random() * cachedIps.length)];
    if (options && options.all) {
      return callback(null, [{ address: ip, family: 4 }]);
    }
    return callback(null, ip, 4);
  }

  // 2. 如果是相关域名但不在池中，触发系统解析后过滤 fake-ip
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);

    // 检测是否命中了代理工具的 Fake-IP (198.18.0.0/15)
    const isFakeIp = typeof address === 'string' && address.startsWith('198.18.');
    if (isFakeIp) {
      // 降级使用内置备用 IP，避免连接挂起
      const fallbackIp = hostname.includes('oversea') ? '103.198.200.200' : '39.137.59.61';
      if (options && options.all) {
        return callback(null, [{ address: fallbackIp, family: 4 }]);
      }
      return callback(null, fallbackIp, 4);
    }

    callback(null, address, family);
  });
}

module.exports = {
  customDnsLookup,
  resolveViaDoH,
  refreshDnsCache,
  STATIC_CDN_MAP,
};
