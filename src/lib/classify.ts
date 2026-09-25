import { experimental_evaluate } from "ai";
import type { ClassificationAnswers, EmailCategory, EmailMessage } from "./types";
import { EMAIL_CATEGORIES } from "./types";

const BODY_CHAR_LIMIT = 2000;
const DEFAULT_MODEL = "typesafe-ai/jev";
const CLASSIFY_CONCURRENCY = 12;

export type EmailState = {
  from: { name: string; email: string };
  subject: string;
  body: string;
  has_unsubscribe_header: boolean;
};

export function buildEmailState(email: EmailMessage): EmailState {
  return {
    from: { name: email.fromName, email: email.fromEmail },
    subject: email.subject,
    body: email.body.slice(0, BODY_CHAR_LIMIT),
    has_unsubscribe_header: email.hasUnsubscribeHeader,
  };
}

/**
 * Atomic Jev questions for one email. Contrastive criteria follow TypeSafe
 * guidance so options do not bleed into each other.
 */
export const EMAIL_QUESTIONS = {
  category: {
    type: "choice" as const,
    instructions: {
      question: "What is the primary category of this email?",
      focus:
        "Classify by intent and audience. Prefer the most specific match. Use `from`, `subject`, `body`, and `has_unsubscribe_header`.",
    },
    criteria: {
      personal: {
        what: "A message from a person you know, about life or a personal matter",
        not_for: "Work tasks, bulk marketing, or automated alerts",
        examples: ["Dinner Friday?", "Thanks for the gift"],
      },
      work: {
        what: "A professional message from a colleague, client, or recruiter about work",
        not_for: "Automated SaaS digests or marketing from vendors",
        examples: ["Can you review the deck?", "Interview availability"],
      },
      newsletter: {
        what: "A recurring editorial digest or blog roundup, often with unsubscribe",
        not_for: "One-off sale blasts or transactional receipts",
        examples: ["Weekly tech digest", "This week in design"],
      },
      promotion: {
        what: "Marketing meant to sell a product, service, or event",
        not_for: "Order confirmations or account security alerts",
        examples: ["40% off this weekend", "Flash sale ends tonight"],
      },
      transactional: {
        what: "A receipt, order update, invoice, shipping notice, or bill",
        not_for: "Marketing offers or editorial newsletters",
        examples: ["Your order shipped", "Payment receipt #4821"],
      },
      notification: {
        what: "An automated alert from an app, social network, or system",
        not_for: "Human-written personal or work messages",
        examples: ["New login detected", "Someone liked your photo"],
      },
      other: {
        what: "Does not clearly fit the other categories",
        not_for: "Anything that clearly matches another option",
        examples: ["Ambiguous or mixed-purpose messages"],
      },
    },
  },
  importance: {
    type: "score" as const,
    instructions: {
      question: "How important is this email for the recipient to see soon?",
      focus: "Judge necessity of attention, not how urgent the sender sounds.",
      inspect: ["`subject`", "`body`", "`from`"],
    },
    criteria: [
      {
        what: "Safe to ignore or delete",
        signals: ["Bulk marketing", "No personal ask"],
      },
      {
        what: "Mildly useful but not time-critical",
        signals: ["FYI digest", "Optional update"],
      },
      {
        what: "Worth reading soon",
        signals: ["Relevant work or personal update", "May need a reply"],
      },
      {
        what: "Important — must not miss",
        signals: ["Deadline", "Money or access at stake", "Direct personal ask"],
      },
    ],
  },
  needs_reply: {
    type: "boolean" as const,
    instructions: {
      question: "Does `body` directly ask the recipient to respond or take an action?",
      focus: "Require an explicit ask aimed at the recipient, not a general CTA in marketing copy.",
    },
    criteria: {
      true: {
        what: "Asks the recipient to reply, confirm, decide, or complete a specific task",
        examples: ["Can you send the file?", "Please confirm by Friday"],
      },
      false: {
        what: "Informational only, or has only generic marketing CTAs",
        examples: ["Shop now", "Here is your weekly digest"],
      },
    },
  },
  time_sensitive: {
    type: "boolean" as const,
    instructions: {
      question:
        "Does the email mention a deadline, appointment, or action that expires soon?",
      focus: "Look for concrete time bounds, not vague urgency words alone.",
    },
    criteria: {
      true: {
        what: "Names a deadline, meeting time, or expiring offer tied to a date or short window",
        examples: ["Meeting tomorrow at 3pm", "Offer ends Sunday"],
      },
      false: {
        what: "No concrete time-bound action",
        examples: ["Whenever you have a minute", "Ongoing sale"],
      },
    },
  },
  written_by_person: {
    type: "boolean" as const,
    instructions: {
      question:
        "Was this email written by a person specifically for the recipient, rather than generated for many recipients?",
      focus: "Use tone, personalization, and sender type. Bulk senders with unsubscribe lean no.",
    },
    criteria: {
      true: {
        what: "Appears individually authored and addressed to this recipient",
        examples: ["Hey Sam, following up on our call"],
      },
      false: {
        what: "Looks templated, automated, or broadcast to a list",
        examples: ["Dear customer", "Unsubscribe | View in browser"],
      },
    },
  },
} as const;

type TypesafeConfidence = {
  typesafe?: {
    confidence?: Record<string, number>;
  };
};

function isEmailCategory(value: string): value is EmailCategory {
  return (EMAIL_CATEGORIES as readonly string[]).includes(value);
}

function readConfidence(
  metadata: TypesafeConfidence | undefined,
  questionId: string
): number {
  return metadata?.typesafe?.confidence?.[questionId] ?? 0;
}

export async function classifyEmail(
  email: EmailMessage
): Promise<ClassificationAnswers> {
  const model = process.env.JEV_MODEL ?? DEFAULT_MODEL;
  const state = buildEmailState(email);

  const result = await experimental_evaluate({
    model,
    state,
    questions: EMAIL_QUESTIONS,
  });

  const { answers } = result;
  const confidence = result.providerMetadata as TypesafeConfidence | undefined;

  const categoryChoice = answers.category.choice;
  if (!isEmailCategory(categoryChoice)) {
    throw new Error(`Unexpected category from Jev: ${categoryChoice}`);
  }

  return {
    category: categoryChoice,
    categoryConfidence: readConfidence(confidence, "category"),
    categoryProbabilities: answers.category.probabilities ?? {
      [categoryChoice]: 1,
    },
    importance: answers.importance.score,
    importanceConfidence: readConfidence(confidence, "importance"),
    importanceProbabilities: answers.importance.probabilities ?? {},
    needsReply: answers.needs_reply.probability,
    timeSensitive: answers.time_sensitive.probability,
    writtenByPerson: answers.written_by_person.probability,
  };
}

/**
 * Classifies emails with a fixed concurrency cap to stay polite to the Gateway.
 */
export async function classifyEmails(
  emails: EmailMessage[]
): Promise<{
  results: Map<string, ClassificationAnswers>;
  errors: { id: string; message: string }[];
}> {
  const results = new Map<string, ClassificationAnswers>();
  const errors: { id: string; message: string }[] = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < emails.length) {
      const index = nextIndex;
      nextIndex += 1;
      const email = emails[index];
      try {
        const classification = await classifyEmail(email);
        results.set(email.id, classification);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown classification error";
        errors.push({ id: email.id, message });
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(CLASSIFY_CONCURRENCY, emails.length) },
    () => worker()
  );
  await Promise.all(workers);

  return { results, errors };
}
