const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const APP_URL = 'https://hypotheken.abnamro.nl/interest-rates/app/?lang=nl';
const API_PATH = '/api/customer-interest-rates/interest-rates/calculate?inactive=true';
const LTV = '>65%-≤85%';

const REQUEST_BODY = {
  product: 'BUDGET',
  type: 'ANNUITAIR',
  energyLabel: 'A',
  discounts: [{ type: 'BANK_ACCOUNT' }]
};

const TARGETS = [
  { label: 'Variable', duration: 1, type: 'VARIABLE' },
  { label: '3 years', duration: 36, type: 'FIXED' },
  { label: '5 years', duration: 60, type: 'FIXED' },
  { label: '10 years', duration: 120, type: 'FIXED' },
  { label: '20 years', duration: 240, type: 'FIXED' },
  { label: '30 years', duration: 360, type: 'FIXED' }
];

function parsePercent(value) {
  const n = Number(String(value).replace('%', '').replace(',', '.').trim());
  if (!Number.isFinite(n) || n <= 0 || n >= 20) {
    throw new Error(`Invalid interest rate value: ${value}`);
  }
  return n;
}

function toDecimal(percent) {
  return percent / 100;
}

function csvEscape(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function normalizeStoredRate(value) {
  const n = Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid stored interest rate: ${value}`);
  }
  return n > 1 ? n / 100 : n;
}

function amsterdamDate() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function readHistory(filePath) {
  if (!fs.existsSync(filePath)) return new Map();
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (!text) return new Map();
  const lines = text.split(/\r?\n/);
  if (lines.length <= 1) return new Map();

  const map = new Map();
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    if (cells.length >= 7) {
      map.set(
        cells[0],
        cells.slice(1, 7).map(v => normalizeStoredRate(v).toFixed(4))
      );
    }
  }
  return map;
}

async function fetchFromOfficialAbn() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      locale: 'nl-NL',
      timezoneId: 'Europe/Amsterdam',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForTimeout(5000);

        const result = await page.evaluate(async ({ apiPath, requestBody }) => {
          const response = await fetch(apiPath, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Accept': 'application/json, text/plain, */*',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
          });
          return {
            status: response.status,
            contentType: response.headers.get('content-type') || '',
            text: await response.text()
          };
        }, { apiPath: API_PATH, requestBody: REQUEST_BODY });

        if (result.status !== 200) {
          throw new Error(`ABN API returned HTTP ${result.status}: ${result.text.slice(0, 500)}`);
        }
        if (!result.contentType.toLowerCase().includes('application/json')) {
          throw new Error(`ABN response was not JSON (${result.contentType})`);
        }

        return JSON.parse(result.text);
      } catch (err) {
        lastError = err;
        if (attempt < 3) await page.waitForTimeout(10000 * attempt);
      }
    }
    throw lastError || new Error('ABN request failed');
  } finally {
    await browser.close();
  }
}

function extractRates(data) {
  if (!data || !Array.isArray(data.periods)) throw new Error('Missing periods array');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.renteblad || ''))) {
    throw new Error(`Invalid or missing renteblad: ${data.renteblad}`);
  }

  const rates = TARGETS.map(target => {
    const period = data.periods.find(p =>
      p.duration === target.duration && p.type === target.type && p.inactive !== true
    );
    if (!period) throw new Error(`Missing active period ${target.label}`);

    const ltvRate = (period.rates || []).find(r => r.type === 'LTV' && r.ltv === LTV);
    if (!ltvRate) throw new Error(`Missing LTV ${LTV} for ${target.label}`);

    return {
      ...target,
      value: String(ltvRate.value),
      percent: parsePercent(ltvRate.value)
    };
  });

  return { renteblad: data.renteblad, rates };
}

function writeFiles(snapshot, rawData) {
  const dataDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const ratesOnly = snapshot.rates
    .map(r => toDecimal(r.percent).toFixed(4))
    .join('\n') + '\n';
  fs.writeFileSync(path.join(dataDir, 'rates.csv'), ratesOnly);

  const currentRows = [
    ['Renteblad', 'Period', 'RateDecimal', 'LTV'],
    ...snapshot.rates.map(r => [
      snapshot.renteblad,
      r.label,
      toDecimal(r.percent).toFixed(4),
      LTV
    ])
  ];
  fs.writeFileSync(
    path.join(dataDir, 'current.csv'),
    currentRows.map(row => row.map(csvEscape).join(',')).join('\n') + '\n'
  );

  // Weekly history is keyed by the actual check date, not by the ABN renteblad date.
  // If the workflow runs more than once on the same day, that day's row is replaced,
  // so the history never gets duplicate entries for one weekly checkpoint.
  const checkDate = amsterdamDate();
  const historyPath = path.join(dataDir, 'history.csv');
  const history = readHistory(historyPath);
  history.set(
    checkDate,
    snapshot.rates.map(r => toDecimal(r.percent).toFixed(4))
  );
  const sortedDates = [...history.keys()].sort();
  const historyLines = [
    'Date,Variable,3 years,5 years,10 years,20 years,30 years',
    ...sortedDates.map(date => [date, ...history.get(date)].join(','))
  ];
  fs.writeFileSync(historyPath, historyLines.join('\n') + '\n');

  const latest = {
    source: APP_URL,
    endpoint: API_PATH,
    configuration: REQUEST_BODY,
    ltv: LTV,
    renteblad: snapshot.renteblad,
    rates: Object.fromEntries(snapshot.rates.map(r => [r.label, `${r.percent.toFixed(2)}%`])),
    retrievedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(dataDir, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');

  const status = {
    ok: true,
    checkedAt: new Date().toISOString(),
    renteblad: snapshot.renteblad,
    source: APP_URL
  };
  fs.writeFileSync(path.join(dataDir, 'status.json'), JSON.stringify(status, null, 2) + '\n');

  fs.writeFileSync(path.join(dataDir, 'latest-response.json'), JSON.stringify(rawData, null, 2) + '\n');
}

(async () => {
  const rawData = await fetchFromOfficialAbn();
  const snapshot = extractRates(rawData);
  writeFiles(snapshot, rawData);
  console.log(`ABN renteblad ${snapshot.renteblad}`);
  for (const rate of snapshot.rates) console.log(`${rate.label}: ${rate.percent.toFixed(2)}%`);
})().catch(err => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
