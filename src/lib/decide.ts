import type {
  ClassificationAnswers,
  EmailCategory,
  SuggestedAction,
} from "./types";

/** Tunable thresholds for mapping Jev answers to mailbox actions. */
export const THRESHOLDS = {
  /** Below this category confidence, suggest Review only. */
  categoryConfidenceMin: 0.6,
  /** Keep in inbox if needs_reply probability exceeds this. */
  needsReplyMin: 0.7,
  /** Keep in inbox if time_sensitive probability exceeds this. */
  timeSensitiveMin: 0.7,
  /** Keep in inbox if written_by_person probability exceeds this. */
  writtenByPersonMin: 0.7,
  /** Keep in inbox if importance score is at or above this (0–3 scale). */
  importanceKeepMin: 2,
  /** Trash promo/newsletter only when importance is below this. */
  importanceTrashMax: 1,
  /** Trash low-importance promo/newsletter older than this many days. */
  trashAgeDays: 30,
} as const;

const ARCHIVEABLE: ReadonlySet<EmailCategory> = new Set([
  "promotion",
  "newsletter",
  "notification",
  "transactional",
]);

const TRASHABLE: ReadonlySet<EmailCategory> = new Set([
  "promotion",
  "newsletter",
]);

export type DecideInput = {
  category: EmailCategory;
  categoryConfidence: number;
  importance: number;
  needsReply: number;
  timeSensitive: number;
  writtenByPerson: number;
  ageDays: number;
};

export type DecideResult = {
  suggestedActions: SuggestedAction[];
  reviewOnly: boolean;
};

function labelAction(category: EmailCategory): SuggestedAction {
  return {
    kind: "label",
    labelName: `Jev/${category}`,
    enabled: true,
  };
}

function shouldKeepInInbox(input: DecideInput): boolean {
  return (
    input.needsReply > THRESHOLDS.needsReplyMin ||
    input.timeSensitive > THRESHOLDS.timeSensitiveMin ||
    input.importance >= THRESHOLDS.importanceKeepMin ||
    input.writtenByPerson > THRESHOLDS.writtenByPersonMin
  );
}

function shouldTrash(input: DecideInput): boolean {
  return (
    TRASHABLE.has(input.category) &&
    input.importance < THRESHOLDS.importanceTrashMax &&
    input.ageDays > THRESHOLDS.trashAgeDays
  );
}

/**
 * Maps Jev classification answers plus email age into suggested mailbox actions.
 * Pure function — unit-tested; no I/O.
 */
export function decideActions(input: DecideInput): DecideResult {
  const label = labelAction(input.category);

  if (input.categoryConfidence < THRESHOLDS.categoryConfidenceMin) {
    return {
      suggestedActions: [{ ...label, enabled: false }],
      reviewOnly: true,
    };
  }

  if (shouldKeepInInbox(input)) {
    return {
      suggestedActions: [label],
      reviewOnly: false,
    };
  }

  if (shouldTrash(input)) {
    return {
      suggestedActions: [
        label,
        { kind: "trash", enabled: true },
        { kind: "read", enabled: true },
      ],
      reviewOnly: false,
    };
  }

  if (ARCHIVEABLE.has(input.category)) {
    return {
      suggestedActions: [
        label,
        { kind: "archive", enabled: true },
        { kind: "read", enabled: true },
      ],
      reviewOnly: false,
    };
  }

  return {
    suggestedActions: [label],
    reviewOnly: false,
  };
}

export function decideFromClassification(
  classification: ClassificationAnswers,
  ageDays: number
): DecideResult {
  return decideActions({
    category: classification.category,
    categoryConfidence: classification.categoryConfidence,
    importance: classification.importance,
    needsReply: classification.needsReply,
    timeSensitive: classification.timeSensitive,
    writtenByPerson: classification.writtenByPerson,
    ageDays,
  });
}
