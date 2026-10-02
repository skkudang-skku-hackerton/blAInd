import { defineConfig } from 'wxt';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mockAlertTerminalPlugin } from './src/alert/mock_data/terminal-server';

export default defineConfig({
  srcDir: 'src',
  manifestVersion: 3,
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ worker: { format: 'es' }, plugins: [mockAlertTerminalPlugin()] }),
  manifest: {
    name: 'blAInd',
    description: 'AI 웹페이지에서 전송 전 개인정보 마스킹을 돕는 확장 프로그램',
    minimum_chrome_version: '116',
    permissions: ['offscreen', 'unlimitedStorage'],
    host_permissions: ['https://huggingface.co/*', 'https://*.hf.co/*'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'",
    },
  },
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
