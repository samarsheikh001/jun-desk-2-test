// I-14: browser side of notifications for agents. The service worker (public/sw.js) shows pushes
// and handles clicks; this file registers it, subscribes to push, and shows in-page notifications
// (the desk is open in a tab that isn't in front) through the same registration.

import type { NotificationPayload } from "../../shared/notifications.ts";
import { api } from "../api.ts";
import { navigate } from "./router.ts";

export type PushSupport = "ok" | "unsupported" | "ios-home-screen";

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

/** iPhone and iPad have Web Push only for a web app added to the Home Screen. */
export function pushSupport(): PushSupport {
  if (isIos() && !isStandalone()) return "ios-home-screen";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return "ok";
}

export const notificationPermission = (): NotificationPermission | "unsupported" => ("Notification" in window ? Notification.permission : "unsupported");

/** Visible and focused: you're looking at the desk, so in-app is enough (and the hub skips push). */
export const tabFocused = () => document.visibilityState === "visible" && document.hasFocus();

/** Registers public/sw.js (scope /). Idempotent. */
export async function deskServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  await navigator.serviceWorker.register("/sw.js");
  return navigator.serviceWorker.ready;
}

/** The service worker asks an open tab to show a conversation when a notification is clicked. */
export function listenForNotificationClicks(): () => void {
  if (!("serviceWorker" in navigator)) return () => {};
  const onMessage = (e: MessageEvent) => {
    const data = e.data as { type?: string; url?: string } | null;
    if (data?.type === "jun:open" && typeof data.url === "string" && data.url.startsWith("/")) navigate(data.url);
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  navigator.serviceWorker.startMessages();
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}

/**
 * A system notification from the open desk. Same tag (conversation) and id as the push of the
 * same event, so whichever comes second replaces the first without alerting again.
 */
export async function showInPageNotification(n: NotificationPayload): Promise<void> {
  if (notificationPermission() !== "granted") return;
  const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration("/") : undefined;
  if (registration) {
    const existing = await registration.getNotifications({ tag: n.tag });
    const repeat = existing.some((x) => (x.data as { id?: string } | null)?.id === n.id);
    // `renotify` isn't in TypeScript's DOM types any more; browsers still honour it.
    await registration.showNotification(n.title, { body: n.body, tag: n.tag, renotify: !repeat, data: { url: n.url, id: n.id } } as NotificationOptions);
    return;
  }
  const shown = new Notification(n.title, { body: n.body, tag: n.tag });
  shown.onclick = () => {
    window.focus();
    navigate(n.url);
    shown.close();
  };
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "="));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

const sameBytes = (a: ArrayBuffer | null, b: Uint8Array) => !!a && a.byteLength === b.length && new Uint8Array(a).every((v, i) => v === b[i]);

export interface Device {
  id: string;
  service: string;
  endpointHash: string;
  userAgent: string | null;
  createdAt: number;
  lastSuccessAt: number | null;
  failures: number;
}

/** This browser's push subscription, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "ok") return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** SHA-256 (base64url) of an endpoint, as the API reports devices. */
export async function endpointHash(endpoint: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Asks permission (needs a click), subscribes with the workspace's VAPID key and registers the device. */
export async function enablePush(workspaceId: string): Promise<Device> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "Notifications are blocked for this site." : "Notifications weren't allowed.");
  const registration = await deskServiceWorker();
  if (!registration) throw new Error("This browser can't run the desk's service worker.");
  const { publicKey } = await api<{ publicKey: string }>(`/workspaces/${workspaceId}/push/key`);
  const key = keyBytes(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  // Subscribed with another key (e.g. another desk on this origin): start over.
  if (subscription && !sameBytes(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const { device } = await api<{ device: Device }>(`/workspaces/${workspaceId}/push/subscriptions`, { body: subscription.toJSON() });
  return device;
}

/** "Chrome on Windows", from a user agent string. */
export function deviceName(userAgent: string | null): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}
