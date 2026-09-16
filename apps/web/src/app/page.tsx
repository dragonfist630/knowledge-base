const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">Knowledge Base</h1>
      <p className="max-w-md text-sm text-neutral-500">
        Phase 0 scaffold: monorepo, apps, and packages are wired up. Auth,
        documents, and chat arrive in later phases.
      </p>
      <p className="text-xs text-neutral-400">
        API health check:{" "}
        <code className="rounded bg-neutral-100 px-1 py-0.5">
          {API_URL}/health
        </code>
      </p>
    </main>
  );
}
