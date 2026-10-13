/*! Jun Desk page actions | MIT License
 * AI-21 (D-40): loaded by widget.js the first time a page registers an action (or when the browser
 * has WebMCP). Implements WebMCP's imperative API where the browser lacks it and bridges the page's
 * tools to the chat: the list travels with each message, the model picks one, this file runs it.
 *
 * Standard (WebMCP, https://developer.chrome.com/docs/ai/webmcp/imperative-api):
 *   document.modelContext.registerTool({ name, description, inputSchema, execute, annotations }, { signal })
 *   document.modelContext.getTools() / executeTool(tool, input) / "toolchange" event
 * Jun superset (the same tool plus extras WebMCP has no place for):
 *   JunDesk.registerAction({ ...tool, pages, key, element, context, available, undo, risk })
 *     pages:     ["/pricing", "/plans/*"]  offered only on matching paths
 *     key:       one instance per product card (name + key must be unique)
 *     element:   an element or React ref, highlighted while the action runs
 *     context:   small facts for the AI ({ price: 89 }), or a function returning them
 *     available: () => boolean, checked before the action is offered and before it runs
 *     undo:      (result) => …, gives the chat an Undo button
 *     risk:      "auto" | "confirm" (default) | "human"; or WebMCP annotations
 *     widget:    a card made on the desk ("cart_summary"): the result (an object) is shown as it
 *   returns a function that removes the action.
 * Nothing here reads the page or fills forms: only what the page's own code registers.
 */
