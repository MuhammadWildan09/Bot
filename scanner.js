// scanner.js - pemilih pair otomatis.
// Pakai:  node scanner.js         (cetak 10 pair terbaik)
// Data pasar publik, tidak butuh API key.
const ex = require('./exchange');

const CFG = {
  minQuoteVolume: +(process.env.MIN_VOL || 50e6), // USDT per 24 jam (turunkan jika di testnet)
  maxSpreadBps: 3,           // spread bid-ask maksimum, basis poin
  minAtrPct: 0.4,            // ATR(14) 1h sebagai % harga
  maxAtrPct: 4.0,
  maxAbsFunding: 0.0005,     // 0.05% per 8 jam
  topByVolume: 40,           // berapa pair yang dicek mendalam (hemat request)
  interval: '1h',
  candles: 120,
  stable: ['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'USDPUSDT'],
};

function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  const out = [e];
  for (let i = 1; i < values.length; i++) { e = values[i] * k + e * (1 - k); out.push(e); }
  return out;
}

function atr(c, period = 14) {
  const tr = [];
  for (let i = 1; i < c.length; i++) {
    tr.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)));
  }
  const recent = tr.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

// ADX sederhana (Wilder) untuk kekuatan tren
function adx(c, period = 14) {
  let trS = 0, pS = 0, mS = 0;
  const dxs = [];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].h - c[i - 1].h, dn = c[i - 1].l - c[i].l;
    const pdm = up > dn && up > 0 ? up : 0;
    const mdm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    if (i <= period) { trS += tr; pS += pdm; mS += mdm; }
    else { trS = trS - trS / period + tr; pS = pS - pS / period + pdm; mS = mS - mS / period + mdm; }
    if (i >= period) {
      const pdi = 100 * pS / trS, mdi = 100 * mS / trS;
      dxs.push(100 * Math.abs(pdi - mdi) / (pdi + mdi || 1));
    }
  }
  const last = dxs.slice(-period);
  return last.reduce((a, b) => a + b, 0) / (last.length || 1);
}

async function scan(cfg = CFG) {
  const [info, tickers, books, premium] = await Promise.all([
    ex.exchangeInfo(), ex.ticker24h(), ex.bookTickers(), ex.premiumIndex(),
  ]);

  const ok = new Set(info.symbols
    .filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
    .map(s => s.symbol));
  const book = Object.fromEntries(books.map(b => [b.symbol, b]));
  const fund = Object.fromEntries(premium.map(p => [p.symbol, +p.lastFundingRate]));

  // Tahap 1: filter murah (volume, spread, funding)
  let cands = tickers
    .filter(t => ok.has(t.symbol) && !cfg.stable.includes(t.symbol))
    .filter(t => +t.quoteVolume >= cfg.minQuoteVolume)
    .map(t => {
      const b = book[t.symbol];
      const spreadBps = b ? ((+b.askPrice - +b.bidPrice) / ((+b.askPrice + +b.bidPrice) / 2)) * 1e4 : 999;
      return { symbol: t.symbol, quoteVolume: +t.quoteVolume, change24h: +t.priceChangePercent,
               spreadBps, funding: fund[t.symbol] ?? 0 };
    })
    .filter(x => Math.abs(x.funding) <= cfg.maxAbsFunding);

  // Spread valid = 0..max. Spread negatif berarti order book rusak (sering di testnet).
  const strict = cands.filter(x => x.spreadBps >= 0 && x.spreadBps <= cfg.maxSpreadBps);
  let spreadOk = true;
  if (strict.length >= 5 || !ex.TESTNET) {
    cands = strict;
  } else {
    spreadOk = false; // testnet: abaikan spread, tandai tidak valid
    console.log('PERINGATAN: data spread testnet tidak valid, filter spread dilewati.');
  }
  cands = cands.sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, cfg.topByVolume);

  // Tahap 2: volatilitas & tren dari kline
  const out = [];
  for (const x of cands) {
    try {
      const c = await ex.klines(x.symbol, cfg.interval, cfg.candles);
      if (c.length < 60) continue;
      const closes = c.map(k => k.c);
      const last = closes[closes.length - 1];
      const atrPct = (atr(c) / last) * 100;
      if (atrPct < cfg.minAtrPct || atrPct > cfg.maxAtrPct) continue;
      const e20 = ema(closes, 20), e50 = ema(closes, 50);
      const dir = e20.at(-1) > e50.at(-1) ? 'LONG' : 'SHORT';
      const slope = (e20.at(-1) - e20.at(-6)) / e20.at(-6) * 100; // kemiringan 5 candle
      const trend = adx(c);
      // Skor: tren kuat + volatilitas cukup + biaya (spread) rendah + likuid
      const spreadPenalty = spreadOk ? x.spreadBps * 3 : 0;
      const score = trend * 1.0 + Math.min(atrPct, 3) * 5 - spreadPenalty
                    + Math.log10(x.quoteVolume / cfg.minQuoteVolume + 1) * 5;
      out.push({ ...x, spreadOk, price: last, atrPct: +atrPct.toFixed(2), adx: +trend.toFixed(1),
                 dir, slope: +slope.toFixed(2), score: +score.toFixed(1) });
    } catch (e) { /* lewati pair bermasalah */ }
  }
  return out.sort((a, b) => b.score - a.score);
}

module.exports = { scan, CFG, ema, atr, adx };

if (require.main === module) {
  console.log(`Mode: ${ex.TESTNET ? 'TESTNET' : 'LIVE'}  (${ex.BASE})`);
  scan().then(r => {
    console.log(`Lolos filter: ${r.length}`);
    for (const x of r.slice(0, 10)) {
      console.log(`${x.symbol.padEnd(12)} ${x.dir.padEnd(5)} skor ${String(x.score).padStart(5)} ` +
        `ADX ${x.adx} ATR% ${x.atrPct} spread ${x.spreadOk ? x.spreadBps.toFixed(1) + 'bps' : 'n/a'} fund ${(x.funding * 100).toFixed(3)}%`);
    }
  }).catch(e => { console.error('Gagal:', e.message); process.exit(1); });
}
