// ==UserScript==
// @name         SoundCloud Layout
// @namespace    local.soundcloud.layout
// @version      1.1.3
// @description  A tidier SoundCloud for big Likes lists: a fast-scroll rail with song previews and year markers; a list bar with Play in order, Shuffle all, song position and jumps; compact song rows; fewer promotions.
// @match        https://soundcloud.com/*
// @match        https://www.soundcloud.com/*
// @run-at       document-start
// @sandbox      raw
// @grant        none
// @noframes
// @license      MIT
// ==/UserScript==

// Works on its own. With "SoundCloud Likes & Long Lists" 1.8.5 or later also
// turned on, the song position and jumps work on lists drawn as a window
// (where most songs are not on the page at any moment), and the fast-scroll
// rail previews song titles and shows when you liked them.

(() => {
  'use strict';


  const KEY = '__scLayoutV1';
  if (window[KEY]) return;
  window[KEY] = true;

  // ===========================================================================
  // Settings
  // ===========================================================================

  const STORE = 'sc-layout-settings-v1';
  // `flag` is the word added to <html data-scl="..."> while the setting is on.
  // `relayout` settings change the height of songs in lists.
  const OPTIONS = [
    { key: 'listBar', flag: 'list-bar', on: true, label: 'List bar on Likes',
      hint: 'Play in order, Shuffle all, song position and jumps. Stays visible while you scroll.' },
    { key: 'scrubber', flag: 'scrubber', on: true, label: 'Fast-scroll rail on Likes',
      hint: 'Drag the rail at the right edge to fly through the list. It previews the song you would land on and when you liked it.' },
    { key: 'compact', flag: 'compact', on: false, relayout: true, label: 'Compact song rows',
      hint: 'Smaller artwork and waveform in list view, so more songs fit on screen.' },
    { key: 'tightGrid', flag: 'tight-grid', on: false, relayout: true, label: 'Tighter grid',
      hint: 'Less space between rows in grid view.' },
    { key: 'hideCommentBox', flag: 'no-comment-box', on: true, relayout: true, label: 'Hide the comment box under each song' },
    { key: 'hideWaveformComments', flag: 'no-waveform-comments', on: false, label: 'Hide comments on waveforms' },
    { key: 'quietActions', flag: 'quiet-actions', on: true, label: 'Show Repost, Share and Copy link on hover',
      hint: 'They appear when you point at a song or move to it with the keyboard.' },
    { key: 'hidePromos', flag: 'no-promos', on: true, label: 'Hide upgrade offers and promotions',
      hint: 'Upgrade buttons, For Artists, and banners.' },
    { key: 'hideFooter', flag: 'no-footer', on: true, label: 'Hide the footer on Library pages' },
    { key: 'modern', flag: 'modern', on: true, relayout: true, label: 'Rounded artwork and row highlight' },
  ];
  const DEFAULTS = Object.fromEntries(OPTIONS.map(option => [option.key, option.on]));
  let settings = load();
  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
      return Object.fromEntries(OPTIONS.map(option => [option.key, typeof saved?.[option.key] === 'boolean' ? saved[option.key] : option.on]));
    }
    catch { return { ...DEFAULTS }; }
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch { /* Settings last until the page closes. */ }
  }
  // Flags go in an attribute rather than classes, so SoundCloud resetting the
  // page's classes cannot switch them off.
  function applyFlags() {
    const flags = OPTIONS.filter(option => settings[option.key]).map(option => option.flag);
    document.documentElement?.setAttribute('data-scl', flags.join(' '));
  }
  // At the very start the page may not have its root element yet.
  function whenRoot(run) {
    if (document.documentElement) { run(); return; }
    const observer = new MutationObserver(() => {
      if (!document.documentElement) return;
      observer.disconnect();
      run();
    });
    observer.observe(document, { childList: true });
  }

  // ===========================================================================
  // Styles
  // ===========================================================================

  const ROW = '.soundList__item';
  const STYLES = `
html { --scl-accent: #ff5500; --scl-header: 46px; --scl-bg: #fff; --scl-bar-z: 5; }

/* Hide only the native page scrollbar on Likes; scrolling still works. */
html[data-scl-likes], html[data-scl-likes] body { scrollbar-width:none !important; }
html[data-scl-likes]::-webkit-scrollbar, html[data-scl-likes] body::-webkit-scrollbar { display:none !important; width:0 !important; }

/* --- Fewer promotions -------------------------------------------------- */
html[data-scl~="no-promos"] .header__upsellWrapper,
html[data-scl~="no-promos"] .header__forArtistsButton,
html[data-scl~="no-promos"] .l-product-banners,
html[data-scl~="no-promos"] .playControls__panel.m-upsell-styling { display: none !important; }
html[data-scl~="no-footer"] .l-collection .l-footer { display: none !important; }

/* --- Song rows (list view) --------------------------------------------- */
html[data-scl~="no-comment-box"] ${ROW} .commentForm { display: none !important; }
html[data-scl~="no-waveform-comments"] ${ROW} .waveformCommentsNode,
html[data-scl~="no-waveform-comments"] ${ROW} .commentPlaceholder,
html[data-scl~="no-waveform-comments"] ${ROW} .commentPopover__wrapper { display: none !important; }

/* Hidden buttons move after "More", so no gap is left between Like and More. */
html[data-scl~="quiet-actions"] ${ROW} .soundActions .sc-button-group { display: flex; align-items: center; gap: 8px; }
html[data-scl~="quiet-actions"] ${ROW} .soundActions .sc-button-group > * { margin-left:0 !important; margin-right:0 !important; }
html[data-scl~="quiet-actions"] ${ROW} :is(.sc-button-repost, .sc-button-share, .sc-button-copylink):not(.sc-button-selected) {
  order: 1; opacity: 0; transition: opacity 120ms ease;
}
html[data-scl~="quiet-actions"] ${ROW}:is(:hover, :focus-within) :is(.sc-button-repost, .sc-button-share, .sc-button-copylink) { opacity: 1; }

/* Compact rows lay the song out explicitly, so they do not depend on how
   SoundCloud positions the artwork. */
html[data-scl~="compact"] ${ROW} .sound__body { display: flex !important; align-items: flex-start; gap: 14px; min-height: 0 !important; }
html[data-scl~="compact"] ${ROW} .sound__artwork {
  position: static !important; float: none !important; flex: none; margin: 0 !important;
  width: 88px !important; height: 88px !important;
}
html[data-scl~="compact"] ${ROW} .sound__artwork :is(.sound__coverArt, .image) { width: 88px !important; height: 88px !important; display: block; }
html[data-scl~="compact"] ${ROW} .sound__content { flex: 1; min-width: 0; margin: 0 !important; padding: 0 !important; }
html[data-scl~="compact"] ${ROW} .sound__header { margin-bottom: 4px !important; padding-left: 0 !important; padding-right: 0 !important; }
html[data-scl~="compact"] ${ROW} .sound__waveform { height: 40px !important; padding-left: 0 !important; padding-right: 0 !important; }
html[data-scl~="compact"] ${ROW} .sound__waveform .waveform { height: 40px !important; }
html[data-scl~="compact"] ${ROW} .sound__waveform canvas { width: 100% !important; height: 100% !important; }
html[data-scl~="compact"] ${ROW} .sound__soundActions { margin-top: 6px !important; padding-left: 0 !important; }
html[data-scl~="compact"] ${ROW} .sound__footer { padding-right: 0 !important; }
html[data-scl~="compact"] ${ROW} .sound__footerRight { margin-top: 6px !important; }
html[data-scl~="compact"] ${ROW} { margin: 0 !important; padding-top: 10px !important; padding-bottom: 10px !important; }
html[data-scl~="compact"] ${ROW} .sound { margin: 0 !important; padding: 0 !important; }

/* --- Grid view ---------------------------------------------------------- */
html[data-scl~="tight-grid"] .badgeList__item .playableTile { margin-bottom: 16px !important; }

/* --- Rounded artwork and row highlight ---------------------------------- */
html[data-scl~="modern"] ${ROW} .sound__artwork :is(.image, .image > span),
html[data-scl~="modern"] .playbackSoundBadge__avatar :is(.image, .image > span) { border-radius: 6px; overflow: hidden; }
html[data-scl~="modern"] .playableTile__artwork :is(.image, .image > span, .playableTile__imageOverlay) { border-radius: 8px; overflow: hidden; }
html[data-scl~="modern"] ${ROW} {
  border-radius: 10px; margin-left: -10px !important; margin-right: -10px !important;
  padding-left: 10px !important; padding-right: 10px !important; transition: background-color 120ms ease;
}
html[data-scl~="modern"] ${ROW}:hover { background-color: color-mix(in srgb, currentColor 5%, transparent); }
html[data-scl~="modern"] :is(${ROW}, .badgeList__item, .playControls, .collectionSection__top) :focus-visible {
  outline: 2px solid var(--scl-accent) !important; outline-offset: 2px; border-radius: 4px;
}

/* --- List bar ----------------------------------------------------------- */
html[data-scl~="list-bar"] .collection__likesSection .collectionSection__top {
  position: sticky; top: var(--scl-header); z-index: var(--scl-bar-z);
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
  background: var(--scl-bg); padding-top: 10px !important; padding-bottom: 12px !important; margin-bottom: 12px !important;
}
/* As wide as a highlighted row, so rows passing underneath never show at its sides. */
html[data-scl~="list-bar"] .collection__likesSection .collectionSection__top::before {
  content: ""; position: absolute; inset: 0 -12px; background: var(--scl-bg); z-index: -1;
}
/* The tabs above already say Likes; keep the heading for screen readers only. */
html[data-scl~="list-bar"] .collection__likesSection .collectionSection__subHeading {
  position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}
.scl-controls {
  --scl-fill: color-mix(in srgb, currentColor 8%, transparent);
  --scl-fill-hover: color-mix(in srgb, currentColor 14%, transparent);
  --scl-line: color-mix(in srgb, currentColor 16%, transparent);
  --scl-muted: color-mix(in srgb, currentColor 62%, transparent);
  --scl-accent-ink: #c43f00;
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font: inherit; font-size: 13px;
}
body.theme-dark .scl-controls, body.theme-dark .scl-panel { --scl-accent-ink: #ff7a3d; }
.scl-group { display: flex; align-items: center; gap: 6px; }
.scl-divider { width: 1px; height: 20px; background: var(--scl-line); margin: 0 4px; }
html .scl-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; box-sizing: border-box;
  border: 0; border-radius: 8px; background: var(--scl-fill); color: inherit;
  font: inherit; font-weight: 600; line-height: 1; cursor: pointer; white-space: nowrap;
}
html .scl-btn:hover { background: var(--scl-fill-hover); }
html .scl-btn:focus-visible, .scl-position input:focus-visible, .scl-panel :focus-visible {
  outline: 2px solid var(--scl-accent); outline-offset: 2px;
}
html .scl-btn svg { width: 16px; height: 16px; flex: none; }
html .scl-btn.scl-primary { background: color-mix(in srgb, var(--scl-accent) 18%, transparent); color: var(--scl-accent-ink); }
html .scl-btn.scl-primary:hover { background: color-mix(in srgb, var(--scl-accent) 28%, transparent); }
html .scl-btn.scl-icon { width: 32px; padding: 0; justify-content: center; }
.scl-position { display: inline-flex; align-items: baseline; gap: 6px; color: var(--scl-muted); font-variant-numeric: tabular-nums; }
.scl-position input {
  width: 6ch; height: 32px; box-sizing: border-box; padding: 0 8px; text-align: right;
  border: 1px solid var(--scl-line); border-radius: 8px; background: transparent; color: inherit;
  font: inherit; font-weight: 600; font-variant-numeric: tabular-nums;
}
.scl-position input:hover { border-color: color-mix(in srgb, currentColor 30%, transparent); }
.scl-status { color: var(--scl-muted); min-height: 1em; }
.scl-meter { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: color-mix(in srgb, currentColor 10%, transparent); pointer-events: none; }
.scl-meter > div { height: 100%; background: var(--scl-accent); transform-origin: left; transform: scaleX(0); }
.scl-settings { margin-left: 4px; }
.scl-found { animation: scl-found 1.4s ease-out; }
@keyframes scl-found { from { box-shadow: inset 0 0 0 2px var(--scl-accent); } to { box-shadow: inset 0 0 0 2px transparent; } }
@media (max-width: 1180px) { .scl-secondary .scl-label { display: none; } .scl-secondary.scl-btn { width: 32px; padding: 0; justify-content: center; } }
@media (max-width: 900px) { .scl-label { display: none; } .scl-btn { width: 32px; padding: 0 !important; justify-content: center; } }

/* --- Fast-scroll rail -------------------------------------------------- */
.scl-rail {
  --scl-muted: color-mix(in srgb, currentColor 62%, transparent);
  position: fixed; right: 4px; width: 26px; z-index: var(--scl-bar-z); color: var(--scl-ink);
  cursor: pointer; touch-action: none; user-select: none; outline: none; font: inherit; font-size: 11px;
}
.scl-rail[hidden] { display: none !important; }
.scl-rail__track { position: absolute; right: 8px; top: 0; bottom: 0; width: 3px; border-radius: 2px; background: color-mix(in srgb, currentColor 10%, transparent); }
.scl-rail__tick { position: absolute; right: 6px; width: 7px; height: 1px; background: color-mix(in srgb, currentColor 35%, transparent); }
.scl-rail__label {
  position: absolute; right: 24px; transform: translateY(-50%); padding: 1px 6px; border-radius: 5px; white-space: nowrap;
  background: var(--scl-bg); color: var(--scl-muted); font-variant-numeric: tabular-nums; cursor: pointer;
  opacity: 0; pointer-events: none; transition: opacity 150ms ease;
}
.scl-rail__label:hover { color: var(--scl-ink); }
.scl-rail__thumb {
  position: absolute; right: 4px; top: 0; width: 11px; height: 28px; border-radius: 6px; box-sizing: border-box;
  background: color-mix(in srgb, currentColor 42%, transparent); transition: background-color 150ms ease;
}
.scl-rail:is(:hover, .is-active, .is-dragging, :focus-visible) .scl-rail__label { opacity: 1; pointer-events: auto; }
.scl-rail:is(:hover, .is-dragging, :focus-visible) .scl-rail__thumb { background: var(--scl-accent); }
.scl-rail:focus-visible .scl-rail__thumb { outline: 2px solid var(--scl-accent); outline-offset: 2px; }
.scl-bubble {
  --scl-muted: color-mix(in srgb, currentColor 62%, transparent);
  position: fixed; right: 44px; z-index: var(--scl-bar-z); transform: translateY(-50%);
  width: max-content; max-width: min(340px, calc(100vw - 90px)); box-sizing: border-box; padding: 8px 12px;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 10px;
  background: var(--scl-bg); color: var(--scl-ink); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  font: inherit; font-size: 13px; line-height: 1.35; pointer-events: none; opacity: 0; transition: opacity 120ms ease;
}
.scl-bubble.is-visible { opacity: 1; }
.scl-bubble > div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.scl-bubble__title { font-weight: 600; }
.scl-bubble__artist { color: var(--scl-muted); }
.scl-bubble__meta { color: var(--scl-muted); font-size: 12px; margin-top: 3px; font-variant-numeric: tabular-nums; }
.scl-bubble div:empty { display: none; }

/* --- Settings panel ----------------------------------------------------- */
.scl-panel {
  --scl-line: color-mix(in srgb, currentColor 16%, transparent);
  --scl-muted: color-mix(in srgb, currentColor 62%, transparent);
  position: fixed; z-index: 2147483600; width: 340px; max-width: calc(100vw - 24px); max-height: calc(100vh - 120px); overflow: auto;
  box-sizing: border-box; padding: 16px 16px 12px; border: 1px solid var(--scl-line); border-radius: 12px;
  background: var(--scl-bg); color: var(--scl-ink); font: 13px/1.45 system-ui, sans-serif;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
}
.scl-panel h2 { margin: 0 0 8px; font-size: 15px; font-weight: 700; }
.scl-panel label { display: grid; grid-template-columns: 18px 1fr; gap: 2px 10px; padding: 8px 0; cursor: pointer; }
.scl-panel label + label { border-top: 1px solid var(--scl-line); }
.scl-panel input[type="checkbox"] { margin: 2px 0 0; accent-color: var(--scl-accent); width: 16px; height: 16px; }
.scl-panel .scl-hint { grid-column: 2; color: var(--scl-muted); font-size: 12px; }
.scl-panel footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 10px; color: var(--scl-muted); font-size: 12px; }
.scl-panel footer button { white-space: nowrap; flex: none; border: 1px solid var(--scl-line); border-radius: 8px; background: transparent; color: inherit; font: inherit; padding: 6px 10px; cursor: pointer; }

@media (prefers-reduced-motion: reduce) {
  .scl-found { animation: none; outline: 2px solid var(--scl-accent); }
  .scl-rail *, .scl-bubble { transition: none !important; }
  html[data-scl~="modern"] ${ROW}, html[data-scl~="quiet-actions"] ${ROW} * { transition: none !important; }
}
`;
  const style = document.createElement('style');
  style.id = 'sc-layout-style';
  style.textContent = STYLES;
  whenRoot(() => {
    applyFlags();
    (document.head || document.documentElement).append(style);
  });

  // ===========================================================================
  // Page details
  // ===========================================================================

  const bridge = () => window.scLikesLongLists?.version >= 1 ? window.scLikesLongLists : null;
  function bridgeCall(method, ...args) {
    const api = bridge();
    if (typeof api?.[method] !== 'function') return null;
    try { return api[method](...args); } catch { return null; }
  }
  const rowCache = new WeakMap();
  function listRows(where) {
    const list = where?.querySelector('.lazyLoadingList__list');
    if (!list) return [];
    let cached = rowCache.get(list);
    if (!cached || cached.count !== list.children.length || cached.first !== list.firstElementChild || cached.last !== list.lastElementChild) {
      cached = { count:list.children.length, first:list.firstElementChild, last:list.lastElementChild,
        rows:[...list.children].filter(item => item.matches('.soundList__item, .badgeList__item, .soundBadgeList__item, .trackList__item')) };
      rowCache.set(list, cached);
    }
    return cached.rows;
  }
  function trackPath(href) {
    try { const url = new URL(href, location.origin); return url.pathname.replace(/\/$/, ''); }
    catch { return ''; }
  }
  let navigation = 0, playRequest = 0, layoutRequest = 0;

  const header = () => document.querySelector('header.header');
  function headerBottom() {
    const element = header();
    return element ? Math.max(0, element.getBoundingClientRect().bottom) : 0;
  }
  // Theme colors and the header's size, written as CSS variables.
  let tokensAt = 0;
  function updateTokens(force) {
    if (!force && Date.now() - tokensAt < 2000) return;
    tokensAt = Date.now();
    const root = document.documentElement.style;
    let background = getComputedStyle(document.body).backgroundColor;
    if (!background || /rgba\(0, 0, 0, 0\)|transparent/.test(background)) background = getComputedStyle(document.documentElement).backgroundColor;
    if (!background || /rgba\(0, 0, 0, 0\)|transparent/.test(background)) background = document.body.classList.contains('theme-dark') ? '#121212' : '#fff';
    root.setProperty('--scl-bg', background);
    root.setProperty('--scl-ink', getComputedStyle(document.body).color);
    root.setProperty('--scl-header', `${Math.round(headerBottom())}px`);
    const z = parseInt(getComputedStyle(header() || document.body).zIndex, 10);
    root.setProperty('--scl-bar-z', String(Number.isFinite(z) && z > 1 ? z - 1 : 5));
  }

  // The bottom player's shuffle button and whether shuffle is on.
  function shuffleButton() {
    return document.querySelector('.playControls .shuffleControl, .playControls .playControls__shuffle button');
  }
  function isShuffling(button) {
    const pressed = button.getAttribute('aria-pressed') ?? button.getAttribute('aria-checked');
    if (pressed != null) return pressed === 'true';
    return /(?:^|\s)(?:m-shuffling|m-active|is-active|active|selected)(?:\s|$)/.test(button.className);
  }
  function setShuffle(on) {
    const button = shuffleButton();
    if (button && isShuffling(button) !== on) button.click();
  }
  const frames = count => new Promise(resolve => {
    const step = () => (--count <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

  // ===========================================================================
  // The list bar
  // ===========================================================================

  const ICONS = {
    play: '<path d="M5 3.5v9l7.5-4.5z" fill="currentColor"/>',
    shuffle: '<path d="M2 4.5h2.5c1.6 0 2.6.7 3.5 2l1 1.5c.9 1.3 1.9 2 3.5 2H14M11.5 7.5 14 10l-2.5 2.5M2 11.5h2.5c1 0 1.7-.3 2.3-.8M9.2 5.3c.6-.5 1.3-.8 2.3-.8H14M11.5 2 14 4.5 11.5 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    locate: '<circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="1.75" fill="currentColor"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    top: '<path d="M3 2.5h10M8 13.5V6M4.5 9.5 8 6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    settings: '<path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="4.5" r="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="6" cy="11.5" r="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  };
  function button(icon, label, title, extra = '') {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `scl-btn ${extra}`.trim();
    element.title = title;
    element.setAttribute('aria-label', label);
    element.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[icon]}</svg>`;
    if (!extra.includes('scl-icon')) {
      const text = document.createElement('span');
      text.className = 'scl-label';
      text.textContent = label;
      element.append(text);
    }
    return element;
  }

  let bar = null; // { top, section, container, input, total, status, fill }
  function mountBar() {
    if (!settings.listBar) { unmountBar(); return; }
    const top = document.querySelector('.collection__likesSection .collectionSection__top');
    if (!top) { unmountBar(); return; }
    if (bar && bar.top !== top) unmountBar();
    if (bar?.top === top && top.querySelector(':scope > .scl-controls')) return;
    top.querySelector(':scope > .scl-controls')?.remove();
    top.querySelector(':scope > .scl-meter')?.remove();
    top.querySelector(':scope > .scl-settings')?.remove();
    updateTokens(true);

    const controls = document.createElement('div');
    controls.className = 'scl-controls';
    controls.setAttribute('role', 'toolbar');
    controls.setAttribute('aria-label', 'Likes');

    const play = button('play', 'Play in order', 'Turn shuffle off and play from the first song');
    const shuffle = button('shuffle', 'Shuffle all', 'Turn shuffle on and start at a random song', 'scl-primary');
    const startGroup = document.createElement('div');
    startGroup.className = 'scl-group';
    startGroup.append(play, shuffle);

    const position = document.createElement('label');
    position.className = 'scl-position';
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Song position. Type a number and press Enter to go there.');
    input.title = 'Type a number and press Enter to go there';
    const total = document.createElement('span');
    position.append(input, total);

    const nowPlaying = button('locate', 'Now playing', 'Scroll to the song that is playing', 'scl-secondary');
    const toTop = button('top', 'Top', 'Back to the first song', 'scl-secondary');
    const jumpGroup = document.createElement('div');
    jumpGroup.className = 'scl-group';
    jumpGroup.append(nowPlaying, toTop);

    const status = document.createElement('span');
    status.className = 'scl-status';
    status.setAttribute('role', 'status');

    const divider = () => Object.assign(document.createElement('span'), { className: 'scl-divider' });
    controls.append(startGroup, divider(), position, jumpGroup, status);

    const settingsButton = button('settings', 'Layout settings', 'Layout settings', 'scl-icon scl-settings');
    settingsButton.setAttribute('aria-haspopup', 'dialog');
    settingsButton.setAttribute('aria-expanded', 'false');
    settingsButton.addEventListener('click', () => togglePanel(settingsButton));

    const meter = document.createElement('div');
    meter.className = 'scl-meter';
    meter.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('div');
    meter.append(fill);

    top.prepend(controls);
    // Settings go after SoundCloud's own view toggle and filter, at the far right.
    top.append(settingsButton, meter);

    const section = top.closest('.collection__likesSection');
    bar = { top, section, input, total, status, fill, controls, settingsButton, meter, lastFirst: -1, lastTotal: -1 };

    play.addEventListener('click', () => void playInOrder().catch(() => say('Could not start playback. Try again.')));
    shuffle.addEventListener('click', () => void shuffleAll().catch(() => say('Could not start playback. Try again.')));
    nowPlaying.addEventListener('click', () => void goToNowPlaying());
    toTop.addEventListener('click', () => { window.scrollTo(0, 0); bar && (bar.input.value = '1'); });
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const value = input.value.replace(/[,\s]/g, '');
        const wanted = /^\d+$/.test(value) ? Number(value) : NaN;
        if (Number.isSafeInteger(wanted) && wanted > 0) void goTo(wanted - 1, true);
        else say('Enter a whole song number, starting at 1.');
        input.blur();
      } else if (event.key === 'Escape') {
        input.blur();
      }
      event.stopPropagation(); // SoundCloud's keyboard shortcuts would act on the typing.
    });
    input.addEventListener('blur', () => { bar && (bar.lastFirst = -1); updateReadout(); });
    updateReadout();
  }
  function unmountBar() {
    if (!bar) return;
    bar.controls.remove();
    bar.settingsButton.remove();
    bar.meter.remove();
    bar = null;
  }
  let section = null; // The Likes section on the page, if any.
  const container = () => (section?.isConnected ? section.querySelector('.collectionSection__list') : null);
  // Where songs should line up when the bar is stuck under the header.
  function edge() {
    return headerBottom() + (bar?.top.isConnected ? bar.top.offsetHeight : 0) + 8;
  }

  // Position in the list, from the Likes script when it is drawing a window,
  // otherwise from the songs on the page.
  function listInfo() {
    const where = container();
    if (!where) return null;
    const info = bridgeCall('listInfo', where, edge());
    if (info) return info;
    const children = listRows(where);
    if (!children?.length) return { total: 0, first: 0 };
    let low = 0, high = children.length - 1;
    const line = edge();
    while (low < high) {
      const middle = (low + high) >> 1;
      if (children[middle].getBoundingClientRect().bottom <= line) low = middle + 1; else high = middle;
    }
    const firstTop = children[0].getBoundingClientRect().top;
    let perRow = 1;
    while (perRow < children.length && Math.abs(children[perRow].getBoundingClientRect().top - firstTop) < 2) perRow++;
    return { total: children.length, first: low, perRow, complete: null };
  }
  // Bar readout and rail together, from one look at the list.
  function refresh() {
    if (!bar && !rail) return;
    const info = listInfo();
    updateReadout(info);
    updateRail(info);
  }
  function updateReadout(info = listInfo()) {
    if (!bar || !bar.top.isConnected) return;
    if (!info) return;
    const { total, first } = info;
    if (document.activeElement !== bar.input &&  (first !== bar.lastFirst || total !== bar.lastTotal)) {
      bar.input.value = total ? (first + 1).toLocaleString() : '0';
      bar.lastFirst = first;
    }
    if (total !== bar.lastTotal) {
      bar.total.textContent = `of ${total.toLocaleString()}`;
      // Wide enough for the longest position, e.g. "12,345".
      bar.input.style.width = `calc(${Math.max(3, total.toLocaleString().length)}ch + 18px)`;
      bar.lastTotal = total;
    }
    bar.total.title = info.complete === false ? 'More songs are still loading' : '';
    bar.fill.style.transform = `scaleX(${total > 1 ? Math.min(1, first / (total - 1)) : 0})`;
  }
  let refreshQueued = false;
  addEventListener('scroll', () => {
    if (!bar && !rail) return;
    railActive();
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => { refreshQueued = false; refresh(); });
  }, { passive: true });
  setInterval(() => {
    if ((!bar && !rail) || document.hidden) return;
    updateTokens(false);
    layoutRail();
    refresh();
  }, 1000);

  let statusTimer = 0;
  function say(text) {
    if (!bar) return;
    bar.status.textContent = text;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { if (bar) bar.status.textContent = ''; }, 4000);
  }

  // Scroll to a song (0-based); resolves with its element once drawn.
  async function goTo(index, flash) {
    const where = container();
    const request = ++navigation;
    if (!where || !Number.isFinite(index)) return null;
    const info = listInfo();
    if (!info?.total) return null;
    index = Math.max(0, Math.min(info.total - 1, Math.floor(index)));
    let element = null;
    const api = bridge();
    if (typeof api?.scrollTo === 'function') {
      try { element = await api.scrollTo(where, index, edge()); }
      catch { if (request === navigation) say('Could not jump to that song. Try again.'); return null; }
    } else {
      element = listRows(where)[index] || null;
      if (element) window.scrollBy(0, element.getBoundingClientRect().top - edge());
    }
    if (request !== navigation || where !== container() || !where.isConnected || !element?.isConnected) return null;
    if (element && flash) {
      element.classList.remove('scl-found');
      void element.offsetWidth; // Restart the highlight if it is still showing.
      element.classList.add('scl-found');
      setTimeout(() => element.classList.remove('scl-found'), 1500);
    }
    updateReadout();
    return element;
  }
  function playIn(element) {
    const playButton = element?.querySelector('.sc-button-play, .playButton');
    if (!playButton || playButton.matches(':disabled, [aria-disabled="true"], .sc-button-disabled')) return false;
    if (playButton.matches('.sc-button-pause, .playing, .m-playing') || /^pause\b/i.test(playButton.getAttribute('title') || playButton.getAttribute('aria-label') || '')) return true;
    playButton.click();
    return true;
  }
  async function playInOrder() {
    const request = ++playRequest;
    const element = await goTo(0, true);
    if (request !== playRequest || !element) return;
    setShuffle(false);
    if (!playIn(element)) say('The first song is not ready yet. Try again in a moment.');
  }
  async function shuffleAll() {
    const info = listInfo();
    if (!info?.total) { say('No songs to shuffle yet.'); return; }
    const request = ++playRequest;
    // Start at a random song; with shuffle on, SoundCloud (and the Likes
    // script's full-list shuffle) picks the rest.
    const element = await goTo(Math.floor(Math.random() * info.total), true);
    if (request !== playRequest || !element) return;
    setShuffle(true);
    if (!playIn(element)) say('That song is not ready yet. Try again in a moment.');
  }
  async function goToNowPlaying() {
    const link = document.querySelector('.playControls .playbackSoundBadge__titleLink');
    const href = link?.getAttribute('href');
    if (!href) { say('Nothing is playing.'); return; }
    const where = container();
    let index = bridgeCall('indexOf', where, href) ?? -1;
    if (index < 0) {
      // Without the Likes script: look among the songs on the page.
      const path = trackPath(href);
      index = listRows(where).findIndex(item => [...item.querySelectorAll('a[href]')].some(link => trackPath(link.href) === path));
    }
    if (index < 0) { say('The playing song is not in this list.'); return; }
    await goTo(index, true);
  }

  // ===========================================================================
  // Fast-scroll rail
  // ===========================================================================

  // A rail at the right edge of the screen that stands for the whole list.
  // Drag it, or click anywhere on it, to fly through the list; a preview shows
  // the song you would land on and when you liked it, and markers show where
  // each year (or month) of likes starts. The thumb has a fixed size: one sized
  // to the share of 2,000+ songs on screen would be too small to grab.
  const THUMB = 28;
  const RAIL_MIN_SONGS = 60;     // Shorter lists scroll fine without it.
  const DRAG_SCROLL_MS = 100;    // While dragging, scroll at most this often (SoundCloud builds songs at each stop).
  let rail = null;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const listElement = () => container()?.querySelector('.lazyLoadingList__list') || null;

  function mountRail() {
    if (!settings.scrubber || !container()) { unmountRail(); return; }
    if (rail?.element.isConnected) return;
    unmountRail();
    const element = document.createElement('div');
    element.className = 'scl-rail';
    element.hidden = true;
    element.tabIndex = 0;
    element.setAttribute('role', 'slider');
    element.setAttribute('aria-label', 'Scroll through songs');
    element.setAttribute('aria-orientation', 'vertical');
    element.title = 'Drag to scroll through the list. Click a year to go there.';
    const part = name => Object.assign(document.createElement('div'), { className: `scl-rail__${name}` });
    const marks = part('marks');
    const thumb = part('thumb');
    element.append(part('track'), marks, thumb);
    const bubble = document.createElement('div');
    bubble.className = 'scl-bubble';
    bubble.setAttribute('aria-hidden', 'true');
    const title = part('title'), artist = part('artist'), meta = part('meta');
    [title, artist, meta].forEach(child => { child.className = child.className.replace('scl-rail__', 'scl-bubble__'); });
    bubble.append(title, artist, meta);
    document.body.append(element, bubble);
    rail = {
      element, bubble, marks, thumb, title, artist, meta,
      top: 0, bottom: 0, height: 0, total: 0, marksKey: '',
      dragging: false, moved: false, startY: 0, lastScroll: 0, trailing: 0, activeTimer: 0,
    };
    const mounted = rail;
    layoutRail();

    element.addEventListener('pointerdown', event => {
      if (event.button !== 0 || rail !== mounted) return;
      event.preventDefault();
      const label = event.target.closest('.scl-rail__label');
      if (label) { void land(Number(label.dataset.index)); return; }
      element.setPointerCapture(event.pointerId);
      element.focus({ preventScroll: true });
      Object.assign(rail, { dragging: true, moved: false, startY: event.clientY });
      element.classList.add('is-dragging');
      drag(event.clientY);
    });
    element.addEventListener('pointermove', event => {
      if (rail !== mounted) return;
      if (rail.dragging) {
        if (Math.abs(event.clientY - rail.startY) > 3) rail.moved = true;
        drag(event.clientY);
      } else if (event.pointerType === 'mouse' && !event.target.closest('.scl-rail__label')) {
        const f = fractionAt(event.clientY);
        showBubble(indexAt(f), event.clientY);
      } else {
        hideBubble();
      }
    });
    const finish = event => {
      if (rail !== mounted || !rail.dragging) return;
      rail.dragging = false;
      clearTimeout(rail.trailing);
      element.classList.remove('is-dragging');
      // Line up exactly on the song the preview showed.
      void land(indexAt(fractionAt(event.clientY)));
    };
    element.addEventListener('pointerup', finish);
    element.addEventListener('pointercancel', event => {
      if (rail !== mounted) return;
      clearTimeout(rail.trailing);
      rail.dragging = false;
      element.classList.remove('is-dragging');
      hideBubble();
    });
    element.addEventListener('lostpointercapture', () => {
      if (rail !== mounted || !rail.dragging) return;
      clearTimeout(rail.trailing); rail.dragging = false; element.classList.remove('is-dragging'); hideBubble();
    });
    element.addEventListener('pointerleave', () => { if (rail && !rail.dragging) hideBubble(); });
    element.addEventListener('blur', () => hideBubble());
    element.addEventListener('keydown', event => {
      const info = listInfo();
      if (!info?.total) return;
      const row = info.perRow || 1;
      const steps = { ArrowDown: row, ArrowUp: -row, PageDown: 10 * row, PageUp: -10 * row };
      let target = null;
      if (event.key in steps) target = info.first + steps[event.key];
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = info.total - 1;
      if (target == null) return;
      event.preventDefault();
      event.stopPropagation(); // Not SoundCloud's own shortcuts.
      target = clamp(target, 0, info.total - 1);
      void goTo(target, false).then(() => { if (rail && document.activeElement === rail.element) showBubble(target, thumbCenter()); });
    });
    refresh();
  }
  function unmountRail() {
    if (!rail) return;
    clearTimeout(rail.trailing);
    clearTimeout(rail.activeTimer);
    rail.element.remove();
    rail.bubble.remove();
    rail = null;
  }
  // Between the list bar and the bottom player.
  function layoutRail() {
    if (!rail) return;
    const top = Math.round(headerBottom() + (bar?.top.isConnected ? bar.top.offsetHeight : 0) + 12);
    const player = document.querySelector('.playControls');
    const playerTop = player ? Math.min(innerHeight, player.getBoundingClientRect().top) : innerHeight;
    const bottom = Math.round(innerHeight - playerTop + 12);
    if (top === rail.top && bottom === rail.bottom) return;
    Object.assign(rail, { top, bottom, height: Math.max(0, innerHeight - top - bottom), marksKey: '' });
    rail.element.style.top = `${top}px`;
    rail.element.style.bottom = `${bottom}px`;
  }
  // The list's height determines whether the rail is useful. The rail itself
  // maps song indices, so dates and landing positions share one coordinate system.
  // The list's own height covers every song
  // (a windowed list keeps space for the songs that are not drawn).
  function scrollModel() {
    const list = listElement();
    if (!list) return null;
    const rect = list.getBoundingClientRect();
    if (rect.height <= 0) return null;
    const visible = Math.max(1, innerHeight - edge() - (rail?.bottom || 0));
    return { top: rect.top, height: rect.height, range: Math.max(1, rect.height - visible) };
  }
  const span = () => Math.max(1, rail.height - THUMB);
  const fractionAt = clientY => clamp((clientY - rail.top - THUMB / 2) / span(), 0, 1);
  const thumbCenter = () => rail.top + THUMB / 2 + (rail.fraction || 0) * span();
  function indexAt(f) {
    return rail?.total ? clamp(Math.round(f * (rail.total - 1)), 0, rail.total - 1) : 0;
  }
  function setThumb(f) {
    rail.fraction = f;
    rail.thumb.style.transform = `translateY(${(f * span()).toFixed(1)}px)`;
  }
  function drag(clientY) {
    const f = fractionAt(clientY);
    setThumb(f);
    showBubble(indexAt(f), thumbCenter());
    const mounted = rail;
    const go = () => {
      if (rail !== mounted || !rail.dragging) return;
      rail.lastScroll = performance.now();
      // Use the same song index as the marker and preview. Pixel estimates
      // drift with grid columns, compact rows, and virtual-list spacers.
      void goTo(indexAt(f), false);
    };
    clearTimeout(rail.trailing);
    const wait = DRAG_SCROLL_MS - (performance.now() - rail.lastScroll);
    if (wait <= 0) go(); else rail.trailing = setTimeout(go, wait);
  }
  async function land(index) {
    hideBubble();
    await goTo(index, true);
  }
  const monthName = (year, month) => new Date(year, month, 1).toLocaleDateString(undefined, { month: 'short' });
  const likedText = likedAt => new Date(likedAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  function showBubble(index, y) {
    if (!rail || !rail.total) return;
    const item = bridgeCall('itemAt', container(), index);
    const position = `Song ${(index + 1).toLocaleString()} of ${rail.total.toLocaleString()}`;
    rail.title.textContent = item?.title || position;
    rail.artist.textContent = item?.title ? (item.artist || '') : '';
    rail.meta.textContent = item?.title
      ? (item.likedAt != null ? `${position} · Liked ${likedText(item.likedAt)}` : position)
      : (item?.likedAt != null ? `Liked ${likedText(item.likedAt)}` : '');
    const half = rail.bubble.offsetHeight / 2;
    rail.bubble.style.top = `${clamp(y, rail.top + half, innerHeight - rail.bottom - half)}px`;
    rail.bubble.classList.add('is-visible');
  }
  function hideBubble() { rail?.bubble.classList.remove('is-visible'); }
  // Year labels show for a moment while the page scrolls.
  function railActive() {
    if (!rail) return;
    rail.element.classList.add('is-active');
    clearTimeout(rail.activeTimer);
    rail.activeTimer = setTimeout(() => rail?.element.classList.remove('is-active'), 1200);
  }
  function updateRail(info) {
    if (!rail) return;
    const model = scrollModel();
    const total = info?.total || 0;
    const show = Boolean(model) && total >= RAIL_MIN_SONGS && rail.height > THUMB * 3;
    if (rail.element.hidden === show) rail.element.hidden = !show;
    if (!show) { hideBubble(); return; }
    rail.total = total;
    if (!rail.dragging) setThumb(total > 1 ? clamp(info.first / (total - 1), 0, 1) : 0);
    const first = clamp(info.first, 0, total - 1);
    rail.element.setAttribute('aria-valuemin', '1');
    rail.element.setAttribute('aria-valuemax', String(total));
    rail.element.setAttribute('aria-valuenow', String(first + 1));
    rail.element.setAttribute('aria-valuetext', `Song ${(first + 1).toLocaleString()} of ${total.toLocaleString()}`);
    buildMarks(model);
  }
  // Likes run newest to oldest. The chronological start of a period is its
  // LAST row on screen. Scan upward so the oldest marker wins label collisions.
  function periodStarts(months, byMonth) {
    const markers = [];
    let previous = null;
    for (let index = months.length - 1; index >= 0; index--) {
      const value = months[index];
      if (!Number.isInteger(value) || value < 0) continue;
      const unit = byMonth ? value : Math.floor(value / 12);
      if (unit === previous) continue;
      previous = unit;
      markers.push({ index, value });
    }
    return markers;
  }
  function buildMarks(model) {
    const months = bridgeCall('likedMonths', container());
    const total = rail.total;
    if (rail.months !== months || !rail.monthsChecked || Date.now() - rail.monthsChecked > 1000) {
      rail.months = months; rail.monthsChecked = Date.now();
      rail.monthsSignature = months ? Array.from(months).join(',') : '';
    }
    const key = `${total}|${rail.monthsSignature}|${rail.height}|${Math.round((model.height / model.range) * 1000)}`;
    if (key === rail.marksKey) return;
    rail.marksKey = key;
    rail.marks.textContent = '';
    if (!months || months.length !== total) return;
    const years = new Set();
    for (const value of months) if (Number.isInteger(value) && value >= 0) years.add(Math.floor(value / 12));
    if (!years.size) return;
    const byMonth = years.size <= 2;
    const fragment = document.createDocumentFragment();
    let lastLabel = Infinity, labelledYear = null;
    for (const { index, value } of periodStarts(months, byMonth)) {
      const f = total > 1 ? index / (total - 1) : 0;
      const y = THUMB / 2 + f * span();
      const tick = document.createElement('div');
      tick.className = 'scl-rail__tick';
      tick.style.top = `${y.toFixed(1)}px`;
      fragment.append(tick);
      if (lastLabel - y < 18) continue;
      const year = Math.floor(value / 12);
      const label = document.createElement('div');
      label.className = 'scl-rail__label';
      label.dataset.index = String(index);
      label.textContent = byMonth ? (labelledYear === year ? monthName(year, value % 12) : `${monthName(year, value % 12)} ${year}`) : String(year);
      label.style.top = `${y.toFixed(1)}px`;
      fragment.append(label);
      lastLabel = y;
      labelledYear = year;
    }
    rail.marks.append(fragment);
  }

  // ===========================================================================
  // Settings panel
  // ===========================================================================

  let panel = null;
  function closePanel() {
    if (!panel) return;
    panel.element.remove();
    panel.opener?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', panel.outside, true);
    document.removeEventListener('keydown', panel.escape, true);
    const opener = panel.opener;
    panel = null;
    if (opener?.isConnected) opener.focus();
  }
  function togglePanel(opener) {
    if (panel) { closePanel(); return; }
    updateTokens(true);
    const element = document.createElement('div');
    element.className = 'scl-panel';
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-label', 'Layout settings');
    const title = document.createElement('h2');
    title.textContent = 'Layout';
    element.append(title);
    for (const option of OPTIONS) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = Boolean(settings[option.key]);
      const text = document.createElement('span');
      text.textContent = option.label;
      label.append(box, text);
      if (option.hint) {
        const hint = document.createElement('span');
        hint.className = 'scl-hint';
        hint.textContent = option.hint;
        label.append(hint);
      }
      box.addEventListener('change', () => change(option, box.checked));
      element.append(label);
    }
    const footer = document.createElement('footer');
    const note = document.createElement('span');
    note.textContent = 'Also in your profile menu: Page layout.';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'Reset to defaults';
    reset.addEventListener('click', () => {
      for (const option of OPTIONS) change(option, option.on, true);
      closePanel();
    });
    footer.append(note, reset);
    element.append(footer);
    document.body.append(element);

    // Below the button that opened it, kept on screen.
    const anchor = opener?.isConnected ? opener.getBoundingClientRect() : null;
    const width = element.offsetWidth;
    const top = Math.max(12, Math.min(anchor ? anchor.bottom + 8 : headerBottom() + 8, innerHeight - element.offsetHeight - 12));
    const left = anchor ? Math.min(innerWidth - width - 12, Math.max(12, anchor.right - width)) : innerWidth - width - 16;
    element.style.top = `${Math.round(top)}px`;
    element.style.left = `${Math.round(left)}px`;

    const outside = event => {
      if (!element.contains(event.target) && !opener?.contains(event.target)) closePanel();
    };
    const escape = event => { if (event.key === 'Escape') { event.stopPropagation(); closePanel(); } };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    opener?.setAttribute('aria-expanded', 'true');
    panel = { element, opener, outside, escape };
    element.querySelector('input')?.focus();
  }
  async function change(option, value, quiet) {
    if (settings[option.key] === value) return;
    const request = option.relayout ? ++layoutRequest : layoutRequest;
    // Keep the same song at the top when songs change height.
    const where = container();
    const keep = option.relayout ? listInfo()?.first : null;
    settings[option.key] = value;
    save();
    applyFlags();
    if (option.key === 'listBar') { mountBar(); layoutRail(); if (!quiet) closePanel(); return; }
    if (option.key === 'scrubber') { mountRail(); return; }
    if (!option.relayout) return;
    await frames(1);
    if (request !== layoutRequest || where !== container()) return;
    const api = bridge();
    if (typeof api?.relayout === 'function') bridgeCall('relayout'); else window.dispatchEvent(new Event('resize'));
    if (keep != null && keep > 0) { await frames(2); if (request === layoutRequest && where === container()) await goTo(keep, false); }
  }

  // ===========================================================================
  // Profile menu entry
  // ===========================================================================

  // SoundCloud builds its profile menu each time it opens. Copy its Likes
  // entry so the new one looks the same.
  function addMenuEntry() {
    const link = document.querySelector('.dropdownMenu a[href="/you/likes"], [role="menu"] a[href="/you/likes"]');
    const item = link?.closest('li') || link;
    if (!item?.parentNode || item.parentNode.querySelector(':scope > [data-scl-entry]')) return;
    const entry = item.cloneNode(true);
    entry.setAttribute('data-scl-entry', '');
    entry.removeAttribute('id');
    const anchor = entry.matches('a') ? entry : entry.querySelector('a') || entry;
    anchor.setAttribute('href', '#');
    anchor.removeAttribute('aria-current');
    anchor.classList.remove('active', 'selected', 'm-active');
    anchor.setAttribute('role', 'menuitem');
    anchor.textContent = 'Page layout';
    anchor.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); // Close SoundCloud's menu.
      const opener = document.querySelector('.header__userNavUsernameButton');
      closePanel();
      togglePanel(opener);
    });
    item.parentNode.append(entry);
  }

  // ===========================================================================
  // Watching the page
  // ===========================================================================

  // SoundCloud builds pages as you move around. Check for the Likes list and
  // the profile menu shortly after the page changes, at most a few times a second.
  let checkTimer = 0;
  function check() {
    checkTimer = 0;
    const next = document.querySelector('.collection__likesSection');
    if (section !== next) { navigation++; playRequest++; layoutRequest++; unmountBar(); unmountRail(); closePanel(); }
    section = next;
    document.documentElement.toggleAttribute('data-scl-likes', !!section && /^\/you\/likes\/?$/.test(location.pathname));
    try { mountBar(); } catch { /* Try again on the next change. */ }
    try { mountRail(); } catch { /* Try again on the next change. */ }
    try { addMenuEntry(); } catch { /* The menu entry is optional. */ }
  }
  function start() {
    updateTokens(true);
    check();
    new MutationObserver(records => {
      for (const record of records) rowCache.delete(record.target);
      if (!checkTimer) checkTimer = setTimeout(check, 150);
    }).observe(document.body, { childList: true, subtree: true });
    addEventListener('resize', () => { updateTokens(true); layoutRail(); refresh(); }, { passive: true });
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
