"use client";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="page-stack">
      <div className="panel">
        <div className="panel-heading">
          <div>
            <h2>This page could not load</h2>
            <p>{error.message || "The clinic database did not answer."} Check the connection, then try again.</p>
          </div>
          <button className="button-primary" type="button" onClick={reset}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
