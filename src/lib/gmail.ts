import { uncategorizedInboxQuery } from "./scan-pace";
import type { EmailMessage, SuggestedAction } from "./types";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_BATCH_URL = "https://www.googleapis.com/batch/gmail/v1";
const LIST_PAGE_SIZE = 500;
const BATCH_GET_SIZE = 10;
const BATCH_RETRY_LIMIT = 4;

type GmailHeader = { name: string; value: string };

type GmailMessagePart = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
};

type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: {
    headers?: GmailHeader[];
    mimeType?: string;
    body?: { data?: string };
    parts?: GmailMessagePart[];
  };
  internalDate?: string;
};

type GmailListResponse = {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
};

type GmailLabel = {
  id: string;
  name: string;
  type?: string;
};

type GmailLabelsResponse = {
  labels?: GmailLabel[];
};

async function gmailFetch<T>(
  accessToken: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gmail API ${response.status}: ${body}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  const match = headers?.find(
    (header) => header.name.toLowerCase() === name.toLowerCase()
  );
  return match?.value ?? "";
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function collectParts(
  part: GmailMessagePart | undefined,
  mimeType: string
): string[] {
  if (!part) {
    return [];
  }

  const chunks: string[] = [];
  if (part.mimeType === mimeType && part.body?.data) {
    chunks.push(decodeBase64Url(part.body.data));
  }
  for (const child of part.parts ?? []) {
    chunks.push(...collectParts(child, mimeType));
  }
  return chunks;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function extractBody(message: GmailMessage): string {
  const payload = message.payload;
  if (!payload) {
    return message.snippet ?? "";
  }

  if (payload.body?.data && payload.mimeType === "text/plain") {
    return decodeBase64Url(payload.body.data);
  }

  const plain = collectParts(payload, "text/plain").join("\n").trim();
  if (plain) {
    return plain;
  }

  const html = collectParts(payload, "text/html").join("\n");
  if (html) {
    return stripHtml(html);
  }

  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  return message.snippet ?? "";
}

function parseFrom(raw: string): { name: string; email: string } {
  const match = raw.match(/^(?:"?([^"]*)"?\s)?<?([^<>]+@[^<>]+)>?$/);
  if (!match) {
    return { name: raw || "Unknown", email: raw };
  }
  return {
    name: (match[1] || match[2]).trim(),
    email: match[2].trim(),
  };
}

function ageInDays(dateHeader: string, internalDate?: string): number {
  const parsed = Date.parse(dateHeader) || Number(internalDate) || Date.now();
  const ms = Date.now() - parsed;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function toEmailMessage(message: GmailMessage): EmailMessage {
  const headers = message.payload?.headers;
  const from = parseFrom(headerValue(headers, "From"));
  const date = headerValue(headers, "Date") || new Date(Number(message.internalDate)).toISOString();
  const unsubscribe = headerValue(headers, "List-Unsubscribe");

  return {
    id: message.id,
    threadId: message.threadId,
    fromName: from.name,
    fromEmail: from.email,
    subject: headerValue(headers, "Subject") || "(no subject)",
    date,
    ageDays: ageInDays(date, message.internalDate),
    snippet: message.snippet ?? "",
    body: extractBody(message),
    hasUnsubscribeHeader: unsubscribe.length > 0,
    isUnread: (message.labelIds ?? []).includes("UNREAD"),
  };
}

export async function listUncategorizedInboxIds(
  accessToken: string
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  const query = encodeURIComponent(uncategorizedInboxQuery());

  do {
    const page = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
    const list = await gmailFetch<GmailListResponse>(
      accessToken,
      `/messages?q=${query}&maxResults=${LIST_PAGE_SIZE}${page}`
    );
    for (const message of list.messages ?? []) {
      ids.push(message.id);
    }
    pageToken = list.nextPageToken;
  } while (pageToken);

  return ids;
}

type BatchPart = {
  id: string;
  status: number;
  body: string;
};

function parseBatchResponse(contentType: string, raw: string): BatchPart[] {
  const boundaryMatch = contentType.match(/boundary=("?)([^";]+)\1/i);
  const boundary = boundaryMatch?.[2];
  if (!boundary) {
    throw new Error("Gmail batch response is missing a boundary");
  }

  return raw
    .split(`--${boundary}`)
    .map((part) => {
      const idMatch = part.match(/Content-ID:\s*<?([^>\r\n]+)>?/i);
      const httpStart = part.indexOf("HTTP/1.1");
      if (!idMatch || httpStart < 0) {
        return null;
      }
      const http = part.slice(httpStart);
      const status = Number(http.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0);
      const bodyStart = http.indexOf("\r\n\r\n");
      const body = bodyStart >= 0 ? http.slice(bodyStart + 4).trim() : "";
      const id = idMatch[1].replace(/^response-/, "");
      return { id, status, body };
    })
    .filter((part): part is BatchPart => part !== null);
}

const QUOTA_BACKOFF_MS = 65_000;

function isConcurrencyLimit(status: number, body: string): boolean {
  return status === 429 || /Too many concurrent requests/i.test(body);
}

function isQuotaExceeded(status: number, body: string): boolean {
  return status === 403 && /quota exceeded|rateLimitExceeded/i.test(body);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffFor(status: number, body: string, attempt: number): number {
  if (isQuotaExceeded(status, body)) {
    return QUOTA_BACKOFF_MS;
  }
  return 1000 * 2 ** attempt;
}

async function batchGetChunk(
  accessToken: string,
  ids: string[]
): Promise<{ messages: EmailMessage[]; errors: { id: string; message: string }[] }> {
  let pending = ids;
  const messages: EmailMessage[] = [];
  const errors: { id: string; message: string }[] = [];

  for (let attempt = 0; attempt <= BATCH_RETRY_LIMIT && pending.length > 0; attempt += 1) {
    const boundary = `batch_${crypto.randomUUID()}`;
    const body =
      pending
        .map(
          (id) =>
            `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <${id}>\r\n\r\nGET /gmail/v1/users/me/messages/${id}?format=full\r\n`
        )
        .join("") + `--${boundary}--`;

    const response = await fetch(GMAIL_BATCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/mixed; boundary=${boundary}`,
      },
      body,
    });

    const raw = await response.text();
    if (!response.ok) {
      if (attempt >= BATCH_RETRY_LIMIT) {
        throw new Error(`Gmail API ${response.status}: ${raw}`);
      }
      await delay(backoffFor(response.status, raw, attempt));
      continue;
    }

    const retryIds: string[] = [];
    let retryDelay = 0;
    for (const part of parseBatchResponse(response.headers.get("content-type") ?? "", raw)) {
      if (
        (isQuotaExceeded(part.status, part.body) || isConcurrencyLimit(part.status, part.body)) &&
        attempt < BATCH_RETRY_LIMIT
      ) {
        retryIds.push(part.id);
        retryDelay = Math.max(retryDelay, backoffFor(part.status, part.body, attempt));
        continue;
      }
      if (part.status < 200 || part.status >= 300) {
        errors.push({ id: part.id, message: `Gmail API ${part.status}: ${part.body}` });
        continue;
      }
      messages.push(toEmailMessage(JSON.parse(part.body) as GmailMessage));
    }
    pending = retryIds;
    if (pending.length > 0) {
      await delay(retryDelay);
    }
  }

  for (const id of pending) {
    errors.push({ id, message: "Gmail API 429: Too many concurrent requests for user." });
  }

  return { messages, errors };
}

export async function fetchMessagesByIds(
  accessToken: string,
  ids: string[]
): Promise<{ messages: EmailMessage[]; errors: { id: string; message: string }[] }> {
  const messages: EmailMessage[] = [];
  const errors: { id: string; message: string }[] = [];

  for (let index = 0; index < ids.length; index += BATCH_GET_SIZE) {
    const chunk = await batchGetChunk(
      accessToken,
      ids.slice(index, index + BATCH_GET_SIZE)
    );
    messages.push(...chunk.messages);
    errors.push(...chunk.errors);
  }

  return { messages, errors };
}

export async function listLabels(
  accessToken: string
): Promise<Map<string, string>> {
  const response = await gmailFetch<GmailLabelsResponse>(
    accessToken,
    "/labels"
  );
  const map = new Map<string, string>();
  for (const label of response.labels ?? []) {
    map.set(label.name, label.id);
  }
  return map;
}

export async function ensureLabels(
  accessToken: string,
  names: string[]
): Promise<Map<string, string>> {
  const existing = await listLabels(accessToken);
  const unique = [...new Set(names.filter(Boolean))];

  for (const name of unique) {
    if (existing.has(name)) {
      continue;
    }
    const created = await gmailFetch<GmailLabel>(accessToken, "/labels", {
      method: "POST",
      body: JSON.stringify({
        name,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      }),
    });
    existing.set(created.name, created.id);
  }

  return existing;
}

export type ApplyPayload = {
  messageId: string;
  actions: SuggestedAction[];
};

/**
 * Applies user-approved actions. Trash uses messages.trash; other mutations
 * use messages.batchModify / messages.modify.
 */
export async function applyMessageActions(
  accessToken: string,
  payload: ApplyPayload
): Promise<void> {
  const enabled = payload.actions.filter((action) => action.enabled);
  if (enabled.length === 0) {
    return;
  }

  const labelNames = enabled
    .filter((action) => action.kind === "label" && action.labelName)
    .map((action) => action.labelName as string);

  const labels = labelNames.length
    ? await ensureLabels(accessToken, labelNames)
    : await listLabels(accessToken);

  const addLabelIds: string[] = [];
  const removeLabelIds: string[] = [];
  let shouldTrash = false;

  for (const action of enabled) {
    if (action.kind === "label" && action.labelName) {
      const id = labels.get(action.labelName);
      if (id) {
        addLabelIds.push(id);
      }
    }
    if (action.kind === "archive") {
      removeLabelIds.push("INBOX");
    }
    if (action.kind === "read") {
      removeLabelIds.push("UNREAD");
    }
    if (action.kind === "trash") {
      shouldTrash = true;
    }
  }

  if (addLabelIds.length > 0 || removeLabelIds.length > 0) {
    await gmailFetch(accessToken, `/messages/${payload.messageId}/modify`, {
      method: "POST",
      body: JSON.stringify({
        addLabelIds: [...new Set(addLabelIds)],
        removeLabelIds: [...new Set(removeLabelIds)],
      }),
    });
  }

  if (shouldTrash) {
    await gmailFetch(accessToken, `/messages/${payload.messageId}/trash`, {
      method: "POST",
    });
  }
}

export async function applyActions(
  accessToken: string,
  payloads: ApplyPayload[]
): Promise<{ applied: string[]; errors: { id: string; message: string }[] }> {
  const applied: string[] = [];
  const errors: { id: string; message: string }[] = [];

  for (const payload of payloads) {
    try {
      await applyMessageActions(accessToken, payload);
      applied.push(payload.messageId);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to apply actions";
      errors.push({ id: payload.messageId, message });
    }
  }

  return { applied, errors };
}
