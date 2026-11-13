export function validateBackendTarget(value: string, production = process.env.NODE_ENV === 'production'): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid backend URL configuration'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (production && url.protocol !== 'https:' && !loopback)) {
    throw new Error('Backend URL must use HTTPS except exact loopback, without credentials, query or fragment');
  }
  return url.toString().replace(/\/+$/, '');
}

export function resolveBackendTarget(kind: 'api' | 'lp'): string {
  const configured = kind === 'api'
    ? process.env.INTERNAL_API_URL ?? process.env.BACKEND_API_INTERNAL_URL
    : process.env.INTERNAL_LP_URL ?? process.env.BACKEND_LP_INTERNAL_URL;
  return validateBackendTarget(configured ?? `http://127.0.0.1:${kind === 'api' ? 3001 : 3010}`);
}
