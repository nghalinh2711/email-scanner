import { Providers } from "@/components/providers";
import { InboxCleaner } from "@/components/inbox-cleaner";

export default function Home() {
  return (
    <Providers>
      <main className="min-h-full bg-zinc-100 px-4">
        <InboxCleaner />
      </main>
    </Providers>
  );
}
