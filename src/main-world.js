/*
 * Force Max Quality — MAIN world content script (document_start).
 *
 * What the primary target player does (observed during normal playback):
 *   - Player: Bitmovin v8 (bundled, no global), HLS + Widevine, AWS MediaPackage.
 *   - The HLS engine runs inside a **module Worker created from a Blob URL**
 *     and is compiled from Go to WebAssembly. All playlist fetches happen in
 *     that worker (`Initiator: blob:...`, `syscall/js.valueCall`).
 *
 * So patching `window.fetch` alone is useless. Strategy:
 *   1. `URL.createObjectURL` is hooked in the page. When the player turns a
 *      JavaScript Blob into a URL (its worker), we return a URL to
 *      `new Blob([shim, original])` — synchronous, no reading, same origin.
 *      The shim runs before the player's worker code and wraps `self.fetch`
 *      *inside* the worker, where the master playlist is actually fetched.
 *   2. Page-level fetch/XHR are still hooked, in case a build fetches a
 *      manifest on the main thread (or the service worker path is used).
 *   3. Both paths share one parser/selector (f1hqCore), serialized into the
 *      worker with Function.prototype.toString() so there is no drift.
 *   4. The worker reports what it saw over BroadcastChannel('f1hq'); the page
 *      relays it to the extension popup.
 *
 * DRM is untouched: the master playlist is not encrypted. The variant
 * playlists, segments, EXT-X-KEY and license requests are left alone.
 */
