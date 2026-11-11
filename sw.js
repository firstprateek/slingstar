// Service worker. PHASE 0 STUB — stream D implements precache; tools/build-precache.mjs rewrites
// the VERSION and FILES lines below.
const VERSION = 'dev';
const FILES = [];
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