(function () {
  var J = window.JunDesk;
  if (!J || J._a) return;
  var MAX = 60; // the desk ranks these for the question and offers the AI at most 30

  // ---------- WebMCP imperative API, when the browser doesn't have it ----------
  // (widget.js leaves a shim that queued early registerTool calls; they're replayed below.)
  var shim = document.modelContext && document.modelContext.jun ? document.modelContext : null;
  if (!document.modelContext || shim) {
    var tools = new Map(), target = new EventTarget();
    function fire() { target.dispatchEvent(new Event("toolchange")); }
    function bad(m) { return new DOMException(m, "InvalidStateError"); }
    document.modelContext = {
      registerTool: function (t, o) {
        if (!t || typeof t.name != "string" || !t.name || typeof t.description != "string" || !t.description) throw bad("A tool needs a name and a description.");
        if (tools.has(t.name)) throw bad("A tool named " + t.name + " is already registered.");
        tools.set(t.name, t);
        if (o && o.signal) o.signal.addEventListener("abort", function () { if (tools.get(t.name) === t) { tools.delete(t.name); fire(); } });
        fire();
      },
      getTools: function () { return Promise.resolve(Array.from(tools.values())); },
      executeTool: function (t, input) {
        var x = typeof t == "string" ? tools.get(t) : t && tools.get(t.name) || t;
        if (!x || typeof x.execute != "function") return Promise.reject(bad("Unknown tool."));
        return Promise.resolve().then(function () { return x.execute(input || {}, runOptions()); });
      },
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
    };
    document.modelContext.polyfill = true;
    if (shim) shim.q.forEach(function (x) { try { document.modelContext.registerTool(x[0], x[1]); } catch (e) { console.warn("Jun Desk:", e.message); } });
  }
  var mc = document.modelContext;
  // execute's second argument. Chrome's docs show `execute(input, { signal })` in code but call it "an
  // AbortSignal named signal" in prose, and sites follow either: this is a real AbortSignal that also
  // has a `.signal` property (itself), so both `fetch(url, { signal: opts })` and `opts.signal` work.
  function runOptions() {
    var s = new AbortController().signal;
    try { Object.defineProperty(s, "signal", { value: s }); } catch (e) {}
    return s;
  }

  // ---------- Jun registry (extras live here; the standard part is mirrored into modelContext) ----------
  var registry = new Map(), mirrors = new Map(), results = new Map();
  function idOf(t) { return t.key == null ? t.name : t.name + "#" + t.key; }
  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function remove(id) {
    registry.delete(id);
    var c = mirrors.get(id);
    if (c) { mirrors.delete(id); c.abort(); }
  }
  function register(t) {
    if (!t || typeof t.name != "string" || typeof t.description != "string" || typeof t.execute != "function") {
      console.warn("Jun Desk: registerAction needs name, description and execute");
      return function () {};
    }
    var id = idOf(t);
    if (registry.has(id)) { console.warn("Jun Desk: action " + id + " registered twice; the newer one replaces it"); remove(id); }
    registry.set(id, t);
    // Other agents (Chrome's) see the standard part too; instances (key) stay ours, names must be unique there.
    if (t.key == null) {
      var c = new AbortController();
      safe(function () {
        mc.registerTool({ name: t.name, description: t.description, inputSchema: t.inputSchema || { type: "object", properties: {} }, annotations: t.annotations || (t.risk == "auto" ? { readOnlyHint: true } : { consequentialHint: true }), execute: t.execute }, { signal: c.signal });
        mirrors.set(id, c);
      });
    }
    return function () { remove(id); };
  }
  function matches(pages) {
    if (!pages) return true;
    var p = location.pathname;
    return [].concat(pages).some(function (pat) { return typeof pat == "string" && (pat.slice(-1) == "*" ? p.indexOf(pat.slice(0, -1)) == 0 : p == pat); });
  }
  function offered(t) { return matches(t.pages) && (typeof t.available != "function" || safe(t.available, false)); }
  function inView(t) {
    var el = t.element && (t.element.current || t.element);
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }
  function describe(id, t) {
    var ctx = typeof t.context == "function" ? safe(t.context) : t.context;
    return { id: id, name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations, risk: t.risk, context: ctx, widget: typeof t.widget == "string" ? t.widget : void 0, status: typeof t.status == "string" ? t.status : void 0, visible: safe(function () { return inView(t); }, false) };
  }
  // The current list (ours first, what's on screen before the rest, then the page's own WebMCP
  // tools), to `cb`; never the functions.
  function list(cb) {
    var out = [];
    registry.forEach(function (t, id) { if (offered(t)) out.push(describe(id, t)); });
    out.sort(function (a, b) { return (b.visible ? 1 : 0) - (a.visible ? 1 : 0); });
    Promise.resolve(safe(function () { return mc.getTools(); }, [])).then(function (ts) {
      (ts || []).forEach(function (t) { if (t && !registry.has(t.name) && !mirrors.has(t.name)) out.push(describe(t.name, t)); });
    }, function () {}).then(function () { cb(out.slice(0, MAX)); });
  }
  function find(id, cb) {
    var t = registry.get(id);
    if (t) return cb(offered(t) ? t : null, true);
    Promise.resolve(safe(function () { return mc.getTools(); }, [])).then(function (ts) {
      cb((ts || []).filter(function (x) { return x && x.name == id; })[0] || null, false);
    }, function () { cb(null, false); });
  }
  var marked;
  function highlight(t) {
    var el = t.element && (t.element.current || t.element);
    if (!el || !el.style) return;
    marked = [el, el.style.outline, el.style.outlineOffset];
    el.style.outline = "2px solid #7c6cff";
    el.style.outlineOffset = "4px";
    safe(function () { el.scrollIntoView({ block: "nearest", behavior: "smooth" }); });
  }
  function unhighlight() {
    if (!marked) return;
    marked[0].style.outline = marked[1];
    marked[0].style.outlineOffset = marked[2];
    marked = null;
  }
  // What the AI reads back (a booking form, search results), up to the desk's MAX_ACTION_RESULT.
  function text(r) {
    if (r == null) return "";
    if (typeof r == "string") return r.slice(0, 2000);
    if (typeof r.summary == "string") return r.summary.slice(0, 2000);
    return safe(function () { return JSON.stringify(r).slice(0, 2000); }, "");
  }
  // The whole result as JSON for its card (W-31), if it is one: the desk draws only what a card asks for.
  function data(r) {
    var s = typeof r == "string" ? r : r && typeof r == "object" ? safe(function () { return JSON.stringify(r); }, "") : "";
    return s && /^\s*[[{]/.test(s) && s.length <= 32768 ? s : void 0;
  }
  // From the chat: run the chosen action, or undo one. `post` answers the frame.
  function handle(m, post) {
    var runId = m.runId;
    if (m.type == "jun:undo") {
      var r = results.get(runId);
      if (!r || typeof r.tool.undo != "function") return post({ type: "jun:action", runId: runId, status: "undo_failed", result: "Nothing to undo." });
      return Promise.resolve().then(function () { return r.tool.undo(r.result); }).then(function () {
        results.delete(runId);
        post({ type: "jun:action", runId: runId, status: "undone" });
      }, function (e) { post({ type: "jun:action", runId: runId, status: "undo_failed", result: text(e && e.message) || "Couldn't undo." }); });
    }
    if (m.type != "jun:run") return;
    find(String(m.id), function (t, ours) {
      // Navigated away, sold out, unmounted: say so instead of failing silently.
      if (!t) return post({ type: "jun:action", runId: runId, status: "gone" });
      var input = m.input && typeof m.input == "object" ? m.input : {};
      highlight(t);
      Promise.resolve().then(function () { return ours ? t.execute(input, runOptions()) : mc.executeTool(t, input); }).then(function (r) {
        results.set(runId, { tool: t, result: r });
        post({ type: "jun:action", runId: runId, status: "ok", result: text(r), data: data(r), canUndo: typeof t.undo == "function" });
      }, function (e) {
        post({ type: "jun:action", runId: runId, status: "error", result: text(e && e.message) || "Something went wrong." });
      }).then(unhighlight, unhighlight);
    });
  }

  J._a = { register: register, list: list, handle: handle };
  // Actions registered before this file loaded.
  (J._q || []).forEach(function (r) { if (!r.dead) r.off = register(r.t); });
  J._q = null;
})();