(function () {
  'use strict';

  var w = window;
  if (w.__f1hqInstalled) return;
  w.__f1hqInstalled = true;

  /* ================================================================== *
   * Core: HLS master parsing + variant selection.
   *
   * IMPORTANT: this function is serialized into the player's Web Worker,
   * so it must stay fully self-contained (only its own scope, no window).
   * ================================================================== */
  function f1hqCore(userConfig) {
    'use strict';

    var cfg = userConfig || {};

    if (typeof cfg.enabled !== 'boolean') cfg.enabled = true;
    if (cfg.strategy !== 'max' && cfg.strategy !== 'cap' && cfg.strategy !== 'pin') cfg.strategy = 'max';
    if (cfg.pin === undefined) cfg.pin = null;
    var cap = Number(cfg.capMbps);
    cfg.capMbps = isFinite(cap) ? Math.min(200, Math.max(1, cap)) : 8;
    if (typeof cfg.avoidHdr !== 'boolean') cfg.avoidHdr = false;

    function setConfig(patch) {
      if (!patch || typeof patch !== 'object') return;
      if (typeof patch.enabled === 'boolean') cfg.enabled = patch.enabled;
      if (patch.strategy === 'max' || patch.strategy === 'cap' || patch.strategy === 'pin') cfg.strategy = patch.strategy;
      if (patch.capMbps !== undefined) {
        var n = Number(patch.capMbps);
        if (isFinite(n)) cfg.capMbps = Math.min(200, Math.max(1, n));
      }
      if (patch.pin === null) {
        cfg.pin = null;
      } else if (patch.pin && typeof patch.pin === 'object') {
        var bw = Number(patch.pin.bandwidth);
        cfg.pin = {
          bandwidth: isFinite(bw) ? bw : 0,
          resolution: String(patch.pin.resolution || ''),
          codec: String(patch.pin.codec || '')
        };
      }
      if (typeof patch.avoidHdr === 'boolean') cfg.avoidHdr = patch.avoidHdr;
      if (typeof patch.debug === 'boolean') cfg.debug = patch.debug;
    }

    function parseAttrs(str) {
      var out = {};
      var parts = [];
      var current = '';
      var inQuotes = false;
      for (var i = 0; i < str.length; i++) {
        var ch = str.charAt(i);
        if (ch === '"') inQuotes = !inQuotes;
        if (ch === ',' && !inQuotes) {
          parts.push(current);
          current = '';
        } else {
          current += ch;
        }
      }
      parts.push(current);
      for (var j = 0; j < parts.length; j++) {
        var part = parts[j];
        var eq = part.indexOf('=');
        if (eq <= 0) continue;
        var key = part.slice(0, eq).trim().toUpperCase();
        var value = part.slice(eq + 1).trim().replace(/^"|"$/g, '');
        if (key) out[key] = value;
      }
      return out;
    }

    function numericAttr(attrs, name) {
      var raw = attrs[name];
      if (!raw) return 0;
      var n = parseInt(raw, 10);
      return isFinite(n) ? n : 0;
    }

    function isDecodable(variant) {
      var codecs = variant.attrs.CODECS;
      if (!codecs) return true;
      if (typeof MediaSource === 'undefined' || typeof MediaSource.isTypeSupported !== 'function') {
        return true; // worker: no MediaSource, keep the server's own list
      }
      try {
        if (MediaSource.isTypeSupported('video/mp4; codecs="' + codecs + '"')) return true;
        var parts = codecs.split(',');
        for (var i = 0; i < parts.length; i++) {
          var codec = parts[i].trim();
          if (/^(avc|hvc|hev|vp0?8|vp0?9|av01|dvh)/i.test(codec)) {
            if (MediaSource.isTypeSupported('video/mp4; codecs="' + codec + '"')) return true;
          }
        }
        return false;
      } catch (e) {
        return true;
      }
    }

    function codecFamily(attrs) {
      var codecs = String((attrs && attrs.CODECS) || '').toLowerCase();
      if (codecs.indexOf('hev') !== -1 || codecs.indexOf('hvc') !== -1) return 'hevc';
      if (codecs.indexOf('av01') !== -1) return 'av1';
      if (codecs.indexOf('avc') !== -1) return 'avc';
      return '';
    }

    /**
     * Finds the variant the user pinned. Matches resolution + codec family,
     * then the closest bandwidth. Falls back to the closest bandwidth overall
     * if that rendition disappeared from the manifest.
     */
    function matchPin(variants, pin) {
      if (!pin) return null;
      var resolution = String(pin.resolution || '');
      var codec = String(pin.codec || '');
      var bandwidth = Number(pin.bandwidth) || 0;
      var exact = null;
      var exactDiff = Infinity;
      var nearest = null;
      var nearestDiff = Infinity;

      for (var i = 0; i < variants.length; i++) {
        var variant = variants[i];
        var attrs = variant.attrs || {};
        var diff = Math.abs((variant.bandwidth || 0) - bandwidth);
        if (diff < nearestDiff) {
          nearest = variant;
          nearestDiff = diff;
        }
        if (resolution && String(attrs.RESOLUTION || '') !== resolution) continue;
        if (codec && codecFamily(attrs) !== codec) continue;
        if (diff < exactDiff) {
          exact = variant;
          exactDiff = diff;
        }
      }

      return exact || nearest;
    }

    function pickVariant(variants) {
      var pool = variants.slice();
      if (!pool.length) return null;

      if (cfg.avoidHdr) {
        var sdr = [];
        for (var i = 0; i < pool.length; i++) {
          var range = String(pool[i].attrs['VIDEO-RANGE'] || '').toUpperCase();
          if (range !== 'PQ' && range !== 'HLG') sdr.push(pool[i]);
        }
        if (sdr.length) pool = sdr;
      }

      var playable = [];
      for (var j = 0; j < pool.length; j++) {
        if (isDecodable(pool[j])) playable.push(pool[j]);
      }
      if (playable.length) pool = playable;

      if (cfg.strategy === 'pin' && cfg.pin) {
        var pinned = matchPin(pool, cfg.pin);
        if (pinned) return pinned;
      }

      pool.sort(function (a, b) {
        return b.bandwidth - a.bandwidth;
      });

      if (cfg.strategy === 'cap') {
        var limit = cfg.capMbps * 1000000;
        for (var k = 0; k < pool.length; k++) {
          if (pool[k].bandwidth <= limit) return pool[k];
        }
        return pool[pool.length - 1]; // nothing under the cap: lowest wins
      }

      return pool[0];
    }

    function buildMaster(text) {
      if (typeof text !== 'string' || text.length > 4000000) return null;

      var clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      if (!/^\s*#EXTM3U/.test(clean)) return null;
      if (clean.indexOf('#EXT-X-STREAM-INF:') === -1) return null;

      var newline = clean.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
      var lines = clean.split(/\r?\n/);
      var items = [];
      var variants = [];
      var pending = null;

      for (var i = 0; i < lines.length; i++) {
        var raw = lines[i];
        var line = raw.trim();

        if (pending !== null) {
          if (line === '') continue; // URI is on the next non-empty line
          if (line.charAt(0) === '#') {
            items.push({ kind: 'raw', text: pending });
            pending = null;
            items.push({ kind: 'raw', text: raw });
            continue;
          }
          var attrs = parseAttrs(pending.slice(pending.indexOf(':') + 1));
          var variant = {
            kind: 'variant',
            inf: pending,
            uri: line,
            attrs: attrs,
            bandwidth: numericAttr(attrs, 'BANDWIDTH') || numericAttr(attrs, 'AVERAGE-BANDWIDTH')
          };
          variants.push(variant);
          items.push(variant);
          pending = null;
          continue;
        }

        if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
          pending = line;
          continue;
        }

        items.push({ kind: 'raw', text: raw });
      }

      if (pending !== null) items.push({ kind: 'raw', text: pending });
      if (!variants.length) return null;

      var chosen = pickVariant(variants);
      if (!chosen) return null;

      var canRewrite = variants.length > 1;
      var out = [];
      var placed = false;

      for (var m = 0; m < items.length; m++) {
        var item = items[m];
        if (item.kind === 'raw') {
          out.push(item.text);
          continue;
        }
        if (item === chosen) {
          out.push(item.inf);
          out.push(item.uri);
          placed = true;
        }
      }

      if (!placed) return null;

      return {
        text: canRewrite ? out.join(newline) : null,
        variants: variants,
        chosen: chosen
      };
    }

    return {
      buildMaster: buildMaster,
      setConfig: setConfig,
      getConfig: function () {
        return cfg;
      }
    };
  }

  /* ================================================================== *
   * Page-side state
   * ================================================================== */

  var config = {
    enabled: true,
    strategy: 'max',
    capMbps: 8,
    avoidHdr: false,
    pin: null,
    debug: false
  };

  var core = f1hqCore(config);

  // Per-page-load id: BroadcastChannel is origin-wide, so scope it to this tab
  // (otherwise two player tabs would cross-report variants to each other).
  var instance = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  var channelName = 'f1hq:' + instance;
  var workerShimCount = 0;

  function log() {
    if (!config.debug) return;
    var args = ['%c[ForceHQ]', 'color:#2dd4bf;font-weight:700'];
    for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
    try {
      console.log.apply(console, args);
    } catch (e) {}
  }

  function post(type, payload) {
    try {
      w.postMessage({ __f1hq: true, type: type, payload: payload }, '*');
    } catch (e) {}
  }

  function configSnapshot() {
    return {
      enabled: config.enabled !== false,
      strategy: config.strategy === 'cap' ? 'cap' : config.strategy === 'pin' ? 'pin' : 'max',
      capMbps: config.capMbps,
      avoidHdr: !!config.avoidHdr,
      pin: config.pin || null,
      debug: !!config.debug
    };
  }

  /* ================================================================== *
   * Worker shim (serialized into the player's blob worker)
   * ================================================================== */

  function f1hqWorkerHook(userConfig, coreFactory, channelName) {
    'use strict';

    var isWorker = typeof self !== 'undefined' && typeof document === 'undefined';
    if (!isWorker || self.__f1hqWorker) return;
    self.__f1hqWorker = true;

    var core = coreFactory(userConfig || {});
    var mediaPlaylists = {};
    var lastReportKey = '';
    var channel = null;

    try {
      channel = new BroadcastChannel(channelName || 'f1hq');
    } catch (e) {}

    function log() {
      if (!core.getConfig().debug) return;
      var args = ['[F1HQ worker]'];
      for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
      try {
        console.log.apply(console, args);
      } catch (e) {}
    }

    function report(type, payload) {
      if (!channel) return;
      try {
        channel.postMessage({ __f1hq: true, type: type, payload: payload });
      } catch (e) {}
    }

    if (channel) {
      try {
        channel.onmessage = function (event) {
          var msg = event.data;
          if (!msg || msg.__f1hq !== true || msg.type !== 'config') return;
          core.setConfig(msg.payload || {});
          log('config', JSON.stringify(core.getConfig()));
        };
      } catch (e) {}
    }

    function looksLikePlaylist(url, contentType) {
      var value = String(url || '');
      if (/\.m3u8?(\?|#|$)/i.test(value)) return true;
      if (contentType && /mpegurl|vnd\.apple/i.test(contentType)) return true;
      if (/master|manifest|playlist/i.test(value) &&
          (!contentType || /^(text\/|application\/(x-mpegurl|vnd\.apple|octet-stream|json|xml))/i.test(contentType))) {
        return true;
      }
      return false;
    }

    function shortUrl(url) {
      var s = String(url || '');
      try {
        if (s.indexOf('blob:') === 0) return 'blob:';
        var u = new URL(s);
        return u.origin + u.pathname;
      } catch (e) {
        return s.split('?')[0].slice(0, 200);
      }
    }

    function summarize(parsed, url) {
      var variants = [];
      for (var i = 0; i < parsed.variants.length; i++) {
        var variant = parsed.variants[i];
        var attrs = variant.attrs || {};
        variants.push({
          bandwidth: variant.bandwidth || 0,
          resolution: attrs.RESOLUTION || '',
          frameRate: attrs['FRAME-RATE'] || '',
          codecs: attrs.CODECS || '',
          range: attrs['VIDEO-RANGE'] || '',
          forced: variant === parsed.chosen
        });
      }
      var chosenAttrs = parsed.chosen.attrs || {};
      return {
        url: shortUrl(url),
        variants: variants,
        chosen: {
          bandwidth: parsed.chosen.bandwidth || 0,
          resolution: chosenAttrs.RESOLUTION || ''
        },
        rewritten: typeof parsed.text === 'string' && core.getConfig().enabled !== false,
        enabled: core.getConfig().enabled !== false,
        source: 'worker'
      };
    }

    function cleanHeaders(headers) {
      var out = new Headers();
      try {
        headers.forEach(function (value, name) {
          var n = String(name).toLowerCase();
          if (n === 'content-length' || n === 'content-encoding' ||
              n === 'transfer-encoding' || n === 'connection') return;
          out.set(name, value);
        });
      } catch (e) {}
      return out;
    }

    function makeResponse(text, original, url) {
      var headers = cleanHeaders(original.headers);
      try {
        headers.set('content-length', String(new TextEncoder().encode(text).byteLength));
      } catch (e) {}
      var response = new Response(text, {
        status: original.status,
        statusText: original.statusText,
        headers: headers
      });
      try {
        Object.defineProperty(response, 'url', {
          value: original.url || url,
          configurable: true,
          enumerable: true
        });
      } catch (e) {}
      return response;
    }

    function handleText(url, text) {
      var parsed = core.buildMaster(text);
      if (!parsed) {
        if (text && text.indexOf('#EXTM3U') !== -1) mediaPlaylists[url] = true;
        return null;
      }
      var summary = summarize(parsed, url);
      var key = JSON.stringify(summary);
      if (key !== lastReportKey) {
        lastReportKey = key;
        report('master', summary);
        log('master:', parsed.variants.length, 'variants ->', parsed.chosen.bandwidth);
      }
      return parsed;
    }

    var nativeFetch = self.fetch;

    if (typeof nativeFetch === 'function') {
      self.fetch = function f1hqWorkerFetch(input, init) {
        var promise = nativeFetch.apply(this, arguments);

        var url = '';
        try {
          url = typeof input === 'string' ? input : (input && input.url) || '';
        } catch (e) {}

        if (mediaPlaylists[url]) return promise;
        if (!promise || typeof promise.then !== 'function') return promise;

        try {
          return promise.then(function (response) {
            try {
              if (!response || !response.ok) return response;
              if (!response.body) return response;

              var contentType = '';
              try {
                contentType = response.headers.get('content-type') || '';
              } catch (e) {}

              if (!looksLikePlaylist(url, contentType)) return response;

              var length = parseInt(response.headers.get('content-length') || '0', 10);
              if (isFinite(length) && length > 2000000) return response;

              return response.clone().text().then(function (text) {
                try {
                  var parsed = handleText(url, text);
                  if (!parsed) return response;
                  if (!core.getConfig().enabled) return response;
                  if (typeof parsed.text !== 'string') return response;
                  return makeResponse(parsed.text, response, url);
                } catch (e) {
                  return response;
                }
              }, function () {
                return response;
              });
            } catch (e) {
              return response;
            }
          });
        } catch (e) {
          return promise;
        }
      };
    }

    log('shim installed');
  }

  function buildWorkerSource() {
    return (
      '(' + f1hqWorkerHook.toString() + ')(' +
      JSON.stringify(configSnapshot()) + ',' +
      f1hqCore.toString() + ',' +
      JSON.stringify(channelName) +
      ');\n'
    );
  }

  /* ================================================================== *
   * Config channel (isolated world -> page -> workers)
   * ================================================================== */

  w.addEventListener('message', function (event) {
    if (event.source !== w) return;
    var data = event.data;
    if (!data || data.__f1hq !== true) return;
    if (data.type !== 'config' || !data.payload) return;

    if (typeof data.payload.debug === 'boolean') config.debug = data.payload.debug;
    core.setConfig(data.payload);
    log('config', JSON.stringify(configSnapshot()));
    broadcastConfig();
    reapplyHls();
    reapplyShaka();
    // Re-announce in case the handshake happened after the shim was injected.
    if (workerShimCount) {
      post('worker', { installed: true, source: 'blob', count: workerShimCount });
    }
  });

  post('hello');

  /* ================================================================== *
   * Broadcast channel used by the worker shim for config + reporting
   * ================================================================== */

  var channel = null;
  try {
    channel = new BroadcastChannel(channelName);
  } catch (e) {}

  if (channel) {
    try {
      channel.onmessage = function (event) {
        var msg = event.data;
        if (!msg || msg.__f1hq !== true) return;
        if (msg.type === 'master' && msg.payload) post('master', msg.payload);
      };
    } catch (e) {}
  }

  function broadcastConfig() {
    if (!channel) return;
    try {
      channel.postMessage({ __f1hq: true, type: 'config', payload: configSnapshot() });
    } catch (e) {}
  }

  /* ================================================================== *
   * Blob interception: prepend the shim to JavaScript workers
   * ================================================================== */

  var nativeCreateObjectURL = w.URL && w.URL.createObjectURL;
  var wrappedBlobs = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  if (typeof nativeCreateObjectURL === 'function') {
    w.URL.createObjectURL = function f1hqCreateObjectURL(blob) {
      try {
        if (blob && typeof blob === 'object' &&
            typeof blob.type === 'string' &&
            /javascript|ecmascript/i.test(blob.type)) {
          var wrapped = wrappedBlobs ? wrappedBlobs.get(blob) : null;
          if (!wrapped) {
            wrapped = new Blob([buildWorkerSource(), blob], { type: blob.type });
            if (wrappedBlobs) wrappedBlobs.set(blob, wrapped);
            workerShimCount++;
            post('worker', { installed: true, source: 'blob', count: workerShimCount });
            log('worker shim injected');
          }
          return nativeCreateObjectURL.call(w.URL, wrapped);
        }
      } catch (e) {}
      return nativeCreateObjectURL.apply(w.URL, arguments);
    };
  }

  /* ================================================================== *
   * Page-level fetch / XHR hooks (main-thread manifests)
   * ================================================================== */

  var PLAYLIST_URL_RE = /\.m3u8?(\?|#|$)/i;
  var PLAYLIST_CT_RE = /mpegurl|vnd\.apple/i;
  var MANIFESTISH_URL_RE = /master|manifest|playlist/i;
  var TEXTISH_CT_RE = /^(text\/|application\/(x-mpegurl|vnd\.apple|octet-stream|json|xml))/i;
  var mediaPlaylistCache = {};

  function looksLikePlaylist(url, contentType) {
    var value = String(url || '');
    if (PLAYLIST_URL_RE.test(value)) return true;
    if (contentType && PLAYLIST_CT_RE.test(contentType)) return true;
    if (MANIFESTISH_URL_RE.test(value) && (!contentType || TEXTISH_CT_RE.test(contentType))) {
      return true;
    }
    return false;
  }

  function isKnownMediaPlaylist(url) {
    return mediaPlaylistCache[url] === true;
  }

  function variantSummary(variant) {
    var attrs = variant.attrs || {};
    return {
      bandwidth: variant.bandwidth || 0,
      resolution: attrs.RESOLUTION || '',
      frameRate: attrs['FRAME-RATE'] || '',
      codecs: attrs.CODECS || '',
      range: attrs['VIDEO-RANGE'] || ''
    };
  }

  var lastReportKey = '';

  function reportMaster(url, parsed) {
    var summary = [];
    for (var i = 0; i < parsed.variants.length; i++) {
      var item = variantSummary(parsed.variants[i]);
      item.forced = parsed.variants[i] === parsed.chosen;
      summary.push(item);
    }

    var chosen = variantSummary(parsed.chosen);
    var report = {
      url: url,
      variants: summary,
      chosen: { bandwidth: chosen.bandwidth, resolution: chosen.resolution },
      rewritten: parsed.text !== null && config.enabled !== false,
      enabled: config.enabled !== false,
      source: 'page'
    };

    var key = JSON.stringify({
      u: url,
      v: summary,
      s: config.strategy + ':' + config.capMbps + ':' + config.avoidHdr
    });
    if (key === lastReportKey) return;
    lastReportKey = key;

    post('master', report);
    log('master fingerprint:', summary.length, 'variants, forced', chosen.bandwidth);
  }

  function shortUrl(url) {
    if (!url) return '';
    var s = String(url);
    try {
      if (s.indexOf('blob:') === 0) return 'blob:';
      var u = new URL(s, location.href);
      return u.origin + u.pathname;
    } catch (e) {
      return s.split('?')[0].slice(0, 200);
    }
  }

  function cleanHeaders(headers) {
    var out = new Headers();
    try {
      headers.forEach(function (value, name) {
        var n = String(name).toLowerCase();
        if (n === 'content-length' || n === 'content-encoding' ||
            n === 'transfer-encoding' || n === 'connection') return;
        out.set(name, value);
      });
    } catch (e) {}
    return out;
  }

  function syntheticResponse(text, original, url) {
    var headers = cleanHeaders(original.headers);
    try {
      headers.set('content-length', String(new TextEncoder().encode(text).byteLength));
    } catch (e) {}
    var response = new Response(text, {
      status: original.status,
      statusText: original.statusText,
      headers: headers
    });
    try {
      Object.defineProperty(response, 'url', {
        value: original.url || url,
        configurable: true,
        enumerable: true
      });
    } catch (e) {}
    return response;
  }

  function handleText(url, text) {
    var parsed = core.buildMaster(text);
    if (!parsed) {
      if (text && text.indexOf('#EXTM3U') !== -1) mediaPlaylistCache[url] = true;
      return null;
    }
    reportMaster(shortUrl(url), parsed);
    return parsed;
  }

  // --- fetch -----------------------------------------------------------

  var nativeFetch = w.fetch;

  if (typeof nativeFetch === 'function') {
    w.fetch = function f1hqFetch(input, init) {
      var promise = nativeFetch.apply(this, arguments);

      var url = '';
      try {
        url = typeof input === 'string' ? input : (input && input.url) || '';
      } catch (e) {}

      if (!promise || typeof promise.then !== 'function') return promise;
      if (isKnownMediaPlaylist(url)) return promise;

      try {
        return promise.then(function (response) {
          try {
            if (!response || !response.ok) return response;
            if (response.type === 'opaque' || response.type === 'opaqueredirect') return response;
            if (!response.body) return response;

            var contentType = response.headers.get('content-type') || '';
            if (!looksLikePlaylist(url, contentType)) return response;

            var length = parseInt(response.headers.get('content-length') || '0', 10);
            if (isFinite(length) && length > 2000000) return response;

            return response.clone().text().then(function (text) {
              try {
                var parsed = handleText(url, text);
                if (!parsed) return response;
                if (!config.enabled) return response;
                if (typeof parsed.text !== 'string') return response;
                return syntheticResponse(parsed.text, response, url);
              } catch (e) {
                return response;
              }
            }, function () {
              return response;
            });
          } catch (e) {
            return response;
          }
        });
      } catch (e) {
        return promise;
      }
    };
  }

  // --- XMLHttpRequest --------------------------------------------------

  var XHR = w.XMLHttpRequest;

  if (XHR && XHR.prototype) {
    var xhrProto = XHR.prototype;
    var descText = Object.getOwnPropertyDescriptor(xhrProto, 'responseText');
    var descResponse = Object.getOwnPropertyDescriptor(xhrProto, 'response');
    var nativeOpen = xhrProto.open;
    var nativeGetHeader = xhrProto.getResponseHeader;

    if (descText && descText.get && descResponse && descResponse.get && nativeOpen) {
      xhrProto.open = function f1hqOpen(method, url) {
        try {
          this.__f1hqUrl = typeof url === 'string' ? url : String(url);
          this.__f1hqDone = false;
          this.__f1hqText = null;
        } catch (e) {}
        return nativeOpen.apply(this, arguments);
      };

      var computeRewrite = function (xhr) {
        if (xhr.__f1hqDone) return xhr.__f1hqText || null;
        if (xhr.readyState !== 4) return null;

        xhr.__f1hqDone = true;
        xhr.__f1hqText = null;

        try {
          var url = xhr.__f1hqUrl || xhr.responseURL || '';
          if (isKnownMediaPlaylist(url)) return null;

          var contentType = nativeGetHeader.call(xhr, 'content-type') || '';
          if (!looksLikePlaylist(url, contentType)) return null;

          var responseType = xhr.responseType;
          var text = null;

          if (responseType === '' || responseType === 'text') {
            text = descText.get.call(xhr);
          } else if (responseType === 'arraybuffer') {
            var buffer = descResponse.get.call(xhr);
            if (!buffer || !buffer.byteLength || buffer.byteLength > 4000000) return null;
            text = new TextDecoder('utf-8').decode(new Uint8Array(buffer));
          } else {
            return null;
          }

          var parsed = handleText(url, text);
          if (!parsed || !config.enabled || typeof parsed.text !== 'string') return null;

          xhr.__f1hqText = parsed.text;
          return parsed.text;
        } catch (e) {
          return null;
        }
      };

      Object.defineProperty(xhrProto, 'responseText', {
        configurable: true,
        enumerable: descText.enumerable,
        get: function () {
          var rewritten = computeRewrite(this);
          return rewritten !== null ? rewritten : descText.get.call(this);
        },
        set: descText.set
      });

      Object.defineProperty(xhrProto, 'response', {
        configurable: true,
        enumerable: descResponse.enumerable,
        get: function () {
          var value = descResponse.get.call(this);
          var rewritten = computeRewrite(this);
          if (rewritten === null) return value;
          if (this.responseType === 'arraybuffer') {
            return new TextEncoder().encode(rewritten).buffer;
          }
          return rewritten;
        },
        set: descResponse.set
      });

      if (nativeGetHeader) {
        xhrProto.getResponseHeader = function f1hqGetHeader(name) {
          var rewritten = computeRewrite(this);
          if (rewritten !== null && String(name).toLowerCase() === 'content-length') {
            try {
              return String(new TextEncoder().encode(rewritten).byteLength);
            } catch (e) {}
          }
          return nativeGetHeader.apply(this, arguments);
        };
      }
    }
  }

  /* ================================================================== *
   * hls.js / Shaka fallbacks (only if exposed globally; the main target bundles
   * Bitmovin, so these usually never fire)
   * ================================================================== */

  var hlsInstances = [];
  var shakaPlayers = [];

  function topLevelIndex(levels) {
    if (!levels || !levels.length) return -1;
    if (config.strategy === 'cap') {
      var cap = config.capMbps * 1000000;
      var best = -1;
      var bestBw = -1;
      for (var i = 0; i < levels.length; i++) {
        var bw = levels[i].bitrate || 0;
        if (bw <= cap && bw > bestBw) {
          bestBw = bw;
          best = i;
        }
      }
      if (best >= 0) return best;
      var low = 0;
      var lowBw = Infinity;
      for (var j = 0; j < levels.length; j++) {
        var b = levels[j].bitrate || 0;
        if (b < lowBw) {
          lowBw = b;
          low = j;
        }
      }
      return low;
    }

    var index = 0;
    var highest = -1;
    for (var k = 0; k < levels.length; k++) {
      var bitrate = levels[k].bitrate || 0;
      if (bitrate > highest) {
        highest = bitrate;
        index = k;
      }
    }
    return index;
  }

  function pinHls(hls) {
    if (!hls || typeof hls !== 'object' || hls.__f1hqPinned) return;
    hls.__f1hqPinned = true;
    hlsInstances.push(hls);

    var apply = function () {
      try {
        var levels = hls.levels;
        if (!levels || !levels.length) return;
        if (!config.enabled) {
          hls.autoLevelCapping = -1;
          hls.currentLevel = -1;
          return;
        }
        var index = topLevelIndex(levels);
        if (index < 0) return;
        hls.autoLevelCapping = -1;
        hls.currentLevel = index;
        log('hls.js pinned to level', index, (levels[index] && levels[index].bitrate) || '');
      } catch (e) {}
    };

    try {
      hls.on('hlsManifestParsed', apply);
      hls.on('hlsLevelsUpdated', apply);
    } catch (e) {}

    apply();
  }

  function reapplyHls() {
    for (var i = 0; i < hlsInstances.length; i++) {
      try {
        var hls = hlsInstances[i];
        if (!config.enabled) {
          hls.autoLevelCapping = -1;
          hls.currentLevel = -1;
        } else if (hls.levels && hls.levels.length) {
          var index = topLevelIndex(hls.levels);
          if (index >= 0) hls.currentLevel = index;
        }
      } catch (e) {}
    }
  }

  function pinShaka(player) {
    if (!player || typeof player !== 'object' || player.__f1hqPinned) return;
    if (typeof player.getVariantTracks !== 'function') return;
    player.__f1hqPinned = true;
    shakaPlayers.push(player);

    var last = 0;

    var apply = function () {
      var now = Date.now();
      if (now - last < 1500) return;
      last = now;
      try {
        var tracks = player.getVariantTracks() || [];
        if (!tracks.length) return;
        if (!config.enabled) {
          player.configure({ abr: { enabled: true } });
          return;
        }

        var sorted = tracks.slice().sort(function (a, b) {
          return (b.bandwidth || 0) - (a.bandwidth || 0);
        });
        var pick = sorted[0];

        if (config.strategy === 'cap') {
          var cap = config.capMbps * 1000000;
          var under = sorted.filter(function (t) {
            return (t.bandwidth || 0) <= cap;
          });
          pick = under[0] || sorted[sorted.length - 1];
        }

        if (!pick) return;
        player.configure({ abr: { enabled: false } });
        var active = null;
        for (var i = 0; i < tracks.length; i++) {
          if (tracks[i].active) active = tracks[i];
        }
        if (!active || active.id !== pick.id) {
          player.selectVariantTrack(pick, false);
          log('shaka pinned to', pick.bandwidth, pick.height);
        }
      } catch (e) {}
    };

    try {
      player.addEventListener('trackschanged', apply);
      player.addEventListener('adaptation', apply);
      player.addEventListener('loaded', apply);
    } catch (e) {}

    apply();
  }

  function reapplyShaka() {
    for (var i = 0; i < shakaPlayers.length; i++) {
      try {
        var player = shakaPlayers[i];
        if (!config.enabled) player.configure({ abr: { enabled: true } });
      } catch (e) {}
    }
  }

  function wrapHls(Hls) {
    if (!Hls || Hls.__f1hqWrapped) return Hls;
    var ProxyCtor;
    try {
      ProxyCtor = new Proxy(Hls, {
        construct: function (target, args, newTarget) {
          var instance = Reflect.construct(target, args, newTarget);
          try {
            pinHls(instance);
          } catch (e) {}
          return instance;
        }
      });
    } catch (e) {
      return Hls;
    }
    try {
      Object.defineProperty(ProxyCtor, '__f1hqWrapped', { value: true });
    } catch (e) {}
    return ProxyCtor;
  }

  function wrapShaka(shaka) {
    if (!shaka || !shaka.Player || shaka.Player.__f1hqWrapped) return shaka;
    try {
      var Player = shaka.Player;
      var Wrapped = new Proxy(Player, {
        construct: function (target, args, newTarget) {
          var instance = Reflect.construct(target, args, newTarget);
          try {
            pinShaka(instance);
          } catch (e) {}
          return instance;
        }
      });
      Object.defineProperty(Wrapped, '__f1hqWrapped', { value: true });
      shaka.Player = Wrapped;
    } catch (e) {}
    return shaka;
  }

  function watchGlobal(name, wrap) {
    var value;
    try {
      value = w[name];
      if (value) value = wrap(value) || value;
      Object.defineProperty(w, name, {
        configurable: true,
        get: function () {
          return value;
        },
        set: function (next) {
          try {
            value = wrap(next) || next;
          } catch (e) {
            value = next;
          }
        }
      });
    } catch (e) {}
  }

  watchGlobal('Hls', wrapHls);
  watchGlobal('shaka', wrapShaka);

  /* ================================================================== *
   * Reporting (what is actually playing)
   * ================================================================== */

  var seenVideos = [];

  function reportMedia(video) {
    try {
      post('media', {
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        paused: !!video.paused,
        readyState: video.readyState,
        src: shortUrl(video.src),
        currentSrc: shortUrl(video.currentSrc || video.src)
      });
    } catch (e) {}
  }

  function scanVideos() {
    try {
      var videos = document.querySelectorAll('video');
      for (var i = 0; i < videos.length; i++) {
        var video = videos[i];
        if (seenVideos.indexOf(video) !== -1) continue;
        seenVideos.push(video);
        (function (v) {
          var send = function () {
            reportMedia(v);
          };
          var events = ['loadedmetadata', 'playing', 'resize', 'emptied'];
          for (var e = 0; e < events.length; e++) {
            v.addEventListener(events[e], send, { passive: true });
          }
          send();
        })(video);
      }
    } catch (e) {}
  }

  function reportFrameworks() {
    try {
      post('frameworks', {
        hls: !!w.Hls,
        shaka: !!w.shaka,
        dashjs: !!w.dashjs,
        videojs: !!w.videojs,
        theoplayer: !!(w.THEOplayer || w.theoplayer),
        bitmovin: !!w.bitmovin,
        mse: typeof MediaSource !== 'undefined',
        nativeHls: !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl')
      });
    } catch (e) {}
  }

  try {
    scanVideos();
    if (document.documentElement) {
      var observer = new MutationObserver(function () {
        scanVideos();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  } catch (e) {}

  setTimeout(reportFrameworks, 2500);
  setTimeout(reportFrameworks, 9000);
  setTimeout(scanVideos, 2500);
  setTimeout(scanVideos, 9000);

  /* ================================================================== *
   * Debug helpers (DevTools console)
   * ================================================================== */

  w.__f1hqDebug = function () {
    var media = [];
    try {
      var videos = document.querySelectorAll('video');
      for (var i = 0; i < videos.length; i++) {
        media.push({
          videoWidth: videos[i].videoWidth,
          videoHeight: videos[i].videoHeight,
          currentSrc: shortUrl(videos[i].currentSrc || videos[i].src),
          paused: videos[i].paused
        });
      }
    } catch (e) {}
    return {
      version: '0.3.0',
      config: configSnapshot(),
      cores: { page: !!core },
      hlsInstances: hlsInstances.length,
      shakaPlayers: shakaPlayers.length,
      workerShims: workerShimCount,
      instance: instance,
      videos: media,
      lastReport: lastReportKey
    };
  };

  w.__f1hqInternals = {
    buildMaster: core.buildMaster,
    buildWorkerSource: buildWorkerSource,
    getConfig: core.getConfig,
    core: f1hqCore
  };
})();
