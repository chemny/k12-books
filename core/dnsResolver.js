// Prefer the user's system DNS/network. Use DoH only when resolution fails or returns Fake-IP.
const dns = require('dns');
const https = require('https');
const dynamicCache = new Map();
const STATIC_CDN_MAP = {}; // Fixed CDN IPs become stale; never override working system DNS.
function isFakeIp(ip) { return typeof ip === 'string' && /^198\.(18|19)\./.test(ip); }
function resolveViaDoH(hostname) {
  return new Promise(resolve => {
    const req = https.get(`https://dns.alidns.com/resolve?name=${encodeURIComponent(hostname)}&type=A`, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('error', () => resolve(null));
      res.on('end', () => {
        try {
          const ips = JSON.parse(raw).Answer?.filter(a => a.type === 1 && !isFakeIp(a.data)).map(a => a.data);
          resolve(ips?.length ? ips : null);
        } catch { resolve(null); }
      });
    });
    req.setTimeout(3500, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}
function customDnsLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dns.lookup(hostname, options, async (err, address, family) => {
    const addresses = Array.isArray(address) ? address : [{ address, family }];
    const usable = addresses.filter(a => a.address && !isFakeIp(a.address));
    if (!err && usable.length) return options?.all ? callback(null, usable) : callback(null, address, family);
    // Only apply platform-specific fallback to platform hosts.
    if (!/(^|\.)(cbern\.com\.cn|smartedu\.cn)$/.test(hostname) || options?.family === 6) {
      return callback(err || Object.assign(new Error('DNS 返回不可用地址'), { code: 'ENOTFOUND' }));
    }
    let cached = dynamicCache.get(hostname);
    if (!cached || cached.expires < Date.now()) {
      const ips = await resolveViaDoH(hostname);
      if (!ips) return callback(err || Object.assign(new Error('备用 DNS 解析失败'), { code: 'ENOTFOUND' }));
      cached = { ips, expires: Date.now() + 300000 };
      dynamicCache.set(hostname, cached);
    }
    const result = { address: cached.ips[0], family: 4 };
    if (options?.all) callback(null, [result]);
    else callback(null, result.address, result.family);
  });
}
async function refreshDnsCache() { dynamicCache.clear(); }
module.exports = { customDnsLookup, resolveViaDoH, refreshDnsCache, STATIC_CDN_MAP };
