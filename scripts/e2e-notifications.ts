// End-to-end test of I-14 notifications for agents against a running dev server: the prefs and
// device APIs, and real Web Push sends to a mock push service in this process (workerd can fetch
// another local port). Every push is checked like a browser would: VAPID signature, then
// aes128gcm decryption with the subscriber keys generated here. No AI turns. Run after e2e-topics.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { base64UrlDecode, base64UrlEncode } from "../worker/lib/crypto.ts";
import { decryptPayload, verifyVapidAuthorization, type KeyPair } from "../worker/lib/webpush.ts";
import { BASE, Client, cookieHeader, ORIGIN, SETUP_TOKEN, SoftAuthenticator, step, summary, TestSocket } from "./e2e-lib.ts";

const owner = new Client();
const teammate = new Client();
const run = Date.now().toString(36);
const teammateName = `Mia ${run}`;
let ownerName = "";
let workspaceId = "";
let widgetKey = "";
let ownerId = "";
let teammateId = "";
let vapidKey = "";
let aiSettings: Record<string, unknown> = {};
let inboxSettings: Record<string, unknown> = {};

// ---------- a mock push service ----------
interface Received { path: string; headers: IncomingMessage["headers"]; body: Uint8Array; status: number }
const received: Received[] = [];
const statusFor = new Map<string, number>();
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const status = statusFor.get(req.url ?? "") ?? 201;
    received.push({ path: req.url ?? "", headers: req.headers, body: new Uint8Array(Buffer.concat(chunks)), status });
    res.writeHead(status).end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const pushOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

interface Device { id: string; path: string; keys: KeyPair; auth: Uint8Array }
interface Payload { id: string; kind: string; title: string; body: string; url: string; tag: string }

/** A browser's push subscription: fresh P-256 keys and auth secret, endpoint on the mock service. */
async function subscribe(client: Client, name: string): Promise<Device & { json: Record<string, any> }> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as unknown as KeyPair;
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const path = `/push/${name}-${run}`;
  const res = await client.call(`/workspaces/${workspaceId}/push/subscriptions`, {
    body: { endpoint: `${pushOrigin}${path}`, keys: { p256dh: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))), auth: base64UrlEncode(auth) } },
    headers: { "User-Agent": `Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 e2e-${name}` },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { id: res.json.device.id, path, keys, auth, json: res.json };
}

/** Pushes a device got, verified and decrypted. */
async function pushes(device: Device): Promise<(Payload & { req: Received })[]> {
  const out = [];
  for (const req of received.filter((r) => r.path === device.path)) {
    const claims = await verifyVapidAuthorization(String(req.headers.authorization), vapidKey);
    assert.equal(claims.aud, pushOrigin);
    assert.equal(claims.sub, ORIGIN);
    assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);
    const plain = await decryptPayload(req.body, device.keys, device.auth);
    out.push({ ...(JSON.parse(new TextDecoder().decode(plain)) as Payload), req });
  }
  return out;
}

