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

  function detectCaptcha() {
    if (!document.body && !document.documentElement) return false;
    const url = location.href.toLowerCase();

    // Strong URL / structural indicators first.
    const hasCaptchaElement = !!document.querySelector(
      'form[action*="/sorry"], #captcha, #recaptcha, .g-recaptcha, iframe[src*="recaptcha"], iframe[src*="captcha"]'
    );
    const inCaptchaUrl = /(\/sorry|captcha|recaptcha)/.test(url);

    if (hasCaptchaElement || inCaptchaUrl) return true;

    // Conservative text checks for common challenge phrases.
    const text = (document.body?.innerText || '').toLowerCase();
    const phrases = [
      'unusual traffic',
      'our systems have detected unusual traffic',
      "i'm not a robot",
      'i am not a robot',
      'type the text',
    ];
    return phrases.some((p) => text.includes(p));
  }

  const NEXT_PAGE_SELECTORS = {
    google: 'a#pnnext, a[aria-label="Next page"], #xjs a:has(> svg), .DwpMZe',
    bing: 'a.sb_pagN, a[title="Next page"]',
    yahoo: 'a.next, .pagination a.next',
    duckduckgo: 'input[name="next"], .nav-link form input[type="submit"], a:has-text(Next)',
    brave: 'a[aria-label="Next page"], a.next, .pagination-next',
  };

  async function scrollToBottom() {
    return new Promise((resolve) => {
      const step = Math.max(window.innerHeight * 0.75, 400);
      let lastY = -1;
      let scrolls = 0;
      const timer = setInterval(() => {
        const y = window.scrollY;
        window.scrollBy(0, step);
        scrolls++;
        const atBottom = (window.innerHeight + window.scrollY) >= (document.body.scrollHeight - 50);
        if (atBottom || window.scrollY === lastY || scrolls > 40) {
          clearInterval(timer);
          resolve();
        }
        lastY = y;
      }, 120);
      // Failsafe
      setTimeout(() => { clearInterval(timer); resolve(); }, 6000);
    });
  }

  function clickNextPage(engine) {
    const selector = NEXT_PAGE_SELECTORS[engine];
    if (!selector) return false;
    const el = document.querySelector(selector);
    if (!el) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.click();
    return true;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'scrapeLinks') {
      try {
        const engine = message.engine || 'google';
        // Even if CAPTCHA-like text exists, a page with real listing URLs is a
        // normal results page, not a challenge. So scrape first.
        const links = scrapeLinks(engine);
        if (links.length > 0) {
          return sendResponse({ links, engine, captcha: false, count: links.length });
        }
        if (detectCaptcha()) {
          return sendResponse({ links: [], captcha: true, count: 0 });
        }
        sendResponse({ links, engine, captcha: false, count: links.length });
      } catch (e) {
        sendResponse({ links: [], engine: message.engine, captcha: false, count: 0, error: e.message });
      }
    }

    if (message.action === 'goToNextPage') {
      (async () => {
        const engine = message.engine || 'google';
        await scrollToBottom();
        const ok = clickNextPage(engine);
        sendResponse({ ok });
      })();
      return true;
    }
  });

  injected = true;
})();
