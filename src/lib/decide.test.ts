import { describe, expect, it } from "vitest";
import { decideActions, THRESHOLDS } from "./decide";
import type { DecideInput } from "./decide";

function base(overrides: Partial<DecideInput> = {}): DecideInput {
  return {
    category: "newsletter",
    categoryConfidence: 0.9,
    importance: 0.2,
    needsReply: 0.1,
    timeSensitive: 0.1,
    writtenByPerson: 0.1,
    ageDays: 5,
    ...overrides,
  };
}

function kinds(input: DecideInput) {
  const result = decideActions(input);
  return {
    kinds: result.suggestedActions
      .filter((a) => a.enabled)
      .map((a) => a.kind),
    reviewOnly: result.reviewOnly,
    labelName: result.suggestedActions.find((a) => a.kind === "label")
      ?.labelName,
  };
}

describe("decideActions", () => {
  it("suggests Review only when category confidence is low", () => {
    const result = kinds(
      base({ categoryConfidence: THRESHOLDS.categoryConfidenceMin - 0.01 })
    );
    expect(result.reviewOnly).toBe(true);
    expect(result.kinds).toEqual([]);
  });

  it("always proposes a Jev/<category> label when confident", () => {
    const result = kinds(base({ category: "work", importance: 2.5 }));
    expect(result.labelName).toBe("Jev/work");
    expect(result.kinds).toContain("label");
  });

  it("keeps personal mail in inbox (label only)", () => {
    const result = kinds(
      base({
        category: "personal",
        writtenByPerson: 0.9,
        importance: 1.5,
      })
    );
    expect(result.kinds).toEqual(["label"]);
    expect(result.reviewOnly).toBe(false);
  });

  it("keeps mail that needs a reply", () => {
    const result = kinds(
      base({
        category: "newsletter",
        needsReply: THRESHOLDS.needsReplyMin + 0.05,
        importance: 0,
      })
    );
    expect(result.kinds).toEqual(["label"]);
  });

  it("keeps time-sensitive mail", () => {
    const result = kinds(
      base({
        category: "promotion",
        timeSensitive: THRESHOLDS.timeSensitiveMin + 0.05,
      })
    );
    expect(result.kinds).toEqual(["label"]);
  });

  it("keeps high-importance mail", () => {
    const result = kinds(
      base({
        category: "notification",
        importance: THRESHOLDS.importanceKeepMin,
      })
    );
    expect(result.kinds).toEqual(["label"]);
  });

  it("archives and marks read for recent newsletters", () => {
    const result = kinds(
      base({
        category: "newsletter",
        ageDays: 5,
        importance: 0.2,
      })
    );
    expect(result.kinds).toEqual(["label", "archive", "read"]);
  });

  it("archives transactional and notification mail", () => {
    expect(
      kinds(base({ category: "transactional", ageDays: 2 })).kinds
    ).toEqual(["label", "archive", "read"]);
    expect(
      kinds(base({ category: "notification", ageDays: 2 })).kinds
    ).toEqual(["label", "archive", "read"]);
  });

  it("trashes old low-importance promotions and newsletters", () => {
    const promo = kinds(
      base({
        category: "promotion",
        importance: THRESHOLDS.importanceTrashMax - 0.1,
        ageDays: THRESHOLDS.trashAgeDays + 1,
      })
    );
    expect(promo.kinds).toEqual(["label", "trash", "read"]);

    const news = kinds(
      base({
        category: "newsletter",
        importance: 0,
        ageDays: 60,
      })
    );
    expect(news.kinds).toEqual(["label", "trash", "read"]);
  });

  it("does not trash recent low-importance promotions", () => {
    const result = kinds(
      base({
        category: "promotion",
        importance: 0,
        ageDays: THRESHOLDS.trashAgeDays - 1,
      })
    );
    expect(result.kinds).toEqual(["label", "archive", "read"]);
  });

  it("labels only for work and other categories", () => {
    expect(kinds(base({ category: "work", importance: 1 })).kinds).toEqual([
      "label",
    ]);
    expect(kinds(base({ category: "other", importance: 1 })).kinds).toEqual([
      "label",
    ]);
  });
});
