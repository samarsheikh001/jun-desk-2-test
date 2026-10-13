// I-14: public/sw.js (plain JS) run in a fake service worker global: push → notification,
// click → focus a desk tab and route it, or open a new one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");

interface FakeClient { url: string; focused: boolean; frameType: string; messages: unknown[]; focusedNow: boolean; postMessage(m: unknown): void; focus(): Promise<FakeClient> }
const client = (url: string, focused = false, frameType = "top-level"): FakeClient => ({
  url,
  focused,
  frameType,
  messages: [],
  focusedNow: false,
  postMessage(m) {
    this.messages.push(m);
  },
  async focus() {
    this.focusedNow = true;
    return this;
  },
});

function load(windows: FakeClient[]) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: "https://desk.acme.test" },
    addEventListener: (type: string, fn: (event: unknown) => void) => (listeners[type] = fn),
    skipWaiting: () => {},
    registration: {
      async getNotifications({ tag }: { tag: string }) {
        return shown.filter((n) => n.options.tag === tag).map((n) => ({ data: n.options.data }));
      },
      async showNotification(title: string, options: Record<string, unknown>) {
        shown.push({ title, options });
      },
    },
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        opened.push(url);
      },
    },
  };
  vm.runInNewContext(source, { self, URL });
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    let work: Promise<unknown> = Promise.resolve();
    listeners[type]!({ ...event, waitUntil: (p: Promise<unknown>) => (work = p) });
    await work;
  };
  return { listeners, shown, opened, dispatch };
}

// Objects made inside the vm have its prototypes: compare as plain JSON.
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const pushEvent = (data: unknown) => ({ data: { json: () => data } });

test("no fetch handler: the service worker never intercepts requests", () => {
  const { listeners } = load([]);
  assert.deepEqual(Object.keys(listeners).sort(), ["activate", "install", "notificationclick", "push"]);
});

test("push shows the notification with the conversation as tag; the same event again replaces it silently", async () => {
  const sw = load([]);
  const payload = { id: "ntf_1", title: "Ana replied", body: "Is it fixed?", url: "/inbox/cv_1", tag: "cv_1" };
  await sw.dispatch("push", pushEvent(payload));
  assert.equal(sw.shown[0]!.title, "Ana replied");
  assert.deepEqual(plain(sw.shown[0]!.options), { body: "Is it fixed?", tag: "cv_1", renotify: true, data: { url: "/inbox/cv_1", id: "ntf_1" } });
  await sw.dispatch("push", pushEvent(payload));
  assert.equal(sw.shown[1]!.options.renotify, false, "a duplicate (in-page + push) doesn't alert twice");
  await sw.dispatch("push", pushEvent({ ...payload, id: "ntf_2" }));
  assert.equal(sw.shown[2]!.options.renotify, true, "a new event in the same chat alerts again");
  // Garbage still shows something (browsers require it) and never an off-site URL.
  await sw.dispatch("push", { data: { json: () => { throw new Error("bad"); } } });
  await sw.dispatch("push", pushEvent({ title: "x", url: "https://evil.test/" }));
  assert.equal(sw.shown[3]!.title, "Jun Desk");
  assert.equal((sw.shown[4]!.options.data as { url: string }).url, "/inbox");
});

test("click focuses the focused desk tab and routes it; ignores the widget frame; opens a tab if none", async () => {
  const widget = client("https://desk.acme.test/widget?key=k", true, "nested");
  const other = client("https://desk.acme.test/settings");
  const focused = client("https://desk.acme.test/inbox", true);
  const sw = load([widget, other, focused]);
  let closed = false;
  await sw.dispatch("notificationclick", { notification: { data: { url: "/inbox/cv_9" }, close: () => (closed = true) } });
  assert.ok(closed);
  assert.deepEqual(plain(focused.messages), [{ type: "jun:open", url: "/inbox/cv_9" }]);
  assert.ok(focused.focusedNow);
  assert.equal(widget.messages.length + other.messages.length, 0);
  assert.deepEqual(sw.opened, []);

  const onlyWidget = load([client("https://desk.acme.test/widget?key=k", false, "nested")]);
  await onlyWidget.dispatch("notificationclick", { notification: { data: { url: "/inbox/cv_9" }, close: () => {} } });
  assert.deepEqual(onlyWidget.opened, ["https://desk.acme.test/inbox/cv_9"]);

  const background = client("https://desk.acme.test/reports");
  const unfocused = load([background]);
  await unfocused.dispatch("notificationclick", { notification: { data: null, close: () => {} } });
  assert.deepEqual(plain(background.messages), [{ type: "jun:open", url: "/inbox" }]);
});
