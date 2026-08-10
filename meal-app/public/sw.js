self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("push", event => {
  if (!event.data) return;
  let data;
  try { data = event.data.json(); } catch { data = { title: "오늘의 식단", body: event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || "오늘의 식단", {
    body: data.body || "",
    tag: data.tag,
    data: data.data || { url: "./" },
    icon: "./icon.svg",
    badge: "./icon.svg"
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async clients => {
    for (const client of clients) {
      if ("navigate" in client) await client.navigate(target);
      if ("focus" in client) return client.focus();
    }
    return self.clients.openWindow(target);
  }));
});
