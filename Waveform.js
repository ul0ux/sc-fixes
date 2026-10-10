// ==UserScript==
// @name         SoundCloud Bottom Player Waveform
// @namespace    local.soundcloud.bottom-waveform
// @version      1.8.0
// @description  Real track waveforms in the bottom player, with SoundCloud's own seeking and live progress.
// @match        https://soundcloud.com/*
// @match        https://www.soundcloud.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      soundcloud.com
// @connect      wave.sndcdn.com
// @noframes
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  const READY = 'sc-bottom-waveform-ready';
  const LOADING = 'sc-bottom-waveform-loading';
  const HOVERING = 'sc-bottom-waveform-hovering';
  const TO_PLACEHOLDER_MS = 220; // Morph from the previous song's waveform to the placeholder.
  const TO_WAVEFORM_MS = 450;    // Morph from the placeholder to the real waveform.
  const PENDING_MS = 5000;       // After clicking a song, how long to wait for SoundCloud to switch to it.
  const PENDING_UNKNOWN_MS = 1500; // Same, when the click's song could not be identified (e.g. Next).
  // Clicks that start a song: play buttons, and playlist rows (clicked outside their links and buttons).
  const PLAY_CONTROL = '.sc-button-play, .playButton, .playableTile__playButton, [class*="__playButton"]';
  const SONG_ROW = '.trackItem, .compactTrackListItem, .trackList__item';
  const SONG_CONTAINER = '.soundList__item, .trackList__item, .badgeList__item, .soundBadgeList__item, .sound, .soundBadge, .trackItem, .compactTrackListItem, .playableTile, .queueItemView, .sound__header, .fullListenHero, .listenHero';
  const SKIP_CONTROL = '.skipControl__next, .skipControl__previous, .playControls__next, .playControls__prev';
  const PLAYER = 'sc-bottom-waveform-player';
  const HEIGHT = 38;
  const CACHE_LIMIT = 20;
  const TICK_MS = 1000;       // Fallback check for track and player changes; changes are normally seen at once.
  const THEME_MS = 2000;      // Colors are re-read this often at most, unless the theme visibly changes.
  const HINT_WAIT = 600;      // How long to wait for a waveform address from the Likes & Long Lists script.
  const STORE_MAX = 2000;     // Waveforms kept between visits (about 1.3 KB each).
  const STORE_BUCKETS = 1000; // Peaks kept per saved waveform.
  const FALLBACK_GRAY = 'rgba(128, 128, 128, 0.45)';
  const FALLBACK_ORANGE = '#ff5500';
  const cache = new Map();
  const colorMemo = new Map();
  let currentKey = '';
  let generation = 0;
  let samples = null;
  let wrapper = null;
  let timeline = null;
  let base = null;    // Unplayed waveform.
  let played = null;  // Played waveform, revealed with a clip as the song plays.
  let layerSignature = '';
  let lastClip = '';
  let hoverLayer = null;     // The stretch you would jump over, shown while pointing at the waveform.
  let cursorLine = null;     // Thin line under the pointer.
  let timeTag = null;        // The time you would jump to.
  let hoverRatio = null;     // Where the pointer is along the waveform (0-1), or null.
  let hoverRect = null;
  let hoverQueued = false;
  let lastHoverClip = '';
  let observedBar = null;
  let unsupported = false;
  let wrapperWidth = 0;
  let colors = null;
  let themeCheckedAt = 0;
  let source = null;        // What is shown: { kind: 'placeholder' | 'waveform', key, samples }.
  let shown = null;         // Bar heights currently drawn (0-1), one per bar.
  let geometry = null;      // Size and colors of the current drawing.
  let morph = null;         // { from, to, start, duration } while changing shape.
  let frame = 0;
  let drawnSource = null;   // The source the drawn bars show (or are gliding towards).
  let failed = false;       // Loading failed: show SoundCloud's own bar until a retry.
  let pending = null;       // A song you just clicked, before SoundCloud switches to it.
  const inflight = new Map(); // Song -> its waveform download, so a song is never fetched twice at once.
  let loading = false;
  let attempts = 0;
  let retryAt = 0;

  // Follow SoundCloud's progress bar as it changes instead of waiting for the next poll.
  const observer = new MutationObserver(updateProgress);
  // Track the player's width without forcing the browser to recalculate layout.
  const resizer = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
    for (const entry of entries) {
      if (entry.target !== wrapper) continue;
      const box = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0] : entry.borderBoxSize;
      wrapperWidth = box?.inlineSize || entry.contentRect.width;
      hoverRect = null;
      if (source && !failed && !document.hidden && wrapper.closest('.playbackTimeline.is-scrubbable')) paint();
    }
  }) : null;
  // A theme switch changes classes or styles on <html> or <body>.
  const themeWatcher = new MutationObserver(() => { colors = null; });
  for (const element of [document.documentElement, document.body]) {
    if (element) themeWatcher.observe(element, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  }
  const probe = document.createElement('canvas').getContext('2d');

  const style = document.createElement('style');
  style.textContent = `
    .${PLAYER} > .playbackTimeline__timePassed,
    .${PLAYER} > .playbackTimeline__duration {
      flex: 0 0 5em !important;
      width: 5em;
      min-width: 5em;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .playbackTimeline__progressWrapper.${READY} {
      min-height: ${HEIGHT}px;
      box-sizing: border-box;
    }
    .${READY} > .playbackTimeline__progressBackground,
    .${READY} > .playbackTimeline__progressBar {
      opacity: 0 !important;
    }
    .${READY} > .playbackTimeline__progressHandle {
      top: calc(50% + ${Math.round(HEIGHT * 0.72 - HEIGHT / 2)}px);
      z-index: 2;
      pointer-events: none;
    }
    .sc-bottom-waveform-canvas {
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 100%;
      height: ${HEIGHT}px;
      pointer-events: none !important;
      display: block;
    }
    .sc-bottom-waveform-played {
      clip-path: inset(0 100% 0 0);
    }
    .sc-bottom-waveform-canvas {
      transition: opacity 350ms ease;
    }
    .${LOADING} > .sc-bottom-waveform-canvas {
      opacity: 0.5;
    }
    /* Pointing at the waveform previews the jump: the stretch between where the
       song is and where you point is drawn in faded orange, with a thin line and
       the time at the pointer. Seeking itself is still SoundCloud's own. */
    .${READY} > .sc-bottom-waveform-hover {
      clip-path: inset(0 100% 0 0);
      opacity: 0;
      transition: opacity 120ms ease;
    }
    .${HOVERING}.${READY} > .sc-bottom-waveform-hover {
      opacity: 0.42;
    }
    .sc-bottom-waveform-cursor, .sc-bottom-waveform-time {
      position: absolute;
      left: 0;
      pointer-events: none;
      opacity: 0;
      transition: opacity 120ms ease;
      z-index: 1;
    }
    .sc-bottom-waveform-cursor {
      top: calc(50% - ${HEIGHT / 2 - 15}px);
      width: 1px;
      height: ${Math.round(HEIGHT * 0.72 + HEIGHT * 0.72 * 0.26 - 15)}px;
      background: var(--sc-wf-ink, rgba(128, 128, 128, 0.7));
    }
    .sc-bottom-waveform-time {
      top: calc(50% - ${HEIGHT / 2}px);
      padding: 0 5px;
      border-radius: 3px;
      background: var(--sc-wf-accent, #ff5500);
      color: #fff;
      font: 600 10px/15px system-ui, -apple-system, "Segoe UI", sans-serif;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.02em;
      white-space: nowrap;
    }
    .${HOVERING}.${READY} > .sc-bottom-waveform-cursor,
    .${HOVERING}.${READY} > .sc-bottom-waveform-time {
      opacity: 1;
    }
    @media (prefers-reduced-motion: reduce) {
      .sc-bottom-waveform-canvas, .sc-bottom-waveform-cursor, .sc-bottom-waveform-time { transition: none; }
    }
  `;
  document.head.append(style);

  function trackKey(value) {
    try {
      const url = new URL(value, location.origin);
      if (!['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname)
          || url.protocol !== 'https:') return '';
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length < 2 || parts.length > 3
          || (parts.length === 3 && !parts[2].startsWith('s-'))) return '';
      // Preserve private-track secret links, but discard tracking parameters.
      const secret = url.searchParams.get('secret_token');
      return `https://soundcloud.com/${parts.join('/')}${secret ? `?secret_token=${encodeURIComponent(secret)}` : ''}`;
    } catch {
      return '';
    }
  }

  // "artist/track" for any form of a track link, with or without a secret segment.
  function trackPath(value) {
    const key = trackKey(value);
    return key ? new URL(key).pathname.split('/').filter(Boolean).slice(0, 2).join('/').toLowerCase() : '';
  }

  // The bottom player, found once and reused. It sits at the very end of the
  // page, so searching the whole page for anything in it means walking past
  // every song drawn above it, several times a second.
  let cachedPlayer = null, playerLookedAt = 0;
  function player() {
    if (cachedPlayer?.isConnected) return cachedPlayer;
    if (Date.now() - playerLookedAt < 1000) return null;
    playerLookedAt = Date.now();
    cachedPlayer = document.querySelector('.playControls');
    return cachedPlayer;
  }
  // Search inside the player (or, before it exists, the page).
  function inPlayer(selector) {
    return (player() || document).querySelector(selector);
  }
  function activeTrack() {
    const link = inPlayer('.playbackSoundBadge__titleLink');
    return link ? trackKey(link.getAttribute('href')) : '';
  }

  function request(url, anonymous = false) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, anonymous, timeout: 15000,
        onload(response) {
          if (response.status >= 200 && response.status < 300) {
            resolve({ text: response.responseText, url: response.finalUrl || url });
          } else reject(new Error(`Request failed (${response.status})`));
        },
        onerror: () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Request timed out')),
        onabort: () => reject(new Error('Request cancelled')),
      });
    });
  }

  // Extract the JSON array that starts at `start`, ignoring any code after it.
  function jsonArray(text, start) {
    if (text[start] !== '[') return null;
    let depth = 0, inString = false, escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === '[' || char === '{') depth++;
      else if (char === ']' || char === '}') {
        depth--;
        if (depth === 0) return text.slice(start, index + 1);
      }
    }
    return null;
  }

  function findTrack(html, urls) {
    const wanted = new Set(urls.map(trackPath).filter(Boolean));
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
      const script = match[1];
      const marker = /(?:window\.)?__sc_hydration\s*=\s*/.exec(script);
      if (!marker) continue;
      try {
        const json = jsonArray(script, marker.index + marker[0].length);
        const entries = json ? JSON.parse(json) : null;
        if (!Array.isArray(entries)) continue;
        const track = entries.filter(entry => entry?.hydratable === 'sound').map(entry => entry.data)
          .find(item => item?.waveform_url && wanted.has(trackPath(item.permalink_url)));
        if (track) return track;
      } catch { /* An unrelated or incomplete hydration script is not track data. */ }
    }
    throw new Error('Track waveform unavailable');
  }

  function waveformURL(value) {
    const url = new URL(value);
    // Some tracks point at the PNG rendering. The same waveform is also served as JSON.
    if (url.hostname === 'wave.sndcdn.com' && url.pathname.endsWith('.png')) {
      url.pathname = url.pathname.replace(/\.png$/, '.json');
    }
    if (url.protocol !== 'https:' || url.hostname !== 'wave.sndcdn.com' || !url.pathname.endsWith('.json')) {
      throw new Error('Unsupported waveform URL');
    }
    return url.href;
  }

  function validateSamples(data) {
    if (!Array.isArray(data?.samples) || data.samples.length < 2 || data.samples.length > 100000
        || !data.samples.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
      throw new Error('Invalid waveform data');
    }
    const peak = data.samples.reduce((max, value) => Math.max(max, value), 1);
    const scale = Math.max(peak, Number(data.height) || 0);
    return data.samples.map(value => value / scale);
  }

  // The waveform address published by the Likes & Long Lists script for the
  // song that is starting. Avoids downloading the song's whole web page.
  function hintElement() {
    return document.getElementById('sc-waveform-hints');
  }
  function waveformHint(key) {
    const path = trackPath(key);
    try {
      const hints = JSON.parse(hintElement()?.textContent || '[]');
      const hint = Array.isArray(hints) ? hints.find(item => item?.path === path) : null;
      return typeof hint?.waveform === 'string' ? hint.waveform : null;
    } catch {
      return null;
    }
  }

  // Waveforms kept between visits, as 1,000 peaks packed into bytes.
  const canStore = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  function encodeSamples(values) {
    const count = Math.min(STORE_BUCKETS, values.length);
    let binary = '';
    for (let index = 0; index < count; index++) {
      const start = Math.floor(index * values.length / count);
      const end = Math.max(start + 1, Math.floor((index + 1) * values.length / count));
      let peak = 0;
      for (let sample = start; sample < end; sample++) peak = Math.max(peak, values[sample]);
      binary += String.fromCharCode(Math.round(Math.min(1, peak) * 255));
    }
    return btoa(binary);
  }
  function decodeSamples(text) {
    const binary = atob(text);
    if (binary.length < 2) return null;
    const values = new Array(binary.length);
    for (let index = 0; index < binary.length; index++) values[index] = binary.charCodeAt(index) / 255;
    return values;
  }
  function storedSamples(key) {
    const path = trackPath(key);
    if (!canStore || !path) return null;
    try {
      const text = GM_getValue(`wf:${path}`, null);
      return typeof text === 'string' ? decodeSamples(text) : null;
    } catch {
      return null;
    }
  }
  function storeSamples(key, values) {
    const path = trackPath(key);
    if (!canStore || !path) return;
    try {
      GM_setValue(`wf:${path}`, encodeSamples(values));
      const index = GM_getValue('wf-index', []);
      const order = (Array.isArray(index) ? index : []).filter(item => item !== path);
      order.push(path);
      while (order.length > STORE_MAX) {
        const evicted = order.shift();
        if (typeof GM_deleteValue === 'function') GM_deleteValue(`wf:${evicted}`);
      }
      GM_setValue('wf-index', order);
    } catch { /* Keeping it for this visit only is fine. */ }
  }

  async function downloadWaveform(key) {
    const sources = [];
    const hint = waveformHint(key);
    if (hint) sources.push(async () => hint);
    sources.push(async () => {
      const page = await request(key);
      return findTrack(page.text, [key, page.url]).waveform_url;
    });
    let failure;
    for (const source of sources) {
      try {
        const address = waveformURL(await source());
        return validateSamples(JSON.parse((await request(address, true)).text));
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  }

  function remember(key, values) {
    cache.delete(key);
    cache.set(key, values);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }
  function waitForHint(key, ms) {
    return new Promise(resolve => {
      const until = Date.now() + ms;
      const check = () => (waveformHint(key) || Date.now() >= until ? resolve() : setTimeout(check, 50));
      check();
    });
  }
  // The song's waveform from memory, from the saved copy, or downloaded.
  // Started as early as the click, and shared with the normal load after it.
  function fetchSamples(key) {
    const known = cache.get(key) || storedSamples(key);
    if (known) { remember(key, known); return Promise.resolve(known); }
    if (inflight.has(key)) return inflight.get(key);
    const promise = (async () => {
      // Give the Likes & Long Lists script a moment to publish this song's
      // waveform address, if it is installed, before downloading the page.
      if (hintElement()) await waitForHint(key, HINT_WAIT);
      const values = await downloadWaveform(key);
      storeSamples(key, values);
      remember(key, values);
      return values;
    })().finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  async function loadTrack(key, token) {
    loading = true;
    attempts++;
    try {
      const result = await fetchSamples(key);
      // Track changes can finish loading out of order.
      if (token !== generation || activeTrack() !== key) return;
      samples = result;
      failed = false;
      setSource({ kind: 'waveform', key, samples: result });
      tick();
    } catch {
      if (token === generation) {
        retryAt = Date.now() + 30000;
        // Show SoundCloud's own timeline while the waveform cannot be loaded.
        failed = true;
        queueMicrotask(tick);
      }
    } finally {
      if (token === generation) loading = false;
    }
  }

  // A color the canvas accepts, or the fallback for invalid or fully transparent values.
  function usableColor(value, fallback) {
    const memoKey = `${value}|${fallback}`;
    if (colorMemo.has(memoKey)) return colorMemo.get(memoKey);
    let result = fallback;
    if (probe && value) {
      probe.fillStyle = '#010203';
      probe.fillStyle = value;
      const normalized = String(probe.fillStyle);
      const invalid = normalized === '#010203' && value.trim().toLowerCase() !== '#010203';
      const transparent = /^rgba\(.*,\s*0(?:\.0+)?\)$/.test(normalized);
      if (!invalid && !transparent) result = value;
    }
    if (colorMemo.size > 50) colorMemo.clear();
    colorMemo.set(memoKey, result);
    return result;
  }

  // A color as [r, g, b, a], via the canvas (which accepts any CSS color).
  function rgba(color) {
    if (!probe) return [128, 128, 128, 1];
    probe.fillStyle = '#000000';
    probe.fillStyle = color;
    const value = String(probe.fillStyle);
    if (value.startsWith('#')) return [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16)).concat(1);
    const parts = value.match(/[\d.]+/g)?.map(Number) || [128, 128, 128, 1];
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }
  function themeColors(bar) {
    const styles = getComputedStyle(wrapper);
    const text = styles.color.match(/\d+(?:\.\d+)?/g);
    const textGray = text && text.length >= 3 ? `rgba(${text[0]}, ${text[1]}, ${text[2]}, 0.45)` : FALLBACK_GRAY;
    const primary = styles.getPropertyValue('--primary-rgb').trim();
    const gray = usableColor(primary ? `rgba(${primary}, 0.45)` : '', usableColor(textGray, FALLBACK_GRAY));
    const orange = usableColor(getComputedStyle(bar).backgroundColor, FALLBACK_ORANGE);
    // The played bars get a little depth: the accent at the bottom, a lighter
    // tone of it at the top.
    const [r, g, b] = rgba(orange);
    const lift = value => Math.round(value + (255 - value) * 0.28);
    const [ir, ig, ib] = rgba(gray);
    return {
      gray, orange,
      highlight: `rgb(${lift(r)}, ${lift(g)}, ${lift(b)})`,
      ink: `rgba(${ir}, ${ig}, ${ib}, 0.75)`,
    };
  }

  function detach() {
    observer.disconnect();
    observedBar = null;
    cancelAnimationFrame(frame);
    frame = 0;
    // Finish a glide in progress, so a rebuilt player continues from its end.
    if (morph) { shown = morph.to; morph = null; }
    wrapper?.classList.remove(READY, LOADING);
    timeline?.classList.remove(PLAYER);
    timeline = null;
    wrapper?.classList.remove(HOVERING);
    base?.remove();
    played?.remove();
    hoverLayer?.remove();
    cursorLine?.remove();
    timeTag?.remove();
    base = played = hoverLayer = cursorLine = timeTag = null;
    geometry = null;
    layerSignature = lastClip = lastHoverClip = '';
  }

  function progressRatio(bar) {
    // SoundCloud normally sets the bar's width as a percentage; read it without forcing layout.
    const inline = bar.style.width.trim();
    if (inline.endsWith('%')) {
      const percent = parseFloat(inline);
      if (Number.isFinite(percent)) return Math.max(0, Math.min(1, percent / 100));
    }
    const width = wrapper.getBoundingClientRect().width;
    return width > 0 ? Math.max(0, Math.min(1, bar.getBoundingClientRect().width / width)) : 0;
  }

  function updateProgress() {
    if (!wrapper || !played?.isConnected || !observedBar?.isConnected) return;
    const progress = progressRatio(observedBar);
    const pointing = hoverRatio !== null && wrapper.classList.contains(HOVERING) ? hoverRatio : null;
    // Pointing behind the playhead: what you would skip back over fades out.
    const playedTo = pointing === null ? progress : Math.min(progress, pointing);
    const clip = `inset(0 ${((1 - playedTo) * 100).toFixed(2)}% 0 0)`;
    if (clip !== lastClip) {
      played.style.clipPath = clip;
      lastClip = clip;
    }
    if (hoverLayer) {
      const from = pointing === null ? 0 : Math.min(progress, pointing);
      const to = pointing === null ? 0 : Math.max(progress, pointing);
      const hoverClip = `inset(0 ${((1 - to) * 100).toFixed(2)}% 0 ${(from * 100).toFixed(2)}%)`;
      if (hoverClip !== lastHoverClip) {
        hoverLayer.style.clipPath = hoverClip;
        lastHoverClip = hoverClip;
      }
    }
  }

  // ---- Pointing at the waveform ----
  function clockSeconds(element) {
    const text = element?.querySelector('[aria-hidden="true"]')?.textContent || element?.textContent || '';
    const match = text.match(/(-)?((?:\d+:)?\d+:\d{2})/);
    if (!match) return NaN;
    const seconds = match[2].split(':').reduce((total, value) => total * 60 + Number(value), 0);
    return match[1] ? -seconds : seconds;
  }
  // The song's length, also when SoundCloud shows the time remaining instead.
  function songLength() {
    const shown = clockSeconds(inPlayer('.playbackTimeline__duration'));
    if (!(shown < 0)) return shown;
    return clockSeconds(inPlayer('.playbackTimeline__timePassed')) - shown;
  }
  function clockText(seconds) {
    const total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, rest = String(total % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
  }
  function renderHover() {
    hoverQueued = false;
    if (!wrapper || !played?.isConnected) return;
    const on = hoverRatio !== null && source?.kind === 'waveform';
    wrapper.classList.toggle(HOVERING, on);
    updateProgress();
    if (!on || !cursorLine || !timeTag) return;
    const width = hoverRect?.width || wrapperWidth;
    const x = hoverRatio * width;
    cursorLine.style.transform = `translateX(${Math.round(x)}px)`;
    const length = songLength();
    const text = Number.isFinite(length) && length > 0 ? clockText(hoverRatio * length) : '';
    if (timeTag.textContent !== text) timeTag.textContent = text;
    timeTag.style.display = text ? '' : 'none';
    // Keep the tag inside the waveform without measuring it (digits are fixed-width).
    const half = (text.length * 6.2 + 10) / 2;
    timeTag.style.transform = `translateX(${Math.round(Math.max(0, Math.min(width - 2 * half, x - half)))}px)`;
  }
  function scheduleHover() {
    if (hoverQueued) return;
    hoverQueued = true;
    requestAnimationFrame(renderHover);
  }
  const hoverWatched = new WeakSet();
  function watchHover(target) {
    if (!target || hoverWatched.has(target)) return;
    hoverWatched.add(target);
    target.addEventListener('pointermove', event => {
      if (event.pointerType !== 'mouse' || target !== wrapper) return;
      // Measured once per visit of the pointer, not on every move.
      if (!hoverRect) hoverRect = target.getBoundingClientRect();
      if (!hoverRect.width) return;
      hoverRatio = Math.max(0, Math.min(1, (event.clientX - hoverRect.left) / hoverRect.width));
      scheduleHover();
    }, { passive: true });
    target.addEventListener('pointerleave', () => {
      hoverRatio = null;
      hoverRect = null;
      scheduleHover();
    }, { passive: true });
  }

  // Real waveform: the loudest sample in each bar's stretch of the song.
  function waveformHeights(values, count) {
    const heights = new Float32Array(count);
    for (let index = 0; index < count; index++) {
      const start = Math.floor(index * values.length / count);
      const end = Math.max(start + 1, Math.floor((index + 1) * values.length / count));
      let peak = 0;
      for (let sample = start; sample < end; sample++) peak = Math.max(peak, values[sample] || 0);
      heights[index] = peak;
    }
    return heights;
  }
  // Placeholder: a calm, waveform-like shape that is the same every time for
  // a given song, so it does not flicker while the real one loads.
  function placeholderHeights(key, count) {
    let seed = 2166136261;
    for (let index = 0; index < key.length; index++) seed = Math.imul(seed ^ key.charCodeAt(index), 16777619);
    const random = () => {
      seed = (seed + 0x6D2B79F5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    const phases = [random(), random(), random()].map(value => value * Math.PI * 2);
    const heights = new Float32Array(count);
    for (let index = 0; index < count; index++) {
      const x = count > 1 ? index / (count - 1) : 0.5;
      const swell = 0.5 + 0.22 * Math.sin(Math.PI * 2 * 1.3 * x + phases[0])
        + 0.14 * Math.sin(Math.PI * 2 * 4.7 * x + phases[1]) + 0.08 * Math.sin(Math.PI * 2 * 13 * x + phases[2]);
      const envelope = 0.6 + 0.4 * Math.sin(Math.PI * x);
      heights[index] = Math.max(0.1, Math.min(0.5, swell * 0.55 * envelope + random() * 0.06));
    }
    return heights;
  }
  function targetHeights(count) {
    if (source?.kind === 'waveform') return waveformHeights(source.samples, count);
    return placeholderHeights(source?.key || '', count);
  }

  // Draw the layers from bar heights: grey for what is still to come, orange
  // for what has played, faded orange for the jump preview. Playback itself
  // only moves clips; nothing is redrawn while a song plays.
  function draw(heights) {
    if (!geometry || !base || !played) return;
    const { pixelWidth, pixelHeight, unit, baseline, count, gray, orange, highlight } = geometry;
    const maxHeight = baseline - 2 * unit;
    const layers = [[base, gray, false], [played, orange, true]];
    if (hoverLayer) layers.push([hoverLayer, orange, true]);
    for (const [layer, color, lit] of layers) {
      // Resizing a canvas reallocates and clears it, so only do it when the size changed.
      if (layer.width !== pixelWidth) layer.width = pixelWidth;
      if (layer.height !== pixelHeight) layer.height = pixelHeight;
      const context = layer.getContext('2d');
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, pixelWidth, pixelHeight);
      let fill = color;
      if (lit && highlight) {
        fill = context.createLinearGradient(0, baseline - maxHeight, 0, baseline);
        fill.addColorStop(0, highlight);
        fill.addColorStop(1, color);
      }
      const rounded = typeof context.roundRect === 'function';
      // Bars, with softly rounded tops, in one path.
      context.globalAlpha = 1;
      context.fillStyle = fill;
      context.beginPath();
      for (let index = 0; index < count; index++) {
        // Snap bars to whole device pixels so they stay sharp at any zoom level.
        const left = Math.round(index * pixelWidth / count);
        const right = Math.round((index + 1) * pixelWidth / count);
        const barWidth = Math.max(1, right - left - unit);
        const height = Math.max(unit, Math.round(heights[index] * maxHeight));
        if (rounded) context.roundRect(left, baseline - height, barWidth, height, [Math.min(barWidth / 2, unit * 1.5), Math.min(barWidth / 2, unit * 1.5), 0, 0]);
        else context.rect(left, baseline - height, barWidth, height);
      }
      context.fill();
      // SoundCloud's mirrored reflection below the line, kept faint.
      context.globalAlpha = 0.3;
      context.fillStyle = color;
      context.beginPath();
      for (let index = 0; index < count; index++) {
        const left = Math.round(index * pixelWidth / count);
        const right = Math.round((index + 1) * pixelWidth / count);
        const barWidth = Math.max(1, right - left - unit);
        const height = Math.max(unit, Math.round(heights[index] * maxHeight));
        context.rect(left, baseline + unit, barWidth, Math.max(unit, Math.round(height * 0.26)));
      }
      context.fill();
      context.globalAlpha = 1;
    }
  }

  // Change what is shown. With something already drawn, the bars glide from
  // their current heights to the new ones; otherwise the new shape appears at once.
  function setSource(next) {
    source = next;
    if (wrapper) wrapper.classList.toggle(LOADING, next.kind !== 'waveform');
    startMorph();
  }
  function startMorph() {
    if (!geometry || !shown || drawnSource === source) return;
    drawnSource = source;
    const to = targetHeights(geometry.count);
    morph = {
      from: Float32Array.from(shown),
      to,
      start: performance.now(),
      duration: source?.kind === 'waveform' ? TO_WAVEFORM_MS : TO_PLACEHOLDER_MS,
    };
    if (!frame) frame = requestAnimationFrame(animate);
  }
  function animate(now) {
    frame = 0;
    if (!morph || !geometry || morph.to.length !== shown?.length) { morph = null; return; }
    const progress = Math.min(1, Math.max(0, (now - morph.start) / morph.duration));
    const eased = 1 - (1 - progress) ** 3;
    for (let index = 0; index < shown.length; index++) {
      shown[index] = morph.from[index] + (morph.to[index] - morph.from[index]) * eased;
    }
    draw(shown);
    if (progress < 1) frame = requestAnimationFrame(animate);
    else morph = null;
  }

  function makeLayer(extraClass) {
    const layer = document.createElement('canvas');
    layer.className = `sc-bottom-waveform-canvas${extraClass ? ` ${extraClass}` : ''}`;
    layer.setAttribute('aria-hidden', 'true');
    return layer;
  }

  function paint() {
    if (unsupported) return;
    const bar = wrapper.querySelector('.playbackTimeline__progressBar');
    if (!bar) { detach(); return; }
    // Proportional time digits otherwise change the flex space every second,
    // changing the number of waveform bars and making the peaks stretch/jump.
    timeline = wrapper.closest('.playbackTimeline');
    timeline?.classList.add(PLAYER);
    // ResizeObserver keeps this current; measure directly only before its first report.
    const width = wrapperWidth || wrapper.getBoundingClientRect().width;
    if (width <= 0) return;
    if (!base?.isConnected || !played?.isConnected) {
      base?.remove();
      played?.remove();
      hoverLayer?.remove();
      cursorLine?.remove();
      timeTag?.remove();
      base = makeLayer('');
      hoverLayer = makeLayer('sc-bottom-waveform-hover');
      played = makeLayer('sc-bottom-waveform-played');
      if (!base.getContext('2d') || !played.getContext('2d') || !hoverLayer.getContext('2d')) { unsupported = true; detach(); return; }
      cursorLine = document.createElement('span');
      cursorLine.className = 'sc-bottom-waveform-cursor';
      cursorLine.setAttribute('aria-hidden', 'true');
      timeTag = document.createElement('span');
      timeTag.className = 'sc-bottom-waveform-time';
      timeTag.setAttribute('aria-hidden', 'true');
      wrapper.append(base, hoverLayer, played, cursorLine, timeTag);
      watchHover(wrapper);
      layerSignature = lastClip = lastHoverClip = '';
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    // Reading computed styles forces a style recalculation, so do it rarely.
    if (!colors || Date.now() - themeCheckedAt > THEME_MS) {
      colors = themeColors(bar);
      themeCheckedAt = Date.now();
    }
    const { gray, orange, highlight, ink } = colors;
    const signature = `${width}:${dpr}:${gray}:${orange}`;
    if (signature !== layerSignature) {
      const count = Math.max(1, Math.floor(width / 3));
      wrapper.style.setProperty('--sc-wf-accent', orange);
      wrapper.style.setProperty('--sc-wf-ink', ink);
      geometry = {
        count, gray, orange, highlight,
        pixelWidth: Math.max(1, Math.round(width * dpr)),
        pixelHeight: Math.round(HEIGHT * dpr),
        unit: Math.max(1, Math.round(dpr)), // One CSS pixel, in device pixels.
        baseline: Math.round(HEIGHT * 0.72 * dpr),
      };
      // A new size starts from the current target; a theme change keeps the shape.
      if (!shown || shown.length !== count) {
        shown = targetHeights(count);
        morph = null;
        drawnSource = source;
      }
      draw(shown);
      layerSignature = signature;
      // The song changed while nothing was drawn: glide to it now.
      startMorph();
    }
    wrapper.classList.toggle(LOADING, source?.kind !== 'waveform');
    if (observedBar !== bar) {
      observer.disconnect();
      observer.observe(bar, { attributes: true, attributeFilter: ['style'] });
      observedBar = bar;
    }
    wrapper.classList.add(READY);
    updateProgress();
  }

  function tick() {
    if (document.hidden) return;
    const key = activeTrack();
    const nextWrapper = inPlayer('.playbackTimeline__progressWrapper');
    if (key !== currentKey) {
      // The song you clicked (or the next one, after Next) is now playing.
      const fromClick = pending && (!pending.key || pending.key === key);
      pending = null;
      generation++;
      currentKey = key;
      samples = null;
      loading = false;
      failed = false;
      attempts = retryAt = 0;
      // Keep the waveform area: glide into a placeholder until this song's
      // waveform arrives, instead of flashing SoundCloud's own bar.
      if (key) {
        const cached = cache.get(key);
        if (cached) { samples = cached; setSource({ kind: 'waveform', key, samples: cached }); }
        else if (fromClick && source?.kind === 'placeholder') {
          // Already showing the placeholder since the click: keep it as it is.
          source = drawnSource = { kind: 'placeholder', key };
          wrapper?.classList.add(LOADING);
        } else setSource({ kind: 'placeholder', key });
      } else {
        source = drawnSource = null;
        shown = null;
        detach();
      }
    }
    if (wrapper !== nextWrapper) {
      detach();
      if (wrapper) resizer?.unobserve(wrapper);
      wrapper = nextWrapper;
      wrapperWidth = 0;
      colors = null;
      if (wrapper) resizer?.observe(wrapper);
    }
    // A click that SoundCloud did not turn into a new song: back to the current one.
    if (pending && Date.now() > pending.until) {
      failed = pending.wasFailed;
      pending = null;
      if (samples) setSource({ kind: 'waveform', key, samples });
      else if (key) setSource({ kind: 'placeholder', key });
    }
    if (!key || !wrapper) return;
    // SoundCloud removes is-scrubbable during advertisements.
    if (!wrapper.closest('.playbackTimeline.is-scrubbable')) { detach(); return; }
    if (failed && !loading) detach();
    else if (source) paint();
    if (!samples && !loading && attempts < 3 && Date.now() >= retryAt && !pending) {
      if (failed) { failed = false; setSource({ kind: 'placeholder', key }); paint(); }
      void loadTrack(key, generation);
    }
  }

  // ---- Reacting the instant you click a song ----

  // A link to a song page (not a profile section, playlist or SoundCloud page).
  const NOT_SONG = /^\/(?:you|discover|search|stream|feed|stations|charts|tags|people|settings|upload|messages|notifications)\/|\/(?:sets|albums|likes|reposts|tracks|followers|following|comments|popular-tracks)(?:\/|$)/;
  function songKey(href) {
    const key = trackKey(href);
    return key && !NOT_SONG.test(new URL(key).pathname) ? key : '';
  }
  // The song a container stands for: its first link to a song page.
  function songIn(container) {
    for (const anchor of container.querySelectorAll('a[href]')) {
      const key = songKey(anchor.getAttribute('href'));
      if (key) return key;
    }
    return '';
  }
  // Works out whether a click starts a song, and which one if it can tell.
  // Returns undefined for clicks that do not start a song.
  function clickedSong(event) {
    const target = event.target;
    if (!(target instanceof Element) || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return undefined;
    if (target.closest('.playControls')) return target.closest(SKIP_CONTROL) ? null : undefined;
    const control = target.closest(PLAY_CONTROL);
    let container;
    if (control) {
      // The playing song's button reads "Pause": clicking it does not change songs.
      const label = `${control.getAttribute('title') || ''} ${control.getAttribute('aria-label') || ''}`;
      if (control.classList.contains('sc-button-pause') || /pause/i.test(label)) return undefined;
      container = control.closest(SONG_CONTAINER);
    } else {
      container = target.closest(SONG_ROW);
      // Links and buttons inside a row do other things (open the song, like it, ...).
      if (!container || target.closest('a, button, input, [role="button"]')) return undefined;
    }
    let key = container ? songIn(container) : '';
    // The big play button on a song's own page.
    if (!key && control && !container?.matches('.soundList__item, .badgeList__item, .soundBadge, .playableTile')) key = songKey(location.href);
    return key || null;
  }
  const clickSongs = new WeakMap(); // Click event -> its song, worked out once for both listeners.
  function onClick(event) {
    const key = clickedSong(event);
    clickSongs.set(event, key);
    if (key === undefined || !wrapper || !currentKey || key === currentKey) return;
    if (!wrapper.closest('.playbackTimeline.is-scrubbable')) return;
    pending = { key, until: Date.now() + (key ? PENDING_MS : PENDING_UNKNOWN_MS), wasFailed: failed };
    failed = false;
    setSource({ kind: 'placeholder', key: key || `next:${currentKey}` });
    paint();
    // Start fetching its waveform right away; the normal load will reuse it.
    if (key) void fetchSamples(key).catch(() => {});
  }
  document.addEventListener('click', onClick, true);

  // A Pause icon means a request was accepted, not that audio has started.
  // Require forward movement of the native playback clock for this track.
  function playbackAdvanced(previous, key, position, now, blocked) {
    if (!key || !Number.isFinite(position) || blocked) return { evidence: null, started: false };
    if (!previous || previous.key !== key) return {
      evidence: { key, position, checked: now, advancingSince: now, steps: 0 }, started: false,
    };
    const delta = position - previous.position;
    const elapsed = Math.max(0, (now - previous.checked) / 1000);
    // A seek/reset is not playback. Large jumps start a fresh observation.
    if (delta < 0 || delta > Math.max(2, elapsed * 3 + 0.25)) return {
      evidence: { key, position, checked: now, advancingSince: now, steps: 0 }, started: false,
    };
    if (delta <= 0) return { evidence: { ...previous, checked: now }, started: false };
    const evidence = { ...previous, position, checked: now, steps: previous.steps + 1 };
    return { evidence, started: evidence.steps >= 1 && now - evidence.advancingSince >= 60 };
  }

  // ---- The play button: instant, steady feedback ----
  //
  // What you see when you press play, in order:
  //  - on press (before you even let go): the button sinks slightly
  //  - on release: it pops back, and immediately shows SoundCloud's "pause"
  //    look, as if the song had already started
  //  - only if the song has not started 140 ms later: a thin ring starts
  //    turning around it (spinners shown too early make things feel slower)
  //  - after 1.5 s: a small "Starting…" note; after 12 s: "Still waiting for
  //    SoundCloud"
  //  - the moment the song's position actually moves: the ring widens and
  //    fades out, revealing SoundCloud's own pause button underneath
  //
  // Why it no longer stutters: the indicator is drawn in its own layer on
  // top of the page, not inside SoundCloud's button. SoundCloud rewrites its
  // buttons several times while a song loads, which used to delete and
  // restart the spinner. The ring now lives for the whole wait, turns on the
  // browser's compositor (smooth even while the page is busy), and is only
  // ever moved with transforms. Playback itself is never touched: the layer
  // ignores the mouse, and SoundCloud's own button underneath gets the clicks.
  function installPlayFeedback() {
    const selector = `${PLAY_CONTROL}, .playControls__play`;
    const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
    const pauseGlyph = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='9.5' y='8' width='4.5' height='16' rx='1.2' fill='%23fff'/%3E%3Crect x='18' y='8' width='4.5' height='16' rx='1.2' fill='%23fff'/%3E%3C/svg%3E\")";
    const css = document.createElement('style');
    css.textContent = `
      .sc-wf-pressed { scale: .9 !important; transition: scale 70ms ease-out !important; }
      .sc-wf-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 2147483600; pointer-events: none; }
      .sc-wf-layer.is-fixed { position: fixed; }
      .sc-wf-indicator { position: absolute; left: 0; top: 0; will-change: transform; }
      .sc-wf-indicator.is-travelling { transition: transform 280ms cubic-bezier(.2, .8, .2, 1); }
      .sc-wf-disc { position: absolute; inset: 0; border-radius: 50%; opacity: 0;
        background: ${pauseGlyph} center / 52% no-repeat, var(--sc-wf-disc, #f50);
        transition: opacity 80ms ease-out; }
      .sc-wf-ring { position: absolute; inset: var(--sc-wf-ring-inset, -4px); border-radius: 50%; box-sizing: border-box;
        border: 2px solid var(--sc-wf-track, rgba(255, 85, 0, .18)); border-top-color: var(--sc-wf-accent, #f50);
        opacity: 0; will-change: transform, opacity; contain: strict;
        animation: sc-wf-turn 720ms linear infinite;
        transition: opacity 160ms ease 140ms, scale 220ms ease; }
      .sc-wf-label { position: absolute; left: 50%; top: calc(100% + 10px); translate: -50% 0;
        padding: 4px 8px; border-radius: 5px; background: #222; color: #fff; white-space: nowrap;
        font: 500 11px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 2px 8px rgba(0, 0, 0, .25);
        opacity: 0; transition: opacity 180ms ease; }
      .sc-wf-indicator.is-above .sc-wf-label { top: auto; bottom: calc(100% + 10px); }
      .sc-wf-indicator.is-shown .sc-wf-disc { opacity: 1; }
      .sc-wf-indicator.is-shown .sc-wf-ring { opacity: 1; }
      .sc-wf-indicator.is-slow .sc-wf-label { opacity: 1; }
      .sc-wf-indicator.is-done .sc-wf-ring { opacity: 0; scale: 1.3; transition: opacity 220ms ease, scale 220ms ease; }
      .sc-wf-indicator.is-done .sc-wf-disc, .sc-wf-indicator.is-done .sc-wf-label { opacity: 0; transition: opacity 180ms ease 60ms; }
      .sc-wf-indicator.is-cancelled * { opacity: 0 !important; transition: opacity 100ms ease !important; }
      @keyframes sc-wf-turn { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) {
        .sc-wf-pressed { scale: 1 !important; }
        .sc-wf-ring { animation: none; border-color: var(--sc-wf-track, rgba(255, 85, 0, .18)); border-top-color: var(--sc-wf-accent, #f50); border-right-color: var(--sc-wf-accent, #f50); }
        .sc-wf-indicator.is-done .sc-wf-ring { scale: 1; }
        .sc-wf-indicator.is-travelling { transition: none; }
      }
    `;
    document.head.append(css);
    // One layer for page buttons (scrolls with the page, even while the page
    // is busy) and one for the bottom player (fixed, like the player).
    const layers = {};
    function layerFor(fixed) {
      const name = fixed ? 'fixed' : 'page';
      if (!layers[name]?.isConnected) {
        layers[name] = document.createElement('div');
        layers[name].className = `sc-wf-layer${fixed ? ' is-fixed' : ''}`;
        layers[name].setAttribute('aria-hidden', 'true');
        document.body.append(layers[name]);
      }
      return layers[name];
    }
    const notice = document.createElement('div');
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    notice.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);pointer-events:none;';
    document.body.append(notice);

    let pressed, pressedSpot = null, state, timer, checkQueued = false, placeQueued = false;
    function buttonFor(event) {
      const button = event.target instanceof Element ? event.target.closest(selector) : null;
      if (!button || button.matches(':disabled, [aria-disabled="true"], .sc-button-disabled')) return null;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return null;
      return button;
    }
    function playing(button) {
      return button?.matches('.sc-button-pause, .playing, .m-playing, [data-state="playing"]')
        || /^pause\b/i.test(button?.getAttribute('title') || '')
        || /^pause\b/i.test(button?.getAttribute('aria-label') || '');
    }
    function buffering(button) {
      return button?.matches('.sc-button-buffering, .buffering, .m-buffering, [aria-busy="true"]');
    }
    function clockSeconds(element) {
      const text = element?.querySelector('[aria-hidden="true"]')?.textContent || element?.textContent || '';
      const match = text.match(/(?:\d+:)?\d+:\d{2}/);
      return match ? match[0].split(':').reduce((total, value) => total * 60 + Number(value), 0) : NaN;
    }
    function progress() {
      const width = inPlayer('.playbackTimeline__progressBar')?.style.width || '';
      const duration = clockSeconds(inPlayer('.playbackTimeline__duration'));
      // Percentages are independent of player resizing and update more often
      // than the visible whole-second clock. Never use a pixel width.
      if (width.endsWith('%') && duration > 0 && Number.isFinite(parseFloat(width))) {
        return parseFloat(width) * duration / 100;
      }
      return clockSeconds(inPlayer('.playbackTimeline__timePassed'));
    }
    // Coalesce bursts of clock changes into one check per frame.
    function scheduleCheck() {
      if (!state || checkQueued) return;
      checkQueued = true;
      requestAnimationFrame(() => { checkQueued = false; check(); });
    }
    let clockTarget;
    const clockObserver = new MutationObserver(scheduleCheck);
    function watchClock() {
      const target = inPlayer('.playbackTimeline');
      if (target === clockTarget) return;
      clockObserver.disconnect(); clockTarget = target;
      if (target) clockObserver.observe(target, { subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['style'] });
    }
    let seeking = false;
    function release() {
      pressed?.classList.remove('sc-wf-pressed');
      pressed = null;
    }

    // ---- The indicator ----
    function build(button) {
      const indicator = document.createElement('span');
      indicator.className = 'sc-wf-indicator';
      const disc = document.createElement('span');
      disc.className = 'sc-wf-disc';
      const ring = document.createElement('span');
      ring.className = 'sc-wf-ring';
      const label = document.createElement('span');
      label.className = 'sc-wf-label';
      indicator.append(disc, ring, label);
      return indicator;
    }
    // Where the button is. A hidden button (SoundCloud shows some only on
    // hover) keeps the last place it was seen.
    function measure(button) {
      const rect = button.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const fixed = !!button.closest('.playControls');
      return { fixed, x: rect.left + (fixed ? 0 : scrollX), y: rect.top + (fixed ? 0 : scrollY), w: rect.width, h: rect.height, bottom: rect.bottom };
    }
    function style(button) {
      // Round play buttons get the optimistic "pause" disc in their own color;
      // the bottom player's plain icon gets just the ring.
      const round = !button.closest('.playControls');
      const color = round ? getComputedStyle(button).backgroundColor : '';
      const opaque = color && !/rgba\(.*,\s*0(?:\.0+)?\)$|transparent/.test(color);
      const indicator = state.indicator;
      indicator.style.setProperty('--sc-wf-disc', opaque ? color : 'var(--sc-wf-accent, #f50)');
      indicator.style.setProperty('--sc-wf-ring-inset', round ? '-4px' : '-7px');
      indicator.firstElementChild.style.display = round ? '' : 'none';
    }
    function place(known) {
      if (!state) return;
      const spot = known || measure(state.button) || state.spot;
      if (!spot) return;
      const { indicator } = state;
      const moving = state.spot && (state.spot.fixed !== spot.fixed || Math.abs(state.spot.x - spot.x) > 2 || Math.abs(state.spot.y - spot.y) > 2);
      if (state.spot && state.spot.fixed !== spot.fixed && !reducedMotion.matches) {
        // Moving between the page and the bottom player: start from where it
        // is on screen now, then glide there.
        const from = { x: state.spot.x - (state.spot.fixed ? 0 : scrollX), y: state.spot.y - (state.spot.fixed ? 0 : scrollY) };
        indicator.classList.remove('is-travelling');
        indicator.style.transform = `translate(${from.x + (spot.fixed ? 0 : scrollX)}px, ${from.y + (spot.fixed ? 0 : scrollY)}px)`;
        layerFor(spot.fixed).append(indicator);
        void indicator.offsetWidth; // Commit the starting point (only on this rare move).
        indicator.classList.add('is-travelling');
      } else if (indicator.parentElement !== layerFor(spot.fixed)) {
        layerFor(spot.fixed).append(indicator);
      }
      if (!state.spot || state.spot.w !== spot.w || state.spot.h !== spot.h) {
        indicator.style.width = `${spot.w}px`;
        indicator.style.height = `${spot.h}px`;
      }
      if (moving || !state.spot) indicator.style.transform = `translate(${spot.x}px, ${spot.y}px)`;
      indicator.classList.toggle('is-above', spot.bottom > innerHeight - 70);
      state.spot = spot;
    }
    function schedulePlace() {
      if (!state || placeQueued) return;
      placeQueued = true;
      requestAnimationFrame(() => { placeQueued = false; place(); });
    }
    function say(text) {
      if (!state || state.said === text) return;
      state.said = text;
      state.indicator.lastElementChild.textContent = text;
      state.indicator.classList.toggle('is-slow', !!text);
      if (notice.textContent !== text) notice.textContent = text;
    }
    // done: the song started (ring widens and fades); otherwise cancelled.
    function finish(done) {
      if (!state) return;
      clearTimeout(timer);
      clockObserver.disconnect(); clockTarget = null;
      const { indicator } = state;
      indicator.classList.add(done ? 'is-done' : 'is-cancelled');
      setTimeout(() => indicator.remove(), done ? 320 : 140);
      state = null;
      notice.textContent = '';
    }
    // If SoundCloud replaced the button, follow the song's new button, or
    // glide down to the bottom player's.
    function retarget() {
      if (state.button.isConnected && location.pathname === state.page) return;
      if (state.retryAt > Date.now()) return;
      state.page = location.pathname;
      let next = null;
      if (state.key) {
        for (const candidate of document.querySelectorAll(PLAY_CONTROL)) {
          const container = candidate.closest(SONG_CONTAINER);
          if (container && songIn(container) === state.key && measure(candidate)) { next = candidate; break; }
        }
      }
      next = next || inPlayer('.playControls__play');
      if (!next) { state.retryAt = Date.now() + 1000; return; }
      if (next !== state.button) {
        state.button = next;
        style(next);
        place();
      }
    }
    function check() {
      if (!state) return;
      clearTimeout(timer);
      if (document.hidden) {
        state.evidence = null;
        timer = setTimeout(check, 500);
        return;
      }
      watchClock();
      retarget();
      const age = Date.now() - state.started;
      const current = activeTrack();
      const bottom = inPlayer('.playControls__play');
      const sameSong = state.key ? trackPath(current) === trackPath(state.key)
        : !!current && current !== state.previous;
      if (sameSong) state.matched = current;
      else if (state.matched && current && current !== state.matched) { finish(false); return; }
      const result = playbackAdvanced(state.evidence, sameSong ? current : '', progress(), Date.now(),
        seeking || !inPlayer('.playbackTimeline.is-scrubbable') || buffering(state.button) || buffering(bottom) || !(playing(bottom) || playing(state.button)));
      state.evidence = result.evidence;
      if (result.started) { finish(true); return; }
      say(age >= 12000 ? 'Still waiting for SoundCloud' : age >= 1500 ? 'Starting…' : '');
      // No timeout: a stalled request keeps its indicator until it plays,
      // the user cancels it with Pause, or another song is requested. Clock
      // changes trigger checks directly; this slower poll is only a fallback
      // (and catches the button moving because the page changed around it).
      // The indicator scrolls with the page by itself; re-measure only now and
      // then, to follow the button if the page shifts around it.
      if (Date.now() - (state.placedAt || 0) > 500) { state.placedAt = Date.now(); schedulePlace(); }
      timer = setTimeout(check, 250);
    }
    function bounce(button) {
      if (reducedMotion.matches || typeof button.animate !== 'function') return;
      // CSS scale preserves SoundCloud's own positioning transforms on artwork.
      try { button.animate([{ scale: '0.9' }, { scale: '1.06', offset: 0.6 }, { scale: '1' }], { duration: 240, easing: 'ease-out' }); } catch { /* Optional. */ }
    }

    // ---- Input ----
    document.addEventListener('pointerdown', event => {
      if (event.target instanceof Element && event.target.closest('.playbackTimeline__progressWrapper')) {
        seeking = true;
        if (state) state.evidence = null;
      }
    }, true);
    document.addEventListener('keydown', event => {
      if (state && event.target instanceof Element && event.target.closest('.playbackTimeline')) state.evidence = null;
    }, true);
    // Press: react before the click even happens (SoundCloud acts on release).
    document.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const button = buttonFor(event);
      if (!button) return;
      release(); pressed = button;
      // Measure before the press shrinks it, so the disc matches its real size.
      pressedSpot = { button, spot: measure(button) };
      button.classList.add('sc-wf-pressed');
      // Start fetching the waveform of the song about to play.
      if (!playing(button)) {
        const key = button.matches('.playControls__play') ? '' : clickedSong(event);
        if (key && key !== currentKey) void fetchSamples(key).catch(() => {});
      }
    }, true);
    document.addEventListener('pointerup', () => { seeking = false; release(); }, true);
    document.addEventListener('pointercancel', () => { seeking = false; release(); }, true);
    window.addEventListener('blur', () => { seeking = false; release(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
    window.addEventListener('resize', schedulePlace, { passive: true });
    document.addEventListener('click', event => {
      if (event.button !== 0) return;
      const button = buttonFor(event);
      if (!button) return;
      release();
      bounce(button);
      if (playing(button)) { finish(false); return; } // Pause cancels a pending start too.
      finish(false);
      const key = button.matches('.playControls__play') ? activeTrack()
        : clickSongs.has(event) ? clickSongs.get(event) : clickedSong(event);
      state = { button, key, previous: activeTrack(), evidence: null, matched: null, started: Date.now(), page: location.pathname, indicator: build(button), spot: null, said: null };
      style(button);
      place(pressedSpot?.button === button ? pressedSpot.spot : null);
      pressedSpot = null;
      // Show it in the same frame: the optimistic disc at once, the ring after
      // a short delay (see the CSS), so quick starts never show a spinner.
      state.indicator.classList.add('is-shown');
      check();
    }, true);
  }
  installPlayFeedback();

  // A small, bounded check also handles SPA navigation and player replacement.
  // No audio interception, framework hooks, API keys, or synthetic seek events.
  window.setInterval(tick, TICK_MS);
  document.addEventListener('visibilitychange', tick);
  // Notice a new song (or a rebuilt player) the moment SoundCloud updates the
  // bottom player, so the placeholder appears in the same frame.
  let watchedPlayer = null;
  let tickQueued = false;
  const playerWatcher = new MutationObserver(() => {
    if (tickQueued) return;
    tickQueued = true;
    queueMicrotask(() => { tickQueued = false; tick(); });
  });
  window.setInterval(() => {
    const root = player();
    if (root === watchedPlayer) return;
    playerWatcher.disconnect();
    watchedPlayer = root;
    if (root) playerWatcher.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  }, 1000);
  tick();
})();
