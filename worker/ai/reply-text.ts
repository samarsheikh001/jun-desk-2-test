/**
 * Puts one reply together from the model's text parts (pure, so it's testable without a model).
 *
 * Steps (text before and after tool calls) join with a blank line. Within one step, a later
 * message item replaces the earlier one: OpenAI's Responses API can answer with a "commentary"
 * message and then the "final_answer" in one response (`phase`), often in nearly the same words,
 * and joined they read as the reply said twice ("…Sentosa Siloso Beach?I found several…").
 * Workers AI streams one text part per step, so nothing changes there.
 */
export class ReplyText {
  text = "";
  #stepStart = 0;
  #stepHasText = false;
  #item: string | null = null;

  startStep(): void {
    this.#stepHasText = false;
    this.#item = null;
  }

  /** A text part (one message item) begins. True when it replaces the step's earlier text. */
  startItem(id: string): boolean {
    const replaces = this.#stepHasText && this.#item !== null && id !== this.#item;
    if (replaces) this.text = this.text.slice(0, this.#stepStart);
    this.#item = id;
    return replaces;
  }

  /** More text of the current item; returns the whole reply so far. */
  delta(id: string, text: string): string {
    if (this.#item === null) this.#item = id;
    else if (id !== this.#item) this.startItem(id);
    if (!this.#stepHasText) {
      if (this.text.trim()) this.text = `${this.text.trimEnd()}\n\n`;
      this.#stepStart = this.text.length;
      this.#stepHasText = true;
    }
    this.text += text;
    return this.text;
  }
}
