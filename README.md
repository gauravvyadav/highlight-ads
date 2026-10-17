<p align="center">
  <img src="./banner.png" alt="Highlight Ads Detector" />
</p>

<h1 align="center">Highlight Ads Detector</h1>

<p align="center">
  <b>See every ad on the page. Highlights ad slots with a bold overlay and a large AD marker. Not an ad blocker: it never blocks, hides, or removes ads.</b>
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/highlight-ads-detector/mmhkcokmkjplkmpmhjkjpellgkpmolhn" style="text-decoration: none;">
    <img src="assets/chrome-webstore.png" height="40" alt="Chrome Web Store" />
  </a>
  &nbsp;
  <a href="https://microsoftedge.microsoft.com/addons/detail/hcohmebafmbfolebpcnahicadacpienb" style="text-decoration: none;">
    <img src="assets/English_Get it from Microsoft Edge.png" height="40" alt="Edge Addons" />
  </a>
</p>

---

## Features

- Automatic detection powered by the community-maintained EasyList filter set,
  refreshed every 4 days (manual refresh included) — same list family behind
  Chrome's own ad tagging (a condensed EasyList)
- Catches Taboola/Outbrain-style native widgets: nodes inserted while an ad
  script runs are flagged (mirrors Chromium AdTracker stack analysis), and
  subframes that identify as ads report upward so the frame gets flagged
  (mirrors Chromium's sticky frame classification)
- Seven highlight colors: red, orange, amber, green, blue, purple, plus an adaptive theme overlay (100% solid white on light websites with black text, 100% solid black on dark websites with white text that hides ads behind the color)
- Website exclusion: 1-click button to exclude any website from ad highlighting, with an instant "Remove from Exclude" action when revisiting that site
- Stays glued to sticky banners while scrolling; works on single-page sites
- Offline fallback with bundled patterns when the list can't be reached
- Detects publisher-labeled slots, ad markers, and standard IAB-size slots

## What's New in v0.2.0

- **Adaptive Theme Highlight Color**: New 7th swatch automatically adapts to the website's theme. Completely covers the ad slot with 100% opaque solid white on light sites and solid black on dark sites, with bold, high-contrast opposite-colored "AD" lettering.
- **Website Exclusion & Pause**: 1-click action in the popup to pause ad highlighting on specific websites, with instant status display and one-click resumption.
- **Native Ad Widget Detection**: Flags Taboola, Outbrain, and sponsored native widgets through main-world script creation stack tracking and upward subframe classification.
- **Performance & Latency Overhaul**:
  - Eliminated popup display delay through parallel tab/storage queries and instant badge text caching.
  - Eliminated webpage lag through debounced rescan passes, scoped mutation filtering that ignores extension overlays, and `requestAnimationFrame`-throttled scroll capture.
- **Engine Modernization**: Upgraded to `@ghostery/adblocker` with latest `tldts` domain extraction.

## Install

Load the production build (no dev-mode warnings):

```sh
npm install
npm run build
```

Then open `chrome://extensions`, enable Developer mode, and "Load unpacked"
the `.output/chrome-mv3` folder. Or install `highlight-ads-<version>-chrome.zip`
from `.output/`.

For development with hot reload:

```sh
npm run dev
```

## Scripts

| Command         | What it does                          |
| --------------- | ------------------------------------- |
| `npm run dev`   | Start WXT dev mode (auto-reloads)     |
| `npm run build` | Production build into `.output/`      |
| `npm run zip`   | Build + pack the store-ready `.zip`   |
| `npm run compile` | Type-check with `tsc --noEmit`      |
| `npm run promo:capture` | Capture store & promo PNG images |

## How it works

- `entrypoints/highlight.content.ts` — scans the top frame for ad slots
  (frames, media, labeled containers, standard-size iframes), draws
  fixed-position overlays, and reports counts.
- `entrypoints/background.ts` — runs the EasyList engine
  ([@ghostery/adblocker](https://github.com/ghostery/adblocker)), caches the list
  in `chrome.storage.local`, validates payloads before parsing, and answers
  batched classification requests.
- `entrypoints/popup/` — toggle, current website exclusion button, live count,
  list status, manual list update, and 7-color picker.
- `utils/` — settings protocol, bundled fallback patterns, EasyList helpers.
- `store-assets/` — icons, promo artwork sources (`promo-page/`), and the
  store listing copy (`listing.txt`).

## Privacy

No user data is collected or transmitted. Detection runs on-device; the only
network request is the periodic download of the public EasyList text file.

## Third-party licenses

- EasyList filter data ships as a snapshot (`public/lists/easylist.txt`,
  updated manually) and refreshes itself at runtime from
  [easylist.to](https://easylist.to). EasyList is licensed under the GPLv3;
  see `public/lists/ATTRIBUTION.txt` and the
  [easylist repository](https://github.com/easylist/easylist) for details.
- This extension bundles [@ghostery/adblocker](https://github.com/ghostery/adblocker)
  (Mozilla Public License 2.0) to match filter rules locally.

## License

MIT — see [LICENSE](./LICENSE).
