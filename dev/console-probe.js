/*
 * Paste this into DevTools → Console on the player tab (before or after
 * installing the extension) if you need to check what the player is doing.
 *
 * It prints (and copies) a JSON summary: which player library is used, which
 * video elements exist, which manifests were requested, and the real playing
 * resolution. Query strings (auth tokens) are stripped.
 */
(() => {
  const clean = (u) => {
    if (!u) return '';
    try {
      if (String(u).startsWith('blob:')) return 'blob:';
      const x = new URL(u, location.href);
      return x.origin + x.pathname;
    } catch (_) {
      return String(u).split('?')[0].slice(0, 160);
    }
  };

  const players = {
    f1hqInstalled: !!window.__f1hqInstalled,
    hlsjs: !!window.Hls,
    shaka: !!window.shaka,
    dashjs: !!window.dashjs,
    videojs: !!window.videojs,
    theoplayer: !!(window.THEOplayer || window.theoplayer),
    bitmovin: !!window.bitmovin
  };

  const videos = [...document.querySelectorAll('video')].map((v) => ({
    width: v.videoWidth,
    height: v.videoHeight,
    readyState: v.readyState,
    paused: v.paused,
    src: clean(v.currentSrc || v.src)
  }));

  const manifests = [
    ...new Set(
      performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((u) => /\.m3u8?(\?|#|$)|\.mpd(\?|#|$)|manifest|playlist/i.test(u))
    )
  ]
    .map(clean)
    .slice(0, 15);

  const iframes = [...document.querySelectorAll('iframe')].map((f) => clean(f.src)).slice(0, 10);

  const storageKeys = Object.keys(localStorage).filter((k) =>
    /qual|abr|bitrate|player|video|hls|dash/i.test(k)
  );

  const out = {
    url: clean(location.href),
    players,
    videos,
    manifests,
    iframes,
    storageKeys,
    debug: typeof window.__f1hqDebug === 'function' ? window.__f1hqDebug() : null
  };

  console.log(out);
  try {
    copy(JSON.stringify(out, null, 2));
    console.log('%cCopied to clipboard.', 'color:#2fbf71;font-weight:700');
  } catch (_) {}
})();
