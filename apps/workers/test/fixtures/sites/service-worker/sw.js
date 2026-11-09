// Must never run: the crawler's browser context uses serviceWorkers: 'block'
// (AAP 0.5.6) and fulfils every request through safe-fetch, so this worker can
// neither register nor fetch of its own accord. It exists so that a regression
// in that blocking is observable: the fetches below must never reach the network.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('fetch', (event) => {
  event.waitUntil(
    Promise.allSettled([
      fetch('http://169.254.169.254/latest/meta-data/'),
      fetch('http://10.0.0.1/internal'),
    ]),
  );
});
