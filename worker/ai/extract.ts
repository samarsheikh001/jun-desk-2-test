import { decodeEntities, type Block } from "./chunk.ts";

// Pulls readable content out of an HTML page with HTMLRewriter (streaming, no DOM).

const SKIP = new Set(["script", "style", "noscript", "svg", "nav", "footer", "header", "aside", "form", "iframe", "button", "select", "template", "dialog"]);
const BLOCK = new Set(["p", "li", "td", "th", "pre", "blockquote", "dt", "dd", "figcaption", "div", "section", "article", "main", "tr", "br", "summary", "caption"]);
const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
// Elements that never have an end tag (onEndTag would throw).
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

export interface ExtractedPage {
  title: string;
  blocks: Block[];
  links: string[];
}

export async function extractPage(response: Response, baseUrl: string): Promise<ExtractedPage> {
  let title = "";
  let inTitle = false;
  let skipDepth = 0;
  let mainDepth = 0;
  let sawMain = false;
  let buffer = "";
  let headingLevel = 0;
  const all: Block[] = [];
  const main: Block[] = [];
  const links = new Set<string>();

  const flush = () => {
    const text = decodeEntities(buffer).replace(/\s+/g, " ").trim();
    buffer = "";
    if (!text) return;
    const block: Block = headingLevel ? { kind: "heading", level: headingLevel, text } : { kind: "text", text };
    all.push(block);
    if (mainDepth > 0) main.push(block);
  };

  // Note: an element can have only one end-tag handler, so all onEndTag logic lives in
  // the single "*" handler below (a second handler would silently replace it).
  const rewriter = new HTMLRewriter()
    .on("a[href]", {
      element(el) {
        const href = el.getAttribute("href");
        if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) return;
        try {
          links.add(new URL(decodeEntities(href), baseUrl).toString());
        } catch {
          // ignore invalid URLs
        }
      },
    })
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        const skip = SKIP.has(tag) || el.getAttribute("aria-hidden") === "true" || el.getAttribute("role") === "navigation";
        const isMain = tag === "main" || tag === "article" || el.getAttribute("role") === "main";
        const level = HEADINGS[tag];
        if (BLOCK.has(tag) || level) flush();
        if (VOID.has(tag)) return;
        if (tag === "title") {
          inTitle = true;
          el.onEndTag(() => {
            inTitle = false;
          });
          return;
        }

        if (skip) skipDepth++;
        if (isMain) {
          mainDepth++;
          sawMain = true;
        }
        if (level && skipDepth === 0) headingLevel = level;
        el.onEndTag(() => {
          if (BLOCK.has(tag) || level) flush();
          if (level) headingLevel = 0;
          if (skip) skipDepth--;
          if (isMain) mainDepth--;
        });
      },
      text(t) {
        if (inTitle) title += t.text;
        else if (skipDepth === 0) buffer += t.text;
      },
    });

  await rewriter.transform(response).arrayBuffer();
  flush();

  // Prefer the <main>/<article> content when the page has a substantial one.
  const mainText = main.reduce((n, b) => n + b.text.length, 0);
  return {
    title: decodeEntities(title).replace(/\s+/g, " ").trim(),
    blocks: sawMain && mainText > 200 ? main : all,
    links: [...links],
  };
}
