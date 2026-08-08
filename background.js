// Background service worker for Search-Link-Grabber.
// Maintains scrape state in chrome.storage.local so work survives popup close.

const STORAGE_KEY = 'slg_state';
const RESULTS_KEY = 'slg_results';

const DEFAULT_STATE = {
  running: false,
  paused: false,
  engine: 'google',
  baseQuery: '',
  combos: [],
  maxPages: 30,
  delayMs: 2000,
  removeDuplicates: true,
  currentComboIndex: 0,
  currentPage: 0,
  currentTabId: null,
  startedAt: null,
  completedAt: null,
  totalEstimated: 0,
};

const ENGINE_CONFIG = {
  google: {
    baseUrl: 'https://www.google.com/search',
    param: 'q',
    pageParam: 'start',
    pageSize: 10,
    newTab: true,
  },
  bing: {
    baseUrl: 'https://www.bing.com/search',
    param: 'q',
    pageParam: 'first',
    pageSize: 10,
    newTab: true,
  },
  yahoo: {
    baseUrl: 'https://search.yahoo.com/search',
    param: 'p',
    pageParam: 'b',
    pageSize: 10,
    newTab: true,
  },
  duckduckgo: {
    baseUrl: 'https://html.duckduckgo.com/html/',
    param: 'q',
    pageParam: 's',
    pageSize: 30,
    newTab: true,
  },
  brave: {
    baseUrl: 'https://search.brave.com/search',
    param: 'q',
    pageParam: 'offset',
    pageSize: 10,
    newTab: true,
  },
};

// Keep a memory singleton as well for fast access between storage syncs.
let memoryState = null;
let timeoutId = null;

async function init() {
  const stored = await getStorage(STORAGE_KEY);
  if (!stored) {
    await setStorage(STORAGE_KEY, DEFAULT_STATE);
    memoryState = { ...DEFAULT_STATE };
  } else {
    memoryState = stored;
    // If Chrome restarted while running, mark as paused so user can resume.
    if (memoryState.running) {
      memoryState.running = false;
      memoryState.paused = true;
      await saveState();
    }
  }
}

async function getStorage(key) {
  try {
    const r = await chrome.storage.local.get(key);
    return r[key] || null;
  } catch (e) {
    return null;
  }
}

