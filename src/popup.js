/* Force Max Quality — popup */
(() => {
  'use strict';

  const VERSION = '0.3.0';

  const el = (id) => document.getElementById(id);

  const ui = {
    status: el('status'),
    enabled: el('enabled'),
    strategy: el('strategy'),
    capRow: el('capRow'),
    capMbps: el('capMbps'),
    avoidHdr: el('avoidHdr'),
    debug: el('debug'),
    streamBadge: el('streamBadge'),
    streamBody: el('streamBody'),
    pickHint: el('pickHint'),
    playingLine: el('playingLine'),
    workerLine: el('workerLine'),
    reload: el('reload'),
    copy: el('copy'),
    reloadHint: el('reloadHint'),
    frameworks: el('frameworks')
  };

  let config = null;
  let tab = null;
  let stats = null;
  let dirty = false;
  let statsTimer = null;

  const send = (message) => chrome.runtime.sendMessage({ __f1hq: true, ...message });
  const fmtMbps = (bw) => ((bw || 0) / 1000000).toFixed(1) + ' Mbps';

  function shortRes(resolution) {
    if (!resolution) return '?';
    const height = String(resolution).split('x')[1];
    return height ? height + 'p' : resolution;
  }

  function frameRate(value) {
    const n = parseFloat(value);
    if (!isFinite(n) || n <= 0) return '';
    return String(Math.round(n));
  }

  function label(variant) {
    const parts = [shortRes(variant.resolution)];
    const fps = frameRate(variant.frameRate);
    if (fps) parts[0] += fps;
    return parts[0];
  }

  function codecInfo(codecs) {
    const value = String(codecs || '').toLowerCase();
    if (value.includes('hev') || value.includes('hvc')) return { family: 'hevc', label: 'HEVC' };
    if (value.includes('av01')) return { family: 'av1', label: 'AV1' };
    if (value.includes('avc')) return { family: 'avc', label: 'AVC' };
    return { family: '', label: '' };
  }

  function sameVariant(variant, pin) {
    if (!pin) return false;
    if (codecInfo(variant.codecs).family !== (pin.codec || '')) return false;
    if (String(variant.resolution || '') !== String(pin.resolution || '')) return false;
    return Math.abs((variant.bandwidth || 0) - (pin.bandwidth || 0)) < 1000;
  }

  function pickVariant(variant) {
    const active =
      config && config.strategy === 'pin' && config.pin && sameVariant(variant, config.pin);
    if (active) {
      save({ strategy: 'max', pin: null });
      return;
    }
    save({
      strategy: 'pin',
      pin: {
        bandwidth: variant.bandwidth || 0,
        resolution: variant.resolution || '',
        codec: codecInfo(variant.codecs).family
      }
    });
  }

  /* ---------------------------------------------------------------- */

  async function loadTabConfig() {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = active || null;
  }

  async function loadStats() {
    if (!tab || tab.id == null) return;
    try {
      stats = await send({ type: 'getStats', tabId: tab.id });
    } catch (_) {
      stats = null;
    }
  }

  function isF1Page() {
    if (!tab || !tab.url) return false;
    return /formula1\.com|f1tv\.com/i.test(tab.url);
  }

  /* ---------------------------------------------------------------- */

  function renderStatus() {
    if (!config) return;
    if (!isF1Page()) {
      ui.status.textContent = 'not on a player';
      ui.status.className = 'pill';
      return;
    }
    if (!config.enabled) {
      ui.status.textContent = 'off';
      ui.status.className = 'pill off';
      return;
    }
    ui.status.textContent = stats && stats.master && stats.master.rewritten ? 'pinned' : 'active';
    ui.status.className = 'pill on';
  }

  function renderControls() {
    if (!config) return;
    ui.enabled.checked = !!config.enabled;
    ui.strategy.value = ['max', 'cap', 'pin'].includes(config.strategy) ? config.strategy : 'max';
    ui.capMbps.value = config.capMbps;
    ui.avoidHdr.checked = !!config.avoidHdr;
    ui.debug.checked = !!config.debug;
    ui.capRow.hidden = config.strategy !== 'cap';
    ui.reloadHint.hidden = !dirty;
    document.body.style.opacity = config.enabled ? '1' : '0.92';
  }

  function renderStream() {
    const master = stats && stats.master;
    const media = stats && stats.media;

    ui.streamBody.textContent = '';
    ui.playingLine.hidden = true;
    ui.pickHint.hidden = true;

    if (!master) {
      ui.streamBadge.textContent = '—';
      ui.streamBody.className = 'muted';
      ui.streamBody.textContent = isF1Page()
        ? 'No stream seen yet — start playback, then reopen this popup.'
        : 'Open a supported player first.';
    } else {
      const variants = (master.variants || []).slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));

      ui.streamBadge.textContent = master.rewritten
        ? 'pinned'
        : variants.length === 1
        ? 'single variant'
        : 'detected';

      const list = document.createElement('ul');
      list.className = 'variants';

      variants.forEach((variant) => {
        const selected =
          config && config.enabled !== false && config.strategy === 'pin' && config.pin
            ? sameVariant(variant, config.pin)
            : !!variant.forced;

        const li = document.createElement('li');
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'variant' + (selected ? ' forced' : '');
        row.title = selected ? 'Click to unpin (reload to apply)' : 'Pin this quality (reload to apply)';
        row.addEventListener('click', () => pickVariant(variant));

        const tick = document.createElement('span');
        tick.className = 'tick';
        tick.textContent = selected ? '●' : '';

        const res = document.createElement('span');
        res.className = 'res';
        res.textContent = label(variant);

        const codec = codecInfo(variant.codecs);
        const bw = document.createElement('span');
        bw.className = 'bw';
        bw.textContent = fmtMbps(variant.bandwidth);

        row.append(tick, res);
        if (codec.label) {
          const codecTag = document.createElement('span');
          codecTag.className = 'tag codec';
          codecTag.textContent = codec.label;
          row.append(codecTag);
        }
        if (variant.range && variant.range !== 'SDR') {
          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = variant.range;
          row.append(tag);
        }
        row.append(bw);
        li.append(row);
        list.append(li);
      });

      ui.streamBody.className = '';
      ui.streamBody.append(list);

      ui.pickHint.hidden = false;
      const pinned = config && config.strategy === 'pin' && config.pin ? config.pin : null;
      if (pinned) {
        const available = variants.some((variant) => sameVariant(variant, pinned));
        ui.pickHint.className = available ? 'hint' : 'hint hint-warn';
        ui.pickHint.textContent = available
          ? 'Pinned. Click the same row to unpin, then reload.'
          : 'Pinned quality is not in this stream — the closest match will be used after reload.';
      } else if (config && config.strategy === 'pin') {
        ui.pickHint.className = 'hint';
        ui.pickHint.textContent = 'Specific quality selected — click a row, then reload.';
      } else {
        ui.pickHint.className = 'hint';
        ui.pickHint.textContent = 'Click a row to pin that quality.';
      }

      if (!config.enabled) {
        ui.pickHint.hidden = true;
        const note = document.createElement('div');
        note.className = 'hint hint-warn';
        note.textContent = 'Extension is off — turn it on and reload to apply a pin.';
        ui.streamBody.append(note);
      }
    }

    if (media && media.width && media.height) {
      ui.playingLine.hidden = false;
      ui.playingLine.textContent = `Now playing ${media.width}×${media.height}${media.paused ? ' (paused)' : ''}`;
    }

    const worker = stats && stats.worker;
    if (worker && worker.installed) {
      const count = worker.count || 1;
      ui.workerLine.hidden = false;
      ui.workerLine.className = 'hint worker-line on';
      ui.workerLine.textContent =
        `Worker hook installed${count > 1 ? ` (${count} workers)` : ''} — the rewrite happens inside the player’s worker.`;
    } else {
      ui.workerLine.hidden = true;
    }

    renderFrameworks();
    renderStatus();
  }

  function renderFrameworks() {
    const frameworks = stats && stats.frameworks;
    if (!frameworks) {
      ui.frameworks.textContent = '';
      return;
    }
    const found = Object.keys(frameworks)
      .filter((key) => frameworks[key] === true)
      .join(', ');
    ui.frameworks.textContent = found ? 'Detected: ' + found : 'No player library exposed globally.';
  }

  /* ---------------------------------------------------------------- */

  async function save(patch) {
    dirty = true;
    try {
      const next = await send({ type: 'setConfig', patch });
      if (next) config = next;
    } catch (_) {}
    renderControls();
    renderStream();
    if (stats && stats.master) ui.reloadHint.hidden = false;

    // Re-read stats shortly after; the player may re-request the manifest.
    setTimeout(refreshStats, 700);
  }

  async function refreshStats() {
    await loadStats();
    renderStream();
  }

  /* ---------------------------------------------------------------- */

  function diagnostics() {
    const data = {
      extension: 'Force Max Quality v' + VERSION,
      page: tab ? tab.url : null,
      config,
      frameworks: stats ? stats.frameworks : null,
      worker: stats ? stats.worker : null,
      master: stats ? stats.master : null,
      media: stats ? stats.media : null,
      seenAt: stats ? new Date(stats.updatedAt || 0).toISOString() : null,
      userAgent: navigator.userAgent
    };
    return JSON.stringify(data, null, 2);
  }

  /* ---------------------------------------------------------------- */

  async function init() {
    await loadTabConfig();
    try {
      config = await send({ type: 'getConfig' });
    } catch (_) {}
    if (!config) {
      config = { enabled: true, strategy: 'max', capMbps: 8, avoidHdr: false, debug: false };
    }

    await loadStats();
    renderControls();
    renderStream();

    ui.enabled.addEventListener('change', () => save({ enabled: ui.enabled.checked }));
    ui.strategy.addEventListener('change', () => {
      const value = ui.strategy.value;
      if (value === 'pin') save({ strategy: 'pin' });
      else save({ strategy: value, pin: null });
    });
    ui.capMbps.addEventListener('change', () => save({ capMbps: Number(ui.capMbps.value) }));
    ui.avoidHdr.addEventListener('change', () => save({ avoidHdr: ui.avoidHdr.checked }));
    ui.debug.addEventListener('change', () => save({ debug: ui.debug.checked }));

    ui.reload.addEventListener('click', () => {
      if (tab && tab.id != null) {
        chrome.tabs.reload(tab.id);
        window.close();
      }
    });

    ui.copy.addEventListener('click', async () => {
      const text = diagnostics();
      try {
        await navigator.clipboard.writeText(text);
        ui.copy.textContent = 'Copied ✓';
      } catch (_) {
        ui.copy.textContent = 'Copy failed';
      }
      setTimeout(() => {
        ui.copy.textContent = 'Copy diagnostics';
      }, 1400);
    });

    statsTimer = setInterval(refreshStats, 1500);
    window.addEventListener('unload', () => clearInterval(statsTimer));
  }

  init();
})();
