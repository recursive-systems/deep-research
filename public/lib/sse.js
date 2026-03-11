export function createSSE(url = '/api/events') {
  const source = new EventSource(url);
  const listeners = [];

  return {
    on(eventType, handler) {
      const wrapper = (e) => {
        try {
          handler(JSON.parse(e.data));
        } catch (err) {
          console.error('SSE parse error:', err);
        }
      };
      source.addEventListener(eventType, wrapper);
      listeners.push({ eventType, wrapper });
    },

    onStatusChange(handler) {
      source.addEventListener('open', () => handler(true));
      source.addEventListener('error', () =>
        handler(
          source.readyState === EventSource.CLOSED ? false : source.readyState !== EventSource.OPEN
        )
      );
    },

    get connected() {
      return source.readyState === EventSource.OPEN;
    },

    close() {
      source.close();
    },
  };
}
