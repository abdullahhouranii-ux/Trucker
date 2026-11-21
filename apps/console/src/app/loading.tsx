export default function Loading() {
  return (
    <main id="main" tabIndex={-1}>
      <div className="page page-narrow" aria-busy="true">
        <p role="status">Loading the staff workspace…</p>
        <div className="loading-placeholder" aria-hidden="true" />
      </div>
    </main>
  );
}