async function setStorage(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

async function saveState() {
  await setStorage(STORAGE_KEY, memoryState);
}

async function getResults() {
  return (await getStorage(RESULTS_KEY)) || [];
}

async function setResults(arr) {
  await setStorage(RESULTS_KEY, arr);
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // strip trailing slash and hash for duplicate detection
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}${u.search}`;
  } catch (e) {
    return url.trim();
  }
}

function buildSearchUrl(engine, query, page) {
  const cfg = ENGINE_CONFIG[engine];
  const u = new URL(cfg.baseUrl);
  u.searchParams.set(cfg.param, query);
  const offset = page * cfg.pageSize;
  if (offset > 0) {
    u.searchParams.set(cfg.pageParam, String(offset));
  }
  // Keep search engines from blocking/redirecting with consistent params.
  if (engine === 'google') {
    u.searchParams.set('filter', '0');
    u.searchParams.set('biw', '1512');
    u.searchParams.set('bih', '857');
  }
  if (engine === 'bing') {
    u.searchParams.set('form', 'PERE');
  }
  return u.toString();
}

function sleep(ms) {
  return new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      timeoutId = null;
      resolve();
    }, ms);
  });
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    // Content script may not be loaded yet; wait and retry once.
    await sleep(500);
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

async function updateStatus(status) {
  memoryState.status = status;
  await saveState();
}

function configsEqual(a, b) {
  if (!a || !b) return false;
  if (a.engine !== b.engine) return false;
  if (a.baseQuery !== b.baseQuery) return false;
  if ((a.maxPages || 0) !== (b.maxPages || 0)) return false;
  const aCombos = a.combos || [];
  const bCombos = b.combos || [];
  if (aCombos.length !== bCombos.length) return false;
  for (let i = 0; i < aCombos.length; i++) {
    if (aCombos[i] !== bCombos[i]) return false;
  }
  return true;
}

async function computeTotalEstimated() {
  // Base query run + one run per combo term.
  const comboRuns = Math.max(1, (memoryState.combos || []).length + 1);
  memoryState.totalEstimated = comboRuns * (memoryState.maxPages || 1);
}

async function start(payload) {
  if (memoryState && memoryState.running) return false;

  // If configuration hasn't changed, Start continues from where it was stopped
  // (same as Resume). If Clear was used or config changed, it starts fresh.
  if (memoryState && configsEqual(memoryState, payload)) {
    memoryState.running = true;
    memoryState.paused = false;
    memoryState.status = 'Resuming from last stop...';
    memoryState.completedAt = null;
    await saveState();
    runLoop();
    return true;
  }

  // Fresh start for the supplied config but **retains** previously captured results.
  memoryState = {
    ...DEFAULT_STATE,
    ...payload,
    running: true,
    paused: false,
    currentComboIndex: 0,
    currentPage: 0,
    currentTabId: memoryState?.currentTabId || null,
    startedAt: Date.now(),
    completedAt: null,
    status: 'Starting...',
  };
  await computeTotalEstimated();
  await saveState();

  runLoop();
  return true;
}

async function stop() {
  if (!memoryState) return;
  memoryState.running = false;
  memoryState.paused = true;
  memoryState.status = 'Stopped by user';
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
  await saveState();
}

async function resume() {
  if (!memoryState) return false;
  if (memoryState.running) return false;
  memoryState.running = true;
  memoryState.paused = false;
  memoryState.status = 'Resuming from last stop...';
  memoryState.completedAt = null;
  await saveState();
  runLoop();
  return true;
}

async function clearData() {
  await stop();
  memoryState = { ...DEFAULT_STATE };
  await saveState();
  await setResults([]);
}

async function runLoop() {
  const { combos, baseQuery } = memoryState;
  // Always run the base query first, then run the base query + each combo term.
  const effectiveCombos = combos.length ? ['', ...combos] : [''];

  while (memoryState.running && memoryState.currentComboIndex < effectiveCombos.length) {
    const combo = effectiveCombos[memoryState.currentComboIndex];
    const query = (baseQuery + ' ' + combo).trim();

    while (memoryState.running && memoryState.currentPage < memoryState.maxPages) {
      const url = buildSearchUrl(memoryState.engine, query, memoryState.currentPage);
      const comboLabel = `${memoryState.currentComboIndex + 1}/${effectiveCombos.length}`;
      const pageLabel = `${memoryState.currentPage + 1}/${memoryState.maxPages}`;

      try {
        await updateStatus(`Scraping ${memoryState.engine} | combo ${comboLabel} | page ${pageLabel}`);
        await navigateAndScrape(url, query);
      } catch (e) {
        // Never stop because of CAPTCHA or transient page errors. Keep trying
        // until the user clicks Stop or all combos/pages are exhausted.
        console.warn(`[SLG] Error on combo ${comboLabel} page ${pageLabel}: ${e.message}`);
        await updateStatus(`Blocked/Captcha on ${memoryState.engine} combo ${comboLabel} page ${pageLabel} — continuing...`);
      }

      memoryState.currentPage += 1;
      await saveState();

      if (memoryState.running && memoryState.currentPage < memoryState.maxPages) {
        await sleep(memoryState.delayMs);
      }
    }

    memoryState.currentPage = 0;
    memoryState.currentComboIndex += 1;
    await saveState();
  }

  if (memoryState.running) {
    memoryState.running = false;
    memoryState.paused = false;
    memoryState.completedAt = Date.now();
    memoryState.status = 'Finished';
    await saveState();
  }
}

async function navigateAndScrape(url, query) {
  // Create or reuse a single tab/window for scraping.
  let tabId = memoryState.currentTabId;
  if (tabId) {
    try {
      await chrome.tabs.get(tabId);
    } catch (e) {
      tabId = null;
      memoryState.currentTabId = null;
    }
  }

  if (!tabId) {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    memoryState.currentTabId = tabId;
    await saveState();
  } else {
    await chrome.tabs.update(tabId, { url, active: false });
  }

  // Wait for page load. Cap at ~25s so a stuck CAPTCHA page doesn't hang forever.
  await waitForTabLoad(tabId, 25000);
  await sleep(2000);

  // Try to inject content script. Some engine pages block this; still continue.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js'],
    });
    await sleep(500);
  } catch (e) {
    console.warn('[SLG] Content script injection skipped:', e.message);
  }

  // Repeatedly ask the page for links. Only treat it as CAPTCHA when the tab
  // URL or the content script explicitly reports one. Otherwise a transient
  // messaging failure on a normal results page won't cause a false alarm.
  let response;
  let attempts = 0;
  while (memoryState.running) {
    let messagingFailed = false;
    try {
      response = await sendToTab(tabId, { action: 'scrapeLinks', engine: memoryState.engine });
    } catch (e) {
      console.warn('[SLG] Scrape message failed:', e.message);
      response = { links: [] };
      messagingFailed = true;
    }

    const likelyCaptcha = response?.captcha || (messagingFailed && await tabLooksLikeCaptcha(tabId));

    if (likelyCaptcha) {
      attempts += 1;
      const pageNo = memoryState.currentPage + 1;
      await updateStatus(`CAPTCHA detected on page ${pageNo} — solve it to continue. Waiting... (${attempts})`);
      await sleep(3000);
      continue;
    }
    break;
  }

  if (!memoryState.running) return;

  // Log page-level metadata even when zero links are found.
  const existing = await getResults();
  const seen = new Set(memoryState.removeDuplicates ? existing.map((r) => normalizeUrl(r.url)) : []);
  const newRecords = [];
  const pageNo = memoryState.currentPage + 1;
  const comboTerm = memoryState.combos[memoryState.currentComboIndex] || '';

  for (const item of response.links || []) {
    const norm = normalizeUrl(item.url);
    if (memoryState.removeDuplicates && seen.has(norm)) continue;
    seen.add(norm);
    newRecords.push({
      url: item.url,
      title: item.title || '',
      engine: memoryState.engine,
      query: query,
      combo: comboTerm,
      page: pageNo,
      capturedAt: new Date().toISOString(),
    });
  }

  await setResults(existing.concat(newRecords));
}

async function tabLooksLikeCaptcha(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = (tab.url || tab.pendingUrl || '').toLowerCase();
    return /(\/sorry|captcha|recaptcha)/.test(url);
  } catch (e) {
    return false;
  }
}

function waitForTabLoad(tabId, maxWaitMs = 25000) {
  return new Promise((resolve) => {
    let resolved = false;
    const listener = (updatedTabId, info) => {
      if (resolved) return;
      if (updatedTabId === tabId && info.status === 'complete') {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        console.warn('[SLG] Tab load timeout; continuing anyway.');
        resolve();
      }
    }, maxWaitMs);
  });
}

// Message API used by popup and content script.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.action) {
      case 'getState':
        sendResponse({ state: memoryState || (await getStorage(STORAGE_KEY)) });
        break;
      case 'getResults':
        sendResponse({ results: await getResults() });
        break;
      case 'start':
        sendResponse({ ok: await start(message.payload) });
        break;
      case 'stop':
        await stop();
        sendResponse({ ok: true });
        break;
      case 'resume':
        sendResponse({ ok: await resume() });
        break;
      case 'clear':
        await clearData();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false });
    }
  })();
  return true;
});

// Also listen for content script link extraction pings via sendMessage.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'scrapeLinks' && sender.tab) {
    // Handled inside content script injection via sendToTab; no-op here.
    sendResponse({ ok: true });
  }
});

init().catch(console.error);
