export interface SseMessage {
  event: string | undefined;
  data: string;
}

/** Minimal Server-Sent Events parser over a web ReadableStream. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];

  // Returns a completed message when the line is the blank line that ends one.
  const processLine = (line: string): SseMessage | undefined => {
    if (line === "") {
      const message = data.length > 0 ? { event, data: data.join("\n") } : undefined;
      event = undefined;
      data = [];
      return message;
    }
    if (line.startsWith(":")) return undefined; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    return undefined;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;

      let newline: number;
      while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
        // A lone trailing "\r" may be the first half of "\r\n"; wait for more input.
        if (newline === buffer.length - 1 && buffer.endsWith("\r")) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer.startsWith("\r\n", newline) ? 2 : 1));
        const message = processLine(line);
        if (message) yield message;
      }
    }
    // Stream ended: treat any partial line and pending fields as a final message.
    for (const line of buffer === "" ? [""] : [buffer, ""]) {
      const message = processLine(line);
      if (message) yield message;
    }
  } finally {
    reader.releaseLock();
  }
}
