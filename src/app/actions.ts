"use server";

import { auth } from "@/auth";
import { classifyEmails } from "@/lib/classify";
import { decideFromClassification } from "@/lib/decide";
import { applyActions, fetchMessagesByIds, listUncategorizedInboxIds } from "@/lib/gmail";
import { SCAN_WAVE_SIZE } from "@/lib/scan-pace";
import type { ClassifiedEmail, ScanResult, SuggestedAction } from "@/lib/types";

async function requireAccessToken(): Promise<string> {
  const session = await auth();
  if (!session?.accessToken) {
    throw new Error("Not signed in. Sign in with Google first.");
  }
  return session.accessToken;
}

export async function listUncategorizedIds(): Promise<{ ids: string[] }> {
  const accessToken = await requireAccessToken();
  const ids = await listUncategorizedInboxIds(accessToken);
  return { ids };
}

export async function classifyMessageIds(ids: string[]): Promise<ScanResult> {
  if (ids.length === 0) {
    return { emails: [], errors: [] };
  }
  if (ids.length > SCAN_WAVE_SIZE) {
    throw new Error(`Classify at most ${SCAN_WAVE_SIZE} messages per wave.`);
  }

  const accessToken = await requireAccessToken();
  const fetched = await fetchMessagesByIds(accessToken, ids);
  const quotaError = fetched.errors.find((error) =>
    /429|403|rateLimit|Quota exceeded/i.test(error.message)
  );
  if (quotaError) {
    throw new Error(quotaError.message);
  }

  const { results, errors } = await classifyEmails(fetched.messages);
  const classified: ClassifiedEmail[] = [];
  for (const email of fetched.messages) {
    const classification = results.get(email.id);
    if (!classification) {
      continue;
    }
    const decision = decideFromClassification(classification, email.ageDays);
    classified.push({
      ...email,
      classification,
      suggestedActions: decision.suggestedActions,
      reviewOnly: decision.reviewOnly,
    });
  }

  return { emails: classified, errors: [...fetched.errors, ...errors] };
}

export async function applyEmailActions(
  items: { messageId: string; actions: SuggestedAction[] }[]
): Promise<{ applied: string[]; errors: { id: string; message: string }[] }> {
  const accessToken = await requireAccessToken();
  return applyActions(accessToken, items);
}
