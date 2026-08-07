// Popup UI logic for Search-Link-Grabber.

const qs = (sel) => document.querySelector(sel);

const els = {
  engine: qs('#engine'),
  baseQuery: qs('#baseQuery'),
  comboList: qs('#comboList'),
  maxPages: qs('#maxPages'),
  delayMs: qs('#delayMs'),
  removeDuplicates: qs('#removeDuplicates'),
  btnStart: qs('#btnStart'),
  btnStop: qs('#btnStop'),
  btnResume: qs('#btnResume'),
  btnClear: qs('#btnClear'),
  statusText: qs('#statusText'),
  progressBar: qs('#progressBar'),
  progressText: qs('#progressText'),
  linkCount: qs('#linkCount'),
  btnCsv: qs('#btnCsv'),
  btnJson: qs('#btnJson'),
  btnXls: qs('#btnXls'),
};

let currentResults = [];

async function send(action, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, payload }, resolve);
  });
}

function parseCombos(text) {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function readConfig() {
  return {
    engine: els.engine.value,
    baseQuery: els.baseQuery.value.trim(),
    combos: parseCombos(els.comboList.value),
    maxPages: parseInt(els.maxPages.value, 10) || 30,
    delayMs: parseInt(els.delayMs.value, 10) || 2000,
    removeDuplicates: els.removeDuplicates.checked,
  };
}

async function updateUI() {
  const { state } = await send('getState');
  currentResults = (await send('getResults')).results || [];

  if (state) {
    els.engine.value = state.engine || 'google';
    if (state.baseQuery !== undefined && !els.baseQuery.value) {
      els.baseQuery.value = state.baseQuery;
    }
    if (state.combos && state.combos.length && !els.comboList.value) {
      els.comboList.value = state.combos.join(', ');
    }
    els.maxPages.value = state.maxPages || 30;
    els.delayMs.value = state.delayMs || 2000;
    els.removeDuplicates.checked = state.removeDuplicates !== false;

    els.statusText.textContent = state.status || (state.running ? 'Running...' : 'Ready');
    const combosLen = Math.max(1, (state.combos || []).length);
    const total = Math.max(1, combosLen * (state.maxPages || 30));
    const done = (state.currentComboIndex || 0) * (state.maxPages || 30) + (state.currentPage || 0);
    els.progressBar.value = Math.min(total, done);
    els.progressBar.max = total;
    els.progressText.textContent = `${done} / ${total}`;
  }

  els.linkCount.textContent = String(currentResults.length);
  updateButtons(state);
}

function updateButtons(state) {
  state = state || {};
  const running = state.running;
  const paused = state.paused;
  els.btnStart.disabled = running;
  els.btnStop.disabled = !running;
  els.btnResume.disabled = running || !paused;
}

els.btnStart.addEventListener('click', async () => {
  const cfg = readConfig();
  if (!cfg.baseQuery) {
    els.statusText.textContent = 'Please enter a base query.';
    return;
  }
  // Start always preserves existing captured links. Use Clear to wipe them.
  const { ok } = await send('start', cfg);
  if (ok) {
    els.statusText.textContent = 'Started...';
    updateButtons({ running: true });
    startPolling();
  }
});

els.btnStop.addEventListener('click', async () => {
  await send('stop');
  updateUI();
});

els.btnResume.addEventListener('click', async () => {
  const { ok } = await send('resume');
  if (ok) {
    startPolling();
  }
  updateUI();
});

els.btnClear.addEventListener('click', async () => {
  if (!confirm('Clear all captured links and reset state?')) return;
  await send('clear');
  currentResults = [];
  els.baseQuery.value = '';
  els.comboList.value = '';
  updateUI();
});

els.btnCsv.addEventListener('click', () => download('csv'));
els.btnJson.addEventListener('click', () => download('json'));
els.btnXls.addEventListener('click', () => download('xls'));

function escapeCsvCell(val) {
  const text = String(val ?? '').replace(/"/g, '""');
  if (/[",\n\r]/.test(text)) return `"${text}"`;
  return text;
}

function buildCsv(rows) {
  const headers = ['url', 'title', 'engine', 'query', 'combo', 'page', 'capturedAt'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map((h) => escapeCsvCell(r[h])).join(','));
  }
  return lines.join('\n');
}

function buildJson(rows) {
  return JSON.stringify(rows, null, 2);
}

function download(format) {
  if (!currentResults || !currentResults.length) {
    els.statusText.textContent = 'No results to download.';
    return;
  }

  let blob;
  let filename;
  if (format === 'csv') {
    blob = new Blob([buildCsv(currentResults)], { type: 'text/csv' });
    filename = `search-links-${Date.now()}.csv`;
  } else if (format === 'json') {
    blob = new Blob([buildJson(currentResults)], { type: 'application/json' });
    filename = `search-links-${Date.now()}.json`;
  } else if (format === 'xls') {
    if (typeof XLSX !== 'undefined') {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(currentResults);
      XLSX.utils.book_append_sheet(wb, ws, 'Links');
      const data = XLSX.write(wb, { bookType: 'xls', type: 'array' });
      blob = new Blob([data], { type: 'application/vnd.ms-excel' });
      filename = `search-links-${Date.now()}.xls`;
    } else {
      // fallback to CSV with .xls extension
      blob = new Blob([buildCsv(currentResults)], { type: 'application/vnd.ms-excel' });
      filename = `search-links-${Date.now()}.xls`;
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

let pollTimer = null;
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    await updateUI();
    const { state } = await send('getState');
    if (!state || !state.running) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 1000);
}

document.addEventListener('DOMContentLoaded', async () => {
  await updateUI();

  // Restore persisted form values from memory state once.
  const { state } = await send('getState');
  if (state) {
    if (state.baseQuery && !els.baseQuery.value) els.baseQuery.value = state.baseQuery;
    if (state.combos && state.combos.length && !els.comboList.value) {
      els.comboList.value = state.combos.join(', ');
    }
    if (state.running) startPolling();
  }
});
