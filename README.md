# Search Link Grabber

A Chrome extension that scrapes organic search result links from multiple search engines across many pages and combination terms.

## Features

- Search engines: Google, Bing, Yahoo, DuckDuckGo, Brave
- Base query + comma separated combo append list
- Scrape up to 30 pages per combo
- Runs in the background service worker so scraping continues even when the popup is closed
- Stop / Resume / Clear controls
- Save results to `chrome.storage.local` (survives browser restarts)
- Download results as CSV, JSON or XLS

## Install

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder
4. Pin the extension to your toolbar

## Usage

1. Open the popup
2. Select a search engine
3. Enter a base query, e.g.
   ```
   site:https://www.volza.com/company-profile Bangladesh p
   ```
4. Enter a comma separated combo list, e.g.
   ```
   garment, textile, rice, jute, leather
   ```
5. Set max pages and delay
6. Click **Start**
7. Close the popup if you like — scraping continues in the background
8. Re-open the popup later to view progress or download results

## Files

- `manifest.json` — extension manifest v3
- `background.js` — service worker orchestrating pages/combos/state/storage
- `content-script.js` — extracts links from search result pages
- `popup.html` / `popup.js` / `popup.css` — extension UI
- `xlsx-writer.js` / `xlsx-shim.js` — lightweight XLS generator
- `icons/` — extension icons
