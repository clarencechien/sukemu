import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { defineConfig } from 'vite';

/* 把建置版本寫進 dist/sw.js。
   關鍵:瀏覽器只在 sw.js 的「位元組」變了才會安裝新 SW。public/sw.js 是靜態檔,
   app 改版時它一個字都不會動 → 已安裝的 PWA 永遠收不到更新通知。
   這裡用 index.html 的雜湊當版本(裡面就是各資產的 hash 檔名,內容變它才變),
   所以有改才會觸發更新,沒改不會平白讓 SW churn。 */
const swBuildId = () => ({
  name: 'sw-build-id',
  closeBundle() {
    const html = readFileSync('dist/index.html', 'utf8');
    const id = createHash('sha256').update(html).digest('hex').slice(0, 12);
    const sw = readFileSync('dist/sw.js', 'utf8').replaceAll('__BUILD_ID__', id);
    writeFileSync('dist/sw.js', sw);
    console.log(`  sw.js build id: ${id}`);
  },
});

// 本機開發:vite dev 跑前端,API 轉給 wrangler dev(npm run dev:worker)
export default defineConfig({
  plugins: [swBuildId()],
  server: {
    proxy: { '/api': 'http://localhost:8787' },
  },
});
