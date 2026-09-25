export const EMAIL_CATEGORIES = [
  "personal",
  "work",
  "newsletter",
  "promotion",
  "transactional",
  "notification",
  "other",
] as const;

export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

export type SuggestedActionKind = "label" | "archive" | "read" | "trash";

export type SuggestedAction = {
  kind: SuggestedActionKind;
  /** Label name when kind is "label", e.g. "Jev/newsletter". */
  labelName?: string;
  enabled: boolean;
};

export type EmailMessage = {
  id: string;
  threadId: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  date: string;
  ageDays: number;
  snippet: string;
  body: string;
  hasUnsubscribeHeader: boolean;
  isUnread: boolean;
};

export type ClassificationAnswers = {
  category: EmailCategory;
  categoryConfidence: number;
  categoryProbabilities: Record<string, number>;
  importance: number;
  importanceConfidence: number;
  importanceProbabilities: Record<string, number>;
  needsReply: number;
  timeSensitive: number;
  writtenByPerson: number;
};

export type ClassifiedEmail = EmailMessage & {
  classification: ClassificationAnswers;
  suggestedActions: SuggestedAction[];
  reviewOnly: boolean;
};

export type ScanResult = {
  emails: ClassifiedEmail[];
  errors: { id: string; message: string }[];
};
