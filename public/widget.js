/*! Jun Desk widget loader | MIT License
 * Usage: <script src="https://<your-desk>/widget.js" data-key="wk_..." defer></script>
 *   in <head>, before the site's own scripts: deferred scripts run in document order, so
 *   document.modelContext (below) exists before page code that checks for it once on load.
 * Put it in <head> so it can see errors from the start of the page.
 * Shows a chat button; the chat itself (an iframe from the desk) loads on first open.
 * Captures recent JS errors, failed requests, page navigation, rage clicks (S-02) and "stuck on
 * a page after an error" (S-13) in memory only, masked, and shares them with support only when
 * the visitor sends a message. data-capture="off" disables capture. Shows the visitor on the
 * desk's live visitor list (data-consent="required"
 * waits for JunDesk.consent(true) and stores nothing before it).
 * API: window.JunDesk.open() / .close() / .toggle() / .identify(jwt) / .logout() / .consent(bool) / .registerAction(tool)
 * Card actions with ChatKit's handler: "client" (D-51) come to the page, never to the server:
 *   JunDesk.onWidgetAction(function (a) { a.type; a.payload; a.values; a.widget; }) (returns a remover),
 *   or the "jundesk:widget-action" window event (same object as event.detail).
 *      / .reportError({ message, code? }). With the island launcher, "/" on the page opens it.
 * identify() takes a JWT your backend signs with the desk's identity secret (data-user-token works too).
 * reportError() tells support what failed in your app's own words ("Row 42: missing email"); masked
 * like everything else and kept in memory with the errors above.
 * Intents (AI-20): JunDesk.open({ intent: "cancel", onExit: function () { location.href = "/billing/cancel"; } })
 * opens a chat for a purpose. A skill in your agent config defines the intent (skills/<name>/SKILL.md
 * frontmatter: intent, opening, replies, exit): the chat starts with its opening line and quick
 * replies, and the AI follows that skill. If it has an exit ("Cancel anyway"), that button stays
 * visible for the whole chat; one click closes the chat and calls onExit(), where your app goes on
 * (e.g. to its own cancel screen). An intent with an exit but no onExit function opens a plain chat
 * instead (with a console warning): the flow never starts without a way out. Names: [a-z0-9_-], max 40
 * (anything else opens a plain chat).
 */
