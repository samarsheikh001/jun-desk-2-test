import assert from "node:assert/strict";
import { test } from "node:test";
import { compileTemplate, MAX_TEMPLATE_STEPS, TemplateError } from "./jinja.ts";

const render = (source: string, data: Record<string, unknown> = {}) => compileTemplate(source).render(data);

test("output, tojson and whitespace control", () => {
  assert.equal(render("Hi {{ name }}!", { name: "Ann" }), "Hi Ann!");
  assert.equal(render('{"v":{{ (name) | tojson }}}', { name: 'a"b' }), '{"v":"a\\"b"}');
  assert.equal(render("{{ missing | tojson }}"), "null");
  assert.equal(render("{{ (undefined) | tojson }}"), "null");
  assert.equal(render("a  {{- 1 -}}  b"), "a1b");
  assert.equal(render("a {%- if true -%} b {%- endif -%} c"), "abc");
  assert.equal(render("x{# comment #}y"), "xy");
  assert.equal(render('{{ "}}" }}'), "}}");
});

test("expressions the ChatKit Studio compiler writes", () => {
  const data = { name: "Ann", number: 7, order: { id: "A1", total: 12.5 }, count: 3, items: [{ id: "x", title: "T" }], note: "hi", status: "open", flag: true };
  assert.equal(render('{{ (("Order " ~ order.id)) | tojson }}', data), '"Order A1"');
  assert.equal(render('{{ ((name ~ " (#" ~ number ~ ")")) | tojson }}', data), '"Ann (#7)"');
  assert.equal(render('{{ (("$" ~ order.total)) | tojson }}', data), '"$12.5"');
  assert.equal(render('{{ (((items | length) ~ " items")) | tojson }}', data), '"1 items"');
  assert.equal(render('{{ (note or "none") | tojson }}', { note: "" }), '"none"');
  assert.equal(render('{{ (note if note is defined and note is not none else "dflt") | tojson }}', {}), '"dflt"');
  assert.equal(render('{{ (note if note is defined and note is not none else "dflt") | tojson }}', { note: null }), '"dflt"');
  assert.equal(render('{% if ((status == "open") and (count >= 1)) %}"a"{% else %}"b"{% endif %}', data), '"a"');
  assert.equal(render("{{ (items[0].title) | tojson }}", data), '"T"');
  assert.equal(render('{{ (order["id"]) | tojson }}', data), '"A1"');
  assert.equal(render("{{ ((count * 2)) | tojson }}", data), "6");
  assert.equal(render("{%-if not (flag) -%}x{%-else-%}{%-endif-%}", data), "");
});

test("for loops: loop variables, index0, else, nested block sets (the Studio's comma trick)", () => {
  const tpl = '[{%- set _c -%}{%-for item in items -%}{%-set index = loop.index0 -%},{"i":{{ (((index + 1))) | tojson }},"t":{{ (item.t) | tojson }}}{%-endfor-%}{%- endset -%}{{- (_c[1:] if _c and _c[0] == \',\' else _c) -}}]';
  assert.deepEqual(JSON.parse(render(tpl, { items: [{ t: "a" }, { t: "b" }] })), [{ i: 1, t: "a" }, { i: 2, t: "b" }]);
  assert.deepEqual(JSON.parse(render(tpl, { items: [] })), []);
  assert.equal(render("{% for x in xs %}{{ x }}{% else %}none{% endfor %}", { xs: [] }), "none");
  assert.equal(render("{% for x in xs %}{{ loop.index }}{% if not loop.last %},{% endif %}{% endfor %}", { xs: [1, 2, 3] }), "1,2,3");
  assert.equal(render("{% for k, v in m | items %}{{ k }}={{ v }};{% endfor %}", { m: { a: 1, b: 2 } }), "a=1;b=2;");
  assert.equal(render("{% for x in xs if x > 1 %}{{ x }}{% endfor %}", { xs: [1, 2, 3] }), "23");
  // A block set inside a loop doesn't leak out of it.
  assert.equal(render("{% set y = 1 %}{% for x in [1] %}{% set y = 2 %}{% endfor %}{{ y }}"), "1");
});

test("Jinja truthiness, slices, in, arithmetic and filters", () => {
  assert.equal(render("{% if xs %}y{% else %}n{% endif %}", { xs: [] }), "n");
  assert.equal(render("{% if m %}y{% else %}n{% endif %}", { m: {} }), "n");
  assert.equal(render("{{ s[1:] }}|{{ s[:2] }}|{{ s[::-1] }}|{{ s[-1] }}", { s: "abc" }), "bc|ab|cba|c");
  assert.equal(render("{{ 'b' in s }} {{ 2 in xs }} {{ 'k' in m }} {{ 3 not in xs }}", { s: "abc", xs: [1, 2], m: { k: 1 } }), "true true true true");
  assert.equal(render("{{ 7 // 2 }} {{ -7 % 3 }} {{ 2 ** 3 }} {{ 7 / 2 }}"), "3 2 8 3.5");
  assert.equal(render("{{ price | round(2) }} {{ name | upper }} {{ xs | join(', ') }} {{ x | default('-') }}", { price: 3.14159, name: "a", xs: [1, 2] }), "3.14 A 1, 2 -");
  assert.equal(render("{{ users | map('name') | join('/') }}", { users: [{ name: "a" }, { name: "b" }] }), "a/b");
  assert.equal(render("{{ 'x' if a else 'y' }}", { a: 0 }), "y");
  assert.equal(render("{{ items.length }} {{ (a.b.c) | tojson }}", { items: [1, 2] }), "2 null");
});

test("rejects what it can't run, at compile time", () => {
  for (const bad of ["{{ x(1) }}", "{{ x | nosuchfilter }}", "{% macro m() %}{% endmacro %}", "{% if x %}", "{{ x ", "{{ x is weird }}"]) {
    assert.throws(() => compileTemplate(bad), TemplateError, bad);
  }
});

test("runaway templates stop", () => {
  const tpl = compileTemplate("{% for a in xs %}{% for b in xs %}{% for c in xs %}x{% endfor %}{% endfor %}{% endfor %}");
  const xs = Array.from({ length: Math.ceil(Math.cbrt(MAX_TEMPLATE_STEPS)) + 5 }, (_, i) => i);
  assert.throws(() => tpl.render({ xs }), /too many steps|too large/);
});

test("jinja: selectattr / rejectattr, with a test, an operator or just truthiness", () => {
  const invoices = [
    { id: "a", status: "open", total: 240, paid: false },
    { id: "b", status: "paid", total: 240, paid: true },
    { id: "c", status: "open", total: 192.5, paid: false },
  ];
  assert.equal(render('{{ invoices | selectattr("status", "equalto", "open") | sum(attribute="total") }}', { invoices }), "432.5");
  assert.equal(render('{{ invoices | selectattr("status", "==", "open") | map(attribute="id") | join(",") }}', { invoices }), "a,c");
  assert.equal(render('{{ invoices | rejectattr("paid") | length }}', { invoices }), "2");
  assert.equal(render('{{ invoices | selectattr("total", ">", 200) | length }}', { invoices }), "2");
  assert.equal(render('{{ missing | selectattr("x") | length }}', {}), "0");
  assert.throws(() => render('{{ invoices | selectattr("status", "nope", 1) }}', { invoices }), TemplateError);
});
