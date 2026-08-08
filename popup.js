// Popup UI logic for Search-Link-Grabber.

const qs = (sel) => document.querySelector(sel);

const POPUP_FORM_KEY = 'slg_popup_form';

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

function getFormValues() {
  return {
    engine: els.engine.value,
    baseQuery: els.baseQuery.value,
    comboList: els.comboList.value,
    maxPages: els.maxPages.value,
    delayMs: els.delayMs.value,
    removeDuplicates: els.removeDuplicates.checked,
  };
}

function setFormValues(values) {
  if (!values) return;
  if (values.engine !== undefined) els.engine.value = values.engine;
  if (values.baseQuery !== undefined) els.baseQuery.value = values.baseQuery;
  if (values.comboList !== undefined) els.comboList.value = values.comboList;
  if (values.maxPages !== undefined) els.maxPages.value = values.maxPages;
  if (values.delayMs !== undefined) els.delayMs.value = values.delayMs;
  if (values.removeDuplicates !== undefined) els.removeDuplicates.checked = values.removeDuplicates;
}

function saveDraft() {
  const draft = getFormValues();
  chrome.storage.local.set({ [POPUP_FORM_KEY]: draft }).catch(() => {});
}

async function loadDraft() {
  try {
    const data = await chrome.storage.local.get(POPUP_FORM_KEY);
    return data[POPUP_FORM_KEY] || null;
  } catch (e) {
    return null;
  }
}

async function clearDraft() {
  try {
    await chrome.storage.local.remove(POPUP_FORM_KEY);
  } catch (e) {
    // ignore
  }
}

async function updateUI() {
  const { state } = await send('getState');
  currentResults = (await send('getResults')).results || [];

  if (state) {
    els.statusText.textContent = state.status || (state.running ? 'Running...' : 'Ready');
    const combosLen = Math.max(1, (state.combos || []).length + 1);
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
  els.btnCsv.disabled = !currentResults.length;
  els.btnJson.disabled = !currentResults.length;
  els.btnXls.disabled = !currentResults.length;
}

// Auto-save form values as the user types so they survive popup close.
[
  els.engine,
  els.baseQuery,
  els.comboList,
  els.maxPages,
  els.delayMs,
  els.removeDuplicates,
].forEach((el) => {
  if (!el) return;
  el.addEventListener('input', saveDraft);
  el.addEventListener('change', saveDraft);
});

els.btnStart.addEventListener('click', async () => {
  const cfg = readConfig();
  if (!cfg.baseQuery) {
    els.statusText.textContent = 'Please enter a base query.';
    return;
  }
  saveDraft();
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
  const cfg = readConfig();
  if (!cfg.baseQuery) {
    els.statusText.textContent = 'Please enter a base query.';
    return;
  }
  saveDraft();
  const { ok } = await send('resume', cfg);
  if (ok) {
    startPolling();
  }
  updateUI();
});

els.btnClear.addEventListener('click', async () => {
  if (!confirm('Clear all captured links and reset state?')) return;
  await send('clear');
  await clearDraft();
  currentResults = [];
  els.baseQuery.value = '';
  els.comboList.value = '';
  els.engine.value = 'google';
  els.maxPages.value = '30';
  els.delayMs.value = '2000';
  els.removeDuplicates.checked = true;
  saveDraft();
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
  document.body.appendChild(a);
  a.click();
  a.remove();
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
  // 1. Restore the last draft the user was editing. If there is no draft,
  //    fallback to the last run configuration so first-time users see something.
  const draft = await loadDraft();
  if (draft) {
    setFormValues(draft);
  } else {
    const { state } = await send('getState');
    if (state) {
      setFormValues({
        engine: state.engine || 'google',
        baseQuery: state.baseQuery || '',
        comboList: (state.combos || []).join(', '),
        maxPages: String(state.maxPages || 30),
        delayMs: String(state.delayMs || 2000),
        removeDuplicates: state.removeDuplicates !== false,
      });
      saveDraft();
    }
  }

  // 2. Load status / results / buttons.
  await updateUI();

  const { state } = await send('getState');
  if (state && state.running) startPolling();
});