(function () {
  var script = document.currentScript;
  if (!script || window.JunDesk) return;
  var key = script.getAttribute("data-key");
  if (!key) return console.warn("Jun Desk: no data-key");
  var origin = new URL(script.src).origin;
  var color = script.getAttribute("data-color"); // overrides the desk's branding colour

  // ---------- debug capture (P1). Same masking rules as shared/debug.ts. ----------
  var events = [];
  var capture = script.getAttribute("data-capture") != "off";
  // S-13 state for the current page (path). Tests on localhost can shorten the 3 minutes with ?jun_stuck_ms=.
  var pagePath = location.pathname, pageIssue, seen = 0, stuckSent, stuckMs = 180000;
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) stuckMs = +(/[?&]jun_stuck_ms=(\d+)/.exec(location.search) || [])[1] || stuckMs;
  var nativeFetch = window.fetch;

  function redact(s, max) {
    max = max || 500;
    return String(s == null ? "" : s).slice(0, max * 2)
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
      .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[token]")
      .replace(/(bearer\s+)[\w.~+/-]+=*/gi, "$1[token]")
      .replace(/\b(sk|pk|rk)_(live|test)_[\w]+/gi, "[key]")
      .replace(/((?:pass(?:word)?|passwd|secret|token|api[_-]?key|auth\w*|session\w*|cookie)["']?\s*[:=]\s*["']?)[^\s"'&,;)]+/gi, "$1[redacted]")
      .replace(/\b(?:\d[ -]?){13,19}\b/g, "[number]")
      .slice(0, max);
  }
  function parse(u) { try { return new URL(String(u), location.href); } catch (e) {} }
  function cleanUrl(u) {
    var x = parse(u), q = [];
    if (!x) return redact(String(u).split(/[?#]/)[0], 300);
    x.searchParams.forEach(function (_, k) { if (q.indexOf(k) < 0 && q.length < 10) q.push(k); });
    var path = redact(x.pathname, 300) + (q.length ? "?" + q.map(function (k) { return redact(k, 40) + "=…"; }).join("&") : "");
    return x.origin == location.origin ? path : x.origin + path;
  }
  // Registrable domain, roughly: the last two labels, or three for "co.uk"-style suffixes.
  function site(h) { var p = h.split("."), n = p.length; return p.slice(n > 2 && p[n - 2].length < 4 && p[n - 1].length < 3 ? -3 : -2).join("."); }
  function push(e) {
    e.t = Date.now();
    events.push(e);
    if (events.length > 40) events.shift();
    // S-13: remember this page's latest problem (a successful submit clears it). Any failed
    // request counts (a GET 404 doesn't nudge by itself), but not asset loads, and a request that
    // got no response (status 0) only when it went to the page's own site: ad blockers and privacy
    // tools block third-party requests (analytics, trackers) all the time.
    var x, k = e.kind, net = k == "network" && !/^failed to load/.test(e.message) &&
      (e.status || e.url[0] == "/" || (x = parse(e.url)) && site(x.hostname) == site(location.hostname));
    if (/error$|rage/.test(k) || net) pageIssue = k;
    // P-01: offer a chat for JS errors, the app's own (reportError), S-02, S-13 and failed API
    // calls, not 404s on GETs. Nothing leaves the page before consent (V-06).
    if (nudged || open || !consented || !(/error$|rage|stuck/.test(k) || net && (!e.status || e.status > 499 || e.method != "GET"))) return;
    nudgeEvent = e;
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(showNudge, /rage|stuck/.test(k) ? 0 : 1200); // errors come in bursts; wait for things to settle (rage clicks already waited)
  }
  // Our own traffic (the chat iframe, uploads) isn't the customer's problem.
  function ours(u) { var x = parse(u); return x && x.origin == origin && /^\/(api\/(widget|files)|widget)/.test(x.pathname); }
  function stackOf(err) { return redact(err && err.stack || "", 800).split("\n").slice(0, 5).join("\n") || undefined; }

  if (capture) {
    try {
      window.addEventListener("error", function (e) {
        var el = e.target;
        if (el && el != window && (el.src || el.href)) {
          if (!ours(el.src || el.href)) push({ kind: "network", method: "GET", url: cleanUrl(el.src || el.href), status: 0, message: "failed to load " + String(el.tagName).toLowerCase() });
        } else {
          push({ kind: "error", message: redact(e.message || (e.error && e.error.message)), source: e.filename ? cleanUrl(e.filename) + ":" + e.lineno : undefined, stack: stackOf(e.error) });
        }
      }, true);
      window.addEventListener("unhandledrejection", function (e) {
        var r = e.reason;
        push({ kind: "error", message: "Unhandled rejection: " + redact(r && r.message || r), stack: stackOf(r) });
      });

      // fetch and XHR: record failures (4xx/5xx, or no response at all: err); a successful
      // non-GET means a save went through (S-13).
      var request = function (method, url) {
        var started = Date.now();
        method = String(method || "GET").toUpperCase();
        return !ours(url) && function (status, err) {
          if (status > 399 || err) push({ kind: "network", method: method, url: cleanUrl(url), status: status, message: err && redact(err.message), durationMs: Date.now() - started });
          else if (status > 199 && status < 300 && method != "GET") pageIssue = 0;
        };
      };
      if (nativeFetch) {
        window.fetch = function (input, init) {
          var done = request(init && init.method || input && input.method, input && input.url || input);
          var p = nativeFetch.apply(this, arguments);
          return done ? p.then(function (res) { done(res.status); return res; }, function (err) { done(0, err || {}); throw err; }) : p;
        };
      }

      // Not "open"/"send": vars are function-scoped and `open` is the chat's state below.
      var xhr = XMLHttpRequest.prototype, xhrOpen = xhr.open, xhrSend = xhr.send;
      xhr.open = function (method, url) { this.__jun = [method, url]; return xhrOpen.apply(this, arguments); };
      xhr.send = function () {
        var x = this, done = x.__jun && request(x.__jun[0], x.__jun[1]);
        if (done) x.addEventListener("loadend", function () { done(x.status, !x.status && {}); });
        return xhrSend.apply(this, arguments);
      };

      // S-02 rage clicks. Sentry's definitions (docs.sentry.io/product/issues/issue-details/replay-issues/rage-clicks/,
      // checked 2026-10-05): a dead click is a click on a button/input/link with no DOM change or
      // scroll within 7 s; 3+ such clicks in that time are a rage click. Ours is stricter on time:
      // 3+ clicks on the same element within 1 s and 30 px, and nothing in the DOM changes or
      // scrolls from the first click until 1 s after the last. Single dead clicks aren't recorded.
      // Recorded: a safe description of the element (never values or arbitrary text) and the count.
      var burst, changed, mo = new MutationObserver(function () { changed = 1; mo.disconnect(); });
      window.addEventListener("scroll", function () { changed = 1; }, true);
      window.addEventListener("click", function (ev) {
        var el = ev.target, now = Date.now(), b = burst;
        el = el && el.closest && (el.closest("button,a,[role=button],input") || el);
        // Not typing, media, our own widget, or scripted clicks.
        if (!el || !ev.isTrusted || el.closest("[data-jun-desk],[contenteditable],textarea,select,canvas,video,audio,input:not([type=submit],[type=button])")) return;
        if (!b || b.el != el || now - b.t > 1000 || Math.abs(ev.clientX - b.x) > 30 || Math.abs(ev.clientY - b.y) > 30) {
          b = burst = { el: el, x: ev.clientX, y: ev.clientY, ts: [] };
          changed = 0;
          mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        }
        b.t = now;
        var n = b.ts.push(now);
        if (n < 3 || now - b.ts[n - 3] > 1000) return;
        clearTimeout(b.timer);
        b.timer = setTimeout(function () {
          var tag = el.tagName.toLowerCase(), role = el.getAttribute("role"), button = /^(a|button)$/.test(tag) || role == "button";
          // A triple click that selected text isn't frustration.
          if (burst != b || changed || !consented || !button && String(getSelection())) return;
          var t = { tag: tag }, text = button && String(el.innerText || "").replace(/\s+/g, " ").trim();
          if (el.id) t.id = redact(el.id, 60);
          if (el.getAttribute("aria-label")) t.label = redact(el.getAttribute("aria-label"), 60);
          if (el.getAttribute("name")) t.name = redact(el.getAttribute("name"), 60);
          if (role) t.role = role.slice(0, 20);
          if (text && text.length <= 40) t.text = redact(text, 40);
          push({ kind: "rage_click", target: t, count: b.ts.length });
        }, 1000);
      }, true);

      // S-13 stuck on a form: on this page for 3+ visible minutes (hidden tab time doesn't count)
      // after a real problem, with no successful submit since. A plain timer would be the cut timed pop-up (N-02).
      window.addEventListener("submit", function () { pageIssue = 0; }, true);
    } catch (e) { /* never break the host page */ }
  }

  // Visible time on this page (path), for S-13 and P-01 page openers. Runs with capture off too:
  // openers send nothing captured (pageIssue stays unset without capture, so no S-13).
  setInterval(function () {
    if (!document.hidden) seen += 1000;
    if (seen >= stuckMs && pageIssue && !stuckSent && consented) {
      stuckSent = 1;
      push({ kind: "stuck", url: cleanUrl(location.pathname), seconds: seen / 1000, issue: pageIssue });
    }
    // P-01: the first opener rule (Settings) for this path whose visible seconds are up; the desk
    // sends its line. Not after an error nudge, a card, or once the chat was opened (setOpen clears them).
    if (openers && !nudged && !nudgeTimer && consented) openers.some(function (r) {
      return seen >= r.delay * 1000 && RegExp(r.match).test(pagePath) && (nudgeEvent = { kind: "opener", id: r.id }, openers = 0, !showNudge());
    });
  }, 1000);

  // Page changes feed both the debug trail and the live visitor list.
  function nav() {
    if (location.pathname != pagePath) { pagePath = location.pathname; pageIssue = seen = stuckSent = 0; }
    if (capture) push({ kind: "navigation", url: cleanUrl(location.href) });
    sendPage();
  }
  try {
    ["pushState", "replaceState"].forEach(function (name) {
      var orig = history[name];
      history[name] = function () { var r = orig.apply(this, arguments); nav(); return r; };
    });
    window.addEventListener("popstate", nav);
  } catch (e) {}

  // ---------- live visitor (V-01), identity (V-03), consent (V-06) ----------
  // data-consent="required": store nothing and stay off the visitor list until JunDesk.consent(true).
  var consented = script.getAttribute("data-consent") != "required";
  var userToken = script.getAttribute("data-user-token") || null;
  var sid, started, live, liveTries = 0;
  function store(k, v) { try { if (!consented) return null; if (v != null) sessionStorage.setItem(k, v); return sessionStorage.getItem(k); } catch (e) { return null; } }
  // 96 random bits as "12-255-0-…" (the desk accepts [A-Za-z0-9_-]{8,64}).
  function rid() { return crypto.getRandomValues(new Uint8Array(12)).join("-"); }
  function liveSend(m) { if (live && live.readyState == 1) live.send(JSON.stringify(m)); }
  function tz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return ""; } }
  function sendPage() {
    liveSend({ t: "page", url: location.origin + cleanUrl(location.href), title: redact(document.title, 200), ref: document.referrer ? cleanUrl(document.referrer) : "", start: started, lang: navigator.language, tz: tz() });
  }
  function connect() {
    if (!consented || live) return;
    sid = sid || store("jun:s") || store("jun:s", rid()) || rid();
    started = started || Number(store("jun:t") || store("jun:t", Date.now())) || Date.now();
    var ws = live = new WebSocket(origin.replace(/^http/, "ws") + "/api/widget/" + encodeURIComponent(key) + "/live?s=" + sid);
    ws.onopen = function () { liveTries = 0; if (userToken) liveSend({ t: "id", token: userToken }); sendPage(); };
    ws.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (x) { return; }
      // V-07: a teammate started a chat from the desk's visitor list.
      if (m.t == "invite" && !open) showCard({ text: String(m.body).slice(0, 1000), inviteId: m.id, from: m.from });
    };
    // Reconnect with backoff, unless this socket was replaced or dropped on purpose.
    ws.onclose = function () { if (live != ws) return; live = null; if (liveTries < 8) setTimeout(connect, 1000 * Math.pow(2, liveTries++)); };
  }
  function disconnect() { var ws = live; live = null; if (ws) ws.close(); }
  setInterval(function () { if (live && live.readyState == 1) live.send("ping"); }, 30000);

  function snapshot() {
    return {
      page: { url: location.origin + cleanUrl(location.href), title: redact(document.title, 200) },
      userAgent: navigator.userAgent,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      language: navigator.language,
      timezone: tz(),
      capturedAt: Date.now(),
      events: events.slice(), // empty when capture is off
    };
  }

  // ---------- proactive help (P-01): offer a chat when something really breaks ----------
  var nudged, nudgeTimer, nudgeEvent, openers; // push() and the ticker decide when (P-01)
  // The card's opener (what the chat starts with if they click it): { text, inviteId?, from?, page? }.
  var cardOpener;
  // The card and island launchers' frame shows the offer itself instead.
  function showCard(o) {
    nudged = 1;
    if (/card|island/.test(wrap.className)) return post({ type: "jun:proactive", opener: pendingOpener = o, sessionId: sid });
    cardOpener = o;
    card.querySelector("p").textContent = o.text;
    card.querySelector(".from").textContent = o.from || "";
    card.style.display = "block";
  }
  // The desk words it from what failed (S-11). Plain-text POST: no CORS preflight.
  function showNudge() {
    if (nudged || open) return;
    nativeFetch(origin + "/api/widget/" + encodeURIComponent(key) + "/nudge", {
      method: "POST",
      body: JSON.stringify({ event: nudgeEvent, page: { url: location.origin + cleanUrl(location.href), title: redact(document.title, 200) } }),
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res.show && res.text && !nudged && !open) showCard(res);
    }).catch(function () {});
  }
  function hideNudge() { card.style.display = "none"; }

  // ---------- launcher ----------
  var host = document.createElement("div");
  host.setAttribute("data-jun-desk", "");
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  root.innerHTML =
    "<style>" +
    ":host{all:initial}.w{--c:#2f5bea;--t:#fff;visibility:hidden}.w.on{visibility:visible}" +
    "button{border:0;padding:0;cursor:pointer}.btn,.frame,.nudge{position:fixed;right:22px;bottom:88px;z-index:2147483000}" +
    // D-34: the earlier Jun Desk widget's palette and radii; the open chat has a soft shadow instead of its border.
    ".frame,.nudge{background:#fff;color:#171717;border:1px solid #e5e5e5;border-radius:var(--r,16px);display:none}" +
    // W-04 dark theme ("auto" keeps the light card; the chat itself follows the system). Before .btn, which keeps its colours.
    ".dark>*{background:#171717;color:#f5f5f5;border-color:#2f2f2f}" +
    ".btn{bottom:22px;width:52px;height:52px;border-radius:var(--r,16px);background:var(--c);color:var(--t);display:grid;place-items:center}" +
    ".badge{position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#e5484d;" +
    "color:#fff;font:600 11px/18px system-ui,sans-serif;display:none}" +
    // The open chat takes the launcher's corner (the button stays under it); phones get the whole screen.
    ".frame,.nudge{width:min(380px,max(300px,32vw))}.frame{bottom:22px;height:min(540px,100dvh - 44px);border:0;box-shadow:0 8px 40px rgba(0,0,0,.16)}" +
    ".nudge{padding:16px 18px;font:14px/1.6 Arial,sans-serif}" +
    // Left side (W-04); the full-screen frame on phones wins over it (same specificity, later).
    ".left>*{right:auto;left:22px}" +
    "@media(max-width:768px){.frame{inset:0;width:100%;height:100dvh;border-radius:0}}" +
    // W-04 "bar" (D-32), "card" (D-34) and "island" (D-39) launchers: no button; the frame draws them and says where it goes (jun:css).
    // The button shows the company logo (a chat bubble until one is uploaded), or "Chat with us".
    ".btn img{width:100%;height:100%;object-fit:cover;border-radius:inherit}.txt .btn{width:auto;padding:0 18px;font:600 14px system-ui,sans-serif}" +
    ".bar .btn,.card .btn,.island .btn{display:none}.bar .frame,.island .frame{display:block;box-shadow:none;background:none}" +
    // Unseen until the frame has sized itself: before that it's the default panel, painted dark by a dark-mode browser.
    ".bar .frame:not(.sized),.island .frame:not(.sized){visibility:hidden}" +
    ".nudge p{margin:0 24px 14px 0}.from{font-size:12px;color:#737373}.go{width:100%;padding:8px 6px;border-radius:calc(var(--r,16px)*.625);background:var(--c);color:var(--t);font:12px Arial,sans-serif}" +
    ".x{position:absolute;top:12px;right:12px;width:30px;height:30px;background:none;font-size:23px;font-weight:300;color:#737373}" +
    "</style><div class=\"w\">" +
    '<div class="nudge" role="dialog" aria-label="Need help?"><button class="x" aria-label="Dismiss">×</button>' +
    '<div class="from"></div><p></p><button class="go">Chat with us</button></div>' +
    '<button class="btn" aria-label="Open chat" aria-expanded="false">' +
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z"/></svg><span class="badge"></span></button><iframe class="frame" title="Chat" allow="clipboard-write; display-capture"></iframe></div>';

  var wrap = root.querySelector(".w"), card = root.querySelector(".nudge");
  var button = root.querySelector(".btn");
  // W-04: colour and side from the desk's settings, so changing them needs no new snippet.
  // Hidden until then (at most 1.5 s) so the button doesn't flash in the default colour.
  function brand(cfg) {
    var c = color || (cfg && cfg.color);
    if (c && /^#[0-9a-f]{6}$/i.test(c)) wrap.style.setProperty("--c", c);
    if (cfg) {
      // Readable text on that colour: the desk works it out (textOn), for data-color too (?color=).
      wrap.style.setProperty("--t", cfg.text);
      openers = !open && cfg.openers;
      // W-04: side, corner rounding, dark theme, and the launcher (the bar and the card load the frame now).
      wrap.classList.add(cfg.position, cfg.theme, cfg.launcher); // "left", "dark", "bar", "card"
      if (cfg.launcher != "button") load();
      // W-21: on a dark button colour (white text on it), the logo made for dark backgrounds if there is one.
      var icon = button.querySelector("svg"), face, logo = (cfg.text == "#ffffff" && cfg.logoDarkUrl) || cfg.logoUrl;
      if (cfg.buttonStyle == "text") wrap.classList.add("txt"), face = document.createElement("span"), face.textContent = "Chat with us";
      else if (logo) face = document.createElement("img"), face.src = origin + logo, face.alt = "";
      if (face) icon.replaceWith(face);
      wrap.style.setProperty("--r", cfg.radius + "px");
    }
    wrap.classList.add("on");
  }
  setTimeout(brand, 1500);
  nativeFetch(origin + "/api/widget/" + encodeURIComponent(key) + "/config?color=" + encodeURIComponent(color || "")).then(function (r) { return r.json(); }).then(brand, function () { brand(); });
  var badge = root.querySelector(".badge");
  var frame = root.querySelector("iframe"), open;

  function post(message) {
    if (frame.contentWindow) frame.contentWindow.postMessage(message, origin);
  }

  // The chat loads on first open (the bar launcher draws itself, so it loads straight away).
  function load() {
    if (!frame.src) frame.src = origin + "/widget?key=" + encodeURIComponent(key) + (consented ? "" : "&persist=0");
  }
  // AI-21 page actions (D-40): WebMCP tools the page registers, offered to the AI. The code lives in
  // widget-actions.js, loaded on first use; until then registrations queue here. Without native
  // WebMCP, a small shim takes document.modelContext.registerTool calls so early page code works.
  var actionQueue = [], actionsLoading;
  function loadActions() {
    if (actionsLoading) return;
    actionsLoading = 1;
    var s = document.createElement("script");
    s.src = origin + "/widget-actions.js";
    s.async = true;
    document.head.appendChild(s);
  }
  if (document.modelContext) loadActions();
  else document.modelContext = {
    jun: 1, q: [],
    registerTool: function (t, o) { this.q.push([t, o]); loadActions(); },
    getTools: function () { loadActions(); return new Promise(function (r) { (function w() { document.modelContext.jun ? setTimeout(w, 50) : r(document.modelContext.getTools()); })(); }); },
  };
  var pendingOpener, onExit;
  function setOpen(next) {
    open = next;
    if (open) hideNudge(), load(), openers = 0;
    frame.style.display = open ? "block" : "";
    button.setAttribute("aria-expanded", open);
    button.setAttribute("aria-label", open ? "Close chat" : "Open chat");
    post({ type: open ? "jun:open" : "jun:close" });
    if (open && pendingOpener) post({ type: "jun:proactive", opener: pendingOpener, sessionId: sid });
  }

  button.addEventListener("click", function () { setOpen(!open); });
  // Island (D-39): "/" opens it, unless the visitor is typing somewhere on the page.
  document.addEventListener("keydown", function (e) {
    var t = e.target;
    if (e.key == "/" && !open && !e.ctrlKey && !e.metaKey && wrap.classList.contains("island") && !(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) { e.preventDefault(); setOpen(true); }
  });
  card.querySelector(".x").addEventListener("click", hideNudge);
  card.querySelector(".go").addEventListener("click", function () {
    pendingOpener = cardOpener;
    setOpen(true);
  });

  window.addEventListener("message", function (e) {
    if (e.origin != origin || !e.data || e.source != frame.contentWindow) return;
    var type = e.data.type;
    // The frame says when it's listening; tell it whether it's currently shown.
    if (type == "jun:ready") {
      post({ type: "jun:session", sessionId: sid || null, userToken: userToken, persist: consented });
      post({ type: open ? "jun:open" : "jun:close" });
      if (pendingOpener) post({ type: "jun:proactive", opener: pendingOpener, sessionId: sid });
    }
    if (type == "jun:proactive-shown") pendingOpener = null;
    if (type == "jun:open" || type == "jun:close") setOpen(type == "jun:open");
    // The bar frame sizes and clips itself (it knows what it shows); only our own frame gets here.
    if (type == "jun:css") frame.style.cssText = e.data.css, frame.classList.add("sized");
    // AI-20: the intent's exit button ("Cancel anyway"): close, then hand back to the host app, once.
    // After a reload the page's onExit is gone: the chat still closes (the exit itself was recorded by the frame).
    if (type == "jun:exit") {
      var done = onExit;
      onExit = 0;
      setOpen(false);
      if (done) done();
    }
    if (type == "jun:context-request") {
      // The debug snapshot, and (AI-21) what this page offers the AI right now.
      var a = window.JunDesk._a, id = e.data.id;
      var reply = function (actions) { post({ type: "jun:context", id: id, context: snapshot(), actions: actions }); };
      if (a) a.list(reply); else reply();
    }
    if ((type == "jun:run" || type == "jun:undo") && window.JunDesk._a) window.JunDesk._a.handle(e.data, post);
    // D-51: a card action for the page (ChatKit's handler: "client").
    if (type == "jun:widget") try { window.dispatchEvent(new CustomEvent("jundesk:widget-action", { detail: e.data.action })); } catch (x) {}
    if (type == "jun:unread") {
      var n = Number(e.data.count) || 0;
      badge.textContent = n > 9 ? "9+" : n;
      badge.style.display = n > 0 && !open ? "block" : "none";
    }
  });

  window.JunDesk = {
    // AI-20: open({ intent, onExit }) starts an intent's chat (see the header). The frame checks the
    // name (a bad one opens a plain chat) and whether the intent needs onExit.
    open: function (o) {
      if (o && o.intent) pendingOpener = { intent: o.intent, exit: !!(onExit = typeof o.onExit == "function" && o.onExit) };
      setOpen(true);
    },
    close: function () { setOpen(false); },
    toggle: function () { setOpen(!open); },
    // Signed-in user: a JWT from your backend. The chat and the visitor list then know who it is.
    identify: function (token) {
      userToken = token || null;
      if (userToken) liveSend({ t: "id", token: userToken });
      post({ type: "jun:identify", userToken: userToken });
    },
    // On sign-out: forget this browser's chat identity so the next person starts fresh.
    logout: function () {
      userToken = null;
      post({ type: "jun:identify", userToken: null });
      disconnect();
      sid = null; started = null;
      store("jun:s", rid()); store("jun:t", Date.now());
      connect();
    },
    // S-12: the app says what failed, in its own words. Same masking as shared/debug.ts.
    reportError: function (err) {
      try {
        var m = err && typeof err.message == "string" && err.message.trim();
        if (!m || !capture || !consented) return;
        var e = { kind: "app_error", message: redact(m, 300) };
        var c = typeof err.code == "string" && redact(err.code, 60).replace(/[^\w.-]/g, "");
        if (c) e.code = c;
        push(e);
      } catch (x) { /* never break the host page */ }
    },
    consent: function (yes) {
      consented = Boolean(yes);
      post({ type: "jun:consent", persist: consented });
      if (consented) connect();
      else disconnect();
    },
    // AI-21: a WebMCP tool ({ name, description, inputSchema, execute, annotations }) plus extras
    // (pages, key, element, context, available, undo, risk); see widget-actions.js. Returns a remover.
    _q: actionQueue,
    onWidgetAction: function (fn) {
      var h = function (e) { fn(e.detail); };
      window.addEventListener("jundesk:widget-action", h);
      return function () { window.removeEventListener("jundesk:widget-action", h); };
    },
    registerAction: function (t) {
      var r = { t: t, off: null, dead: false };
      if (window.JunDesk._a) r.off = window.JunDesk._a.register(t);
      else { actionQueue.push(r); loadActions(); }
      return function () { r.dead = true; if (r.off) r.off(); };
    },
  };
  // For code that loaded before this script (e.g. the React hook): the API is there now.
  try { window.dispatchEvent(new Event("jundesk:ready")); } catch (e) {}
  connect();

  // Loaded from <head> (recommended, for early error capture) there's no body yet.
  if (document.body) document.body.appendChild(host);
  else document.addEventListener("DOMContentLoaded", function () { document.body.appendChild(host); });
})();
