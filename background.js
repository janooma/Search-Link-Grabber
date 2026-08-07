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

async function computeTotalEstimated() {
  const combos = memoryState.combos.length || 1;
  memoryState.totalEstimated = combos * memoryState.maxPages;
}

async function start(payload) {
  if (memoryState && memoryState.running) return false;

  memoryState = {
    ...DEFAULT_STATE,
    ...payload,
    running: true,
    paused: false,
    currentComboIndex: 0,
    currentPage: 0,
    currentTabId: null,
    startedAt: Date.now(),
    completedAt: null,
    status: 'Starting...',
  };
  await computeTotalEstimated();
  await saveState();
  if (payload.clearPrevious) await setResults([]);

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
  memoryState.status = 'Resuming...';
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
  const effectiveCombos = combos.length ? combos : [''];

  while (memoryState.running && memoryState.currentComboIndex < effectiveCombos.length) {
    const combo = effectiveCombos[memoryState.currentComboIndex];
    const query = (baseQuery + ' ' + combo).trim();

    while (memoryState.running && memoryState.currentPage < memoryState.maxPages) {
      const url = buildSearchUrl(memoryState.engine, query, memoryState.currentPage);
      await updateStatus(`Scraping ${memoryState.engine} | combo ${memoryState.currentComboIndex + 1}/${effectiveCombos.length} | page ${memoryState.currentPage + 1}/${memoryState.maxPages}`);

      try {
        await navigateAndScrape(url);
      } catch (e) {
        memoryState.status = 'Error: ' + e.message;
        memoryState.running = false;
        memoryState.paused = true;
        await saveState();
        return;
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

  memoryState.running = false;
  memoryState.paused = false;
  memoryState.completedAt = Date.now();
  memoryState.status = memoryState.completedAt ? 'Finished' : 'Ready';
  await saveState();
}

async function navigateAndScrape(url) {
  // Create or reuse a single tab/window for scraping.
  let tabId;
  if (memoryState.currentTabId) {
    try {
      await chrome.tabs.get(memoryState.currentTabId);
      await chrome.tabs.update(memoryState.currentTabId, { url, active: false });
      tabId = memoryState.currentTabId;
    } catch (e) {
      memoryState.currentTabId = null;
    }
  }

  if (!memoryState.currentTabId) {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    memoryState.currentTabId = tabId;
    await saveState();
  }

  // Wait for page load + some buffer for scripts to render results.
  await waitForTabLoad(tabId);
  await sleep(1500);

  // Inject content script if not present.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js'],
    });
    await sleep(500);
  } catch (e) {
    // already injected or unsupported
  }

  const response = await sendToTab(tabId, { action: 'scrapeLinks', engine: memoryState.engine });
  if (!response || !response.links) return;

  const existing = await getResults();
  const seen = new Set(memoryState.removeDuplicates ? existing.map((r) => normalizeUrl(r.url)) : []);
  const newRecords = [];

  for (const item of response.links) {
    const norm = normalizeUrl(item.url);
    if (memoryState.removeDuplicates && seen.has(norm)) continue;
    seen.add(norm);
    newRecords.push({
      url: item.url,
      title: item.title || '',
      engine: memoryState.engine,
      query: (memoryState.baseQuery + ' ' + (memoryState.combos[memoryState.currentComboIndex] || '')).trim(),
      page: memoryState.currentPage + 1,
      capturedAt: new Date().toISOString(),
    });
  }

  await setResults(existing.concat(newRecords));
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Failsafe
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 20000);
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
