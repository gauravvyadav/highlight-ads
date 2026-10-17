import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    name: 'Highlight Ads Detector – Not an Ad Blocker',
    description:
      'See every ad on the page. Ad detector that outlines slots with a bold overlay, not an ad blocker.',
    permissions: ['storage', 'tabs'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Highlight Ads',
    },
    // MAIN-world creator hook (stack analysis, mirrors Chromium's AdTracker).
    // WXT only emits ISOLATED content scripts, so this entry is declared
    // manually; the file ships verbatim from public/.
    content_scripts: [
      {
        matches: ['<all_urls>'],
        js: ['had-creator-hook.js'],
        run_at: 'document_start',
        all_frames: true,
        world: 'MAIN',
      },
    ],
  },
});
