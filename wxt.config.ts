import { defineConfig } from 'wxt';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  zip: {
    // Keep Mozilla's review archive limited to reproducible build inputs.
    includeSources: ['src/**', 'package.json', 'package-lock.json', 'tsconfig.json', 'wxt.config.ts', 'SOURCE_CODE_REVIEW.md'],
  },
  // Load ORT's external ESM/WASM assets from /ort-wasm/ instead of also
  // embedding them in Vite's bundles. Workers have their own resolver.
  vite: () => ({
    resolve: { conditions: ['onnxruntime-web-use-extern-wasm', 'module', 'browser', 'development|production'] },
    worker: {
      format: 'es',
      plugins: () => [{
        name: 'ort-external-wasm',
        config: () => ({
          resolve: { conditions: ['onnxruntime-web-use-extern-wasm', 'module', 'browser', 'development|production'] },
        }),
      }],
    },
  }),
  manifest: ({ browser, manifestVersion }) => ({
    name: 'blAInd',
    description: 'AI 웹페이지에서 전송 전 개인정보 마스킹을 돕는 확장 프로그램',
    ...(browser === 'chrome' ? { minimum_chrome_version: '116' } : {}),
    permissions: browser === 'chrome' ? ['offscreen', 'unlimitedStorage'] : ['unlimitedStorage'],
    host_permissions: ['https://huggingface.co/*', 'https://*.hf.co/*'],
    web_accessible_resources: [{
      resources: ['document-review.html'],
      matches: ['https://chatgpt.com/*', 'https://claude.ai/*', 'https://gemini.google.com/*'],
    }],
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
    'build:publicAssets': async (wxt, files) => {
      const runtimeDir = resolve('node_modules/onnxruntime-web/dist');
      // ORT 1.30's /wasm entry uses the plain runtime; /webgpu uses Asyncify.
      // Firefox disables WebGPU, while Chrome retains WASM as a fallback.
      const variants = wxt.config.browser === 'firefox' ? [''] : ['', '.asyncify'];
      for (const variant of variants) {
        for (const extension of ['mjs', 'wasm']) {
          const name = `ort-wasm-simd-threaded${variant}.${extension}`;
          await access(resolve(runtimeDir, name));
          files.push({ absoluteSrc: resolve(runtimeDir, name), relativeDest: `ort-wasm/${name}` });
        }
      }
    },
  },
});
