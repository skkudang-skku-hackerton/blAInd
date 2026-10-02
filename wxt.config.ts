import { defineConfig } from 'wxt';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ worker: { format: 'es' } }),
  manifest: ({ browser, manifestVersion }) => ({
    name: 'blAInd',
    description: 'AI 웹페이지에서 전송 전 개인정보 마스킹을 돕는 확장 프로그램',
    ...(browser === 'chrome' ? { minimum_chrome_version: '116' } : {}),
    permissions: browser === 'chrome' ? ['offscreen', 'unlimitedStorage'] : ['unlimitedStorage'],
    host_permissions: ['https://huggingface.co/*', 'https://*.hf.co/*'],
    content_security_policy: manifestVersion === 3
      ? { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'" }
      : "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    ...(browser === 'firefox' ? {
      browser_specific_settings: {
        gecko: {
          id: 'blaind@skkudang-skku-hackerton.github.io',
          strict_min_version: '140.0',
          data_collection_permissions: { required: ['none'] },
        },
      },
    } : {}),
  }),
  hooks: {
    'build:publicAssets': async (_wxt, files) => {
      const runtimeDir = resolve('node_modules/onnxruntime-web/dist');
      for (const name of await readdir(runtimeDir)) {
        if (/^ort-wasm-.*\.(wasm|mjs)$/.test(name)) {
          files.push({ absoluteSrc: resolve(runtimeDir, name), relativeDest: `ort-wasm/${name}` });
        }
      }
    },
  },
});
