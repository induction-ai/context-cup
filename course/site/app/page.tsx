import Link from "next/link";

export default function Home() {
  return (
    <div className="container py-4">
      <h1 className="mb-3">Context Cup</h1>
      <p className="lead text-body-secondary" style={{ maxWidth: "62ch" }}>
        Context Cup benchmarks context-management strategies. Each driver
        decides what an agent keeps, compresses, drops, or retrieves as its
        context grows; the course runs every driver through the same benchmarks
        and scores it on accuracy and cost.
      </p>
      <div className="d-flex gap-2">
        <Link className="btn btn-primary" href="/leaderboard">
          Leaderboard
        </Link>
        <Link className="btn btn-outline-secondary" href="/suites">
          Browse suite runs
        </Link>
      </div>
    </div>
  );
}
