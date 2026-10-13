import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ChatGPTCredentials, CredentialStore } from "@jun/llm";

export function defaultCredentialsPath(): string {
  return process.env.JUN_HOME ? join(process.env.JUN_HOME, "chatgpt.json") : join(homedir(), ".jun", "chatgpt.json");
}

/** Stores ChatGPT credentials in a user-only file (`~/.jun/chatgpt.json`). */
export class FileCredentialStore implements CredentialStore {
  readonly path: string;

  constructor(path = defaultCredentialsPath()) {
    this.path = path;
  }

  async load(): Promise<ChatGPTCredentials | undefined> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as ChatGPTCredentials;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(credentials: ChatGPTCredentials): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    // Write-then-rename so a crash never leaves a half-written file (and a lost rotated refresh token).
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(credentials, null, 2), { mode: 0o600 });
    await rename(temp, this.path);
  }
}
