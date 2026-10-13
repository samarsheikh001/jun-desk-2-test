import { SOCKET_PROTOCOL } from "../../shared/protocol.ts";
import { FORWARD_HEADERS, type ConversationRef, type Participant, type SendInput, type SendResult } from "../conversation.ts";
import { HUB_USER_HEADER, HUB_VISITOR_HEADER, type VisitorConnect } from "../hub.ts";
import { HttpError } from "../types.ts";

/** Subprotocols the client offered, e.g. `["jun", "<visitor token>"]`. */
export function offeredProtocols(request: Request): string[] {
  return (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
}

export function assertWebSocketUpgrade(request: Request): void {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(400, "websocket_required", "Expected a WebSocket upgrade.");
  }
  if (!offeredProtocols(request).includes(SOCKET_PROTOCOL)) {
    throw new HttpError(400, "bad_protocol", `Use the "${SOCKET_PROTOCOL}" WebSocket subprotocol.`);
  }
  // Both the dashboard and the widget frame are served from this origin.
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new HttpError(403, "bad_origin", "Cross-origin WebSocket rejected.");
  }
}

function forward(request: Request, headers: Record<string, string>): Request {
  const forwarded = new Headers(request.headers);
  // Identity headers only ever come from the Worker, never from the client.
  for (const name of [HUB_USER_HEADER, HUB_VISITOR_HEADER]) forwarded.delete(name);
  for (const [k, v] of Object.entries(headers)) forwarded.set(k, v);
  return new Request(request.url, { method: "GET", headers: forwarded });
}

/** Forwards an already-authenticated socket upgrade to the conversation's Durable Object. */
export function connectConversation(env: Env, request: Request, ref: ConversationRef, participant: Participant): Promise<Response> {
  assertWebSocketUpgrade(request);
  return env.CONVERSATION.getByName(ref.conversationId).fetch(
    forward(request, {
      [FORWARD_HEADERS.conversationId]: ref.conversationId,
      [FORWARD_HEADERS.workspaceId]: ref.workspaceId,
      [FORWARD_HEADERS.participant]: JSON.stringify(participant),
    }),
  );
}

export function connectHub(env: Env, request: Request, workspaceId: string, user: { userId: string; name: string }): Promise<Response> {
  assertWebSocketUpgrade(request);
  return env.WORKSPACE_HUB.getByName(workspaceId).fetch(forward(request, { [HUB_USER_HEADER]: JSON.stringify(user) }));
}

/** V-01: the loader's live socket from a customer's site (any origin; the widget key was checked). */
export function connectVisitorLive(env: Env, request: Request, workspaceId: string, info: VisitorConnect): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new HttpError(400, "websocket_required", "Expected a WebSocket upgrade.");
  return env.WORKSPACE_HUB.getByName(workspaceId).fetch(forward(request, { [HUB_VISITOR_HEADER]: JSON.stringify(info) }));
}

export async function sendMessage(env: Env, ref: ConversationRef, participant: Participant, input: SendInput) {
  const result = (await env.CONVERSATION.getByName(ref.conversationId).send(ref, participant, input)) as SendResult;
  if (!result.ok) throw new HttpError(400, result.code, result.message);
  return result.message;
}

export async function notifyConversationChanged(env: Env, ref: ConversationRef): Promise<void> {
  await env.CONVERSATION.getByName(ref.conversationId).conversationChanged(ref);
}
