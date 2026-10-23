/*
 * Force Max Quality — ISOLATED world bridge.
 *
 * The MAIN world script cannot use chrome.* APIs, so this script forwards:
 *   - config (chrome.storage -> page)
 *   - diagnostics (page -> background service worker -> popup)
 */
(function () {
  'use strict';

  var DEFAULTS = {
    enabled: true,
    strategy: 'max',
    capMbps: 8,
    avoidHdr: false,
    pin: null,
    debug: false
  };

  var current = {};
  for (var key in DEFAULTS) current[key] = DEFAULTS[key];

  function sendConfig() {
    try {
      window.postMessage({ __f1hq: true, type: 'config', payload: current }, '*');
    } catch (e) {}
  }

  function loadConfig() {
    try {
      chrome.storage.sync.get(DEFAULTS, function (stored) {
        if (chrome.runtime.lastError) return;
        var next = {};
        for (var k in DEFAULTS) next[k] = stored && stored[k] !== undefined ? stored[k] : DEFAULTS[k];
        current = next;
        sendConfig();
      });
    } catch (e) {}
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.__f1hq !== true) return;

    if (data.type === 'hello') {
      sendConfig();
      return;
    }

    if (data.type === 'master' || data.type === 'media' ||
        data.type === 'frameworks' || data.type === 'worker' ||
        data.type === 'log') {
      try {
        chrome.runtime.sendMessage(
          { __f1hq: true, type: 'event', event: { type: data.type, payload: data.payload } },
          function () {
            // Reading lastError keeps Chrome from logging "unchecked runtime.lastError".
            void chrome.runtime.lastError;
          }
        );
      } catch (e) {}
    }
  });

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'sync') return;
      for (var k in DEFAULTS) {
        if (Object.prototype.hasOwnProperty.call(changes, k)) {
          loadConfig();
          return;
        }
      }
    });
  } catch (e) {}

  // The MAIN world script may attach slightly before or after us; a few
  // retries make the handshake reliable without polling forever.
  sendConfig();
  setTimeout(sendConfig, 50);
  setTimeout(sendConfig, 400);
  setTimeout(sendConfig, 1500);

  loadConfig();
})();
