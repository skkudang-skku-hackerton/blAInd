import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifestVersion: 3,
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'blAInd',
    description: 'AI 웹페이지에서 전송 전 개인정보 마스킹을 돕는 확장 프로그램',
  },
});
