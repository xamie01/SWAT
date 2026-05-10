async function getApiStatus() {
  try {
    const response = await fetch('http://localhost:3001/v1/health', { cache: 'no-store' });
    if (!response.ok) return 'unreachable';
    const json = (await response.json()) as { status?: string };
    return json.status ?? 'unknown';
  } catch {
    return 'unreachable';
  }
}

export default async function HomePage() {
  const apiStatus = await getApiStatus();

  return (
    <main>
      <h1>SWAT Dashboard (MVP Scaffold)</h1>
      <p>Solana Wallet Analysis & Tracking monorepo is initialized.</p>
      <p>API status: <strong>{apiStatus}</strong></p>
      <ul>
        <li>Wallet ingestion/indexing scaffold</li>
        <li>Pattern signal engine scaffold</li>
        <li>Trade executor with paper mode</li>
        <li>Alert service integration point</li>
      </ul>
    </main>
  );
}
