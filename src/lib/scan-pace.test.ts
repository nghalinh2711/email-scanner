import { describe, expect, it } from "vitest";
import { uncategorizedInboxQuery } from "./scan-pace";

describe("uncategorizedInboxQuery", () => {
  it("searches the inbox and skips every Jev category label", () => {
    const query = uncategorizedInboxQuery();
    expect(query.startsWith("in:inbox ")).toBe(true);
    expect(query).toContain('-label:"Jev/personal"');
    expect(query).toContain('-label:"Jev/newsletter"');
    expect(query).toContain('-label:"Jev/other"');
    expect(query).not.toContain("label:inbox");
  });
});
