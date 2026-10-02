import type { Plugin } from 'vite';

/** Receives development extension decisions and prints them in the WXT terminal. */
export function mockAlertTerminalPlugin(): Plugin {
  return {
    name: 'blaind-mock-alert-terminal',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__blaind/mock-alert-result', (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405).end();
          return;
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > 65536) req.destroy();
        });
        req.on('end', () => {
          try {
            const result = JSON.parse(body) as { status?: string };
            if (!result || !['approved', 'cancelled'].includes(result.status ?? '')) {
              res.writeHead(400).end('Invalid review result');
              return;
            }
            console.log('\n[blAInd:mock-alert] 최종 선택 결과\n' + JSON.stringify(result, null, 2));
            res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
          } catch {
            res.writeHead(400).end('Invalid JSON');
          }
        });
      });
    },
  };
}
