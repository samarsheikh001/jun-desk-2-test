import assert from "node:assert/strict";
import { test } from "node:test";
import { APPEARANCE_DEFAULTS, applyAppearance, logoFor, radiusVars, textOn, widgetLook } from "./appearance.ts";

test("appearance: an untouched desk gets the original look", () => {
  assert.deepEqual(widgetLook({}, "Acme", null), {
    workspaceName: "Acme",
    greeting: "Hi! How can we help?",
    color: "#2f5bea",
    position: "right",
    replyTime: "We usually reply in a few minutes",
    logoUrl: null,
    logoDarkUrl: null,
    theme: "auto",
    radius: 16,
    launcher: "card",
    placeholder: "Write a message…",
    suggestions: [],
    neon: true,
    islandSurface: "dark",
    buttonStyle: "logo",
    sound: true,
  });
  // The island's neon border is on unless turned off; anything but false keeps it.
  assert.equal(widgetLook({ neon: false }, "Acme", null).neon, false);
  assert.equal(widgetLook({ neon: "off" }, "Acme", null).neon, true);
  assert.deepEqual(radiusVars(APPEARANCE_DEFAULTS.radius), { "--r-md": "14px", "--r-sm": "8px" });
});

test("appearance: reading is lenient (half-typed drafts, hand-edited rows)", () => {
  const look = widgetLook({ color: "#12", radius: 99, theme: "neon", launcher: 3, greeting: "  ", suggestions: ["  ", "Pricing?", 7, "a", "b", "c"] }, "Acme", null);
  assert.equal(look.color, "#2f5bea");
  assert.equal(look.radius, 16);
  assert.equal(look.theme, "auto");
  assert.equal(look.launcher, "card");
  assert.equal(look.greeting, "Hi! How can we help?");
  assert.deepEqual(look.suggestions, ["Pricing?", "a", "b", "c"]);
  assert.equal(widgetLook({ radius: 0 }, "Acme", null).radius, 0);
});

test("appearance: writing is strict, and empty text clears a field", () => {
  const settings: Record<string, unknown> = { greeting: "Old" };
  applyAppearance(settings, { color: "#FF6600", theme: "dark", radius: 4, launcher: "card", greeting: " ", placeholder: " Ask   us ", suggestions: [" How much? ", ""] });
  assert.deepEqual(settings, { color: "#ff6600", theme: "dark", radius: 4, launcher: "card", placeholder: "Ask us", suggestions: ["How much?"] });
  applyAppearance(settings, { launcher: "bar" });
  assert.equal(settings.launcher, "bar");
  assert.equal(widgetLook(settings, "Acme", null).launcher, "bar");
  for (const body of [{ color: "blue" }, { position: "top" }, { theme: "neon" }, { launcher: "banner" }, { radius: 25 }, { radius: 2.5 }, { radius: "4" }, { placeholder: "x".repeat(61) }, { suggestions: "a" }, { suggestions: ["1", "2", "3", "4", "5"] }, { suggestions: ["x".repeat(81)] }]) {
    assert.throws(() => applyAppearance({}, body), Error, JSON.stringify(body));
  }
  applyAppearance(settings, { suggestions: [] });
  assert.equal(settings.suggestions, undefined);
});

test("appearance: readable text on the brand colour", () => {
  assert.equal(textOn("#2f5bea"), "#ffffff");
  assert.equal(textOn("#ffe066"), "#1c1c1a");
});

test("appearance: the button shows the logo unless set to text; only those two are accepted", () => {
  assert.equal(widgetLook({ buttonStyle: "text" }, "Acme", null).buttonStyle, "text");
  assert.equal(widgetLook({ buttonStyle: "emoji" }, "Acme", null).buttonStyle, "logo");
  const settings: Record<string, unknown> = {};
  applyAppearance(settings, { buttonStyle: "text" });
  assert.equal(settings.buttonStyle, "text");
  assert.throws(() => applyAppearance(settings, { buttonStyle: "big" }), /logo or text/);
});

test("appearance: the reply sound (W-20) is on unless turned off; only true or false is accepted", () => {
  assert.equal(APPEARANCE_DEFAULTS.sound, true);
  assert.equal(widgetLook({ sound: false }, "Acme", null).sound, false);
  assert.equal(widgetLook({ sound: "off" }, "Acme", null).sound, true);
  assert.equal(widgetLook({ sound: 0 }, "Acme", null).sound, true);
  const settings: Record<string, unknown> = {};
  applyAppearance(settings, { sound: false });
  assert.equal(settings.sound, false);
  applyAppearance(settings, { sound: true });
  assert.equal(settings.sound, true);
  for (const sound of ["off", 0, null, "true"]) {
    assert.throws(() => applyAppearance(settings, { sound }), /Sound must be true or false\./);
  }
  assert.equal(settings.sound, true);
});

test("appearance: the island is dark unless set to follow the page; only dark and page are accepted", () => {
  assert.equal(APPEARANCE_DEFAULTS.islandSurface, "dark");
  assert.equal(widgetLook({ islandSurface: "page" }, "Acme", null).islandSurface, "page");
  assert.equal(widgetLook({ islandSurface: "dark" }, "Acme", null).islandSurface, "dark");
  assert.equal(widgetLook({ islandSurface: "light" }, "Acme", null).islandSurface, "dark");
  assert.equal(widgetLook({ islandSurface: 1 }, "Acme", null).islandSurface, "dark");
  const settings: Record<string, unknown> = {};
  applyAppearance(settings, { islandSurface: "page" });
  assert.equal(settings.islandSurface, "page");
  applyAppearance(settings, { islandSurface: "dark" });
  assert.equal(settings.islandSurface, "dark");
  for (const islandSurface of ["light", "", null, true]) {
    assert.throws(() => applyAppearance(settings, { islandSurface }), /Island surface must be dark or page\./);
  }
  assert.equal(settings.islandSurface, "dark");
});

test("appearance: the dark-background logo (W-21) is used only on dark surfaces, else the main logo", () => {
  const both = widgetLook({}, "Acme", "/logo", "/logo-dark");
  assert.equal(both.logoDarkUrl, "/logo-dark");
  assert.equal(logoFor(both, true), "/logo-dark");
  assert.equal(logoFor(both, false), "/logo");
  // No dark logo: the main one everywhere.
  const main = widgetLook({}, "Acme", "/logo");
  assert.equal(main.logoDarkUrl, null);
  assert.equal(logoFor(main, true), "/logo");
  // Only a dark logo: on dark surfaces only (light ones show the Jun mark).
  const dark = widgetLook({}, "Acme", null, "/logo-dark");
  assert.equal(logoFor(dark, true), "/logo-dark");
  assert.equal(logoFor(dark, false), null);
  assert.equal(logoFor(widgetLook({}, "Acme", null), true), null);
});
