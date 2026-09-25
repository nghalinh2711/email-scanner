"use client";

import { signIn, signOut, useSession } from "next-auth/react";
import { useMemo, useRef, useState, useTransition } from "react";
import {
  applyEmailActions,
  classifyMessageIds,
  listUncategorizedIds,
} from "@/app/actions";
import { SCAN_WAVE_SIZE, waitForNextWave } from "@/lib/scan-pace";
import type {
  ClassifiedEmail,
  EmailCategory,
  SuggestedAction,
  SuggestedActionKind,
} from "@/lib/types";
import { EMAIL_CATEGORIES } from "@/lib/types";

function sleepUntil(ms: number, shouldStop: () => boolean): Promise<void> {
  const endsAt = Date.now() + ms;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (shouldStop() || Date.now() >= endsAt) {
        clearInterval(timer);
        resolve();
      }
    }, 250);
  });
}

function formatAge(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "1d";
  return `${days}d`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function categoryColor(category: EmailCategory): string {
  const colors: Record<EmailCategory, string> = {
    personal: "bg-emerald-100 text-emerald-900",
    work: "bg-sky-100 text-sky-900",
    newsletter: "bg-violet-100 text-violet-900",
    promotion: "bg-amber-100 text-amber-900",
    transactional: "bg-slate-100 text-slate-800",
    notification: "bg-orange-100 text-orange-900",
    other: "bg-zinc-100 text-zinc-800",
  };
  return colors[category];
}

function toggleAction(
  actions: SuggestedAction[],
  kind: SuggestedActionKind
): SuggestedAction[] {
  return actions.map((action) =>
    action.kind === kind ? { ...action, enabled: !action.enabled } : action
  );
}

function addMissingAction(
  actions: SuggestedAction[],
  kind: SuggestedActionKind,
  labelName?: string
): SuggestedAction[] {
  if (actions.some((action) => action.kind === kind)) {
    return toggleAction(actions, kind);
  }
  return [
    ...actions,
    {
      kind,
      enabled: true,
      ...(kind === "label" && labelName ? { labelName } : {}),
    },
  ];
}

export function InboxCleaner() {
  const { data: session, status } = useSession();
  const [emails, setEmails] = useState<ClassifiedEmail[]>([]);
  const [errors, setErrors] = useState<{ id: string; message: string }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<EmailCategory | "all">(
    "all"
  );
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null
  );
  const [isScanning, setIsScanning] = useState(false);
  const stopScan = useRef(false);
  const [isPending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    if (categoryFilter === "all") return emails;
    return emails.filter(
      (email) => email.classification.category === categoryFilter
    );
  }, [emails, categoryFilter]);

  function updateEmail(
    id: string,
    updater: (email: ClassifiedEmail) => ClassifiedEmail
  ) {
    setEmails((current) =>
      current.map((email) => (email.id === id ? updater(email) : email))
    );
  }

  async function handleScan() {
    stopScan.current = false;
    setIsScanning(true);
    setStatusMessage("Listing inbox mail without a Jev label…");
    setErrors([]);

    try {
      const { ids } = await listUncategorizedIds();
      const known = new Set(emails.map((email) => email.id));
      const pending = ids.filter((id) => !known.has(id));
      setProgress({ done: 0, total: pending.length });

      if (pending.length === 0) {
        setStatusMessage(
          ids.length === 0
            ? "Inbox has no mail without a Jev label."
            : "Every uncategorized inbox message is already in this list."
        );
        return;
      }

      let classified = 0;
      const waveErrors: { id: string; message: string }[] = [];

      for (let index = 0; index < pending.length; index += SCAN_WAVE_SIZE) {
        if (stopScan.current) {
          break;
        }
        const waveStarted = Date.now();
        const slice = pending.slice(index, index + SCAN_WAVE_SIZE);
        setStatusMessage(
          `Classifying ${index + 1}–${index + slice.length} of ${pending.length}`
        );
        const result = await classifyMessageIds(slice);
        classified += result.emails.length;
        waveErrors.push(...result.errors);
        setEmails((current) => {
          const seen = new Set(current.map((email) => email.id));
          return [
            ...current,
            ...result.emails.filter((email) => !seen.has(email.id)),
          ];
        });
        setErrors(waveErrors.slice(-8));
        setProgress({
          done: Math.min(index + slice.length, pending.length),
          total: pending.length,
        });

        const remaining = index + SCAN_WAVE_SIZE < pending.length;
        const pauseMs = waitForNextWave(waveStarted);
        if (remaining && pauseMs > 0 && !stopScan.current) {
          setStatusMessage(
            `Classified ${classified}. Waiting ${Math.ceil(pauseMs / 1000)}s so Gmail quota can recover.`
          );
          await sleepUntil(pauseMs, () => stopScan.current);
        }
      }

      setStatusMessage(
        stopScan.current
          ? `Stopped after classifying ${classified} of ${pending.length}.`
          : `Classified ${classified} uncategorized emails.`
      );
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Scan failed");
    } finally {
      setIsScanning(false);
    }
  }

  function handleApply() {
    const items = filtered
      .filter((email) => selected.has(email.id))
      .map((email) => ({
        messageId: email.id,
        actions: email.suggestedActions.filter((action) => action.enabled),
      }))
      .filter((item) => item.actions.length > 0);

    if (items.length === 0) {
      setStatusMessage("Select rows with at least one enabled action.");
      return;
    }

    setStatusMessage(null);
    startTransition(async () => {
      try {
        const result = await applyEmailActions(items);
        const applied = new Set(result.applied);
        setEmails((current) =>
          current.filter((email) => !applied.has(email.id))
        );
        setSelected((current) => {
          const next = new Set(current);
          for (const id of applied) next.delete(id);
          return next;
        });
        setStatusMessage(
          `Applied ${result.applied.length}` +
            (result.errors.length
              ? `; ${result.errors.length} failed`
              : "")
        );
        if (result.errors.length) {
          setErrors(result.errors);
        }
      } catch (error) {
        setStatusMessage(
          error instanceof Error ? error.message : "Apply failed"
        );
      }
    });
  }

  function toggleSelectAll() {
    if (filtered.every((email) => selected.has(email.id))) {
      setSelected((current) => {
        const next = new Set(current);
        for (const email of filtered) next.delete(email.id);
        return next;
      });
      return;
    }
    setSelected((current) => {
      const next = new Set(current);
      for (const email of filtered) next.add(email.id);
      return next;
    });
  }

  if (status === "loading") {
    return <p className="text-sm text-zinc-500">Loading session…</p>;
  }

  if (!session) {
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-4 py-16">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">
          Jev Gmail Cleaner
        </h1>
        <p className="text-zinc-600">
          Sign in with Google, scan your inbox, and approve cleanup actions
          suggested by TypeSafe&apos;s Jev model.
        </p>
        <button
          type="button"
          onClick={() => signIn("google")}
          className="w-fit rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
        >
          Sign in with Google
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
            Jev Gmail Cleaner
          </h1>
          <p className="mt-1 text-sm text-zinc-600">
            Signed in as {session.user?.email}
          </p>
        </div>
        <button
          type="button"
          onClick={() => signOut()}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
        >
          Sign out
        </button>
      </header>

      <section className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 bg-white p-4">
        <button
          type="button"
          disabled={isScanning}
          onClick={handleScan}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
        >
          {isScanning ? "Scanning…" : "Scan uncategorized"}
        </button>
        {isScanning && (
          <button
            type="button"
            onClick={() => {
              stopScan.current = true;
            }}
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            Stop
          </button>
        )}

        <label className="flex flex-col gap-1 text-sm text-zinc-700">
          Category filter
          <select
            value={categoryFilter}
            onChange={(event) =>
              setCategoryFilter(
                event.target.value as EmailCategory | "all"
              )
            }
            className="rounded-md border border-zinc-300 px-2 py-1.5"
          >
            <option value="all">All</option>
            {EMAIL_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          disabled={isPending || selected.size === 0}
          onClick={handleApply}
          className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
        >
          Apply to selected ({selected.size})
        </button>
      </section>

      {progress && progress.total > 0 && (
        <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200">
          <div
            className="h-full bg-zinc-900"
            style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
          />
        </div>
      )}

      {statusMessage && (
        <p className="text-sm text-zinc-700">{statusMessage}</p>
      )}

      {errors.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">Some items failed</p>
          <ul className="mt-1 list-disc pl-5">
            {errors.slice(0, 5).map((error) => (
              <li key={error.id}>
                {error.id}: {error.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="Select all visible"
                  checked={
                    filtered.length > 0 &&
                    filtered.every((email) => selected.has(email.id))
                  }
                  onChange={toggleSelectAll}
                />
              </th>
              <th className="px-3 py-2">From</th>
              <th className="px-3 py-2">Subject</th>
              <th className="px-3 py-2">Age</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-8 text-center text-zinc-500"
                >
                  No emails yet. Scan uncategorized inbox mail to classify with Jev.
                </td>
              </tr>
            ) : (
              filtered.map((email) => {
                const isOpen = expanded === email.id;
                return (
                  <EmailRow
                    key={email.id}
                    email={email}
                    selected={selected.has(email.id)}
                    expanded={isOpen}
                    onToggleSelect={() => {
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(email.id)) next.delete(email.id);
                        else next.add(email.id);
                        return next;
                      });
                    }}
                    onToggleExpand={() =>
                      setExpanded(isOpen ? null : email.id)
                    }
                    onToggleAction={(kind) =>
                      updateEmail(email.id, (current) => ({
                        ...current,
                        suggestedActions: addMissingAction(
                          current.suggestedActions,
                          kind,
                          `Jev/${current.classification.category}`
                        ),
                      }))
                    }
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmailRow({
  email,
  selected,
  expanded,
  onToggleSelect,
  onToggleExpand,
  onToggleAction,
}: {
  email: ClassifiedEmail;
  selected: boolean;
  expanded: boolean;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  onToggleAction: (kind: SuggestedActionKind) => void;
}) {
  const { classification } = email;
  const actionKinds: SuggestedActionKind[] = [
    "label",
    "archive",
    "read",
    "trash",
  ];

  return (
    <>
      <tr className="border-b border-zinc-100 align-top hover:bg-zinc-50/80">
        <td className="px-3 py-3">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            aria-label={`Select ${email.subject}`}
          />
        </td>
        <td className="px-3 py-3">
          <div className="font-medium text-zinc-900">{email.fromName}</div>
          <div className="text-xs text-zinc-500">{email.fromEmail}</div>
        </td>
        <td className="px-3 py-3">
          <button
            type="button"
            onClick={onToggleExpand}
            className="text-left font-medium text-zinc-900 hover:underline"
          >
            {email.subject}
          </button>
          {email.reviewOnly && (
            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
              Review
            </span>
          )}
        </td>
        <td className="px-3 py-3 text-zinc-600">{formatAge(email.ageDays)}</td>
        <td className="px-3 py-3">
          <span
            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${categoryColor(classification.category)}`}
          >
            {classification.category}
          </span>
          <div className="mt-1 text-xs text-zinc-500">
            conf {formatPercent(classification.categoryConfidence)}
          </div>
        </td>
        <td className="px-3 py-3">
          <div className="flex flex-wrap gap-1.5">
            {actionKinds.map((kind) => {
              const action = email.suggestedActions.find((a) => a.kind === kind);
              const enabled = action?.enabled ?? false;
              const label =
                kind === "label"
                  ? action?.labelName ?? `Jev/${classification.category}`
                  : kind;
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => onToggleAction(kind)}
                  className={`rounded-full border px-2 py-0.5 text-xs ${
                    enabled
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-300 bg-white text-zinc-500"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-zinc-100 bg-zinc-50">
          <td colSpan={6} className="px-3 py-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Jev answers
                </h3>
                <pre className="mt-2 overflow-x-auto rounded-md bg-white p-3 text-xs text-zinc-800">
                  {JSON.stringify(
                    {
                      category: classification.category,
                      categoryConfidence: classification.categoryConfidence,
                      categoryProbabilities:
                        classification.categoryProbabilities,
                      importance: classification.importance,
                      importanceConfidence:
                        classification.importanceConfidence,
                      importanceProbabilities:
                        classification.importanceProbabilities,
                      needsReply: classification.needsReply,
                      timeSensitive: classification.timeSensitive,
                      writtenByPerson: classification.writtenByPerson,
                    },
                    null,
                    2
                  )}
                </pre>
              </div>
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Body preview
                </h3>
                <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-white p-3 text-xs text-zinc-700">
                  {email.body.slice(0, 1500) || email.snippet}
                </p>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
