/**
 * Spike: call experimental_evaluate via AI Gateway on a sample email.
 * Usage: AI_GATEWAY_API_KEY=... npm run spike:jev
 * Optional: JEV_MODEL=typesafe-ai/jev-latest npm run spike:jev
 */
import { experimental_evaluate } from "ai";
import { EMAIL_QUESTIONS, buildEmailState } from "../src/lib/classify";
import type { EmailMessage } from "../src/lib/types";

const candidates = [
  process.env.JEV_MODEL,
  "typesafe-ai/jev",
  "typesafe-ai/jev-latest",
].filter((value, index, all): value is string =>
  Boolean(value) && all.indexOf(value) === index
);

const sample: EmailMessage = {
  id: "spike",
  threadId: "spike",
  fromName: "Acme Deals",
  fromEmail: "deals@acmeshop.example",
  subject: "Flash sale — 40% off everything this weekend only",
  date: new Date().toISOString(),
  ageDays: 12,
  snippet: "Don't miss our weekend flash sale.",
  body: `Hi there,

Our biggest flash sale of the season is here. Take 40% off sitewide through Sunday.
Shop now: https://acmeshop.example/sale

Unsubscribe anytime.
`,
  hasUnsubscribeHeader: true,
  isUnread: true,
};

async function tryModel(model: string) {
  console.log(`\n--- Trying model: ${model} ---`);
  const result = await experimental_evaluate({
    model,
    state: buildEmailState(sample),
    questions: EMAIL_QUESTIONS,
  });

  console.log("response.modelId:", result.response?.modelId);
  console.log("answers:", JSON.stringify(result.answers, null, 2));
  console.log(
    "providerMetadata:",
    JSON.stringify(result.providerMetadata ?? null, null, 2)
  );
  console.log("usage:", result.usage);
  return result;
}

async function main() {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error(
      "Set AI_GATEWAY_API_KEY before running the spike.\nExample: AI_GATEWAY_API_KEY=... npm run spike:jev"
    );
    process.exit(1);
  }

  let lastError: unknown;
  for (const model of candidates) {
    try {
      await tryModel(model);
      console.log(`\nWorking model ID: ${model}`);
      return;
    } catch (error) {
      lastError = error;
      console.error(`Failed for ${model}:`, error);
    }
  }

  console.error("\nAll model IDs failed.");
  throw lastError;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
