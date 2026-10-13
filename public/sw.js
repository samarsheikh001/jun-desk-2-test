/*! Jun Desk service worker | AGPL-3.0 | I-14 notifications for agents.
 * Shows Web Push notifications and opens the right conversation when one is clicked.
 * It has no fetch handler on purpose: it never intercepts or caches requests. */
"use strict";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/**
 * Shows one notification per conversation (tag). The same event can arrive twice, from the open
 * desk tab and as a push: then the second replaces the first silently instead of alerting again.
 */
async function showDeskNotification(data) {
  const tag = typeof data.tag === "string" && data.tag ? data.tag : "jun";
  const existing = await self.registration.getNotifications({ tag });
  const repeat = existing.some((n) => n.data && n.data.id === data.id);
  await self.registration.showNotification(typeof data.title === "string" && data.title ? data.title : "Jun Desk", {
    body: typeof data.body === "string" ? data.body : "",
    tag,
    renotify: !repeat,
    data: { url: typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/inbox", id: data.id || null },
  });
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // An unreadable message still gets a notification (browsers require one per push).
  }
  event.waitUntil(showDeskNotification(data || {}));
});

/** Focus a desk tab and have it open the conversation (no reload); open a new tab if there is none. */
async function openDesk(path) {
  const url = new URL(path || "/inbox", self.location.origin).href;
  // Desk tabs only: the chat widget's frame (/widget) and the demo page share this origin.
  const windows = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter((c) => {
    const p = new URL(c.url).pathname;
    return c.frameType !== "nested" && !p.startsWith("/widget") && p !== "/demo.html";
  });
  const desk = windows.find((c) => c.focused) || windows[0];
  if (desk) {
    desk.postMessage({ type: "jun:open", url: new URL(url).pathname });
    return desk.focus();
  }
  return self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openDesk(event.notification.data && event.notification.data.url));
});
