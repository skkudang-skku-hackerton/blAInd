import type { browser } from 'wxt/browser';

export const REVIEW_PORT_PREFIX = 'blaind:document-review:';
export const REVIEW_PAGE = 'document-review.html';
type Port = ReturnType<typeof browser.runtime.connect>;
type Runtime = Pick<typeof browser.runtime, 'id' | 'getURL' | 'onConnect'>;

/** Private extension transport: document contents never go through page postMessage. */
export function installReviewRelay(runtime: Runtime): () => void {
  const sessions = new Map<string, { host: Port; frame?: Port; close(): void }>();
  const connect = (port: Port) => {
    if (!port.name.startsWith(REVIEW_PORT_PREFIX)) return;
    const match = /^([a-f0-9-]{36}):(host|frame)$/.exec(port.name.slice(REVIEW_PORT_PREFIX.length));
    if (!match || port.sender?.id !== runtime.id) { port.disconnect(); return; }
    const [, id, role] = match;
    if (role === 'host') {
      if (sessions.has(id!) || (port.sender.frameId ?? 0) !== 0) { port.disconnect(); return; }
      const session = {
        host: port, frame: undefined as Port | undefined,
        close() {
          if (sessions.get(id!) !== session) return;
          sessions.delete(id!);
          port.disconnect();
          session.frame?.disconnect();
        },
      };
      sessions.set(id!, session);
      port.onDisconnect.addListener(session.close);
      port.onMessage.addListener(message => {
        if (message?.type === 'open') session.frame?.postMessage(message);
      });
    } else {
      const session = sessions.get(id!);
      if (!session || session.frame || port.sender.url !== `${runtime.getURL(`/${REVIEW_PAGE}`)}#${id}` ||
          port.sender.tab?.id !== session.host.sender?.tab?.id) { port.disconnect(); return; }
      session.frame = port;
      port.onDisconnect.addListener(session.close);
      port.onMessage.addListener(message => {
        if (message?.type === 'ready' || message?.type === 'decision' || message?.type === 'error') {
          session.host.postMessage(message);
        }
      });
    }
  };
  runtime.onConnect.addListener(connect);
  return () => {
    runtime.onConnect.removeListener(connect);
    for (const session of sessions.values()) session.close();
  };
}