async function expectPush(device: Device, match: (p: Payload) => boolean, what: string): Promise<Payload & { req: Received }> {
  for (let i = 0; i < 60; i++) {
    const found = (await pushes(device)).find(match);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No push to ${device.path}: ${what}`);
}

async function expectNoPush(device: Device, match: (p: Payload) => boolean, what: string, ms = 2000): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  const found = (await pushes(device)).find(match);
  assert.equal(found, undefined, `Unexpected push to ${device.path}: ${what}`);
}

const about = (conversationId: string, kind?: string) => (p: Payload) => p.url === `/inbox/${conversationId}` && (!kind || p.kind === kind);

// ---------- the desk ----------
const visitors = new Map<string, { client: Client; token: string }>();
async function newChat(body: string): Promise<string> {
  const visitor = new Client();
  const token = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token;
  const res = await visitor.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body }, headers: { "X-Visitor-Token": token } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  visitors.set(res.json.conversation.id, { client: visitor, token });
  return res.json.conversation.id;
}
async function visitorSays(conversationId: string, body: string): Promise<void> {
  const v = visitors.get(conversationId)!;
  const res = await v.client.call(`/widget/${widgetKey}/conversations/${conversationId}/messages`, { body: { clientMsgId: crypto.randomUUID(), body }, headers: { "X-Visitor-Token": v.token } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
}
const note = (client: Client, conversationId: string, body: string) => client.call(`/conversations/${conversationId}/messages`, { body: { body, internal: true, clientMsgId: crypto.randomUUID() } });
const setAssignment = (assignment: unknown) => owner.call(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { assignment } });
const setAi = (enabled: boolean) => owner.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { ...aiSettings, enabled } });
const prefs = (client: Client, body: unknown) => client.call(`/workspaces/${workspaceId}/notifications`, { method: "PUT", body });
const devicesOf = async (client: Client) => (await client.call(`/workspaces/${workspaceId}/push/subscriptions`)).json.devices as { id: string; failures: number; endpointHash: string }[];
const hub = async (client: Client, focused?: boolean) => {
  const socket = new TestSocket(`/api/workspaces/${workspaceId}/ws`, { headers: { Cookie: cookieHeader(client) } });
  await socket.opened;
  await socket.next((e) => e.type === "presence");
  if (focused !== undefined) socket.send({ type: "focus", focused });
  return socket;
};

let ownerDevice: Device;
let teammateDevice: Device;

await step("owner signs in; a teammate joins; AI off, manual assignment", async () => {
  assert.equal((await owner.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  const me = (await owner.call("/me")).json;
  workspaceId = me.memberships[0].workspaceId;
  ownerId = me.user.id;
  ownerName = me.user.name;
  const inbox = (await owner.call(`/workspaces/${workspaceId}/inbox`)).json.inbox;
  widgetKey = inbox.widgetKey;
  inboxSettings = inbox.settings;
  aiSettings = (await owner.call(`/workspaces/${workspaceId}/ai`)).json.settings;
  const invite = await owner.call(`/workspaces/${workspaceId}/invites`, { body: { role: "agent" } });
  const token = new URL(invite.json.url).pathname.split("/").pop()!;
  assert.equal((await teammate.register(`/invites/${token}`, new SoftAuthenticator(), { name: teammateName, email: `mia-${run}@acme.test` })).status, 200);
  teammateId = (await teammate.call("/me")).json.user.id;
  assert.equal((await setAi(false)).status, 200);
  assert.equal((await setAssignment({ mode: "manual", capacity: 0 })).status, 200);
});

try {
  await step("prefs: all on by default, per person, partial updates, validated", async () => {
    assert.equal((await new Client().call(`/workspaces/${workspaceId}/notifications`)).status, 401);
    const initial = await owner.call(`/workspaces/${workspaceId}/notifications`);
    assert.deepEqual(initial.json.prefs, { needsPerson: true, assigned: true, visitorReply: true, mention: true, sound: true });
    const saved = await prefs(owner, { mention: false });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.prefs, { needsPerson: true, assigned: true, visitorReply: true, mention: false, sound: true });
    assert.equal((await teammate.call(`/workspaces/${workspaceId}/notifications`)).json.prefs.mention, true, "the teammate's own settings");
    for (const bad of [{ volume: 1 }, { sound: "on" }, { mention: "off" }, [true]]) assert.equal((await prefs(owner, bad)).status, 400, JSON.stringify(bad));
    assert.equal((await prefs(owner, { mention: true })).json.prefs.mention, true);
  });

  await step("devices: VAPID key, register (validated), list your own only, no keys returned, remove", async () => {
    const key = await owner.call(`/workspaces/${workspaceId}/push/key`);
    assert.equal(key.status, 200);
    vapidKey = key.json.publicKey;
    assert.equal(base64UrlDecode(vapidKey).length, 65);
    assert.equal((await teammate.call(`/workspaces/${workspaceId}/push/key`)).json.publicKey, vapidKey, "one key per workspace, kept");
    assert.equal((await new Client().call(`/workspaces/${workspaceId}/push/key`)).status, 401);

    const p256dh = base64UrlEncode(new Uint8Array([4, ...new Uint8Array(64).fill(7)]));
    const auth = base64UrlEncode(new Uint8Array(16));
    for (const body of [
      { endpoint: "ftp://push.example/x", keys: { p256dh, auth } },
      { endpoint: "http://push.example.com/x", keys: { p256dh, auth } },
      { endpoint: `${pushOrigin}/x`, keys: { p256dh: base64UrlEncode(new Uint8Array(33)), auth } },
      { endpoint: `${pushOrigin}/x`, keys: { p256dh, auth: base64UrlEncode(new Uint8Array(15)) } },
      { endpoint: `${pushOrigin}/x` },
      { keys: { p256dh, auth } },
    ]) {
      assert.equal((await owner.call(`/workspaces/${workspaceId}/push/subscriptions`, { body })).status, 400, JSON.stringify(body));
    }

    ownerDevice = await subscribe(owner, "owner");
    teammateDevice = await subscribe(teammate, "mia");
    const again = await subscribe(owner, "owner");
    assert.equal(again.id, ownerDevice.id, "the same endpoint again updates the device");
    ownerDevice = again;
    assert.deepEqual(Object.keys(again.json.device).sort(), ["createdAt", "endpointHash", "failures", "id", "lastSuccessAt", "service", "userAgent"]);
    assert.ok(!JSON.stringify(again.json).includes(ownerDevice.path), "the endpoint isn't echoed");

    const extra = await subscribe(owner, "owner-laptop");
    const mine = await devicesOf(owner);
    assert.deepEqual(mine.map((d) => d.id).sort(), [ownerDevice.id, extra.id].sort());
    assert.deepEqual((await devicesOf(teammate)).map((d) => d.id), [teammateDevice.id]);
    assert.equal((await teammate.call(`/workspaces/${workspaceId}/push/subscriptions/${extra.id}`, { method: "DELETE" })).status, 404, "not yours");
    assert.equal((await teammate.call(`/workspaces/${workspaceId}/push/test`, { body: { subscriptionId: ownerDevice.id } })).status, 404, "not yours");
    assert.equal((await owner.call(`/workspaces/${workspaceId}/push/subscriptions/${extra.id}`, { method: "DELETE" })).status, 200);
    assert.deepEqual((await devicesOf(owner)).map((d) => d.id), [ownerDevice.id]);
  });

  await step("test notification: a real push, VAPID-signed, TTL 24 h, urgency high, aes128gcm", async () => {
    const res = await owner.call(`/workspaces/${workspaceId}/push/test`, { body: { subscriptionId: ownerDevice.id } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const push = await expectPush(ownerDevice, (p) => p.kind === "test", "test");
    assert.equal(push.url, "/settings");
    assert.equal(push.req.headers["content-encoding"], "aes128gcm");
    assert.equal(push.req.headers.ttl, "86400");
    assert.equal(push.req.headers.urgency, "high");
    assert.match(String(push.req.headers.topic), /^[\w-]{32}$/);
    const device = (await devicesOf(owner)).find((d) => d.id === ownerDevice.id)!;
    assert.equal(device.failures, 0);
  });

  let assignedChat = "";
  await step("needs a person (AI off, unassigned): both teammates get a push with the visitor's words", async () => {
    const id = await newChat(`My invoices page is blank (${run})`);
    for (const device of [ownerDevice, teammateDevice]) {
      const push = await expectPush(device, about(id, "needs_person"), "needs a person");
      assert.match(push.title, /^Visitor #\d{4} needs a person$/);
      assert.equal(push.body, `My invoices page is blank (${run})`);
      assert.equal(push.tag, id);
    }
    assignedChat = id;
  });

  await step("an AI handoff (\"talk to a person\") notifies too", async () => {
    assert.equal((await setAi(true)).status, 200);
    try {
      const id = await newChat("Can I talk to a person please?");
      await expectPush(teammateDevice, about(id, "needs_person"), "handoff");
      await expectPush(ownerDevice, about(id, "needs_person"), "handoff");
    } finally {
      await setAi(false);
    }
  });

  await step("assigned by a teammate: only the assignee; assigning yourself notifies nobody", async () => {
    assert.equal((await owner.call(`/conversations/${assignedChat}`, { method: "PATCH", body: { assigneeId: teammateId } })).status, 200);
    const push = await expectPush(teammateDevice, about(assignedChat, "assigned"), "assigned");
    assert.ok(push.title.startsWith(`${ownerName} assigned you Visitor #`), push.title);
    // The same assignee again is not news.
    assert.equal((await owner.call(`/conversations/${assignedChat}`, { method: "PATCH", body: { assigneeId: teammateId } })).status, 200);
    const self = await newChat("Second question");
    await expectPush(ownerDevice, about(self, "needs_person"), "new chat");
    assert.equal((await owner.call(`/conversations/${self}`, { method: "PATCH", body: { assigneeId: ownerId } })).status, 200);
    await expectNoPush(ownerDevice, about(self, "assigned"), "self-assignment");
    await expectNoPush(ownerDevice, about(assignedChat, "assigned"), "not the assigner", 0);
    assert.equal((await pushes(teammateDevice)).filter(about(assignedChat, "assigned")).length, 1, "no repeat for the same assignee");
  });

  await step("visitor replies in an assigned chat: the assignee, with the visitor's text and never note text", async () => {
    assert.equal((await note(teammate, assignedChat, `Internal: card ends 4242, SECRET-${run}`)).status, 200);
    await visitorSays(assignedChat, `Still blank after reload (${run})`);
    const push = await expectPush(teammateDevice, about(assignedChat, "visitor_reply"), "visitor reply");
    assert.match(push.title, /^Visitor #\d{4} replied$/);
    assert.equal(push.body, `Still blank after reload (${run})`);
    assert.equal(push.url, `/inbox/${assignedChat}`);
    for (const device of [ownerDevice, teammateDevice]) {
      for (const p of await pushes(device)) assert.ok(!JSON.stringify(p).includes("SECRET"), "internal text never in a non-mention push");
    }
    await expectNoPush(ownerDevice, about(assignedChat, "visitor_reply"), "not assigned to the owner", 0);
  });

  await step("@mention in a note: the mentioned teammate gets the note; the author doesn't", async () => {
    assert.equal((await note(teammate, assignedChat, `NOTE-${run} @${ownerName} can you check the invoice job?`)).status, 200);
    const push = await expectPush(ownerDevice, about(assignedChat, "mention"), "mention");
    assert.ok(push.title.startsWith(`${teammateName} mentioned you (Visitor #`), push.title);
    assert.ok(push.body.includes(`NOTE-${run}`));
    await expectNoPush(teammateDevice, about(assignedChat, "mention"), "the author");
  });

  await step("a focused desk tab gets it in-app instead of a push; an unfocused one gets both", async () => {
    const ownerHub = await hub(owner, true);
    const teammateHub = await hub(teammate);
    try {
      await new Promise((r) => setTimeout(r, 300)); // the focus message lands first
      const id = await newChat("Focused test");
      const ownerEvent = await ownerHub.next((e) => e.type === "notify" && e.notification.url === `/inbox/${id}`);
      assert.equal(ownerEvent.mode, "toast");
      assert.equal(ownerEvent.sound, true, "the desk chimes unless the person turned sound off");
      const teammateEvent = await teammateHub.next((e) => e.type === "notify" && e.notification.url === `/inbox/${id}`);
      assert.equal(teammateEvent.mode, "system");
      const push = await expectPush(teammateDevice, about(id, "needs_person"), "unfocused teammate");
      assert.equal(push.id, teammateEvent.notification.id, "same id: the in-page copy and the push collapse");
      await expectNoPush(ownerDevice, about(id), "owner is looking at the desk");
    } finally {
      ownerHub.close();
      teammateHub.close();
    }
  });

  await step("round robin: only the assignee is notified (\"New chat assigned to you\")", async () => {
    assert.equal((await setAssignment({ mode: "round_robin", capacity: 0 })).status, 200);
    const teammateHub = await hub(teammate);
    try {
      const id = await newChat("Round robin please");
      const push = await expectPush(teammateDevice, about(id, "assigned"), "auto-assigned");
      assert.match(push.title, /^New chat assigned to you: Visitor #\d{4}$/);
      await expectNoPush(ownerDevice, about(id), "someone else has it");
      await expectNoPush(teammateDevice, about(id, "needs_person"), "one notification, not two", 0);
    } finally {
      teammateHub.close();
      assert.equal((await setAssignment({ mode: "manual", capacity: 0 })).status, 200);
    }
  });

  await step("prefs off: nothing for that person", async () => {
    assert.equal((await prefs(owner, { needsPerson: false, assigned: false, visitorReply: false, mention: false })).status, 200);
    try {
      const id = await newChat("Anyone?");
      await expectPush(teammateDevice, about(id, "needs_person"), "teammate still on");
      await expectNoPush(ownerDevice, about(id), "owner turned it off", 500);
      assert.equal((await note(teammate, id, `@${ownerName} ping`)).status, 200);
      await expectNoPush(ownerDevice, about(id, "mention"), "mentions off");
    } finally {
      await prefs(owner, { needsPerson: true, assigned: true, visitorReply: true, mention: true });
    }
  });

  await step("push service says 410: the device is forgotten; other errors are counted", async () => {
    statusFor.set(ownerDevice.path, 410);
    statusFor.set(teammateDevice.path, 500);
    const id = await newChat("Gone?");
    await expectPush(ownerDevice, about(id), "410 attempt");
    await expectPush(teammateDevice, about(id), "500 attempt");
    let owners: { id: string }[] = [];
    let mia: { failures: number }[] = [];
    for (let i = 0; i < 20; i++) {
      owners = await devicesOf(owner);
      mia = await devicesOf(teammate);
      if (owners.length === 0 && mia[0]?.failures === 1) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.deepEqual(owners, [], "410 deletes the subscription");
    assert.equal(mia[0]?.failures, 1);
    statusFor.delete(teammateDevice.path);
    assert.equal((await teammate.call(`/workspaces/${workspaceId}/push/test`, { body: { subscriptionId: teammateDevice.id } })).status, 200);
    assert.equal((await devicesOf(teammate))[0]?.failures, 0, "a success resets the count");
  });
} finally {
  for (const c of [owner, teammate]) for (const d of await devicesOf(c).catch(() => [])) await c.call(`/workspaces/${workspaceId}/push/subscriptions/${d.id}`, { method: "DELETE" });
  await owner.call(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { assignment: inboxSettings.assignment ?? { mode: "manual", capacity: 0 } } });
  await owner.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: aiSettings });
  server.close();
}

console.log(`(desk ${BASE}, mock push service ${pushOrigin})`);
summary();
