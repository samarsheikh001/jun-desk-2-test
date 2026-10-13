import { Fragment, type ReactNode } from "react";
import type { MdBlock, MdToken } from "../../shared/markdown.ts";

// Draws `parseMarkdown` blocks as React elements (never HTML strings). Used for AI answers in the
// widget (`answer.tsx`, with the paced reveal: `shown` tokens, each word in a `wordClass` span)
// and in the inbox (`MessageList`, all at once). Styles: `.md-*` in widget.css and desk.css.

export interface MarkdownProps {
  blocks: MdBlock[];
  /** How many tokens to show (the reveal); all when left out. */
  shown?: number;
  /** Each word's span class (the widget's reveal animation); plain text when left out. */
  wordClass?: string;
  /** A citation `[n]`. */
  cite: (n: number) => ReactNode;
  /** Drawn at the end of the last shown block (the caret). */
  tail?: ReactNode;
}

type Item = Extract<MdToken, { kind: "word" | "code" }>;

function Inline({ tokens, wordClass, cite }: { tokens: MdToken[]; wordClass: string | undefined; cite: (n: number) => ReactNode }) {
  const word = (t: Item, key: number, space: string) => {
    let node: ReactNode = t.kind === "code" ? <code>{t.text}</code> : t.text;
    if (t.em) node = <em>{node}</em>;
    if (t.strong) node = <strong>{node}</strong>;
    return wordClass ? <span key={key} className={wordClass}>{node}{space}</span> : <Fragment key={key}>{node}{space}</Fragment>;
  };
  const out: ReactNode[] = [];
  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i]!;
    if (t.kind === "br") out.push(<br key={i} />);
    else if (t.kind === "cite") out.push(<Fragment key={i}>{cite(t.n)}{t.space}</Fragment>);
    else if (t.href) {
      // One link around its words; the space after it stays outside the underline.
      const href = t.href;
      let j = i;
      while (j < tokens.length) {
        const n = tokens[j]!;
        if ((n.kind !== "word" && n.kind !== "code") || n.href !== href) break;
        j++;
      }
      const run = tokens.slice(i, j) as Item[];
      out.push(
        <Fragment key={i}>
          <a className="md-a" href={href} target="_blank" rel="noopener noreferrer nofollow">{run.map((r, k) => word(r, k, k === run.length - 1 ? "" : r.space))}</a>
          {run.at(-1)!.space}
        </Fragment>,
      );
      i = j;
      continue;
    } else out.push(word(t, i, t.space));
    i++;
  }
  return <>{out}</>;
}

export function Markdown({ blocks, shown = Infinity, wordClass, cite, tail }: MarkdownProps) {
  // The blocks in view, each with its shown tokens.
  const visible: { block: MdBlock; tokens: MdToken[] }[] = [];
  let budget = shown;
  for (const block of blocks) {
    if (budget <= 0) break;
    const tokens = block.tokens.slice(0, budget);
    budget -= tokens.length;
    visible.push({ block, tokens });
  }
  const out: ReactNode[] = [];
  const last = visible.length - 1;
  for (let i = 0; i <= last; i++) {
    const { block, tokens } = visible[i]!;
    const end = i === last ? tail : null;
    const inline = <Inline tokens={tokens} wordClass={wordClass} cite={cite} />;
    if (block.kind === "li") {
      // Consecutive items make one list (nested ones by their depth).
      const items: ReactNode[] = [];
      let j = i;
      for (; j <= last; j++) {
        const v = visible[j]!;
        // A bulleted list right after a numbered one (or the other way round) is a list of its own.
        if (v.block.kind !== "li" || (j > i && v.block.depth === 0 && v.block.ordered !== block.ordered)) break;
        const b = v.block;
        items.push(
          <li key={j} className={`md-li md-d${b.depth}`}>
            {b.ordered ? <span className="md-mark">{b.n}.</span> : <span className="md-mark" aria-hidden="true">{b.depth ? "◦" : "•"}</span>}
            <span className="md-li-body"><Inline tokens={v.tokens} wordClass={wordClass} cite={cite} />{j === last ? tail : null}</span>
          </li>,
        );
      }
      out.push(block.ordered ? <ol key={i} className="md-list">{items}</ol> : <ul key={i} className="md-list">{items}</ul>);
      i = j - 1;
    } else if (block.kind === "h") out.push(<p key={i} className="md-h">{inline}{end}</p>);
    else if (block.kind === "quote") out.push(<blockquote key={i} className="md-quote">{inline}{end}</blockquote>);
    else if (block.kind === "pre") {
      out.push(
        <Fragment key={i}>
          <pre className="md-pre"><code>{tokens.map((t, k) => (t.kind === "word" ? <span key={k} className={wordClass}>{t.text}{k < tokens.length - 1 ? "\n" : ""}</span> : null))}</code></pre>
          {end}
        </Fragment>,
      );
    } else if (block.kind === "hr") out.push(<Fragment key={i}><hr className="md-hr" />{end}</Fragment>);
    else out.push(<p key={i} className="md-p">{inline}{end}</p>);
  }
  if (!visible.length && tail) out.push(<Fragment key="tail">{tail}</Fragment>);
  return <>{out}</>;
}
