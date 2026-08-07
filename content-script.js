// Content script: extracts organic search result links.

(function () {
  let injected = false;

  const ENGINE_SELECTORS = {
    google: {
      containers: '#search .g, [data-sokoban-container], div[data-hveid]',
      anchor: 'a[href]',
      skip: /^\/url\?/,
    },
    bing: {
      containers: '#b_content .b_algo, .b_algo',
      anchor: 'a[href]',
      skip: /^\/accounts/,
    },
    yahoo: {
      containers: '#web .algo, .searchCenterFooter ~ div .algo, #main .algo',
      anchor: 'a[href]',
      skip: /^\/r\?/,
    },
    duckduckgo: {
      containers: '.result, .web-result',
      anchor: 'a.result__a, a[href]',
      skip: /^\/l\?/,
    },
    brave: {
      containers: '#results .fdb, .snippet, [data-loc]',
      anchor: 'a[href]',
      skip: /^\/s\?/,
    },
  };

  function isSearchInternal(url, engine) {
    try {
      const u = new URL(url, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
      if (u.host === location.host) return true;
      const cfg = ENGINE_SELECTORS[engine];
      if (cfg && cfg.skip && cfg.skip.test(u.href)) return true;
      return false;
    } catch (e) {
      return true;
    }
  }

  function scrapeLinks(engine) {
    const cfg = ENGINE_SELECTORS[engine] || ENGINE_SELECTORS.google;
    const containers = Array.from(document.querySelectorAll(cfg.containers));
    const links = [];

    if (containers.length) {
      containers.forEach((container, idx) => {
        const anchors = Array.from(container.querySelectorAll(cfg.anchor));
        for (const a of anchors) {
          const href = a.href;
          if (!href) continue;
          if (isSearchInternal(href, engine)) continue;
          links.push({
            url: href,
            title: a.innerText?.trim() || a.title?.trim() || '',
            index: idx,
          });
          break;
        }
      });
    }

    // Fallback if no containers matched: grab the first external link in each logical block.
    if (!links.length) {
      const anchors = Array.from(document.querySelectorAll('a[href^="http"], a[href^="/url"], a[href^="/l?"], a[href^="/r?"]'));
      anchors.forEach((a, idx) => {
        const href = a.href;
        if (!href || isSearchInternal(href, engine)) return;
        links.push({
          url: href,
          title: a.innerText?.trim() || a.title?.trim() || '',
          index: idx,
        });
      });
    }

    return dedupeByUrl(links);
  }

  function dedupeByUrl(arr) {
    const seen = new Set();
    const out = [];
    for (const item of arr) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      out.push(item);
    }
    return out;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'scrapeLinks') {
      const engine = message.engine || 'google';
      const links = scrapeLinks(engine);
      sendResponse({ links, engine, count: links.length });
    }
  });

  injected = true;
})();
