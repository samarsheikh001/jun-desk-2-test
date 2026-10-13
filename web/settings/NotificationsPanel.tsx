import { useCallback, useEffect, useState } from "react";
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from "../../shared/notifications.ts";
import { api, describeError } from "../api.ts";
import { currentSubscription, deviceName, enablePush, endpointHash, notificationPermission, pushSupport, type Device } from "../lib/notifications.ts";
import { useAction } from "../useAction.ts";
import { Button } from "@/components/ui/button.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { SettingRow, SettingsCard } from "./layout.tsx";
import { previewChime } from "../lib/sound.ts";

const TRIGGERS: { key: keyof NotificationPrefs; label: string; hint: string }[] = [
  { key: "needsPerson", label: "A chat needs a person", hint: "Handed to the team and nobody has it yet (or round robin gave it to you)." },
  { key: "assigned", label: "A chat is assigned to you", hint: "By round robin or by a teammate." },
  { key: "visitorReply", label: "A customer replies in your chat", hint: "Chats assigned to you." },
  { key: "mention", label: "Someone @mentions you in a note", hint: "" },
];

const day = (ms: number) => new Date(ms).toLocaleDateString();

/** I-14: your notifications. Per person: which events, and which of your devices get them. */
export function NotificationsPanel({ workspaceId }: { workspaceId: string }) {
  const base = `/workspaces/${workspaceId}`;
  const support = pushSupport();
  const [permission, setPermission] = useState(notificationPermission);
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [thisDevice, setThisDevice] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();

  const load = useCallback(async () => {
    const [list, subscription] = await Promise.all([api<{ devices: Device[] }>(`${base}/push/subscriptions`), currentSubscription().catch(() => null)]);
    setDevices(list.devices);
    const hash = subscription ? await endpointHash(subscription.endpoint) : null;
    setThisDevice(list.devices.find((d) => d.endpointHash === hash)?.id ?? null);
  }, [base]);
  useEffect(() => {
    api<{ prefs: NotificationPrefs }>(`${base}/notifications`).then((r) => setPrefs(r.prefs), () => setPrefs(DEFAULT_NOTIFICATION_PREFS));
    load().catch(() => {});
  }, [base, load]);

  const toggle = (key: keyof NotificationPrefs, value: boolean) =>
    run(async () => {
      setPrefs((p) => p && { ...p, [key]: value });
      setPrefs((await api<{ prefs: NotificationPrefs }>(`${base}/notifications`, { method: "PUT", body: { [key]: value } })).prefs);
    });

  const turnOn = () =>
    run(async () => {
      setSent(false);
      try {
        const device = await enablePush(workspaceId);
        setThisDevice(device.id);
      } catch (e) {
        setPermission(notificationPermission());
        // Permission granted but no push service (some browsers, headless ones): the open desk still notifies.
        if (notificationPermission() === "granted") throw new Error(`This browser couldn't subscribe to push (${describeError(e)}). You'll still get notifications while the desk is open in a tab.`);
        throw e;
      }
      setPermission(notificationPermission());
      await load();
    });

  const remove = (device: Device) =>
    run(async () => {
      if (device.id === thisDevice) await (await currentSubscription())?.unsubscribe();
      await api(`${base}/push/subscriptions/${device.id}`, { method: "DELETE" });
      await load();
    });

  const test = () =>
    run(async () => {
      setSent(false);
      await api(`${base}/push/test`, { body: { subscriptionId: thisDevice } });
      setSent(true);
    });

  const current = devices.find((d) => d.id === thisDevice);
  return (
    <>
    <SettingsCard
      title="This device"
      id="notifications"
      description="Get a notification when a chat needs you. With the desk open in a tab you're not looking at, the tab shows it; with the desk closed, your devices get a push. Nothing is sent while you're looking at the desk."
    >
      <div className="notify-device">
        {support === "ios-home-screen" ? (
          <p className="small">On iPhone and iPad, notifications work only in the desk added to your Home Screen: tap Share, then <strong>Add to Home Screen</strong>, open Jun Desk from there and turn them on.</p>
        ) : support === "unsupported" ? (
          <p className="small">This browser can't show notifications. Try a current Chrome, Edge, Firefox or Safari.</p>
        ) : permission === "denied" ? (
          <p className="small error">Notifications are blocked for this site. Allow them in your browser's site settings (the icon next to the address bar), then reload this page.</p>
        ) : current ? (
          <div className="row wrap">
            <span className="small"><span className="ok-text">●</span> On for this device ({deviceName(current.userAgent)})</span>
            <span className="spacer" />
            <Button size="sm" disabled={busy} onClick={test}>Send a test notification</Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => remove(current)}>Turn off on this device</Button>
          </div>
        ) : (
          <div className="row wrap">
            <Button disabled={busy} onClick={turnOn}>Turn on notifications on this device</Button>
            <span className="muted small">Your browser will ask for permission.</span>
          </div>
        )}
        {sent && <p className="small ok-text">Sent. It should appear in a few seconds.</p>}
        {error && <p className="small error">{error}</p>}
      </div>
    </SettingsCard>

    <SettingsCard title="Notify me when" description="Your own choices: teammates pick theirs.">
      {TRIGGERS.map((t) => (
        <SettingRow key={t.key} label={t.label} description={t.hint || undefined}>
          <Switch checked={prefs?.[t.key] ?? true} disabled={!prefs || busy} onCheckedChange={(value) => toggle(t.key, value)} aria-label={t.label} />
        </SettingRow>
      ))}
      <SettingRow label="Play a sound" description="A soft chime in the open desk for the events above, not while you're looking at that conversation.">
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={previewChime}>Test sound</Button>
          <Switch checked={prefs?.sound ?? true} disabled={!prefs || busy} onCheckedChange={(value) => toggle("sound", value)} aria-label="Play a sound" />
        </div>
      </SettingRow>
    </SettingsCard>

      {devices.length > 0 && (
        <SettingsCard title="Your devices" description="Browsers and phones that get your push notifications.">
          <ul className="list">
            {devices.map((d) => (
              <li key={d.id}>
                <span>
                  {deviceName(d.userAgent)}
                  {d.id === thisDevice && <em className="tag">this device</em>}
                </span>
                <span className="muted small">
                  added {day(d.createdAt)} · {d.lastSuccessAt ? `last delivered ${day(d.lastSuccessAt)}` : "nothing delivered yet"}
                  {d.failures > 0 && ` · ${d.failures} failed`}
                </span>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => remove(d)}>Remove</Button>
              </li>
            ))}
          </ul>
        </SettingsCard>
      )}
    </>
  );
}
