const CACHE_PREFIX = "murk-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v36`;
const APP_SHELL = [
  "./",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
  "audio/music/creepy-music-1.wav",
  "audio/camera/picture-taken.wav",
  "audio/floodlight/floodlight-on.wav",
  "audio/floodlight/floodlight-off.wav",
  "audio/floodlight/floodlight-burnout.wav",
  "audio/floodlight/floodlight-active.wav",
  "audio/creature/far-aggro-1.wav",
  "audio/creature/far-aggro-2.wav",
  "audio/creature/favorite-non-aggro.wav",
  "audio/creature/mid-aggro.wav",
  "audio/creature/attack.wav",
  "audio/creature/random-2.wav",
  "audio/creature/aggro-engaged.wav",
  "audio/creature/random-1.wav",
  "textures/creature/plesiosaur-hide.png",
  "textures/fish/fish-scales-minnow.png",
  "textures/fish/fish-scales-bream.png",
  "textures/fish/fish-scales-pike.png",
  "textures/fish/fish-scales-coelacanth.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL.map((path) => new URL(path, self.registration.scope))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(new URL("./", self.registration.scope), copy));
          return response;
        })
        .catch(() => caches.match(new URL("./", self.registration.scope)))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
