// exchange.js - klien Binance USDT-M Futures (REST). Node 18+ (fetch bawaan).
// Env: BINANCE_KEY, BINANCE_SECRET, TESTNET (default "true")
const crypto = require('crypto');

const TESTNET = (process.env.TESTNET || 'true') !== 'false';
const BASE = process.env.BASE_URL ||
  (TESTNET ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com'); // demo/testnet resmi Binance Futures
const KEY = process.env.BINANCE_KEY || '';
const SECRET = process.env.BINANCE_SECRET || '';

let timeOffset = 0;

async function requestOnce(method, path, params = {}, signed = false, base = BASE) {
  const p = { ...params };
  if (signed) {
    p.timestamp = Date.now() + timeOffset;
    p.recvWindow = 5000;
  }
  let qs = new URLSearchParams(p).toString();
  if (signed) {
    const sig = crypto.createHmac('sha256', SECRET).update(qs).digest('hex');
    qs += '&signature=' + sig;
  }
  const url = base + path + (qs ? '?' + qs : '');
  const res = await fetch(url, {
    method,
    headers: KEY ? { 'X-MBX-APIKEY': KEY } : {},
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const body = typeof data === 'object' ? JSON.stringify(data) : String(data).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    const err = new Error(`Binance ${res.status} ${path}: ${body}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Data pasar publik boleh diambil dari alamat lain (mis. DATA_URL=https://fapi.binance.com)
// karena data testnet sering tidak realistis. Order tetap ke BASE.
const DATA_BASE = process.env.DATA_URL || BASE;
// Ulangi otomatis untuk GET saja (aman). Order (POST/DELETE) tidak pernah diulang otomatis.
async function request(method, path, params = {}, signed = false, base = BASE) {
  const maxTry = method === 'GET' ? 4 : 1;
  for (let i = 1; ; i++) {
    try {
      return await requestOnce(method, path, params, signed, base);
    } catch (e) {
      const retryable = !e.status || e.status >= 500 || e.status === 429;
      if (i >= maxTry || !retryable) throw e;
      await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
}

const pub = (path, params) => request('GET', path, params, false, DATA_BASE);
const sgn = (method, path, params) => request(method, path, params, true);

async function syncTime() {
  const t = await pub('/fapi/v1/time');
  timeOffset = t.serverTime - Date.now();
  return timeOffset;
}

// ---------- data pasar (publik) ----------
const exchangeInfo = () => pub('/fapi/v1/exchangeInfo');
const ticker24h = () => pub('/fapi/v1/ticker/24hr');
const bookTickers = () => pub('/fapi/v1/ticker/bookTicker');
const premiumIndex = () => pub('/fapi/v1/premiumIndex'); // berisi lastFundingRate
const klines = (symbol, interval = '1h', limit = 200) =>
  pub('/fapi/v1/klines', { symbol, interval, limit }).then(rows =>
    rows.map(r => ({
      t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], closeT: r[6],
    })));

// ---------- akun & order (bertanda tangan) ----------
const account = () => sgn('GET', '/fapi/v2/account');
const positions = async () =>
  (await sgn('GET', '/fapi/v2/positionRisk')).filter(p => +p.positionAmt !== 0);
const openOrders = symbol => sgn('GET', '/fapi/v1/openOrders', symbol ? { symbol } : {});
const setLeverage = (symbol, leverage) => sgn('POST', '/fapi/v1/leverage', { symbol, leverage });
const setMarginType = (symbol, marginType = 'ISOLATED') =>
  sgn('POST', '/fapi/v1/marginType', { symbol, marginType }).catch(e => {
    // -4046 = sudah di tipe margin tersebut, aman diabaikan
    if (!(e.data && e.data.code === -4046)) throw e;
  });

const marketOrder = (symbol, side, quantity, reduceOnly = false) =>
  sgn('POST', '/fapi/v1/order', {
    symbol, side, type: 'MARKET', quantity,
    ...(reduceOnly ? { reduceOnly: 'true' } : {}),
  });

// Stop loss di sisi exchange: tetap aktif walau bot/HP mati.
const stopMarketClose = (symbol, side, stopPrice) =>
  sgn('POST', '/fapi/v1/order', {
    symbol, side, type: 'STOP_MARKET', stopPrice,
    closePosition: 'true', workingType: 'MARK_PRICE',
  });

const takeProfitMarketClose = (symbol, side, stopPrice) =>
  sgn('POST', '/fapi/v1/order', {
    symbol, side, type: 'TAKE_PROFIT_MARKET', stopPrice,
    closePosition: 'true', workingType: 'MARK_PRICE',
  });

const cancelAll = symbol => sgn('DELETE', '/fapi/v1/allOpenOrders', { symbol });

// Helper pembulatan sesuai filter simbol
function symbolFilters(info, symbol) {
  const s = info.symbols.find(x => x.symbol === symbol);
  if (!s) throw new Error('Simbol tidak ditemukan: ' + symbol);
  const f = Object.fromEntries(s.filters.map(x => [x.filterType, x]));
  return {
    tickSize: +f.PRICE_FILTER.tickSize,
    stepSize: +f.LOT_SIZE.stepSize,
    minQty: +f.LOT_SIZE.minQty,
    minNotional: +(f.MIN_NOTIONAL ? f.MIN_NOTIONAL.notional : 5),
  };
}
const decimals = step => (String(step).split('.')[1] || '').replace(/0+$/, '').length;
const roundStep = (v, step) => +(Math.floor(v / step + 1e-9) * step).toFixed(decimals(step));
const roundPrice = (v, tick) => +(Math.round(v / tick) * tick).toFixed(decimals(tick));

module.exports = {
  TESTNET, BASE, DATA_BASE, syncTime, exchangeInfo, ticker24h, bookTickers, premiumIndex, klines,
  account, positions, openOrders, setLeverage, setMarginType, marketOrder,
  stopMarketClose, takeProfitMarketClose, cancelAll, symbolFilters, roundStep, roundPrice,
};
