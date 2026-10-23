# Force Max Quality

A Chrome extension that pins an HLS web player to the best rendition your
account is already entitled to, instead of letting auto-bitrate drift down to
540p/270p. Primary target is the F1 TV web player. No DRM circumvention, no
entitlement bypass, no telemetry, no third-party servers.

> **Unofficial.** Not affiliated with, endorsed by, or sponsored by Formula 1.
> See [Disclaimer](#disclaimer).

## Install (~30 seconds)

Chrome can't install from a link, so this is manual and one-time. No account,
build step, or dependencies.

1. Download
   [`force-max-quality.zip`](../../releases/latest/download/force-max-quality.zip)
   and extract it, or `git clone https://github.com/bas1t-drafts/force-max-quality`.
2. `chrome://extensions` → **Developer mode** → **Load unpacked** → pick the
   folder containing `manifest.json`.
3. Open a stream, press play, click the icon. Reload tabs opened before install.

Update: extract the new zip over the same folder and hit the reload arrow on
`chrome://extensions`. The path never changes, so settings survive.

## How it works

The master playlist is fetched inside a blob worker, so hooking page-level
`fetch` is not enough.

- Hooks `URL.createObjectURL` at `document_start`, prepending a shim to the
  player's blob worker, where `self.fetch` is wrapped.
- Rewrites the master playlist so only the chosen variant is advertised — one
  level left, so ABR has nothing to be conservative about.
- Page `fetch`/XHR and hls.js/Shaka are hooked too, in case a manifest is
  fetched on the main thread.
- Variant playlists, segments, keys, and license requests are never touched, so
  Widevine/FairPlay keep working.

## Settings

| Setting | Meaning |
| --- | --- |
| **Force best quality** | Master switch. |
| **Highest available** | Advertise only the highest-bitrate variant. |
| **Highest under cap** | Best variant at or below N Mbps. |
| **Specific quality** | Pin an exact rendition from the detected list. |
| **Avoid HDR variants** | Skip PQ/HLG when SDR alternatives exist. |
| **Reload player** | Re-create the worker/source. |

Click a row to pin it; click it again to unpin. Changes apply to the next master
playlist fetch (one per playback), so hit **Reload player** after toggling.

## Limitations

- Cannot invent quality the server does not send.
- Two video pipelines both get the top variant, doubling bandwidth; use the cap.
- Single-variant masters are reported but cannot be forced higher.

## Development

```sh
node dev/test-rewrite.mjs   # 19 tests
node dev/package.mjs        # build the release zip
node dev/make-icons.mjs     # regenerate icons
```

## Disclaimer

This project is unofficial and is not associated in any way with the Formula 1
companies. F1, FORMULA ONE, FORMULA 1, FIA FORMULA ONE WORLD CHAMPIONSHIP,
GRAND PRIX and related marks are trade marks of Formula One Licensing B.V.

You are responsible for complying with the terms of service of any service you
use it with.

## License

MIT — see [LICENSE](LICENSE).
