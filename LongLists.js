// ==UserScript==
// @name         SoundCloud Likes & Long Lists
// @namespace    local.soundcloud.likes-long-lists
// @version      1.8.5
// @description  Cache Likes and playlist metadata, show saved lists at once, add new likes, shuffle all your Likes, keep Play working on long lists, and start songs faster.
// @match        https://soundcloud.com/*
// @match        https://www.soundcloud.com/*
// @run-at       document-start
// @sandbox      raw
// @grant        none
// @noframes
// @license      MIT
// ==/UserScript==

// Replaces "SoundCloud Metadata Cache" and "SoundCloud Long List Helper".
// Turn those two off; this script keeps using the same saved data.

(() => {
  'use strict';

  const KEY = '__scLikesLongListsV1';
  if (window[KEY]) return;
  window[KEY] = true;

  // ===========================================================================
  // The two older scripts
  // ===========================================================================

  const OLD_SCRIPTS = [['__scMetadataCacheV1', 'SoundCloud Metadata Cache'], ['__scLongListQueueFixV2', 'SoundCloud Long List Helper']];
  const conflicts = OLD_SCRIPTS.filter(([key]) => window[key]).map(([, name]) => name);
  // If the old scripts run after this one, this makes them stop immediately.
  for (const [key] of OLD_SCRIPTS) window[key] = true;
  if (conflicts.length) {
    // They already patched SoundCloud. Patching it again would stack two caches.
    whenReady(() => {
      const element = makeBadge();
      element.textContent = 'SoundCloud scripts: conflict';
      element.addEventListener('click', () => openPanel([
        'SoundCloud Likes & Long Lists is paused',
        '',
        `These older scripts are still turned on: ${conflicts.join(' and ')}.`,
        'This script replaces them. Turn them off in Tampermonkey, then reload SoundCloud. Your saved lists are kept.',
      ].join('\n'), [['Close', panel => panel.remove()]]));
    });
    return;
  }

  // ===========================================================================
  // Settings
  // ===========================================================================

  const DB_NAME = 'sc-userscript-metadata-v1';
  const LISTS = new Set(['userLikes', 'userTrackLikes', 'userPlaylists', 'userPlaylistsWithoutAlbums', 'userAlbums', 'playlist']);
  const OMIT = new Set(['media', 'track_authorization', 'stream_url', 'stream_urls', 'download_url', 'authorization', 'oauth_token', 'access_token']);
  const TRANSIENT = ['client_id', 'app_version', 'oauth_token', 'access_token', 'track_authorization'];
  // Query parameters that do not say which page of a list a URL points to.
  // SoundCloud adds some of these to requests but not to the next_href cursors
  // it returns, so they must not stop saved pages from being joined together.
  const PAGE_NOISE = new Set([...TRANSIENT, 'app_locale', 'linked_partitioning', 'limit', '_']);
  const PREVIEW_MAX = 10;      // Lists capped at this many items are previews or sidebars. Never enlarge them.
  const LIVE_WAIT = 1000;      // Longest an opened Likes list waits for the new-likes check (run alongside loading).
  const STALE_OK_MS = 5 * 60 * 1000; // After a recent check, open at once and check in the background.
  const RENDER_FIRST = 48;     // Saved items drawn immediately when a list opens or switches view.
  const RENDER_BUDGET = 8;     // Milliseconds of drawing per frame while the rest of a saved list fills in.
  const RENDER_AHEAD = 3;      // Screens of songs kept drawn below what you can see.
  const RENDER_CHUNK = 60;     // Songs added at a time when you scroll towards the end of what is drawn.
  const WINDOW_MIN = 150;      // Saved lists at least this long are drawn as a window.
  const KEEP_SCREENS = 1.25;   // Songs kept drawn above and below what you can see, in screens.
  const DROP_SCREENS = 3;      // Songs further away than this are removed from the page.
  const WINDOW_BUDGET = 10;    // Milliseconds of drawing per frame while the window fills in.
  const WINDOW_URGENT = 30;    // ... while part of the screen is still empty.
  const RECHECK_MS = 60000;    // Check the same Likes list at most once a minute.
  const MAX_LIVE_PAGES = 5;    // Server pages read while lining new likes up with the saved list.
  const REMOVED_MAX = 1000;    // Unliked songs remembered for saved pages beyond the first.
  const QUEUE_SLICE_MS = 12;   // Longest stretch of queue loading on the way to playback before a pause.
  const FILL_SLICE_MS = 5;     // Same, for filling the rest of the queue in the background.
  const PLAYBACK_TTL = 10 * 60 * 1000; // How long fresh playback details from SoundCloud are reused.
  const PREFETCH_AHEAD = 3;    // Upcoming songs whose playback details are fetched while one plays.
  const OFFSCREEN_MARGIN = '2000px 0px'; // List items further than this from the screen are not rendered.
  const ITEM_SELECTOR = '.soundList__item, .trackList__item, .badgeList__item';
  const CATALOG_PAGE = 200;    // Songs per request while saving the rest of your Likes.
  const CATALOG_PAUSE = 400;   // Pause between those requests, to stay gentle on SoundCloud.
  const CATALOG_DELAY = 3000;  // Wait this long after Likes opens before starting.
  const CATALOG_MAX = 25000;   // Stop saving beyond this many songs.
  const SHUFFLE_SELECTOR = '.shuffleControl, .playControls__shuffle button, button[aria-label*="huffle"], button[title*="huffle"]';
  const DRAIN_IDLE = 4000;     // A queue fill ends after this long without SoundCloud handing over a song.
  const DRAIN_MAX = 90000;     // ... and never runs longer than this.
  const SIGNATURES = [
    ['queue', ['audibleAt', 'getQueueMetadataAt', 'isFullyPopulated', 'resume', 'pause', 'dispose']],
    ['api', ['endpoints:', 'services:', 'includeCredentials', 'listenToAbortSignal']],
    ['backbone', ['getRequestEquivalencyUrl', 'getEndpointForMethod', '.sync=', 'forceCredentials']],
    ['list', ['getInitialDesiredLength', 'checkScrollPositionDebounced', 'addPagesUntilModelRendered', 'afterFetch']],
    ['track', ['getTrackAuthorization', 'resource_type:"sound"', 'getMediaPayload']],
  ];
  const QUEUE_SHORT = { waiting: 'waiting', found: 'ready', active: 'on', failed: 'failed', missing: 'not found' };

  // ===========================================================================
  // State
  // ===========================================================================

  const patched = new WeakSet();
  const inspected = new WeakSet();
  const depScanned = new WeakSet();
  const expandedModels = new WeakSet();
  const expandedURLs = new Set();
  const servedItems = new Set();
  let servedVersion = 0;               // Changes whenever servedItems gains songs.
  const lengthCache = new WeakMap();   // List view -> its cached cachedLength result.
  const applied = new WeakMap();
  const trackedViews = new WeakSet();
  const liveViews = new Set();
  const likeChecks = new Map();
  const likesCheckedAt = new Map();  // Cache key -> when its last check finished.
  const pageIndexes = new Map();     // Owner -> Map(page identity -> cache key), built from keys only.
  const deepIndexed = new Set();     // Owners whose rows were also read once for their saved page URLs.
  const progressive = new WeakMap(); // List view -> drawing task.
  const redrawsAll = new WeakSet();  // List views that redraw every item on each change.
  const windows = new WeakMap();     // List view -> its window (see "Windowed long lists").
  const windowQueued = new WeakSet();
  // Your own Likes lists: list identity -> { owner, next, count, collections, delivered, catalog }.
  // `next` is where the list SoundCloud is showing stops; null once it has every song.
  const likesLists = new Map();
  const readerControls = new Set();   // WeakRefs to the queue readers' fill controls.
  const likesEndpoints = new Map();   // 'likes' | 'track_likes' -> SoundCloud's endpoint name for it.
  const recentErrors = [];
  const drains = [];
  const readerLog = [];               // The last few queue readers, for diagnostics.
  const shuffleCalls = new Map();     // SoundCloud functions named *shuffle*: label -> { count, last }.
  const probedFunctions = new WeakSet();
  let readerSeq = 0;
  const likesHeads = new Set();       // First few song IDs of your Likes, to recognize a queue built from them.
  let seenClientId = null;
  const guardedReaders = new WeakSet();
  const factoryWrappers = new WeakSet();
  const stats = {
    hits: 0, misses: 0, writes: 0, invalidations: 0, songUpdates: 0, viewsExpanded: 0, lastList: null,
    likes: null, newLikes: 0,
    instantStarts: 0, extraFetches: 0, prepared: 0, offscreen: 0,
    listsCompleted: 0, reshuffles: 0,
    windowedLists: 0, windowDrawn: 0, windowTotal: 0, windowRemoved: 0, windowRebuilds: 0, windowSkip: null,
    topUps: 0, lastTopUp: null,
    readers: 0, unguarded: 0, deferred: 0, stackErrors: 0,
  };
  let config, deferred, loader, liveAPI, rawByUrl, dbPromise;
  let playbackSafe = false, apiActive = false, listViewActive = false, storageFailed = false;
  const playbackFields = new Map();  // Track ID -> { fields, at }, from live responses only. Never stored.
  const pendingFields = new Map();   // Track ID -> request already fetching its playback details.
  const pathToId = new Map();        // "artist/song" -> track ID, from lists handed to SoundCloud.
  const waveformHints = [];
  let playOrders = [];
  let lastPlanned = null, planned = new Set(), predictionMisses = 0;
  let visit = 0, lastVisit = null, expanding = false, sweepTimers = [];
  let queueStatus = 'waiting';

  // ===========================================================================
  // Staying out of the way of clicks
  // ===========================================================================

  let lastInputAt = 0;
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, () => { lastInputAt = performance.now(); }, { capture: true, passive: true });
  }
  // True while you are clicking, typing or scrolling: background work waits.
  function userBusy() {
    try { if (navigator.scheduling?.isInputPending?.()) return true; } catch { /* Not supported. */ }
    return performance.now() - lastInputAt < 250;
  }
  // Run a task at low priority, after input and rendering. Returns a cancel function.
  function background(task) {
    if (globalThis.scheduler?.postTask && typeof AbortController === 'function') {
      const controller = new AbortController();
      globalThis.scheduler.postTask(task, { priority: 'background', signal: controller.signal }).catch(() => {});
      return () => controller.abort();
    }
    const timer = setTimeout(task, 0);
    return () => clearTimeout(timer);
  }
  function whenIdle(task, timeout = 3000) {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => task(), { timeout });
    else setTimeout(task, 300);
  }

  // ===========================================================================
  // Storage
  // ===========================================================================

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function database() {
    if (dbPromise) return dbPromise;
    if (storageFailed) return Promise.reject(new Error('Storage unavailable'));
    dbPromise = new Promise((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => { expired = true; reject(new Error('Storage open timed out')); }, 1500);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('entries', { keyPath: 'key' }).createIndex('saved', 'saved');
        db.createObjectStore('control');
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        if (expired) { request.result.close(); return; }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => { clearTimeout(timer); reject(request.error); };
    });
    return dbPromise;
  }
  async function transaction(mode, operation) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['entries', 'control'], mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('Storage transaction failed'));
      Promise.resolve(operation(tx.objectStore('entries'), tx.objectStore('control')))
        .then(value => { result = value; }, error => { try { tx.abort(); } catch {} reject(error); });
    });
  }
  const initial = () => ({ generation: 0, clears: 0, bytes: 0, count: 0 });
  async function lookup(key) {
    return transaction('readonly', async (entries, control) => {
      const [entry, meta] = await Promise.all([requestResult(entries.get(key)), requestResult(control.get('meta'))]);
      return { entry: entry || null, generation: (meta || initial()).generation, clears: meta?.clears || 0 };
    });
  }
  async function save(key, body, generation, url) {
    const bytes = new TextEncoder().encode(body).length;
    // Remember which page this is, so later visits can join the pages without
    // having to rebuild the URL from the cache key.
    let source = null;
    try { if (url) source = cleanURL(url); } catch { /* Save without a page URL. */ }
    await transaction('readwrite', async (entries, control) => {
      const meta = await requestResult(control.get('meta')) || initial();
      if (meta.generation !== generation) return; // A mutation/clear overtook this GET.
      const old = await requestResult(entries.get(key));
      const saved = Date.now();
      meta.bytes += bytes - (old?.bytes || 0);
      if (!old) meta.count++;
      const entry = { key, body, bytes, saved };
      if (source) entry.url = source;
      entries.put(entry);
      control.put(meta, 'meta');
      stats.writes++;
    });
    const index = pageIndexes.get(key.slice(0, key.indexOf('|')));
    const id = source ? pageId(source) : null;
    if (index && id && !key.includes('|trackBatch|')) index.set(id, key);
  }
  // Replace the body of an existing row, unless the cache was cleared meanwhile.
  async function rewrite(key, body, clears) {
    const serialized = serialize(body);
    const bytes = new TextEncoder().encode(serialized).length;
    await transaction('readwrite', async (entries, control) => {
      const meta = await requestResult(control.get('meta')) || initial();
      if ((meta.clears || 0) !== clears) return;
      const old = await requestResult(entries.get(key));
      if (!old) return;
      meta.bytes += bytes - (old.bytes || 0);
      entries.put({ ...old, body: serialized, bytes, saved: Date.now() });
      control.put(meta, 'meta');
      stats.writes++;
    });
  }
  async function invalidate() {
    await transaction('readwrite', async (entries, control) => {
      const meta = await requestResult(control.get('meta')) || initial();
      entries.clear();
      control.put({ generation: meta.generation + 1, clears: (meta.clears || 0) + 1, count: 0, bytes: 0 }, 'meta');
    });
    stats.invalidations++;
    stats.lastList = null;
    stats.likes = null;
    servedItems.clear();
    expandedURLs.clear();
    likeChecks.clear();
    likesCheckedAt.clear();
    pageIndexes.clear();
    deepIndexed.clear();
    likesLists.clear();
    storageFailed = false;
    refreshBadge();
  }
  function storageError() {
    storageFailed = true;
    refreshBadge();
  }

  // ===========================================================================
  // URLs and saved bodies
  // ===========================================================================

  function cleanURL(value) {
    const url = new URL(value, location.origin);
    for (const name of TRANSIENT) url.searchParams.delete(name);
    url.searchParams.sort();
    return url.href;
  }
  // A looser identity than cleanURL, used only to decide whether two URLs are
  // the same page of the same list.
  function pageId(value) {
    try {
      const url = new URL(value, location.origin);
      const params = [...url.searchParams].filter(([name]) => !PAGE_NOISE.has(name))
        .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
      const query = new URLSearchParams(params).toString();
      return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, '')}${query ? `?${query}` : ''}`;
    } catch { return null; }
  }
  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
      .filter(key => !TRANSIENT.includes(key)).map(key => [key, stable(value[key])]));
    return value;
  }
  function serialize(body) {
    return JSON.stringify(body, (key, value) => {
      if (OMIT.has(key.toLowerCase())) return undefined;
      if (key === 'next_href' && typeof value === 'string') return cleanURL(value);
      return value;
    });
  }
  function withClientId(value) {
    const url = new URL(value);
    const clientId = config?.get('client_id');
    if (clientId) url.searchParams.set('client_id', clientId);
    return url.href;
  }
  function fixNextHrefs(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) fixNextHrefs(item); return; }
    for (const key of Object.keys(value)) {
      if (key === 'next_href' && typeof value[key] === 'string') value[key] = withClientId(value[key]);
      else fixNextHrefs(value[key]);
    }
  }
  // JSON.parse with a reviver calls back into JavaScript for every value in a
  // list of thousands of songs. Parse plainly, then fix the paging link.
  function restore(body) {
    const value = JSON.parse(body);
    const first = body.indexOf('"next_href"');
    if (first < 0) return value;
    if (first === body.lastIndexOf('"next_href"') && value && typeof value === 'object' && typeof value.next_href === 'string') {
      value.next_href = withClientId(value.next_href);
    } else {
      fixNextHrefs(value);
    }
    return value;
  }
  // Bookkeeping fields stored with a list are never handed to SoundCloud.
  function withoutInternal(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('__scRemoved' in body)) return body;
    const { __scRemoved, ...rest } = body;
    return rest;
  }
  function account() {
    const me = config?.get('me');
    return me?.id ? String(me.id) : null;
  }
  function eligible(name) { return LISTS.has(name) || (name === 'trackBatch' && playbackSafe); }
  function cacheKey(method, args, owner) {
    const [name, path, query] = args;
    if (method === 'callEndpointByUrl') return `${owner}|${name}|${cleanURL(path)}`;
    return `${owner}|${name}|${JSON.stringify(stable([path || {}, query || {}]))}`;
  }
  function listURL(value) {
    try {
      const url = new URL(value, location.origin);
      if (url.protocol !== 'https:' || !['api-v2.soundcloud.com', 'api.soundcloud.com'].includes(url.hostname)) return false;
      return /^\/(?:users\/[^/]+\/(?:likes|track_likes|playlists|playlists_without_albums|albums)|playlists\/[^/]+)\/?$/.test(url.pathname);
    } catch { return false; }
  }
  // The first page of a Likes list, where new likes would appear.
  function isLikesFirstPage(url, name, byURL) {
    if (url) {
      try {
        const parsed = new URL(url, location.origin);
        const offset = parsed.searchParams.get('offset');
        return listURL(parsed.href) && /^\/users\/[^/]+\/(?:likes|track_likes)\/?$/.test(parsed.pathname)
          && (!offset || offset === '0') && !parsed.searchParams.has('cursor');
      } catch { return false; }
    }
    return !byURL && (name === 'userLikes' || name === 'userTrackLikes');
  }

  // ===========================================================================
  // List items
  // ===========================================================================

  // Read a field from either a raw API object or a Backbone model.
  function field(value, key) {
    try { return typeof value?.get === 'function' ? value.get(key) : (value?.attributes || value)?.[key]; }
    catch { return undefined; }
  }
  // The same identity for a raw list item and the model SoundCloud builds from it.
  function itemId(item) {
    if (!item || typeof item !== 'object') return null;
    const kind = field(item, 'kind'), id = field(item, 'id');
    if (id != null && ['track', 'playlist', 'system-playlist', 'user'].includes(kind)) return `${kind}:${id}`;
    for (const type of ['track', 'playlist']) {
      const inner = field(item, type);
      const innerId = inner && typeof inner === 'object' ? field(inner, 'id') : inner;
      if (innerId != null && innerId !== '' && typeof innerId !== 'boolean') return `${type}:${innerId}`;
    }
    if (id == null) return null;
    if (!kind && field(item, 'title') != null) return `${field(item, 'tracks') || field(item, 'track_count') != null ? 'playlist' : 'track'}:${id}`;
    return `${kind || 'item'}:${id}`;
  }
  // Playlist responses list most songs as bare IDs until they are fetched.
  function isStub(item) {
    if (!item || typeof item !== 'object') return false;
    if (field(item, 'title') || field(item, 'track') || field(item, 'playlist') || field(item, 'user')) return false;
    const kind = field(item, 'kind');
    return field(item, 'id') != null && (!kind || kind === 'track');
  }
  function rememberServed(body) {
    servedVersion++;
    if (servedItems.size > 100000) servedItems.clear();
    const add = item => { if (!isStub(item)) { const id = itemId(item); if (id) servedItems.add(id); } };
    if (Array.isArray(body)) for (const item of body) add(item);
    if (Array.isArray(body?.collection)) for (const item of body.collection) add(item);
    if (Array.isArray(body?.tracks)) for (const item of body.tracks) add(item);
    rememberPaths(Array.isArray(body) ? body : body?.collection);
    rememberPaths(body?.tracks);
  }

  // ===========================================================================
  // Joining saved pages
  // ===========================================================================

  function rowURL(key, owner) {
    const prefix = `${owner}|`;
    if (!key.startsWith(prefix)) return null;
    const rest = key.slice(prefix.length), split = rest.indexOf('|');
    const name = rest.slice(0, split), args = rest.slice(split + 1);
    try {
      if (args.startsWith('https://')) return cleanURL(args);
      if (!LISTS.has(name) || !liveAPI?.getUrlForEndpoint) return null;
      const [path, query] = JSON.parse(args);
      return cleanURL(liveAPI.getUrlForEndpoint(name, path, query));
    } catch { return null; }
  }
  function combinePages(body, url, pages) {
    if (!Array.isArray(body?.collection)) return { body, stitched: 0 };
    const combined = { ...body, collection: body.collection.slice() };
    delete combined.__scRemoved;
    // Songs unliked since the later pages were saved.
    const removed = new Set(Array.isArray(body.__scRemoved) ? body.__scRemoved : []);
    const seenPages = new Set();
    const own = url && pageId(url);
    if (own) seenPages.add(own);
    const seenItems = new Set(combined.collection.map(itemId).filter(Boolean));
    let stitched = 0;
    while (typeof combined.next_href === 'string' && listURL(combined.next_href)) {
      const next = pageId(combined.next_href);
      if (!next || seenPages.has(next)) { combined.next_href = null; break; }
      seenPages.add(next);
      const page = pages.get(next);
      if (!Array.isArray(page?.collection)) break;
      for (const item of page.collection) {
        // Pages saved at different times can overlap. Show each item once.
        const id = itemId(item);
        if (id && (seenItems.has(id) || removed.has(id))) continue;
        if (id) seenItems.add(id);
        combined.collection.push(item);
      }
      combined.next_href = page.next_href ?? null;
      stitched++;
    }
    // Keep the first uncached cursor so ordinary infinite scrolling can continue.
    return { body: combined, stitched };
  }
  // Playlists list most songs as bare IDs. They sit in `tracks` of the body or
  // of a list item, so there is no need to walk every field of every song.
  function hasStubs(body) {
    const stubbed = tracks => Array.isArray(tracks) && tracks.some(track => track && typeof track === 'object' && !track.title);
    if (stubbed(body?.tracks)) return true;
    return Array.isArray(body?.collection) && body.collection.some(item => stubbed(item?.tracks) || stubbed(item?.playlist?.tracks));
  }
  // Page identity -> cache key, from the keys alone (no saved bodies are read).
  async function pageIndex(owner) {
    let index = pageIndexes.get(owner);
    if (index) return index;
    const keys = await transaction('readonly', entries => requestResult(entries.getAllKeys(
      IDBKeyRange.bound(`${owner}|`, `${owner}|\uffff`))));
    index = new Map();
    for (const key of keys) {
      if (key.includes('|trackBatch|')) continue;
      const source = rowURL(key, owner);
      const id = source ? pageId(source) : null;
      if (id) index.set(id, key);
    }
    pageIndexes.set(owner, index);
    return index;
  }
  // Some saved pages can only be matched by the URL stored with them. Read
  // those once per visit, and only if a page is missing from the key index.
  async function deepIndex(owner, index) {
    if (deepIndexed.has(owner)) return;
    deepIndexed.add(owner);
    await transaction('readonly', entries => new Promise((resolve, reject) => {
      const cursor = entries.openCursor(IDBKeyRange.bound(`${owner}|`, `${owner}|\uffff`));
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) return resolve();
        const row = item.value;
        const id = row.url && !row.key.includes('|trackBatch|') ? pageId(row.url) : null;
        if (id && !index.has(id)) index.set(id, row.key);
        item.continue();
      };
    }));
  }
  // Follow the saved list's paging links and load just those pages.
  async function loadChain(body, url, owner) {
    const pages = new Map();
    if (!Array.isArray(body?.collection)) return pages;
    const index = await pageIndex(owner);
    const seen = new Set();
    const own = url && pageId(url);
    if (own) seen.add(own);
    let next = body.next_href;
    while (typeof next === 'string' && listURL(next)) {
      const id = pageId(next);
      if (!id || seen.has(id)) break;
      seen.add(id);
      if (!index.has(id)) await deepIndex(owner, index);
      const key = index.get(id);
      if (!key) break;
      const row = await transaction('readonly', entries => requestResult(entries.get(key)));
      let page = null;
      try { page = row ? restore(row.body) : null; } catch { /* Ignore damaged cache entries. */ }
      if (!Array.isArray(page?.collection)) break;
      pages.set(id, page);
      next = page.next_href;
    }
    return pages;
  }
  async function expandCached(body, owner, url) {
    const started = performance.now();
    const pages = await loadChain(body, url, owner);
    const { body: expanded, stitched } = combinePages(body, url, pages);
    // Playlist responses can contain ID-only stubs after their first few tracks.
    // Fill them from saved songs before SoundCloud creates the models. Only
    // then is the rest of the cache read.
    if (hasStubs(expanded)) {
      const rows = await transaction('readonly', entries => requestResult(entries.getAll(
        IDBKeyRange.bound(`${owner}|`, `${owner}|\uffff`))));
      rows.sort((a, b) => (a.saved || 0) - (b.saved || 0));
      const tracks = new Map();
      const collect = (value, context = false) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { for (const item of value) collect(item, context); return; }
        if ((value.kind === 'track' || context) && value.id && value.title && value.duration != null) {
          tracks.set(String(value.id), value); return;
        }
        for (const [key, child] of Object.entries(value)) collect(child, key === 'track' || key === 'tracks');
      };
      for (const row of rows) {
        try { collect(JSON.parse(row.body), row.key.includes('|trackBatch|')); } catch { /* Ignore damaged cache entries. */ }
      }
      const fill = list => Array.isArray(list) ? list.map(track =>
        track && !track.title && tracks.has(String(track.id)) ? { ...tracks.get(String(track.id)), ...track } : track) : list;
      if (Array.isArray(expanded.tracks)) expanded.tracks = fill(expanded.tracks);
      if (Array.isArray(expanded.collection)) {
        for (const item of expanded.collection) {
          if (Array.isArray(item?.tracks)) item.tracks = fill(item.tracks);
          if (Array.isArray(item?.playlist?.tracks)) item.playlist.tracks = fill(item.playlist.tracks);
        }
      }
    }
    const id = url ? pageId(url) : null;
    if (id) expandedURLs.add(`${owner}|${id}`);
    stats.lastList = {
      pages: 1 + stitched,
      items: Array.isArray(expanded?.collection) ? expanded.collection.length
        : Array.isArray(expanded?.tracks) ? expanded.tracks.filter(track => !isStub(track)).length : 0,
      ms: Math.round(performance.now() - started),
    };
    return expanded;
  }

  // ===========================================================================
  // New likes
  // ===========================================================================

  // SoundCloud's own sign-in token, sent only to SoundCloud's API hosts (listURL).
  function oauthToken() {
    const match = document.cookie.match(/(?:^|;\s*)oauth_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }
  // A request to SoundCloud's API, made the way SoundCloud's own pages make it.
  async function apiJSON(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['api-v2.soundcloud.com', 'api.soundcloud.com'].includes(url.hostname)) {
      throw new Error('Not a SoundCloud API URL');
    }
    const clientId = config?.get('client_id') || seenClientId;
    if (clientId) url.searchParams.set('client_id', clientId);
    const token = oauthToken();
    const response = await fetch(url.href, { credentials: 'omit', headers: token ? { Authorization: `OAuth ${token}` } : {} });
    if (!response.ok) throw new Error(`SoundCloud request failed (${response.status})`);
    return response.json();
  }
  async function fetchJSON(value) {
    if (!listURL(value)) throw new Error('Not a SoundCloud list URL');
    return apiJSON(value);
  }
  function responseBody(response) {
    if (response?.status !== 200 || !response.body) throw new Error(`SoundCloud request failed (${response?.status ?? 'no answer'})`);
    return response.body;
  }
  async function livePage(name, url) {
    if (rawByUrl && liveAPI) return responseBody(await Reflect.apply(rawByUrl, liveAPI, [name, url]));
    return fetchJSON(url);
  }
  function raceTimeout(promise, ms) {
    let timer;
    return Promise.race([
      promise.then(value => ({ value, timedOut: false })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ value: null, timedOut: true }), ms); }),
    ]).finally(() => clearTimeout(timer));
  }
  // Lines the newest likes on SoundCloud up with the saved list. Returns the
  // list to show (or null if nothing changed) and saves the update.
  async function runLikesCheck({ key, page1, stitched: loading, clears, first, next }) {
    // Ask SoundCloud while the saved list is still being loaded, not after.
    let [page, stitched] = await Promise.all([first(), Promise.resolve(loading)]);
    capturePlayback(page);
    const saved = stitched?.collection;
    if (!Array.isArray(saved) || !Array.isArray(page1?.collection)) return null;
    const position = new Map();
    saved.forEach((item, index) => {
      const id = itemId(item);
      if (id && !position.has(id)) position.set(id, index);
    });
    if (saved.length && !position.size) return null; // Never rewrite items that cannot be matched.
    const live = [];
    let liveNext = null;
    let overlap = -1;
    for (let pages = 1; ; pages++) {
      if (!Array.isArray(page?.collection)) return null;
      const start = live.length;
      live.push(...page.collection);
      liveNext = typeof page.next_href === 'string' ? page.next_href : null;
      // The oldest server item that is also saved marks where the saved list continues.
      for (let index = live.length - 1; index >= start && overlap < 0; index--) {
        const at = position.get(itemId(live[index]));
        if (at !== undefined) overlap = at;
      }
      if (overlap >= 0 || pages >= MAX_LIVE_PAGES || !liveNext || !listURL(liveNext)) break;
      page = await next(liveNext);
      capturePlayback(page);
    }
    const liveIds = live.map(itemId);
    if (liveIds.some(id => !id)) return null;
    const inLive = new Set(liveIds);
    const added = live.filter(item => !position.has(itemId(item))).length;
    // Only the songs from SoundCloud need playback fields stripped; the saved
    // ones already have none, so the whole list is not copied again.
    const clean = item => JSON.parse(serialize(item));
    let display, stored, removed = 0;
    if (overlap < 0) {
      if (!live.length) return null;
      // Too many changes to line up with the saved list: restart it from the server's copy.
      stored = { ...page1, collection: live, next_href: liveNext };
      delete stored.__scRemoved;
      display = { ...stored, collection: live.map(clean), next_href: liveNext ? withClientId(cleanURL(liveNext)) : null };
      stats.likes = `restarted from the newest ${live.length} likes; older pages refill as you scroll`;
    } else {
      if (overlap === live.length - 1 && liveIds.every((id, index) => id === itemId(saved[index]))) {
        stats.likes = 'up to date';
        return null;
      }
      const own = page1.collection;
      const tail = saved.slice(overlap + 1).filter(item => !inLive.has(itemId(item)));
      display = { ...stitched, collection: [...live.map(clean), ...tail] };
      // Saved likes newer than the overlap that SoundCloud no longer lists were unliked.
      const gone = new Set(Array.isArray(page1.__scRemoved) ? page1.__scRemoved : []);
      for (const item of saved.slice(0, overlap + 1)) {
        const id = itemId(item);
        if (!id || inLive.has(id)) continue;
        removed++;
        // Those on the first page are simply dropped; later pages need a note.
        if (position.get(id) >= own.length) gone.add(id);
      }
      for (const id of inLive) gone.delete(id);
      stored = { ...page1, collection: [...live, ...own.slice(overlap + 1).filter(item => !inLive.has(itemId(item)))] };
      if (gone.size) stored.__scRemoved = [...gone].slice(-REMOVED_MAX);
      else delete stored.__scRemoved;
      const parts = [];
      if (added) parts.push(`${added} new`);
      if (removed) parts.push(`${removed} removed`);
      stats.likes = parts.length ? parts.join(', ') : 'order updated';
    }
    await rewrite(key, stored, clears);
    stats.newLikes += added;
    return withoutInternal(display);
  }
  function checkLikes(task) {
    const previous = likeChecks.get(task.key);
    if (previous && Date.now() - previous.at < RECHECK_MS) return previous.done ? Promise.resolve(null) : previous.promise;
    const record = { at: Date.now(), done: false, promise: null };
    record.promise = runLikesCheck(task)
      .then(value => { likesCheckedAt.set(task.key, Date.now()); return value; })
      .catch(error => { stats.likes = 'could not reach SoundCloud; showing saved likes'; noteError('Likes check', error); return null; })
      .finally(() => { record.done = true; });
    likeChecks.set(task.key, record);
    return record.promise;
  }
  // Start the new-likes check alongside loading the saved list. Wait for it
  // (up to LIVE_WAIT) only if no check finished in the last few minutes;
  // otherwise open at once and let it update the saved list for next time.
  function startLikesCheck(task) {
    const recent = Date.now() - (likesCheckedAt.get(task.key) || 0) < STALE_OK_MS;
    const deadline = Date.now() + LIVE_WAIT;
    const promise = checkLikes(task);
    return async body => {
      if (recent) return body;
      const outcome = await raceTimeout(promise, Math.max(0, deadline - Date.now()));
      if (outcome.timedOut) stats.likes = 'still checking; any new likes appear next time you open the list';
      return outcome.value || body;
    };
  }

  // ===========================================================================
  // Showing saved lists at once
  // ===========================================================================

  function markedList(collection) {
    const owner = account();
    for (const model of [collection, collection?.playlist]) {
      if (!model || typeof model !== 'object') continue;
      if (expandedModels.has(model)) return true;
      try {
        const url = typeof model.url === 'function' ? model.url() : model.url;
        const id = typeof url === 'string' ? pageId(url) : null;
        if (id && expandedURLs.has(`${owner}|${id}`)) return true;
      } catch { /* A view without a list URL keeps its normal behavior. */ }
    }
    return false;
  }
  function listModels(view) {
    const all = Array.isArray(view.collection?.models) ? view.collection.models : [];
    let rendered;
    try { rendered = view.getModelsToRender?.(); } catch { /* Use the collection itself. */ }
    if (!Array.isArray(rendered)) return all;
    // Some list views only return the part that is already on screen.
    const shown = typeof view._desiredLength === 'number' ? view._desiredLength : -1;
    return all.length > rendered.length && rendered.length === shown ? all : rendered;
  }
  function cachedLength(view) {
    if (!view?.collection) return 0;
    // Walking thousands of songs on every scroll frame adds up: reuse the
    // answer until the list, the served songs or the marked lists change.
    const signature = `${view.collection.models?.length}:${servedVersion}:${expandedURLs.size}:${shownLength(view)}`;
    const memo = lengthCache.get(view);
    if (memo?.signature === signature) return memo.value;
    const value = computeCachedLength(view);
    lengthCache.set(view, { signature, value });
    return value;
  }
  function computeCachedLength(view) {
    const models = listModels(view);
    if (!models.length) return 0;
    // Leading items that this script handed to SoundCloud from the cache.
    let prefix = 0;
    while (prefix < models.length && !isStub(models[prefix]) && servedItems.has(itemId(models[prefix]))) prefix++;
    if (!markedList(view.collection)) return prefix;
    // Stop at unknown playlist stubs rather than fetching uncached songs en masse.
    const firstStub = models.findIndex(isStub);
    return Math.max(prefix, firstStub < 0 ? models.length : firstStub);
  }
  function targetLength(view) {
    let count = cachedLength(view);
    const max = view.options?.maxDisplay;
    if (count && max) {
      if (max <= PREVIEW_MAX) count = Math.min(count, max);
      else if (count > max) view.options.maxDisplay = count;
    }
    return count;
  }
  function shownLength(view) {
    return typeof view._desiredLength === 'number' ? view._desiredLength : (applied.get(view) || 0);
  }
  function showItems(view, count) {
    expanding = true;
    try {
      applied.set(view, count);
      view.setDisplayedItems(count);
    } finally { expanding = false; }
  }
  const nextFrame = callback => (document.hidden || typeof requestAnimationFrame !== 'function'
    ? setTimeout(callback, 0) : requestAnimationFrame(callback));
  // How many more songs to draw so that drawn songs reach a few screens below
  // the window: 0 when far enough already. A big jump (e.g. the End key) asks
  // for enough to catch up at once. Lists that cannot be measured get a chunk.
  function songsWanted(view, shownNow) {
    const element = view._listElement?.[0] || view.el;
    if (!element || typeof element.getBoundingClientRect !== 'function') return RENDER_CHUNK;
    if (element.isConnected === false) return 0;
    const rect = element.getBoundingClientRect();
    if (!rect.width && !rect.height) return 0; // Hidden (e.g. another tab of the page).
    const missing = innerHeight * (1 + RENDER_AHEAD) - rect.bottom;
    if (missing <= 0) return 0;
    const perSong = shownNow > 0 && rect.height > 0 ? rect.height / shownNow : 80;
    return Math.max(RENDER_CHUNK, Math.min(600, Math.ceil(missing / perSong) + 10));
  }
  // The whole saved list stays loaded (for Play, shuffle and the queue), but
  // only the songs near where you are scrolled are drawn: a few screens
  // ahead, topped up as you scroll, straight from memory. Drawing all 2,000+
  // likes at once cost several hundred MB and made every click slower.
  // ---- Likes opened from another page ----
  // Opening Likes with Ctrl+R makes SoundCloud ask for the first page, which
  // the saved copy answers with your whole list. Arriving from another page
  // (Home -> Likes), SoundCloud often starts from songs it already had in
  // memory and never asks, so only those show. When a Likes list appears
  // holding part of your Likes, ask SoundCloud for "the next page" right away:
  // that request goes through the saved copy, which answers with the rest.
  const toppedUp = new WeakSet();
  const LIKES_PATH = /\/users\/[^/?#]+\/(?:likes|track_likes)(?:[/?#]|$)/;
  function topUpLikes(view) {
    if (toppedUp.has(view)) return;
    const collection = view.collection;
    if (!collection || typeof view.fetchNextPage !== 'function' || !collection.models?.length) return;
    const options = view.options || {};
    if (options.fullPageList === false || (options.maxDisplay && options.maxDisplay <= PREVIEW_MAX)) return; // Sidebars and shelves.
    let url;
    try { url = typeof collection.url === 'function' ? collection.url() : collection.url; } catch { return; }
    if (typeof url !== 'string' || !LIKES_PATH.test(url)) return;
    toppedUp.add(view);
    if (typeof collection.isFullyPopulated === 'function' && collection.isFullyPopulated()) return;
    const before = collection.models.length;
    stats.topUps++;
    Promise.resolve(view.fetchNextPage()).catch(() => {}).finally(() => {
      stats.lastTopUp = `${before} → ${collection.models?.length ?? '?'} songs`;
      scheduleSweep();
    });
  }
  function expandView(view) {
    if (expanding || !view || view.disposed || typeof view.setDisplayedItems !== 'function') return;
    try { topUpLikes(view); } catch (error) { noteError('completing Likes', error); }
    // Long saved lists are drawn as a window instead (below).
    if (windows.has(view)) { scheduleWindow(view); return; }
    if (canWindow(view)) { startWindow(view); return; }
    if (progressive.get(view)) return; // A chunk is being drawn; it checks again when done.
    // Already showing every loaded item: nothing to work out.
    const shownNow = shownLength(view);
    const loaded = view.collection?.models?.length;
    if (typeof loaded === 'number' && shownNow >= loaded) return;
    const available = targetLength(view);
    if (available <= shownNow) return;
    const wanted = songsWanted(view, shownNow);
    if (!wanted) return;
    // A list that redraws everything on each change is drawn in bigger chunks.
    const target = Math.min(available, shownNow + (redrawsAll.has(view) ? Math.max(wanted, RENDER_CHUNK * 5) : wanted));
    const task = { target, chunk: redrawsAll.has(view) ? target : RENDER_FIRST, done: 0 };
    progressive.set(view, task);
    stats.viewsExpanded++;
    const step = () => {
      if (windows.has(view)) { progressive.delete(view); return; }
      // task.done guarantees progress even if SoundCloud reports its length differently.
      const now = Math.max(shownLength(view), task.done);
      if (view.disposed || view.el?.isConnected === false || now >= task.target) {
        progressive.delete(view);
        // Still close to the end of what is drawn? Add the next chunk.
        if (!view.disposed && now >= task.target) nextFrame(() => { try { expandView(view); } catch {} });
        return;
      }
      // Let a click or scroll be handled first; draw more on a later frame.
      if (userBusy()) { nextFrame(step); return; }
      const next = Math.min(task.target, now + task.chunk);
      const started = performance.now();
      try { showItems(view, next); } catch { progressive.delete(view); return; }
      task.done = next;
      const elapsed = performance.now() - started;
      const added = next - now;
      if (task.unit === undefined) task.unit = Math.max(0.01, elapsed / added);
      else if (elapsed > 2 * added * task.unit + 16) {
        // Each step costs far more than the items it adds: SoundCloud redraws
        // the whole list every time, so steps only add work. Finish in one go.
        redrawsAll.add(view);
        try { showItems(view, task.target); } catch { /* Keep what is shown. */ }
        progressive.delete(view);
        nextFrame(() => { try { expandView(view); } catch {} });
        return;
      }
      // Size the next step to fit the per-frame budget.
      if (elapsed > 0.5) task.chunk = Math.max(8, Math.min(400, Math.round(added * RENDER_BUDGET / elapsed)));
      else task.chunk = Math.min(400, task.chunk * 2);
      nextFrame(step);
    };
    nextFrame(step);
  }
  function trackView(view) {
    if (typeof WeakRef !== 'function' || !view || trackedViews.has(view)) return;
    trackedViews.add(view);
    liveViews.add(new WeakRef(view));
  }
  function sweep() {
    for (const ref of liveViews) {
      const view = ref.deref();
      if (!view || view.disposed) { liveViews.delete(ref); continue; }
      try { expandView(view); } catch { /* Leave this list as SoundCloud rendered it. */ }
    }
  }
  // Cached data can reach a list after its own fetch callbacks have run, so
  // check the open lists again shortly after every cache hit.
  function scheduleSweep() {
    for (const timer of sweepTimers) clearTimeout(timer);
    sweepTimers = [0, 250, 1000].map(delay => setTimeout(sweep, delay));
  }
  // ===========================================================================
  // Windowed long lists
  // ===========================================================================

  // A long saved list is drawn as a window: only the songs on screen plus a
  // little either side exist on the page. Space above and below stands in for
  // the rest, sized from the songs' real height, so the scrollbar covers the
  // whole list and you can drag anywhere. Songs that leave the window are
  // disposed by SoundCloud's own code (freeing their memory) and rebuilt if
  // you come back. Play, the queue and shuffle use SoundCloud's full list of
  // songs, which is never touched; only what is drawn changes.
  //
  // Built from SoundCloud's own list parts: addListItemSubview + render +
  // addListItemToDOM (at the top or bottom) to draw a song, and removeSubview
  // + _dispose to remove one. Its "load more near the bottom" (preloadAt) is
  // switched off for these lists so the two do not fight.
  // Any long SoundCloud list can be windowed, wherever its songs came from
  // (1.8.0 also required the list to come from the saved copy, and that
  // check failed on the real Likes page, so the window never switched on).
  function windowBlocker(view) {
    const models = view.collection?.models;
    const options = view.options;
    if (!Array.isArray(models)) return 'no song list';
    if (models.length < WINDOW_MIN) return `only ${models.length} songs`;
    if (!view._listElement?.[0]) return 'no list element';
    if (!options) return 'no list options';
    if (options.fullPageList === false) return 'list scrolls inside a box';
    if (options.inverted) return 'list is upside down';
    if (options.maxDisplay && options.maxDisplay <= PREVIEW_MAX) return 'preview list';
    const missing = ['addListItemSubview', 'addListItemToDOM', 'getSubviewWrapper', 'removeSubview', 'getListItemViews']
      .find(name => typeof view[name] !== 'function');
    return missing ? `list has no ${missing}` : null;
  }
  function canWindow(view) {
    const reason = windowBlocker(view);
    // Remember why a long list was not windowed, for the panel and diagnostics.
    if (reason && (view.collection?.models?.length || 0) >= WINDOW_MIN) stats.windowSkip = reason;
    return !reason;
  }
  const wrapperOf = (view, sub) => view.getSubviewWrapper(sub)?.[0] || null;
  function equivalent(view, sub, model) {
    const key = value => value?.getEquivalencyKey?.() ?? value?.cid ?? value;
    const target = typeof view.getSubviewModel === 'function' ? view.getSubviewModel(model) : model;
    return key(sub?.model) === key(target);
  }
  function drawSong(view, model, atTop) {
    const sub = view.addListItemSubview(model);
    sub.render();
    view.addListItemToDOM(sub, atTop ? 0 : -1);
    return sub;
  }
  function removeSong(view, sub) {
    try {
      const wrapper = view.getSubviewWrapper(sub);
      view.removeSubview(sub);
      if (wrapper?.detach) wrapper.detach(); else wrapper?.[0]?.remove();
      sub._dispose?.();
      stats.windowRemoved++;
    } catch { /* Already gone. */ }
  }
  // Songs per row (1 in list view, several in grid view) and the height of a row.
  function measureWindow(view, state) {
    const views = state.views;
    if (!views.length) return;
    const tops = [];
    for (const sub of views.slice(0, 25)) {
      const element = wrapperOf(view, sub);
      if (element) tops.push(element.getBoundingClientRect().top);
    }
    if (!tops.length) return;
    let perRow = 1;
    while (perRow < tops.length && Math.abs(tops[perRow] - tops[0]) < 2) perRow++;
    const rows = Math.ceil(views.length / perRow);
    const lastRowFirst = wrapperOf(view, views[(rows - 1) * perRow]);
    const lastElement = wrapperOf(view, views[views.length - 1]);
    let rowH = 0;
    if (rows > 1 && lastRowFirst) rowH = (lastRowFirst.getBoundingClientRect().top - tops[0]) / (rows - 1);
    else if (lastElement) rowH = lastElement.getBoundingClientRect().bottom - tops[0];
    state.perRow = perRow;
    if (rowH > 0) state.rowH = rowH;
  }
  function startWindow(view) {
    const list = view._listElement[0];
    progressive.delete(view);
    const state = {
      list, start: 0, end: 0, views: [], topPad: 0, bottomPad: 0, perRow: 1, rowH: 150,
      dirty: true, remeasure: false, fetching: false,
    };
    windows.set(view, state);
    stats.windowedLists++;
    // SoundCloud's own "load more near the bottom" is replaced by the window.
    view.options.preloadAt = -1e9;
    // The browser's scroll anchoring would fight the window's own adjustments.
    list.style.overflowAnchor = 'none';
    // Keep what SoundCloud already drew if it is simply the top of the list.
    const models = view.collection.models;
    const byWrapper = new Map(view.getListItemViews().map(sub => [wrapperOf(view, sub), sub]));
    const ordered = [...list.children].map(child => byWrapper.get(child)).filter(Boolean);
    if (ordered.length && ordered.length === byWrapper.size && ordered.every((sub, index) => equivalent(view, sub, models[index]))) {
      state.views = ordered;
      state.end = ordered.length;
      state.dirty = false;
      measureWindow(view, state);
    }
    try {
      // A change anywhere in the list redraws the window (SoundCloud's own
      // handling of it is switched off above).
      view.listenTo?.(view.collection, 'remove reset sort', () => markWindowDirty(view));
    } catch { /* The window still redraws when SoundCloud rebuilds the list. */ }
    scheduleWindow(view);
  }
  function markWindowDirty(view) {
    const state = windows.get(view);
    if (!state) return;
    state.dirty = true;
    scheduleWindow(view);
  }
  // Songs added after the window only lengthen the space below it.
  function windowAdded(view, model, collection) {
    const state = windows.get(view);
    if (!state) return;
    const index = (collection || view.collection)?.indexOf?.(model);
    if (!(index >= state.end)) state.dirty = true;
    scheduleWindow(view);
  }
  function scheduleWindow(view) {
    if (windowQueued.has(view)) return;
    windowQueued.add(view);
    nextFrame(() => {
      windowQueued.delete(view);
      try { updateWindow(view); } catch (error) { noteError('drawing a long list', error); }
    });
  }
  function setPads(state) {
    state.list.style.paddingTop = `${Math.max(0, Math.round(state.topPad))}px`;
    state.list.style.paddingBottom = `${Math.max(0, Math.round(state.bottomPad))}px`;
  }
  function updateWindow(view) {
    const state = windows.get(view);
    if (!state) return;
    if (view.disposed) { windows.delete(view); return; }
    const list = view._listElement?.[0];
    if (!list) return;
    if (list !== state.list) {
      // SoundCloud rebuilt the list (e.g. after a reset): start the window again.
      state.list = list;
      list.style.overflowAnchor = 'none';
      state.dirty = true;
    }
    if (state.remeasure) {
      const perRow = state.perRow;
      measureWindow(view, state);
      state.remeasure = false;
      if (state.perRow !== perRow) state.dirty = true;
    }
    const models = view.collection.models;
    const total = models.length;
    const perRow = state.perRow;
    const rowH = state.rowH;
    const totalRows = Math.ceil(total / perRow);
    const rect = list.getBoundingClientRect();
    if (!rect.width && !rect.height) return; // Hidden (another tab of the page).
    const screen = innerHeight;
    const top = -rect.top;          // The window's top, measured from the top of the list.
    const bottom = screen - rect.top;
    let startRow = state.start / perRow;
    let endRow = Math.ceil(state.end / perRow);
    const drawnHeight = Math.max(0, rect.height - state.topPad - state.bottomPad);
    const clampRow = row => Math.max(0, Math.min(totalRows, row));

    // Jumped somewhere nothing is drawn (or the list changed): draw from there.
    const drawnTop = state.topPad, drawnBottom = state.topPad + drawnHeight;
    const overlaps = state.views.length && bottom + screen > drawnTop && top - screen < drawnBottom;
    if (state.dirty || !overlaps) {
      if (state.views.length) measureWindow(view, state);
      // Start from the first song on screen, so the songs you can see are drawn
      // first; the margin above is added afterwards. (1.8.0/1.8.1 started a
      // screen above, and when SoundCloud's songs took longer to build than a
      // frame allowed, it kept starting over without ever reaching the screen.)
      const row = clampRow(Math.floor(Math.max(0, top) / state.rowH));
      for (const sub of view.getListItemViews()) removeSong(view, sub);
      state.views = [];
      state.start = state.end = Math.min(row * state.perRow, total);
      state.topPad = (state.start / state.perRow) * state.rowH;
      state.bottomPad = (totalRows - state.start / state.perRow) * state.rowH;
      // Keep the page its full height right away, so the browser never shortens
      // it (and moves you) while songs are being drawn.
      setPads(state);
      state.dirty = false;
      stats.windowRebuilds++;
      startRow = endRow = state.start / state.perRow;
    }

    // Where the screen is, in rows: real heights where songs are drawn,
    // estimated heights in the space above and below.
    const drawnRowH = endRow > startRow && drawnHeight > 0 ? drawnHeight / (endRow - startRow) : rowH;
    const aboveRowH = startRow > 0 && state.topPad > 0 ? state.topPad / startRow : rowH;
    const rowAt = y => {
      if (y < state.topPad) return y / aboveRowH;
      if (y < state.topPad + (endRow - startRow) * drawnRowH) return startRow + (y - state.topPad) / drawnRowH;
      return endRow + (y - state.topPad - (endRow - startRow) * drawnRowH) / rowH;
    };
    const wantFrom = clampRow(Math.floor(rowAt(top - screen * KEEP_SCREENS)));
    const wantTo = clampRow(Math.ceil(rowAt(bottom + screen * KEEP_SCREENS)));
    const dropAbove = Math.floor(rowAt(top - screen * DROP_SCREENS));
    const dropBelow = Math.ceil(rowAt(bottom + screen * DROP_SCREENS));
    const started = performance.now();
    // Empty screen: draw harder until it is covered, then go back to small steps.
    const screenEmpty = Math.ceil(state.end / perRow) < Math.min(totalRows, Math.ceil(rowAt(bottom)))
      || state.start / perRow > Math.max(0, Math.floor(rowAt(top)));
    const budget = screenEmpty ? WINDOW_URGENT : WINDOW_BUDGET;
    const budgetLeft = () => performance.now() - started < budget;
    let more = false;

    // Remove songs far above, keeping everything below exactly in place.
    if (startRow < dropAbove && state.views.length) {
      const rows = Math.min(dropAbove - startRow, endRow - startRow - 1);
      const count = Math.min(rows * perRow, state.views.length - 1);
      if (count > 0) {
        const first = wrapperOf(view, state.views[0]);
        const keep = wrapperOf(view, state.views[count]);
        const removed = first && keep ? keep.getBoundingClientRect().top - first.getBoundingClientRect().top : (count / perRow) * rowH;
        for (const sub of state.views.splice(0, count)) removeSong(view, sub);
        state.start += count;
        state.topPad += Math.max(0, removed);
        setPads(state);
      }
    }
    // Remove songs far below.
    if (endRow > dropBelow && endRow - startRow > 1) {
      const keepRows = Math.max(1, dropBelow - state.start / perRow);
      const newEnd = Math.min(state.end, state.start + keepRows * perRow);
      for (const sub of state.views.splice(newEnd - state.start)) removeSong(view, sub);
      state.end = newEnd;
    }
    // Draw songs coming into view below.
    while (Math.ceil(state.end / perRow) < wantTo && state.end < total) {
      if (!budgetLeft()) { more = true; break; }
      const until = Math.min(total, (Math.floor(state.end / perRow) + 1) * perRow);
      for (let index = state.end; index < until; index++) state.views.push(drawSong(view, models[index], false));
      state.end = until;
    }
    // Draw songs coming into view above, keeping what is on screen in place.
    if (state.start / perRow > wantFrom && state.views.length && !more) {
      const anchorElement = wrapperOf(view, state.views[0]);
      const before = anchorElement?.getBoundingClientRect().top;
      while (state.start / perRow > wantFrom) {
        if (!budgetLeft()) { more = true; break; }
        const from = Math.max(0, state.start - perRow);
        for (let index = state.start - 1; index >= from; index--) state.views.unshift(drawSong(view, models[index], true));
        state.start = from;
      }
      const added = anchorElement ? anchorElement.getBoundingClientRect().top - before : 0;
      state.topPad -= added;
      setPads(state);
      if (state.start === 0 || state.topPad < 0) {
        // The estimate above was off: settle it and move the page by the same
        // amount so nothing on screen jumps.
        const correction = state.topPad;
        state.topPad = 0;
        if (correction) window.scrollBy(0, -correction);
      }
    }
    state.bottomPad = (totalRows - Math.ceil(state.end / perRow)) * state.rowH;
    setPads(state);
    // Keep SoundCloud's own count in step with what is drawn.
    view._desiredLength = state.views.length;
    stats.windowDrawn = state.views.length;
    stats.windowTotal = total;
    // At the end of what is loaded: ask SoundCloud for more (served from the
    // saved copy when there is one). Lists that cannot say whether they are
    // complete keep asking until a request adds nothing.
    const knowsIfComplete = typeof view.collection.isFullyPopulated === 'function';
    const mayHaveMore = knowsIfComplete ? !view.collection.isFullyPopulated() : state.moreAvailable !== false;
    if (state.end >= total && !state.fetching && mayHaveMore && typeof view.fetchNextPage === 'function') {
      state.fetching = true;
      const before = total;
      Promise.resolve(view.fetchNextPage()).catch(() => {}).finally(() => {
        state.fetching = false;
        if (view.collection && view.collection.models.length <= before) state.moreAvailable = false;
        scheduleWindow(view);
      });
    }
    if (more) scheduleWindow(view);
  }
  addEventListener('resize', () => {
    for (const ref of liveViews) {
      const view = ref.deref();
      const state = view && windows.get(view);
      if (state) { state.remeasure = true; scheduleWindow(view); }
    }
  }, { passive: true });

  let scrollQueued = false;
  function onScroll() {
    if (scrollQueued || !liveViews.size) return;
    scrollQueued = true;
    nextFrame(() => { scrollQueued = false; sweep(); });
  }
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('resize', onScroll, { passive: true });

  // ===========================================================================
  // Bridge for the Layout script
  // ===========================================================================

  // The SoundCloud Layout script's list bar (song position, jump to a song,
  // jump to the playing song) needs to know where songs are, which only this
  // script knows once a list is drawn as a window. Lists are found by an
  // element that contains them, so the bar asks about the list it sits on.
  function viewIn(container) {
    let best = null;
    for (const ref of liveViews) {
      const view = ref.deref();
      if (!view || view.disposed) continue;
      const list = view._listElement?.[0];
      if (!list?.isConnected || (container && !container.contains(list))) continue;
      if (view.options?.maxDisplay && view.options.maxDisplay <= PREVIEW_MAX) continue;
      if ((view.collection?.models?.length || 0) > (best?.collection?.models?.length || 0)) best = view;
    }
    return best;
  }
  // The element of the song at an index, if it is drawn.
  function drawnAt(view, index) {
    const state = windows.get(view);
    const list = view._listElement?.[0];
    if (!list) return null;
    const offset = state ? state.start : 0;
    const element = list.children[index - offset];
    if (state && index >= state.end) return null;
    return element || null;
  }
  // The first song whose bottom is below `edge` (a distance from the top of the screen).
  function firstVisible(view, edge) {
    const list = view._listElement?.[0];
    const children = list?.children;
    if (!children?.length) return 0;
    const offset = windows.get(view)?.start || 0;
    let low = 0, high = children.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (children[middle].getBoundingClientRect().bottom <= edge) low = middle + 1; else high = middle;
    }
    return offset + low;
  }
  function pathOf(url) {
    try { return new URL(url, 'https://soundcloud.com').pathname.replace(/\/+$/, '').toLowerCase(); } catch { return null; }
  }
  function modelPath(item) {
    for (const target of [item, field(item, 'track'), field(item, 'playlist')]) {
      if (!target || typeof target !== 'object') continue;
      const url = field(target, 'permalink_url');
      if (typeof url === 'string') return pathOf(url);
    }
    return null;
  }
  // A list item is either a song (or playlist) or, in Likes, a like that
  // holds one; only a like's own date says when you liked it.
  function describeItem(model) {
    let inner = null;
    for (const key of ['track', 'playlist']) {
      const value = field(model, key);
      if (value && typeof value === 'object') { inner = value; break; }
    }
    const sound = inner || model;
    const user = field(sound, 'user');
    const liked = inner ? Date.parse(field(model, 'created_at')) : NaN;
    return {
      title: field(sound, 'title') ?? null,
      artist: (user && typeof user === 'object' ? field(user, 'username') : null) ?? null,
      likedAt: Number.isFinite(liked) ? liked : null,
    };
  }
  const monthCache = new WeakMap();
  const waitFrames = count => new Promise(resolve => {
    const step = () => (--count <= 0 ? resolve() : nextFrame(step));
    nextFrame(step);
  });
  // Scroll so the song at `index` sits `edge` pixels from the top of the
  // screen. A far jump first lands on the window's estimate, then corrects
  // using the song's real position once it is drawn.
  async function scrollToIndex(view, index, edge) {
    const list = view._listElement?.[0];
    const total = view.collection?.models?.length || 0;
    if (!list || !total) return null;
    index = Math.max(0, Math.min(total - 1, Math.floor(index)));
    for (let attempt = 0; attempt < 12; attempt++) {
      const element = drawnAt(view, index);
      if (element) {
        const distance = element.getBoundingClientRect().top - edge;
        if (Math.abs(distance) < 2) return element;
        window.scrollBy(0, distance);
      } else {
        const state = windows.get(view);
        const rowH = state?.rowH || list.firstElementChild?.offsetHeight || 150;
        const perRow = state?.perRow || 1;
        const listTop = list.getBoundingClientRect().top + scrollY;
        window.scrollTo(0, listTop + Math.floor(index / perRow) * rowH - edge);
      }
      await waitFrames(3);
    }
    return drawnAt(view, index);
  }
  Object.defineProperty(window, 'scLikesLongLists', {
    configurable: false,
    value: Object.freeze({
      version: 1,
      // { total, first, complete, windowed } for the list inside `container`.
      listInfo(container, edge = 0) {
        const view = viewIn(container);
        if (!view) return null;
        const complete = typeof view.collection.isFullyPopulated === 'function' ? view.collection.isFullyPopulated() : null;
        return {
          total: view.collection.models.length, first: firstVisible(view, edge), complete,
          windowed: windows.has(view), perRow: windows.get(view)?.perRow || 1,
        };
      },
      // { title, artist, likedAt } of the song at an index (likedAt in ms, or null).
      itemAt(container, index) {
        const model = viewIn(container)?.collection?.models?.[index];
        return model ? describeItem(model) : null;
      },
      // The month each song was liked in (year * 12 + month, or -1), for the
      // fast-scroll rail's year markers. Worked out once per list version.
      likedMonths(container) {
        const view = viewIn(container);
        const models = view?.collection?.models;
        if (!models) return null;
        const cached = monthCache.get(view);
        if (cached && cached.total === models.length && cached.head === models[0] && cached.tail === models[models.length - 1]) return cached.months;
        const months = new Int32Array(models.length);
        for (let index = 0; index < models.length; index++) {
          const likedAt = describeItem(models[index]).likedAt;
          if (likedAt == null) { months[index] = -1; continue; }
          const date = new Date(likedAt);
          months[index] = date.getFullYear() * 12 + date.getMonth();
        }
        monthCache.set(view, { total: models.length, head: models[0], tail: models[models.length - 1], months });
        return months;
      },
      // Index of a song (by its page address) in the list, or -1.
      indexOf(container, url) {
        const view = viewIn(container);
        const wanted = pathOf(url);
        if (!view || !wanted) return -1;
        return view.collection.models.findIndex(model => modelPath(model) === wanted);
      },
      // Scrolls to a song; resolves with its element once drawn (or null).
      async scrollTo(container, index, edge = 0) {
        const view = viewIn(container);
        return view ? scrollToIndex(view, index, edge) : null;
      },
      // The page's layout changed (e.g. compact rows): measure songs again.
      relayout() {
        for (const ref of liveViews) {
          const view = ref.deref();
          const state = view && windows.get(view);
          if (state) { state.remeasure = true; state.dirty = true; scheduleWindow(view); }
        }
      },
    }),
  });

  function patchListView(View) {
    const prototype = View?.prototype;
    if (!prototype || patched.has(prototype) || typeof prototype.getInitialDesiredLength !== 'function') return;
    patched.add(prototype);
    const initialLength = prototype.getInitialDesiredLength;
    prototype.getInitialDesiredLength = function (...args) {
      const base = Reflect.apply(initialLength, this, args);
      let count = 0;
      try { trackView(this); count = targetLength(this); } catch { /* Keep SoundCloud's length. */ }
      // Start with a screenful; the rest is drawn over the next frames.
      const first = Math.max(base, Math.min(count, RENDER_FIRST));
      if (first > base) applied.set(this, first);
      if (count > first) nextFrame(() => { try { expandView(this); } catch {} });
      return first;
    };
    const afterFetch = prototype.afterFetch;
    if (typeof afterFetch === 'function') {
      prototype.afterFetch = function (...args) {
        const result = Reflect.apply(afterFetch, this, args);
        // Expand after SoundCloud's own handling, so its bookkeeping cannot
        // shrink the list back to a single page.
        try { trackView(this); expandView(this); } catch { /* Keep SoundCloud's rendering. */ }
        if (result && typeof result.then === 'function') {
          result.then(() => { try { expandView(this); } catch {} }, () => {});
        }
        return result;
      };
    }
    // In a windowed list, the window decides which songs exist on the page.
    // SoundCloud's own "show N songs", "song added" and "song removed"
    // handling would put songs in the wrong place, so for those lists they
    // only tell the window to redraw.
    for (const name of ['setDisplayedItems', 'onAdd', 'onRemove']) {
      const original = prototype[name];
      if (typeof original !== 'function') continue;
      prototype[name] = function (...args) {
        if (!windows.has(this)) return Reflect.apply(original, this, args);
        if (name === 'onAdd') windowAdded(this, args[0], args[1]);
        else if (name === 'onRemove') markWindowDirty(this);
        return undefined;
      };
    }
    listViewActive = true;
    scheduleSweep();
  }

  // ===========================================================================
  // Serving saved lists
  // ===========================================================================

  function patchBackbone(Backbone) {
    if (!Backbone || patched.has(Backbone) || typeof Backbone.sync !== 'function' || !deferred || !config) return;
    patched.add(Backbone);
    const original = Backbone.sync;
    Backbone.sync = function (method, model, options = {}) {
      options = options || {};
      const owner = account();
      queueMicrotask(checkSongPage);
      let value;
      try { value = options.url || (typeof model.url === 'function' ? model.url() : model.url); }
      catch { return Reflect.apply(original, this, arguments); }
      if (method !== 'read' || storageFailed || !owner || !listURL(value) || options.headers || options.beforeSend || options.xhr || options.jqAjax) {
        return Reflect.apply(original, this, arguments);
      }
      const self = this;
      const result = deferred.defer();
      const promise = result.promise();
      let aborted = false, started = false, native;
      promise.abort = () => {
        if (result.state() !== 'pending') return promise;
        aborted = true;
        if (started) native?.abort?.();
        options.error?.(promise, 'abort', 'abort');
        result.reject(promise, 'abort', 'abort');
        options.complete?.(promise, 'abort');
        return promise;
      };
      const key = `${owner}|backbone|${cleanURL(value)}`;
      noteRequest(null, value);
      (async () => {
        let cached, body;
        if (alreadyDelivered(value)) body = { collection: [], next_href: null };
        else {
          try {
            cached = await lookup(key);
            // A page saved another way (e.g. while saving your full Likes) also counts.
            if (cached && !cached.entry) cached = { ...cached, entry: await savedPageFor(owner, value) };
          } catch { storageError(); }
        }
        if (aborted) return;
        if (body === undefined && cached?.entry && account() === owner) {
          try {
            const page1 = restore(cached.entry.body);
            body = page1;
            const expansion = expandCached(page1, owner, value).catch(() => page1);
            const finish = isLikesFirstPage(value)
              ? startLikesCheck({ key: cached.entry.key || key, page1, stitched: expansion, clears: cached.clears, first: () => likesPage(value), next: likesPage })
              : null;
            body = await expansion;
            if (finish) body = await finish(body);
          } catch { /* Fetch corrupt entries again. */ }
        }
        if (aborted) return;
        if (body !== undefined && account() === owner) {
          body = withoutInternal(body);
          expandedModels.add(model);
          rememberServed(body);
          rememberOrder(body);
          noteLikesList(owner, value, body, model);
          stats.hits++;
          Object.assign(promise, { status: 200, statusText: 'OK', readyState: 4, responseJSON: body });
          options.success?.(body, 'success', promise);
          result.resolve(body, 'success', promise);
          options.complete?.(promise, 'success');
          scheduleSweep();
          return;
        }
        stats.misses++;
        started = true;
        const networkOptions = { ...options };
        for (const callback of ['success', 'error', 'complete']) {
          networkOptions[callback] = function (...args) {
            if (!aborted && options[callback]) return Reflect.apply(options[callback], this, args);
          };
        }
        native = Reflect.apply(original, self, [method, model, networkOptions]);
        native.done((...args) => {
          if (aborted) return;
          if (cached && account() === owner && args[0] && (!native.status || native.status === 200)) {
            void save(key, serialize(args[0]), cached.generation, value).catch(storageError);
          }
          capturePlayback(args[0]);
          if (account() === owner) noteLikesList(owner, value, args[0], model);
          result.resolve(...args);
        }).fail((...args) => {
          if (aborted) return;
          result.reject(...args);
        });
      })().catch(error => result.reject(error));
      return promise;
    };
  }

  function patchAPI(api) {
    if (!api || patched.has(api) || !deferred || !config) return;
    patched.add(api);
    if (typeof api.callEndpointByUrl === 'function') rawByUrl = api.callEndpointByUrl;
    for (const method of ['callEndpoint', 'callEndpointByUrl']) {
      const original = api[method];
      if (typeof original !== 'function') continue;
      api[method] = function (...args) {
        const name = args[0];
        const owner = account();
        const byURL = method === 'callEndpointByUrl';
        const headers = args[byURL ? 2 : 3];
        const data = args[byURL ? 3 : 4];
        const extras = args[byURL ? 4 : 5];
        queueMicrotask(checkSongPage);
        if (storageFailed || !owner || !eligible(name) || extras?.abort || data || (headers && Object.keys(headers).length)) {
          return Reflect.apply(original, this, args);
        }
        const self = this;
        const result = deferred.defer();
        // Return SoundCloud's own Deferred type so .done/.fail callers keep working.
        (async () => {
          let cached, key, url;
          try {
            key = cacheKey(method, args, owner);
            try { url = byURL ? args[1] : api.getUrlForEndpoint?.(name, args[1], args[2]); } catch { /* Save without a page URL. */ }
            noteRequest(name, url);
            if (LISTS.has(name) && url && alreadyDelivered(url)) return { body: { collection: [], next_href: null }, status: 200, headers: {} };
            cached = await lookup(key);
            // A page saved another way (e.g. while saving your full Likes) also counts.
            if (!cached.entry && LISTS.has(name) && url) cached = { ...cached, entry: await savedPageFor(owner, url) };
          } catch { storageError(); return await Reflect.apply(original, self, args); }
          if (cached.entry && account() === owner) {
            try {
              const page1 = restore(cached.entry.body);
              let body = page1;
              if (LISTS.has(name)) {
                const expansion = expandCached(page1, owner, url).catch(() => page1);
                const finish = isLikesFirstPage(url, name, byURL)
                  ? startLikesCheck({
                    key: cached.entry.key || key, page1, stitched: expansion, clears: cached.clears,
                    first: async () => responseBody(await Reflect.apply(original, self, args)),
                    next: nextURL => livePage(name, nextURL),
                  })
                  : null;
                body = await expansion;
                if (finish) body = await finish(body);
              }
              body = withoutInternal(body);
              stats.hits++;
              rememberServed(body);
              if (LISTS.has(name)) {
                rememberOrder(body);
                if (url) noteLikesList(owner, url, body, null);
                // Song batches fetched while playing do not change any list on screen.
                scheduleSweep();
              }
              return { body, status: 200, headers: {} };
            } catch { /* A damaged record falls back to a real request. */ }
          }
          stats.misses++;
          const response = await Reflect.apply(original, self, args);
          if (response?.status === 200 && response.body && account() === owner) {
            void save(key, serialize(response.body), cached.generation, url).catch(storageError);
          }
          if (response?.status === 200) {
            capturePlayback(response.body);
            if (url && account() === owner) noteLikesList(owner, url, response.body, null);
          }
          return response;
        })().then(value => result.resolve(value), error => result.reject(error));
        return result.promise();
      };
    }
    liveAPI = api;
    apiActive = true;
    refreshBadge();
    queueMicrotask(checkSongPage);
  }

  function patchTrack(Model) {
    const prototype = Model?.prototype;
    if (!prototype || patched.has(prototype) || typeof prototype.getOrFetch !== 'function') return;
    const original = prototype.getOrFetch;
    prototype.getOrFetch = function (attrs) {
      if (Array.isArray(attrs) && attrs.some(key => key === 'media' || key === 'track_authorization')) {
        try {
          publishWaveform(this);
          planAhead(this);
        } catch { /* Preparation is optional. */ }
        if (!this.attrExists(attrs)) {
          // Saved metadata intentionally lacks media and authorization. Reuse
          // fresh details SoundCloud sent during this visit, if any.
          const id = this.id ?? field(this, 'id');
          const useFresh = () => {
            const fields = freshFields(id);
            if (!fields) return false;
            try { this.set(fields); } catch { /* Fall back to a request. */ }
            return this.attrExists(attrs);
          };
          // Otherwise force an uncached single-track request; do not send it
          // back through the metadata batch cache.
          const fetchOwn = () => {
            stats.extraFetches++;
            return this.fetch({ batch: false }).then(() => {
              capturePlayback(this.attributes || null);
              return Reflect.apply(original, this, [attrs]);
            });
          };
          if (useFresh()) {
            stats.instantStarts++;
            return Reflect.apply(original, this, [attrs]);
          }
          const pending = id != null ? pendingFields.get(String(id)) : null;
          if (pending && deferred) {
            // Its details are already being fetched (it was on screen or next
            // up): wait for that instead of asking SoundCloud a second time.
            const result = deferred.defer();
            Promise.race([pending, wait(2000)])
              .then(() => {
                if (!useFresh()) return fetchOwn();
                stats.instantStarts++;
                return Reflect.apply(original, this, [attrs]);
              })
              .then(value => result.resolve(value), error => result.reject(error));
            return result.promise();
          }
          return fetchOwn();
        }
      }
      return Reflect.apply(original, this, arguments);
    };
    patched.add(prototype);
    playbackSafe = true;
  }

  // ===========================================================================
  // Shuffling all of your Likes
  // ===========================================================================

  // SoundCloud shuffles only the songs its list has loaded. Saving the rest of
  // your Likes in the background makes the opened list - and so the play queue
  // and shuffle - cover all of them.

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  function noteError(where, error) {
    recentErrors.push({ where, message: String(error?.message || error).slice(0, 160), at: new Date().toLocaleTimeString() });
    while (recentErrors.length > 10) recentErrors.shift();
  }
  // Remember which of SoundCloud's endpoint names loads your Likes, and the
  // client ID its requests use, so the script can ask the same way.
  function noteRequest(name, url) {
    if (typeof url !== 'string') return;
    try {
      const parsed = new URL(url, location.origin);
      const clientId = parsed.searchParams.get('client_id');
      if (clientId) seenClientId = clientId;
      const kind = parsed.pathname.match(/^\/users\/[^/]+\/(likes|track_likes)\/?$/)?.[1];
      if (kind && name && listURL(parsed.href)) likesEndpoints.set(kind, name);
    } catch { /* Not a URL. */ }
  }
  async function likesPage(url) {
    const kind = new URL(url).pathname.match(/\/(likes|track_likes)\/?$/)?.[1];
    const name = kind && likesEndpoints.get(kind);
    if (name && rawByUrl && liveAPI) return responseBody(await Reflect.apply(rawByUrl, liveAPI, [name, url]));
    return apiJSON(url);
  }
  // One identity per list, whichever page of it a URL points to.
  function listIdentity(value) {
    try {
      const url = new URL(value, location.origin);
      url.searchParams.delete('offset');
      url.searchParams.delete('cursor');
      return pageId(url.href);
    } catch { return null; }
  }
  function isOwnLikes(value) {
    const me = account();
    if (!me) return false;
    try {
      const { pathname } = new URL(value, location.origin);
      const match = pathname.match(/^\/users\/(?:soundcloud:users:)?([^/]+)\/(?:likes|track_likes)\/?$/);
      return Boolean(match && match[1] === me && listURL(value));
    } catch { return false; }
  }
  // A saved page found by its identity, whatever key it was saved under.
  async function savedPageFor(owner, url) {
    if (!listURL(url)) return null;
    const id = pageId(url);
    const key = id ? (await pageIndex(owner)).get(id) : null;
    return key ? transaction('readonly', entries => requestResult(entries.get(key))) : null;
  }
  // After the rest of a list was handed to SoundCloud, a second request for the
  // same page would add every song twice. Answer it with "no more songs".
  function alreadyDelivered(url) {
    const list = likesLists.get(listIdentity(url));
    return Boolean(list?.delivered.has(pageId(url)));
  }
  // Called whenever the first page of a list is handed to SoundCloud.
  function noteLikesList(owner, url, body, collection) {
    if (!isLikesFirstPage(url) || !isOwnLikes(url) || !Array.isArray(body?.collection)) return;
    const id = listIdentity(url);
    let list = likesLists.get(id);
    if (!list) {
      list = { owner, collections: new Set(), delivered: new Set(), catalog: { state: 'idle', saved: 0 } };
      likesLists.set(id, list);
    }
    list.owner = owner;
    list.next = typeof body.next_href === 'string' && listURL(body.next_href) ? body.next_href : null;
    list.count = body.collection.length;
    list.delivered.clear();
    for (const item of body.collection.slice(0, 3)) { const head = itemId(item); if (head) likesHeads.add(head); }
    if (collection && typeof WeakRef === 'function') list.collections.add(new WeakRef(collection));
    if (!list.next) {
      if (list.catalog.state !== 'saving') list.catalog = { state: 'complete', saved: list.count };
      return;
    }
    if (list.catalog.state !== 'saving' && list.catalog.state !== 'waiting') {
      list.catalog = { state: 'waiting', saved: list.count };
      setTimeout(() => startCatalog(id), CATALOG_DELAY);
    }
  }
  function startCatalog(id) {
    const list = likesLists.get(id);
    if (!list || list.catalog.state === 'saving') return;
    if (!list.next) { list.catalog = { state: 'complete', saved: list.count }; return; }
    list.catalog = { state: 'saving', saved: list.count };
    void saveCatalog(list).then(() => afterCatalog(id));
  }
  // Save the rest of the list, 200 songs per request, from where the opened list stops.
  async function saveCatalog(list) {
    const job = list.catalog;
    const { owner } = list;
    let next = list.next;
    let limit = CATALOG_PAGE;
    try {
      const { clears } = await lookup('__catalog__');
      while (next && job.saved < CATALOG_MAX) {
        if (account() !== owner || storageFailed) throw new Error('signed out or storage unavailable');
        // Pages saved by an earlier, interrupted run are not requested again.
        let page = null;
        const savedRow = await savedPageFor(owner, next);
        if (savedRow) { try { page = restore(savedRow.body); } catch { page = null; } }
        if (!Array.isArray(page?.collection)) {
          // Background work: wait for a quiet moment before each page.
          await new Promise(resolve => whenIdle(resolve, 3000));
          const url = new URL(next);
          url.searchParams.set('limit', String(limit));
          try {
            page = await likesPage(url.href);
          } catch (error) {
            // If SoundCloud refuses large pages, use smaller ones.
            if (limit > 50 && /\((?:400|413|422)\)/.test(String(error?.message))) { limit = 50; continue; }
            throw error;
          }
          if (!Array.isArray(page?.collection)) throw new Error('unexpected response');
          const meta = await lookup('__catalog__');
          if (meta.clears !== clears) throw new Error('saved data was cleared');
          await save(`${owner}|catalog|${cleanURL(url.href)}`, serialize(page), meta.generation, url.href);
          if (CATALOG_PAUSE) await wait(CATALOG_PAUSE);
        }
        job.saved += page.collection.length;
        next = typeof page.next_href === 'string' && listURL(page.next_href) ? page.next_href : null;
      }
      job.state = next ? 'limit' : 'complete';
    } catch (error) {
      job.state = 'paused';
      job.error = /\(429\)/.test(String(error?.message)) ? 'SoundCloud asked to slow down' : String(error?.message || error);
      noteError('saving full Likes', job.error);
    }
  }
  // The bottom player, found once and reused: searching the whole page for it
  // is slow when a long list is drawn, and it sits at the very end of the page.
  let cachedPlayer = null, playerLookedAt = 0;
  function playerRoot() {
    if (cachedPlayer?.isConnected) return cachedPlayer;
    if (Date.now() - playerLookedAt < 2000) return null;
    playerLookedAt = Date.now();
    cachedPlayer = document.querySelector('.playControls');
    return cachedPlayer;
  }
  // The shuffle button in the bottom player (not "shuffle" buttons on pages).
  function shuffleButton() {
    const root = playerRoot();
    if (!root) return null;
    for (const selector of SHUFFLE_SELECTOR.split(', ')) {
      const found = root.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  function isShuffling(button = shuffleButton()) {
    if (!button) return false;
    const pressed = button.getAttribute('aria-pressed') ?? button.getAttribute('aria-checked');
    if (pressed != null) return pressed === 'true';
    return /(?:^|\s)(?:m-shuffling|m-active|is-active|active|selected)(?:\s|$)/.test(button.className) || /shuffling/i.test(button.className);
  }
  // Hand the rest of the saved list to the list SoundCloud already has open,
  // as if it had been scrolled to the end.
  async function completeOpenList(id) {
    const list = likesLists.get(id);
    if (!list?.next) return false;
    const collections = new Set();
    for (const ref of list.collections) { const collection = ref.deref(); if (collection) collections.add(collection); }
    for (const ref of liveViews) {
      const view = ref.deref();
      const collection = view?.collection;
      if (!collection || view.disposed) continue;
      let url;
      try { url = typeof collection.url === 'function' ? collection.url() : collection.url; } catch { /* Not a list. */ }
      if (typeof url === 'string' && listIdentity(url) === id) collections.add(collection);
    }
    const cursor = list.next;
    let grew = false;
    for (const collection of collections) {
      if (typeof collection.fetch !== 'function') continue;
      const before = collection.models?.length ?? collection.length ?? 0;
      try {
        await Promise.race([
          new Promise(resolve => {
            const request = collection.fetch({ url: cursor, remove: false, success: () => resolve(), error: () => resolve() });
            request?.then?.(() => resolve(), () => resolve());
          }),
          wait(15000),
        ]);
      } catch (error) { noteError('adding saved songs to the open list', error); }
      if ((collection.models?.length ?? collection.length ?? 0) > before) grew = true;
    }
    if (grew) {
      list.delivered.add(pageId(cursor));
      list.next = null;
      stats.listsCompleted++;
      scheduleSweep();
    }
    return grew;
  }
  // Turn shuffle off and on again so it reshuffles with every song included.
  let reshuffling = false;
  let lastReshuffleAt = 0;
  let rebuiltAfterReshuffle = 0;
  function reshuffle() {
    const button = shuffleButton();
    if (!isShuffling(button)) return;
    lastReshuffleAt = Date.now();
    reshuffling = true;
    button.click();
    setTimeout(() => {
      if (!isShuffling(button)) button.click();
      setTimeout(() => { reshuffling = false; }, 100);
    }, 150);
    stats.reshuffles++;
  }
  async function afterCatalog(id) {
    const list = likesLists.get(id);
    if (!list || list.catalog.state !== 'complete' && list.catalog.state !== 'limit') return;
    await completeOpenList(id);
  }
  function waitUntil(test, ms) {
    return new Promise(resolve => {
      const until = Date.now() + ms;
      const check = () => (test() || Date.now() > until ? resolve() : setTimeout(check, 250));
      check();
    });
  }
  // 1. Make sure every song of your Likes is saved, so nothing waits on the network.
  // 2. Fill SoundCloud's play queue with the whole list.
  // 3. Turn shuffle off and on, so SoundCloud reshuffles with every song in it.
  let filling = null;
  let lastFill = null;
  function fillQueueAndReshuffle(reason, { reshuffle: redo = true } = {}) {
    if (filling) return filling;
    filling = (async () => {
      const unfinished = () => [...likesLists.values()].filter(list => ['waiting', 'saving'].includes(list.catalog.state)
        || (list.catalog.state !== 'complete' && list.catalog.state !== 'limit' && list.next));
      const pending = unfinished();
      if (pending.length) {
        const saved = pending.reduce((sum, list) => sum + list.catalog.saved, 0);
        toast(`Saving the rest of your Likes (${saved.toLocaleString()} songs so far). Shuffle will be redone with all of them when it is done.`);
        for (const [id, list] of likesLists) if (!['waiting', 'saving', 'complete', 'limit'].includes(list.catalog.state)) startCatalog(id);
        await waitUntil(() => !unfinished().some(list => ['waiting', 'saving'].includes(list.catalog.state)), 5 * 60 * 1000);
      }
      for (const [id, list] of likesLists) if (list.next) await completeOpenList(id);
      const controls = [];
      for (const ref of readerControls) {
        const control = ref.deref();
        if (!control || control.disposed) readerControls.delete(ref);
        else if (control.likes) controls.push(control);
      }
      if (!controls.length) {
        // SoundCloud only keeps a queue reader while it loads songs into the
        // queue. The next one that starts while shuffle is on is filled.
        lastFill = { reason, songs: 0, reshuffled: false, note: 'no queue reader open; the next song started from your Likes fills it' };
        if (queueStatus !== 'active') noteError('shuffle', `queue fix is ${queueStatus}`);
        else toast('Shuffle will cover all your Likes from the next song you start in your Likes list.');
        return;
      }
      const counts = await Promise.all(controls.map(control => control.drain()));
      const songs = counts.reduce((sum, count) => sum + count, 0);
      // Never reshuffle twice in quick succession (if SoundCloud rebuilds the
      // queue on reshuffle, the new queue is filled but not reshuffled again).
      const reshuffled = redo && isShuffling() && Date.now() - lastReshuffleAt > 15000;
      if (reshuffled) reshuffle();
      lastFill = { reason, songs, reshuffled };
    })().catch(error => noteError('shuffle', error)).finally(() => { filling = null; });
    return filling;
  }
  function onShuffleOn() {
    void fillQueueAndReshuffle('shuffle turned on');
  }
  // A queue reader that started while shuffle was on has read the whole list.
  function onQueueFilled(songs, reason) {
    const reshuffled = songs > 0 && isShuffling() && Date.now() - lastReshuffleAt > 15000;
    lastFill = { reason, songs, reshuffled };
    if (reshuffled) reshuffle();
  }

  // ---- Diagnostics about SoundCloud's queue and shuffle ----
  function summarize(value) {
    if (value == null) return String(value);
    if (Array.isArray(value)) return `array(${value.length})`;
    if (typeof value === 'function') return 'function';
    if (typeof value !== 'object') return typeof value === 'string' ? `string(${value.length})` : typeof value;
    if (typeof value.then === 'function') return 'promise';
    if (Array.isArray(value.models)) return `collection(${value.models.length})`;
    const lists = Object.keys(value).filter(key => { try { return Array.isArray(value[key]) || Array.isArray(value[key]?.models); } catch { return false; } })
      .slice(0, 4).map(key => `${key}:${Array.isArray(value[key]) ? value[key].length : value[key].models.length}`);
    return `object{${lists.length ? lists.join(' ') : Object.keys(value).slice(0, 5).join(',')}}`;
  }
  // Is a queue reader reading from one of your Likes lists?
  function isLikesSource(args) {
    const candidates = [];
    for (const arg of args || []) {
      if (!arg || typeof arg !== 'object') continue;
      candidates.push(arg);
      for (const key of ['collection', 'source', 'sourceCollection']) if (arg[key] && typeof arg[key] === 'object') candidates.push(arg[key]);
    }
    for (const candidate of candidates) {
      let url;
      try { url = typeof candidate.url === 'function' ? candidate.url() : candidate.url; } catch { /* No URL. */ }
      if (typeof url === 'string' && /^https?:/.test(url)) return isOwnLikes(url);
      const models = Array.isArray(candidate.models) ? candidate.models : null;
      if (models?.length && likesHeads.has(itemId(models[0]))) return true;
    }
    return false;
  }
  function summarizeArgs(args) {
    try { return [...args].map(summarize).join(', '); } catch { return '?'; }
  }
  // Wrap a SoundCloud function whose name mentions shuffling, only to count
  // its calls and note how many items it was given and returned.
  function probeShuffle(fn, label) {
    if (typeof fn !== 'function' || probedFunctions.has(fn) || factoryWrappers.has(fn)) return fn;
    const wrapper = function (...args) {
      const result = new.target ? Reflect.construct(fn, args, new.target) : Reflect.apply(fn, this, args);
      try {
        const entry = shuffleCalls.get(label) || { count: 0 };
        entry.count++;
        entry.last = `(${summarizeArgs(args)}) → ${summarize(result)} on ${summarize(this)} at ${new Date().toLocaleTimeString()}`;
        if (!shuffleCalls.has(label) && shuffleCalls.size >= 24) return result;
        shuffleCalls.set(label, entry);
      } catch { /* Diagnostics only. */ }
      return result;
    };
    try {
      for (const key of Reflect.ownKeys(fn)) {
        if (['length', 'name', 'prototype', 'arguments', 'caller'].includes(key)) continue;
        Object.defineProperty(wrapper, key, Object.getOwnPropertyDescriptor(fn, key));
      }
      if (fn.prototype && typeof fn.prototype === 'object') wrapper.prototype = fn.prototype;
      Object.defineProperty(wrapper, 'name', { value: fn.name, configurable: true });
    } catch { /* Still usable. */ }
    probedFunctions.add(wrapper);
    return wrapper;
  }
  const SHUFFLE_NAME = /shuffl/i;
  function probeObject(target, label, depth = 0) {
    if (!target || (typeof target !== 'object' && typeof target !== 'function') || depth > 1) return;
    let names;
    try { names = Object.getOwnPropertyNames(target); } catch { return; }
    for (const name of names) {
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(target, name); } catch { continue; }
      if (!descriptor) continue;
      if (!('value' in descriptor)) {
        // A getter-only export (already wrapped by the loader if its name
        // mentions shuffling). Its class or object can still be looked into.
        let inner;
        try { inner = target[name]; } catch { continue; }
        if (typeof inner === 'function' && inner.prototype) probeObject(inner.prototype, `${label}.${name}#`, depth + 1);
        else if (inner && typeof inner === 'object' && !Array.isArray(inner) && depth === 0) probeObject(inner, `${label}.${name}`, depth + 1);
        continue;
      }
      const value = descriptor.value;
      if (typeof value === 'function' && SHUFFLE_NAME.test(name)) {
        if (descriptor.writable) { try { target[name] = probeShuffle(value, `${label}.${name}`); } catch {} }
        else if (descriptor.configurable) { try { Object.defineProperty(target, name, { ...descriptor, value: probeShuffle(value, `${label}.${name}`) }); } catch {} }
      } else if (typeof value === 'function' && value.prototype && name !== 'constructor') {
        probeObject(value.prototype, `${label}.${name}#`, depth + 1);
      } else if (value && typeof value === 'object' && !Array.isArray(value) && depth === 0) {
        probeObject(value, `${label}.${name}`, depth + 1);
      }
    }
  }
  function probeModule(module, id) {
    const exports = module.exports;
    probeObject(exports, `m${id}`);
    if (typeof exports === 'function' && exports.prototype) probeObject(exports.prototype, `m${id}#`, 1);
  }
  let watchedShuffle = null, shuffleObserver = null, wasShuffling = false;
  function watchShuffle() {
    const button = shuffleButton();
    if (button === watchedShuffle) return;
    shuffleObserver?.disconnect();
    watchedShuffle = button;
    wasShuffling = isShuffling(button);
    if (!button) return;
    shuffleObserver = new MutationObserver(() => {
      const now = isShuffling(button);
      if (now && !wasShuffling && !reshuffling) void onShuffleOn();
      wasShuffling = now;
    });
    shuffleObserver.observe(button, { attributes: true, attributeFilter: ['class', 'aria-pressed'] });
  }
  function toast(message) {
    whenReady(() => {
      let element = document.getElementById('sc-likes-long-lists-toast');
      if (!element) {
        element = document.createElement('div');
        element.id = 'sc-likes-long-lists-toast';
        element.setAttribute('role', 'status');
        element.style.cssText = 'position:fixed;right:14px;bottom:76px;z-index:2147483645;max-width:340px;padding:10px 12px;border:1px solid #666;border-radius:8px;background:#252525;color:#eee;font:13px/1.45 system-ui;box-shadow:0 4px 16px rgba(0,0,0,.35);';
        document.body.append(element);
      }
      element.textContent = message;
      clearTimeout(element.timer);
      element.timer = setTimeout(() => element.remove(), 9000);
    });
  }
  function describeCatalogs() {
    if (!likesLists.size) return 'starts when you open your Likes';
    return [...likesLists.values()].map(list => {
      const { state, saved, error } = list.catalog;
      const songs = `${saved.toLocaleString()} songs`;
      if (state === 'complete') return list.next ? `complete (${songs}); reopen Likes to load them all` : `complete (${songs})`;
      if (state === 'saving') return `saving… ${songs} so far`;
      if (state === 'waiting') return 'starting shortly';
      if (state === 'limit') return `stopped at ${songs} (the limit)`;
      if (state === 'paused') return `paused at ${songs} (${error}); continues next time you open Likes`;
      return 'not started';
    }).join(' · ');
  }

  // ===========================================================================
  // Faster song starts
  // ===========================================================================

  // Keep media and playback authorization from live SoundCloud responses in
  // memory for a short time. They are never written to the saved cache.
  function capturePlayback(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 4) return;
    if (Array.isArray(value)) { for (const item of value) capturePlayback(item, depth + 1); return; }
    if (value.id != null && (value.media || value.track_authorization) && (!value.kind || value.kind === 'track')) {
      const fields = {};
      if (value.media) fields.media = value.media;
      if (value.track_authorization) fields.track_authorization = value.track_authorization;
      const id = String(value.id);
      playbackFields.delete(id);
      playbackFields.set(id, { fields, at: Date.now() });
      while (playbackFields.size > 3000) playbackFields.delete(playbackFields.keys().next().value);
      return;
    }
    for (const key of ['collection', 'track', 'tracks']) if (value[key]) capturePlayback(value[key], depth + 1);
  }
  function freshFields(id) {
    const entry = id == null ? null : playbackFields.get(String(id));
    return entry && Date.now() - entry.at < PLAYBACK_TTL ? entry.fields : null;
  }
  // Remember the song order of lists served from the cache, to know what plays next.
  function rememberOrder(body) {
    const items = Array.isArray(body?.collection) ? body.collection : Array.isArray(body?.tracks) ? body.tracks : null;
    if (!items) return;
    const ids = [];
    for (const item of items) {
      const track = item?.kind === 'track' ? item : item?.track;
      if (track && typeof track === 'object' && track.id != null) ids.push(String(track.id));
    }
    if (ids.length < 2) return;
    const index = new Map();
    ids.forEach((id, position) => { if (!index.has(id)) index.set(id, position); });
    playOrders = [{ ids, index }, ...playOrders].slice(0, 5);
  }
  // While one song plays, fetch playback details for the next few in one
  // request, so they start without waiting for SoundCloud.
  function planAhead(model) {
    const value = model.id ?? field(model, 'id');
    if (value == null) return;
    const id = String(value);
    if (id === lastPlanned) return;
    lastPlanned = id;
    if (planned.size) predictionMisses = planned.has(id) ? 0 : predictionMisses + 1;
    // The longest saved list containing this song, not a short preview of it.
    let best = null;
    for (const order of playOrders) {
      const at = order.index.get(id);
      if (at !== undefined && (!best || order.ids.length > best.order.ids.length)) best = { order, at };
    }
    planned = new Set(best ? best.order.ids.slice(best.at + 1, best.at + 1 + PREFETCH_AHEAD) : []);
    // Shuffle or a different queue: predictions are not landing, so stop fetching.
    if (predictionMisses >= 2) return;
    const missing = [...planned].filter(next => !freshFields(next) && !pendingFields.has(next));
    if (missing.length) void prefetch(missing);
  }
  // Fetch playback details for up to 30 songs in one request. A song whose
  // details are already being fetched is not asked for twice.
  function prefetch(ids) {
    const batch = [...new Set(ids.map(String))].filter(id => !pendingFields.has(id)).slice(0, 30);
    if (!batch.length) return Promise.resolve();
    const promise = (async () => {
      try {
        const url = new URL('https://api-v2.soundcloud.com/tracks');
        url.searchParams.set('ids', batch.join(','));
        const body = await apiJSON(url.href);
        capturePlayback(Array.isArray(body) ? body : body?.collection);
        stats.prepared += batch.filter(id => freshFields(id)).length;
      } catch (error) {
        // The song will fetch its own details when it starts, as before.
        noteError('preparing songs', error);
      } finally {
        for (const id of batch) if (pendingFields.get(id) === promise) pendingFields.delete(id);
      }
    })();
    for (const id of batch) pendingFields.set(id, promise);
    return promise;
  }

  // Songs on screen (or under the pointer) get their playback details before
  // you click, so a click starts the song without waiting for SoundCloud.
  const SONG_RESERVED = new Set(['you', 'discover', 'search', 'stream', 'feed', 'upload', 'settings', 'pages', 'charts', 'stations', 'library', 'jobs', 'terms-of-use', 'people', 'messages', 'notifications', 'tags']);
  const SONG_SECTIONS = new Set(['sets', 'tracks', 'albums', 'likes', 'reposts', 'followers', 'following', 'popular-tracks', 'comments', 'spotlight', 'toptracks']);
  function songPath(href) {
    try {
      const parts = new URL(href, location.origin).pathname.split('/').filter(Boolean);
      if (parts.length !== 2 || SONG_RESERVED.has(parts[0]) || SONG_SECTIONS.has(parts[1])) return null;
      return parts.join('/').toLowerCase();
    } catch { return null; }
  }
  function rememberPaths(items) {
    for (const item of items || []) {
      const track = item?.kind === 'track' ? item : item?.track;
      const path = track?.permalink_url && track.id != null ? songPath(track.permalink_url) : null;
      if (path) pathToId.set(path, String(track.id));
    }
    while (pathToId.size > 50000) pathToId.delete(pathToId.keys().next().value);
  }
  const itemSongs = new WeakMap();
  function songForItem(item) {
    if (itemSongs.has(item)) return itemSongs.get(item);
    for (const anchor of item.querySelectorAll('a[href]')) {
      const id = pathToId.get(songPath(anchor.getAttribute('href')));
      if (id) { itemSongs.set(item, id); return id; }
    }
    return null;
  }
  const wantedSongs = new Set();   // Asked for directly (pointer over a song).
  const nearItems = new Set();     // List items near the screen right now.
  let wantedTimer = null;
  function needsFields(id) {
    if (!id || pendingFields.has(id)) return false;
    const entry = playbackFields.get(id);
    return !(entry && Date.now() - entry.at < PLAYBACK_TTL * 0.7);
  }
  function scheduleFlush(delay) {
    clearTimeout(wantedTimer);
    wantedTimer = setTimeout(flushWanted, delay);
  }
  function wantSong(id, now = false) {
    if (!needsFields(id)) return;
    wantedSongs.add(id);
    scheduleFlush(now ? 0 : 250);
  }
  // Waits until scrolling pauses, then asks for the songs on screen at that
  // moment, 30 per request, so fast scrolling does not queue up requests.
  function flushWanted() {
    if (document.hidden) return;
    const ids = new Set([...wantedSongs].filter(needsFields));
    wantedSongs.clear();
    for (const item of nearItems) {
      if (ids.size >= 30) break;
      const id = songForItem(item);
      if (needsFields(id)) ids.add(id);
    }
    if (ids.size) void prefetch([...ids]).then(() => scheduleFlush(300));
  }
  // Tell the bottom-player waveform script where the playing song's waveform
  // is, so it does not have to download the song's whole web page.
  function publishWaveform(model) {
    const permalink = field(model, 'permalink_url');
    const waveform = field(model, 'waveform_url');
    if (typeof permalink !== 'string' || typeof waveform !== 'string') return;
    let path;
    try { path = new URL(permalink).pathname.split('/').filter(Boolean).slice(0, 2).join('/').toLowerCase(); } catch { return; }
    if (!path.includes('/')) return;
    const existing = waveformHints.findIndex(hint => hint.path === path);
    if (existing >= 0) {
      if (existing === waveformHints.length - 1 && waveformHints[existing].waveform === waveform) return;
      waveformHints.splice(existing, 1);
    }
    waveformHints.push({ path, waveform });
    while (waveformHints.length > 20) waveformHints.shift();
    let element = document.getElementById('sc-waveform-hints');
    if (!element) {
      element = document.createElement('script');
      element.type = 'application/json'; // Data only; never executed.
      element.id = 'sc-waveform-hints';
      (document.head || document.documentElement).append(element);
    }
    element.textContent = JSON.stringify(waveformHints);
  }

  // ===========================================================================
  // Long lists stay light while music plays
  // ===========================================================================

  // Showing thousands of saved songs at once makes every style and layout pass
  // slower. List items far from the screen are skipped by the browser
  // (content-visibility), sized as they last appeared so scrolling stays put.
  // Items near the screen render normally, so menus and tooltips are never clipped.
  // One observer for every change to the page, shared by everything below,
  // so each change SoundCloud makes is looked at once instead of several times.
  const domAdded = [];
  const domRemoved = [];
  function watchDom() {
    if (typeof MutationObserver !== 'function') return;
    new MutationObserver(records => {
      for (const record of records) {
        if (domRemoved.length) for (const node of record.removedNodes) if (node.nodeType === 1) for (const handler of domRemoved) handler(node);
        for (const node of record.addedNodes) if (node.nodeType === 1) for (const handler of domAdded) handler(node);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  const eachItem = (node, action) => {
    if (node.matches(ITEM_SELECTOR)) action(node);
    else if (node.firstElementChild) for (const item of node.querySelectorAll(ITEM_SELECTOR)) action(item);
  };
  function watchListItems() {
    if (typeof IntersectionObserver !== 'function') return;
    const observers = [];
    // Songs near the screen: prepare their playback details before a click.
    observers.push(new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) nearItems.add(entry.target);
        else nearItems.delete(entry.target);
      }
      scheduleFlush(250);
    }, { rootMargin: '400px 0px' }));
    document.addEventListener('pointerover', event => {
      const item = event.target?.closest?.(ITEM_SELECTOR);
      if (item) wantSong(songForItem(item), true);
    }, { capture: true, passive: true });
    // Songs far from the screen: let the browser skip drawing them.
    const skipped = new WeakSet();
    if (globalThis.CSS?.supports?.('content-visibility', 'auto')) {
      const withAuto = CSS.supports('contain-intrinsic-size', 'auto 1px auto 1px');
      observers.push(new IntersectionObserver(entries => {
        for (const entry of entries) {
          const item = entry.target;
          if (entry.isIntersecting) {
            if (!skipped.has(item)) continue;
            item.style.removeProperty('content-visibility');
            item.style.removeProperty('contain-intrinsic-size');
            skipped.delete(item);
            stats.offscreen--;
          } else if (!skipped.has(item)) {
            const { width, height } = entry.boundingClientRect;
            if (width <= 0 || height <= 0) continue; // Hidden items keep their normal styles.
            const w = Math.round(width), h = Math.round(height);
            item.style.setProperty('contain-intrinsic-size', withAuto ? `auto ${w}px auto ${h}px` : `${w}px ${h}px`);
            item.style.setProperty('content-visibility', 'auto');
            skipped.add(item);
            stats.offscreen++;
          }
        }
      }, { rootMargin: OFFSCREEN_MARGIN }));
    }
    const watch = item => { for (const observer of observers) observer.observe(item); };
    const forget = item => {
      for (const observer of observers) observer.unobserve(item);
      nearItems.delete(item);
      if (skipped.has(item)) { skipped.delete(item); stats.offscreen--; }
    };
    domAdded.push(node => eachItem(node, watch));
    domRemoved.push(node => eachItem(node, forget));
    eachItem(document.body, watch);
  }

  // ===========================================================================
  // Refreshing one song when its page is opened
  // ===========================================================================

  // Resolve only actual page visits. A play-button click does not change this URL.
  function songPageURL(value) {
    try {
      const url = new URL(value);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length < 2 || parts.length > 3 || SONG_RESERVED.has(parts[0]) || SONG_SECTIONS.has(parts[1])) return null;
      if (parts.length === 3 && !/^s-[a-zA-Z0-9]+$/.test(parts[2])) return null;
      // Strip tracking/player query parameters while preserving private links.
      const result = new URL(url.pathname.replace(/\/$/, ''), 'https://soundcloud.com');
      if (url.searchParams.has('secret_token')) result.searchParams.set('secret_token', url.searchParams.get('secret_token'));
      return result.href;
    } catch { return null; }
  }
  function replaceSong(value, fresh, trackContext = false) {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) {
      let changed = false;
      for (const item of value) changed = replaceSong(item, fresh, trackContext) || changed;
      return changed;
    }
    // Track IDs and user/playlist IDs can overlap. Never match by ID alone.
    const isTrack = (!value.kind || value.kind === 'track') && (trackContext || value.kind === 'track' || value.resource_type === 'sound'
      || (typeof value.title === 'string' && ('duration' in value || 'waveform_url' in value)));
    if (isTrack && String(value.id) === String(fresh.id)) {
      Object.assign(value, fresh);
      return true;
    }
    let changed = false;
    for (const [key, child] of Object.entries(value)) {
      changed = replaceSong(child, fresh, key === 'track' || key === 'tracks') || changed;
    }
    return changed;
  }
  // Find the saved rows that mention a song by searching their text, without
  // parsing anything. The cursor hands rows over one at a time, so clicks can
  // be handled in between.
  async function rowsMentioning(owner, id) {
    const needles = [`"id":${id},`, `"id":${id}}`, `"id":"${id}"`];
    return transaction('readonly', entries => new Promise((resolve, reject) => {
      const keys = [];
      const cursor = entries.openCursor(IDBKeyRange.bound(`${owner}|`, `${owner}|\uffff`));
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) return resolve(keys);
        const body = item.value?.body;
        if (typeof body === 'string' && needles.some(needle => body.includes(needle))) keys.push(item.key);
        item.continue();
      };
    }));
  }
  async function updateSong(owner, song, clears, stillCurrent) {
    const fresh = JSON.parse(serialize(song));
    const keys = await rowsMentioning(owner, song.id);
    if (!keys.length || !stillCurrent()) return;
    await transaction('readwrite', async (entries, control) => {
      const meta = await requestResult(control.get('meta')) || initial();
      if ((meta.clears || 0) !== clears || !stillCurrent()) return;
      // Reject pre-refresh list responses without deleting any saved lists.
      meta.generation++;
      for (const key of keys) {
        const row = await requestResult(entries.get(key));
        if (!row) continue;
        let body;
        try { body = JSON.parse(row.body); } catch { continue; }
        if (!replaceSong(body, fresh, row.key.includes('|trackBatch|'))) continue;
        const serialized = serialize(body);
        const bytes = new TextEncoder().encode(serialized).length;
        meta.bytes += bytes - row.bytes;
        entries.put({ ...row, body: serialized, bytes });
      }
      control.put(meta, 'meta');
      stats.songUpdates++;
    });
  }
  async function checkSongPage() {
    const owner = account();
    const url = songPageURL(location.href);
    const key = url && owner ? `${owner}|${url}` : null;
    if (key === lastVisit) return;
    lastVisit = key;
    const currentVisit = ++visit;
    if (!key || !liveAPI || storageFailed) { lastVisit = null; return; }
    const stillCurrent = () => visit === currentVisit && account() === owner && songPageURL(location.href) === url;
    try {
      // Not urgent: wait until the song's page has finished opening.
      await new Promise(resolve => whenIdle(resolve, 4000));
      if (!stillCurrent()) return;
      const snapshot = await lookup('__page_refresh__');
      if (!stillCurrent()) return;
      // The resolve endpoint is never cached, including on SPA navigation when
      // SoundCloud already has the song model and would not fetch it again.
      const response = await liveAPI.callEndpoint('resolve', {}, { url });
      const song = response?.body;
      if (!stillCurrent() || response?.status !== 200 || song?.kind !== 'track' || !song.id) return;
      await new Promise(resolve => whenIdle(resolve, 4000));
      await updateSong(owner, song, snapshot.clears, stillCurrent);
    } catch {
      // A failed page refresh leaves the saved metadata and playback intact.
    }
  }
  function watchSongPages() {
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      history[method] = function (...args) {
        const result = Reflect.apply(original, this, args);
        queueMicrotask(checkSongPage);
        return result;
      };
    }
    window.addEventListener('popstate', checkSongPage);
    window.addEventListener('load', checkSongPage, { once: true });
    document.addEventListener('DOMContentLoaded', checkSongPage, { once: true });
    queueMicrotask(checkSongPage);
  }

  // ===========================================================================
  // Play on long lists
  // ===========================================================================

  function setQueueStatus(value) {
    // Once a copy of the reader is protected, a later failure does not undo that.
    if (queueStatus === 'active' && value !== 'active') return;
    queueStatus = value;
    refreshBadge();
  }

  // Zero-delay yields between batches. Nested setTimeout(0) calls are clamped
  // to at least 4 ms, which adds up on lists with thousands of songs.
  const soon = (() => {
    if (typeof MessageChannel !== 'function') {
      return task => { const timer = window.setTimeout(task, 0); return () => window.clearTimeout(timer); };
    }
    const channel = new MessageChannel();
    const tasks = new Map();
    let next = 0;
    channel.port1.onmessage = event => {
      const task = tasks.get(event.data);
      tasks.delete(event.data);
      task?.();
    };
    return task => {
      const id = ++next;
      tasks.set(id, task);
      channel.port2.postMessage(id);
      return () => tasks.delete(id);
    };
  })();

  // The native collection reader can be resumed synchronously from its own
  // data listener, once per preceding track. Queue these reentrant resumes
  // instead of adding another stack frame for each song.
  //
  // The same reader feeds SoundCloud's play queue only a little ahead of the
  // song that is playing: the queue pauses it once it has enough. Shuffle then
  // shuffles just that part. drain() keeps the reader going, ignoring those
  // pauses, until the list has no more songs, so shuffle can cover all of them.
  function guardReader(reader, factoryArgs = []) {
    if (!reader || typeof reader !== 'object' || guardedReaders.has(reader)) return reader;
    if (!['resume', 'pause', 'dispose'].every(key => typeof reader[key] === 'function')) return reader;
    guardedReaders.add(reader);
    const record = {
      n: ++readerSeq, created: Date.now(), args: summarizeArgs(factoryArgs), keys: Object.keys(reader).slice(0, 12).join(','),
      reads: 0, queuePauses: 0, disposedAfter: null, disposedInRead: false, filled: null, shuffle: isShuffling(),
    };
    readerLog.push(record);
    while (readerLog.length > 6) readerLog.shift();
    // SoundCloud's queue readers only live while the queue loads a stretch of
    // songs. If shuffle is on when one starts from your Likes, fill the whole
    // list right away. Other sources (e.g. the endless Stream) are left alone.
    record.likes = isLikesSource(factoryArgs);
    let fillFromStart = record.shuffle && record.likes;
    let disposeArgs = null;
    const resume = reader.resume;
    const pause = reader.pause;
    const dispose = reader.dispose;
    let running = false;
    let requested = false;
    let disposed = false;
    let returnsSelf = false;
    let cancelYield = null;
    let args = [];
    let pauseArgs = null;
    // Filling the whole queue.
    let draining = false, delivered = 0, handed = 0, pauseWanted = false;
    let pastEnough = false; // The queue already said "enough": the rest is background work.
    let idleTimer = null, capTimer = null, drainPromise = null, drainDone = null, drainStarted = 0;

    function bumpIdle() {
      clearTimeout(idleTimer);
      // Waiting on our own low-priority slice is not "SoundCloud has nothing more".
      idleTimer = setTimeout(() => (cancelYield ? bumpIdle() : finishDrain()), DRAIN_IDLE);
    }
    function beginDrain(afterEnough = false) {
      draining = true;
      pastEnough = afterEnough;
      handed = 0;
      drainStarted = Date.now();
      drainPromise = new Promise(resolve => { drainDone = resolve; });
      bumpIdle();
      capTimer = setTimeout(() => finishDrain('time limit'), DRAIN_MAX);
      return drainPromise;
    }
    function finishDrain(outcome = 'list ended') {
      if (!draining) return;
      draining = false;
      clearTimeout(idleTimer);
      clearTimeout(capTimer);
      record.filled = handed;
      drains.push({ songs: handed, seconds: Math.round((Date.now() - drainStarted) / 100) / 10, outcome: disposed ? 'queue replaced' : outcome });
      while (drains.length > 10) drains.shift();
      // Give control back the way the queue last asked for it.
      if (disposeArgs && !disposed) {
        disposed = true;
        record.disposedAfter = Date.now() - record.created;
        try { Reflect.apply(dispose, reader, disposeArgs); } catch {}
      } else if (pauseWanted && !disposed) {
        try { Reflect.apply(pause, reader, pauseArgs || []); } catch {}
      }
      pauseWanted = false;
      disposeArgs = null;
      const done = drainDone;
      drainPromise = drainDone = null;
      done?.(handed);
    }

    function pump() {
      if (running || disposed) return undefined;
      running = true;
      let first;
      let turns = 0;
      const sliceStart = performance.now();
      // Reading up to the song you clicked is on the way to playback, so it runs
      // in larger slices. Filling the rest of the queue runs in small slices at
      // low priority, and pauses whenever you click or scroll.
      const backgroundWork = draining && (pastEnough || Date.now() - drainStarted > 300);
      const budget = backgroundWork ? FILL_SLICE_MS : QUEUE_SLICE_MS;
      try {
        while (requested && !disposed) {
          requested = false;
          delivered = 0;
          const value = Reflect.apply(resume, reader, args);
          record.reads++;
          if (turns === 0) first = value;
          if (value === reader) returnsSelf = true;
          if (draining) {
            // The queue reacted (resume or pause) to a song this reader handed over: keep going.
            if (delivered > 0) { handed++; requested = true; bumpIdle(); }
          }
          turns++;
          if (requested && !disposed && turns >= 4
              && (performance.now() - sliceStart > budget || (backgroundWork && userBusy()))) {
            stats.deferred++;
            const next = () => { cancelYield = null; pump(); };
            cancelYield = backgroundWork ? background(next) : soon(next);
            break;
          }
        }
      } finally {
        running = false;
      }
      return first;
    }

    function cancelPending() {
      requested = false;
      cancelYield?.();
      cancelYield = null;
    }

    const control = {
      get disposed() { return disposed; },
      likes: record.likes,
      drain() {
        if (disposed) return Promise.resolve(0);
        if (drainPromise) return drainPromise;
        const promise = beginDrain(true);
        requested = true;
        if (!running && !cancelYield) pump();
        return promise;
      },
    };

    const saved = ['resume', 'pause', 'dispose'].map(key => [key, Object.getOwnPropertyDescriptor(reader, key)]);
    try {
      reader.resume = function (...nextArgs) {
        if (disposed) return undefined;
        if (fillFromStart && !running) {
          fillFromStart = false;
          void beginDrain().then(songs => onQueueFilled(songs, 'play with shuffle on'));
        }
        args = nextArgs;
        requested = true;
        if (running) delivered++;
        else if (draining) bumpIdle(); // The reader continued after loading more of the list.
        pauseWanted = false;
        // A resume from inside a resume, or while a batch is pending, is queued rather than nested.
        if (running || cancelYield) return returnsSelf ? reader : undefined;
        return pump();
      };
      reader.pause = function (...nextPauseArgs) {
        record.queuePauses++;
        if (running) delivered++;
        if (draining) {
          // The queue has "enough"; while filling, keep reading anyway.
          pastEnough = true;
          pauseWanted = true;
          pauseArgs = nextPauseArgs;
          requested = true;
          if (!running && !cancelYield) pump();
          return undefined;
        }
        cancelPending();
        return Reflect.apply(pause, this, nextPauseArgs);
      };
      reader.dispose = function (...nextDisposeArgs) {
        // While filling, a dispose from inside a read means "the queue has
        // enough"; keep reading to the end of the list first.
        if (draining && running) {
          pastEnough = true;
          disposeArgs = nextDisposeArgs;
          delivered++;
          requested = true;
          return undefined;
        }
        record.disposedAfter = Date.now() - record.created;
        record.disposedInRead = running;
        disposed = true;
        cancelPending();
        finishDrain('queue replaced');
        return Reflect.apply(dispose, this, nextDisposeArgs);
      };
    } catch {
      // A frozen or locked reader keeps its native methods instead of breaking Play.
      for (const [key, descriptor] of saved) {
        try { if (descriptor) Object.defineProperty(reader, key, descriptor); else delete reader[key]; } catch {}
      }
      stats.unguarded++;
      return reader;
    }
    stats.readers++;
    if (typeof WeakRef === 'function') readerControls.add(new WeakRef(control));
    if (record.shuffle && Date.now() - lastReshuffleAt < 15000) rebuiltAfterReshuffle++;
    return reader;
  }

  // A transparent stand-in for an exported function: same arguments, `this`,
  // `new` behavior, prototype and static properties, but readers it returns are guarded.
  function wrapFactory(original) {
    if (typeof original !== 'function' || factoryWrappers.has(original)) return original;
    const wrapper = function (...args) {
      const result = new.target
        ? Reflect.construct(original, args, new.target)
        : Reflect.apply(original, this, args);
      return guardReader(result, args);
    };
    try {
      for (const key of Reflect.ownKeys(original)) {
        if (['length', 'name', 'prototype', 'arguments', 'caller'].includes(key)) continue;
        Object.defineProperty(wrapper, key, Object.getOwnPropertyDescriptor(original, key));
      }
      if (original.prototype && typeof original.prototype === 'object') wrapper.prototype = original.prototype;
      Object.defineProperty(wrapper, 'name', { value: original.name, configurable: true });
    } catch { /* The wrapper still works without copied metadata. */ }
    factoryWrappers.add(wrapper);
    return wrapper;
  }
  function wrapGetter(getter, wrap = wrapFactory, name = '') {
    let source;
    let wrapper;
    return function () {
      const value = Reflect.apply(getter, this, []);
      if (typeof value !== 'function') return value;
      if (value !== source) {
        source = value;
        wrapper = wrap(value, name);
      }
      return wrapper;
    };
  }
  // Webpack's ES-module exports are getter-only properties that cannot be
  // replaced after the module has run. Give the module a loader whose export
  // helper wraps those getters as they are defined.
  function loaderFor(require, wrap = wrapFactory) {
    if (typeof require !== 'function' || typeof require.d !== 'function') return require;
    const define = require.d;
    const d = function (exports, name, getter) {
      if (typeof name === 'string' && typeof getter === 'function') {
        return Reflect.apply(define, this, [exports, name, wrapGetter(getter, wrap, name)]);
      }
      if (name && typeof name === 'object') {
        const definitions = {};
        for (const key of Object.keys(name)) definitions[key] = typeof name[key] === 'function' ? wrapGetter(name[key], wrap, key) : name[key];
        return Reflect.apply(define, this, [exports, definitions]);
      }
      return Reflect.apply(define, this, [exports, name, getter]);
    };
    return new Proxy(require, { get: (target, key) => (key === 'd' ? d : Reflect.get(target, key)) });
  }
  // Wrap exports that can still be changed after the module ran (plain
  // assignments, or configurable getters). Returns true if any export is protected.
  function wrapExports(exports) {
    if (!exports || (typeof exports !== 'object' && typeof exports !== 'function')) return false;
    let active = false;
    for (const name of Object.keys(exports)) {
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(exports, name); } catch { continue; }
      if (!descriptor) continue;
      try {
        if (descriptor.get) {
          if (factoryWrappers.has(exports[name])) active = true;
          else if (descriptor.configurable && typeof exports[name] === 'function') {
            Object.defineProperty(exports, name, { get: wrapGetter(descriptor.get), enumerable: descriptor.enumerable, configurable: true });
            active = true;
          }
          continue;
        }
        const value = descriptor.value;
        if (typeof value !== 'function') continue;
        if (factoryWrappers.has(value)) { active = true; continue; }
        if (descriptor.writable) exports[name] = wrapFactory(value);
        else if (descriptor.configurable) Object.defineProperty(exports, name, { ...descriptor, value: wrapFactory(value) });
        else continue;
        active = true;
      } catch { /* Leave this export unchanged. */ }
    }
    return active;
  }
  function protectModule(module) {
    if (typeof module.exports === 'function') {
      module.exports = wrapFactory(module.exports);
      return true;
    }
    return wrapExports(module.exports);
  }

  // ===========================================================================
  // Finding SoundCloud's modules
  // ===========================================================================

  // Webpack modules may export the class or object directly, as `default`,
  // or as one of several named exports.
  function exported(exports, test) {
    const candidates = [exports];
    if (exports && (typeof exports === 'object' || typeof exports === 'function')) {
      for (const key of Object.keys(exports)) { try { candidates.push(exports[key]); } catch {} }
    }
    return candidates.find(value => { try { return value && test(value); } catch { return false; } });
  }
  function dependencies() {
    if ((config && deferred) || !loader) return;
    for (const id of Object.keys(loader.m)) {
      const factory = loader.m[id];
      if (typeof factory !== 'function' || depScanned.has(factory)) continue;
      depScanned.add(factory);
      const text = Function.prototype.toString.call(factory);
      if (!config && ['api_v2_host', 'client_is_expiring', 'allowConfigOverride'].every(word => text.includes(word))) config = loader(id);
      if (!deferred && ['deferFrom', 'mapEither', 'allTruthy'].every(word => text.includes(word))) deferred = loader(id);
      if (config && deferred) return;
    }
  }
  function applyPatch(kind, module) {
    dependencies();
    const exports = module.exports;
    if (kind === 'queue') setQueueStatus(protectModule(module) ? 'active' : 'failed');
    else if (kind === 'api') patchAPI(exported(exports, value => typeof value.callEndpoint === 'function'));
    else if (kind === 'backbone') patchBackbone(exported(exports, value => typeof value.sync === 'function'));
    else if (kind === 'list') patchListView(exported(exports, value => typeof value.prototype?.getInitialDesiredLength === 'function'));
    else if (kind === 'track') patchTrack(exported(exports, value => typeof value.prototype?.getOrFetch === 'function'));
  }
  function scan(modules) {
    for (const id of Object.keys(modules || {})) {
      const original = modules[id];
      // Read each factory's source once. SoundCloud ships thousands of modules
      // and this runs again for every chunk that loads.
      if (typeof original !== 'function' || inspected.has(original)) continue;
      inspected.add(original);
      const text = Function.prototype.toString.call(original);
      const kind = SIGNATURES.find(([, words]) => words.every(word => text.includes(word)))?.[0]
        || (SHUFFLE_NAME.test(text) ? 'probe' : null);
      if (!kind) continue;
      const probeWrap = (value, name) => (SHUFFLE_NAME.test(name) ? probeShuffle(value, `m${id}.${name}`) : value);
      const wrapped = function (module, exports, require) {
        const loaderArg = kind === 'queue' ? loaderFor(require) : kind === 'probe' ? loaderFor(require, probeWrap) : require;
        const result = Reflect.apply(original, this, [module, exports, loaderArg]);
        if (kind === 'probe') { try { probeModule(module, id); } catch {} }
        else applyPatch(kind, module);
        return result;
      };
      inspected.add(wrapped);
      modules[id] = wrapped;
      if (kind === 'queue' && (queueStatus === 'waiting' || queueStatus === 'missing')) setQueueStatus('found');
      // A module that already ran. The queue reader can then only be protected
      // if its exports are still writable.
      const cachedModule = loader?.c?.[id];
      if (kind === 'probe') { if (cachedModule) { try { probeModule(cachedModule, id); } catch {} } }
      else if (cachedModule && (kind !== 'queue' || cachedModule.l || cachedModule.loaded)) applyPatch(kind, cachedModule);
    }
  }

  // Register a tiny Webpack 4 bootstrap. Before startup it waits in the normal
  // chunk array; after startup it executes immediately. Future module factories
  // are wrapped before the loader executes them. No network interception.
  const chunks = window.webpackJsonp = window.webpackJsonp || [];
  const bootId = `sc-likes-long-lists-${Date.now()}`;
  chunks.push([[bootId], { [bootId](module, exports, require) {
    loader = require;
    scan(require.m);
    // The runtime drains preloaded chunks directly, bypassing .push. Scan
    // once after that drain as well as before later chunks execute.
    queueMicrotask(() => scan(require.m));
    const push = chunks.push;
    chunks.push = function (...payloads) {
      scan(require.m);
      for (const payload of payloads) scan(payload?.[1]);
      return Reflect.apply(push, this, payloads);
    };
  } }, [[bootId]]]);

  watchSongPages();

  // Count overflows whether SoundCloud lets them escape or loses them in a promise.
  const OVERFLOW = /maximum call stack size exceeded|too much recursion/i;
  window.addEventListener('error', event => {
    if (OVERFLOW.test(event.message || event.error?.message || '')) stats.stackErrors++;
  });
  window.addEventListener('unhandledrejection', event => {
    if (OVERFLOW.test(String(event.reason?.message ?? event.reason ?? ''))) stats.stackErrors++;
  });
  window.setTimeout(() => {
    if (queueStatus === 'waiting') setQueueStatus('missing');
  }, 12000);

  // ===========================================================================
  // Profile menu entry and panel
  // ===========================================================================

  // No floating button: the panel opens from an entry in SoundCloud's profile
  // menu (the avatar at the top right), or with Alt+Shift+L. The entry gets a
  // small "!" when something needs attention.
  function needsAttention() {
    return storageFailed || queueStatus === 'failed' || [...likesLists.values()].some(list => list.catalog.state === 'paused');
  }
  const MENU_LABEL = 'Likes & Long Lists';
  function refreshBadge() {
    for (const element of document.querySelectorAll('[data-sc-likes-long-lists-label]')) {
      element.textContent = needsAttention() ? `${MENU_LABEL} (!)` : MENU_LABEL;
    }
  }
  // SoundCloud builds the profile menu when it opens. Add the entry each time,
  // copying one of its own entries so it looks the same.
  function addMenuEntry(root) {
    if (root.nodeType !== 1) return;
    const link = root.matches?.('a[href="/you/likes"]') ? root : root.querySelector?.('a[href="/you/likes"]');
    // Only inside a dropdown menu, not e.g. the Library page's tabs.
    const menu = link?.parentElement?.closest('.dropdownMenu, [role="menu"], [class*="headerMenu"], [class*="profileMenu"], [class*="userMenu"]');
    if (!menu) return;
    const item = link.closest('li') || link;
    if (!item.parentNode || item.parentNode.querySelector(':scope > [data-sc-likes-long-lists-entry]')) return;
    const entry = item.cloneNode(true);
    entry.setAttribute('data-sc-likes-long-lists-entry', '');
    entry.removeAttribute('id');
    const anchor = entry.matches('a') ? entry : entry.querySelector('a') || entry;
    anchor.setAttribute('href', '#');
    anchor.removeAttribute('aria-current');
    anchor.classList.remove('active', 'selected', 'm-active');
    anchor.setAttribute('role', 'menuitem');
    anchor.textContent = '';
    const label = document.createElement('span');
    label.setAttribute('data-sc-likes-long-lists-label', '');
    anchor.append(label);
    anchor.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      // Close SoundCloud's menu the way a click elsewhere would.
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      void showPanel();
    });
    item.parentNode.append(entry);
    refreshBadge();
  }
  function watchProfileMenu() {
    domAdded.push(addMenuEntry);
    addMenuEntry(document.body);
    document.addEventListener('keydown', event => {
      if (event.altKey && event.shiftKey && (event.key === 'L' || event.key === 'l' || event.code === 'KeyL')) {
        event.preventDefault();
        void showPanel();
      }
    });
  }

  function shuffleButtonInfo() {
    const button = shuffleButton();
    if (!button) return 'not found';
    const attrs = ['class', 'aria-pressed', 'aria-checked', 'aria-label', 'title']
      .map(name => button.getAttribute(name) != null ? `${name}="${button.getAttribute(name)}"` : null).filter(Boolean).join(' ');
    return `found (${attrs}); reads as ${isShuffling(button) ? 'on' : 'off'}`;
  }
  function diagnostics(info) {
    const liveReaders = [...readerControls].filter(ref => ref.deref() && !ref.deref().disposed).length;
    return [
      `SoundCloud Likes & Long Lists 1.8.3 — ${new Date().toISOString()} — page ${location.pathname.replace(/^\/[^/]+(?=\/|$)/, '/…')}`,
      `cache: ${storageFailed ? 'storage unavailable' : apiActive ? 'active' : 'waiting'}; saved ${info?.count ?? '?'} rows; hits ${stats.hits}, server reads ${stats.misses}`,
      `last list: ${stats.lastList ? `${stats.lastList.pages} pages, ${stats.lastList.items} items, ${stats.lastList.ms} ms` : 'none'}; views expanded ${stats.viewsExpanded}`,
      `likes check: ${stats.likes || 'not run'}; likes endpoints seen: ${[...likesEndpoints].map(([kind, name]) => `${kind}=${name}`).join(', ') || 'none'}; client id known: ${config?.get('client_id') || seenClientId ? 'yes' : 'no'}; sign-in cookie: ${oauthToken() ? 'yes' : 'no'}`,
      `full likes lists: ${[...likesLists.values()].map(list => `${list.catalog.state} ${list.catalog.saved} songs, open list ${list.next ? 'incomplete' : 'complete'}`).join(' | ') || 'none seen'}`,
      `queue fix: ${queueStatus}; readers protected ${stats.readers}, live ${liveReaders}, unprotected ${stats.unguarded}; batches ${stats.deferred}; stack errors ${stats.stackErrors}`,
      `queue fills: ${drains.map(drain => `${drain.songs} songs in ${drain.seconds}s (${drain.outcome})`).join(' | ') || 'none'}; last fill: ${lastFill ? `${lastFill.songs} songs for "${lastFill.reason}", reshuffled ${lastFill.reshuffled ? 'yes' : 'no'}` : 'none'}`,
      `shuffle button: ${shuffleButtonInfo()}; open lists completed ${stats.listsCompleted}; reshuffles ${stats.reshuffles}; queues rebuilt right after a reshuffle ${rebuiltAfterReshuffle}`,
      `last fill note: ${lastFill?.note || 'none'}`,
      `readers: ${readerLog.map(r => `#${r.n} ${new Date(r.created).toLocaleTimeString()} shuffle ${r.shuffle ? 'on' : 'off'} from likes ${r.likes ? 'yes' : 'no'} args(${r.args}) keys(${r.keys}) reads ${r.reads}, queue pauses ${r.queuePauses}, disposed ${r.disposedAfter == null ? 'no' : `after ${r.disposedAfter} ms${r.disposedInRead ? ' inside a read' : ''}`}, filled ${r.filled ?? '-'}`).join(' | ') || 'none'}`,
      `shuffle functions: ${[...shuffleCalls].map(([label, entry]) => `${label} ×${entry.count} ${entry.last}`).join(' | ') || 'none called'}`,
      `next up items on page: ${document.querySelectorAll('.queue__itemWrapper, .queueItemView, .queue__item').length}`,
      `playback: instant ${stats.instantStarts}, waited ${stats.extraFetches}, prepared ${stats.prepared}; offscreen items ${Math.max(0, stats.offscreen)}`,
      `likes top-ups after page changes: ${stats.topUps}${stats.lastTopUp ? ` (last: ${stats.lastTopUp})` : ''}`,
      `window: lists ${stats.windowedLists}, drawn ${stats.windowDrawn}/${stats.windowTotal}, removed ${stats.windowRemoved}, rebuilds ${stats.windowRebuilds}, not windowed because: ${stats.windowSkip || '-'}; page elements now ${document.getElementsByTagName('*').length}`,
      `errors: ${recentErrors.map(error => `[${error.at}] ${error.where}: ${error.message}`).join(' | ') || 'none'}`,
    ].join('\n');
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* Fall back below. */ }
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;opacity:0;';
    document.body.append(area);
    area.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { /* Not available. */ }
    area.remove();
    return copied;
  }

  async function showPanel() {
    let info;
    try { info = await transaction('readonly', async (entries, control) => await requestResult(control.get('meta')) || initial()); }
    catch { storageError(); }
    const queueText = {
      waiting: 'SoundCloud has not loaded its queue module yet. It usually loads when you first press Play.',
      missing: 'SoundCloud has not loaded its queue module yet. It usually loads when you first press Play. If this still says "not found" after you press Play, this version does not recognize the current SoundCloud build.',
      found: 'The queue module was found and will be protected as soon as SoundCloud runs it.',
      active: 'Long lists are fed into the play queue in a flat loop, so Play cannot overflow the stack.',
      failed: 'The queue module loaded before it could be protected, so Play is not protected on this page. Reloading the page usually fixes this.',
    }[queueStatus];
    openPanel([
      'SoundCloud Likes & Long Lists',
      '',
      'SAVED LISTS',
      `Status: ${storageFailed ? 'storage unavailable; using server' : apiActive ? 'active' : 'waiting for supported SoundCloud API'}`,
      `Saved pages/batches: ${info?.count ?? 'unknown'} · ${info ? (info.bytes / 1048576).toFixed(1) : '?'} MiB`,
      `Cache hits this page: ${stats.hits} · Server reads: ${stats.misses}`,
      `Last saved list opened: ${stats.lastList ? `${stats.lastList.pages} page(s) joined · ${stats.lastList.items} items · loaded in ${stats.lastList.ms} ms` : 'none yet'}`,
      `Last Likes check: ${stats.likes || 'not run yet'} · New likes added this page: ${stats.newLikes}`,
      '',
      'SHUFFLE',
      `Full Likes list: ${describeCatalogs()}`,
      `Queue filled for shuffle: ${lastFill ? `${lastFill.songs.toLocaleString()} songs (${lastFill.reason})` : 'not yet'} · Shuffles redone with every song: ${stats.reshuffles}`,
      `Shuffle button: ${shuffleButtonInfo()}`,
      '',
      'PLAY ON LONG LISTS',
      `Queue readers protected: ${stats.readers} · could not be protected: ${stats.unguarded} · Stack-overflow errors: ${stats.stackErrors}`,
      queueText,
      '',
      'PLAYBACK',
      `Songs that started without waiting: ${stats.instantStarts} · that had to wait: ${stats.extraFetches} · prepared in advance: ${stats.prepared}`,
      `List items off screen and skipped by the browser: ${Math.max(0, stats.offscreen)}`,
      `Likes completed after arriving from another page: ${stats.topUps}${stats.lastTopUp ? ` (last: ${stats.lastTopUp})` : ''}`,
      `Long lists drawn as a window: ${stats.windowedLists} · songs on the page now: ${stats.windowDrawn} of ${stats.windowTotal} · removed so far: ${stats.windowRemoved}${stats.windowSkip ? ` · last long list not windowed: ${stats.windowSkip}` : ''}`,
      ...(recentErrors.length ? ['', 'RECENT PROBLEMS', ...recentErrors.slice(-5).map(error => `${error.at} · ${error.where}: ${error.message}`)] : []),
      '',
      'Shuffle on your Likes: the first time you open Likes, the rest of the list is saved in the background (one request per 200 songs, once). When you start a song from your Likes with shuffle on, SoundCloud\'s play queue is filled with the whole list and shuffle is switched off and on once, so it reshuffles with every song. Turning shuffle on in the middle of a song takes effect from the next song you start in your Likes.',
      'Your whole saved list is loaded at once (so Play and shuffle cover every song). Long lists are drawn as a window: the scrollbar covers the whole list, only the songs around where you are exist on the page, and songs far away are removed to free memory and redrawn when you come back.',
      'Saved metadata has no expiry. New likes are added when you open Likes; unlikes further down stay until you use Refresh lists. Audio and playback authorization are never saved.',
      'Open this panel from your profile menu or with Alt+Shift+L. If something does not work, use "Copy diagnostics" and paste the result into your report.',
    ].join('\n'), [
      ['Copy diagnostics', async panel => {
        const copied = await copyText(diagnostics(info));
        const note = panel.querySelector('[data-note]') || panel.appendChild(Object.assign(document.createElement('div'), { style: 'margin-top:10px;color:#9c9;' }));
        note.setAttribute('data-note', '');
        note.textContent = copied ? 'Diagnostics copied to the clipboard.' : 'Could not copy automatically.';
      }],
      ['Clear saved metadata', async () => { await invalidate(); await showPanel(); }],
      ['Refresh lists — reloads page', async () => { await invalidate(); location.reload(); }],
      ['Close', panel => panel.remove()],
    ]);
  }

  function mount() {
    watchDom();
    watchProfileMenu();
    watchListItems();
    watchShuffle();
    setInterval(watchShuffle, 2000);
  }
  whenReady(mount);

  // ---------------------------------------------------------------------------
  // DOM helpers (also used before the rest of the script starts)
  // ---------------------------------------------------------------------------

  function whenReady(callback) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', callback, { once: true });
    else callback();
  }
  function makeBadge() {
    const element = document.createElement('button');
    element.type = 'button';
    element.style.cssText = 'position:fixed;right:14px;bottom:112px;z-index:2147483645;padding:5px 9px;border:1px solid #666;border-radius:6px;background:#252525;color:#eee;font:12px/1.4 system-ui;cursor:pointer;';
    document.body.append(element);
    return element;
  }
  // A non-blocking panel. alert() would freeze the page while it is open.
  function openPanel(content, actions) {
    document.getElementById('sc-likes-long-lists-panel')?.remove();
    const panel = document.createElement('dialog');
    panel.id = 'sc-likes-long-lists-panel';
    panel.setAttribute('aria-label', 'SoundCloud Likes & Long Lists');
    panel.style.cssText = 'position:fixed;inset:0;margin:auto;max-width:500px;width:calc(100% - 32px);max-height:80vh;overflow:auto;background:#252525;color:#eee;border:1px solid #777;border-radius:10px;padding:24px;font:14px/1.6 system-ui;box-sizing:border-box;z-index:2147483647;';
    const text = document.createElement('div');
    text.style.whiteSpace = 'pre-line';
    text.textContent = content;
    panel.append(text);
    for (const [label, action] of actions) {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = label;
      element.style.cssText = 'margin:16px 8px 0 0;padding:8px;background:#333;color:#fff;border:1px solid #999;border-radius:5px;font:inherit;cursor:pointer;';
      element.addEventListener('click', async () => {
        element.disabled = true;
        try { await action(panel); } catch { text.textContent += '\nThat did not work. SoundCloud will keep using the server.'; }
        finally { element.disabled = false; }
      });
      panel.append(element);
    }
    panel.addEventListener('keydown', event => { if (event.key === 'Escape') panel.remove(); });
    document.body.append(panel);
    if (typeof panel.show === 'function') panel.show(); else panel.setAttribute('open', '');
  }
})();
