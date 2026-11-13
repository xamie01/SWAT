'use strict';
function renderPreview(data) {
  document.getElementById('result').textContent = data.pda
    ? `PDA preview: ${String(data.pda.address)}\nBump: ${String(data.pda.bump)}\nNot a funding instruction. No deployment or authority verified.`
    : 'Preview unavailable. Check the owner public key.';
}
window.renderPreview = renderPreview;
document.getElementById('preview').addEventListener('click', async () => {
  try {
    const owner = document.getElementById('owner').value.trim();
    const response = await fetch(`/api/vault-info?owner=${encodeURIComponent(owner)}`, { cache: 'no-store' });
    renderPreview(response.ok ? await response.json() : {});
  } catch { renderPreview({}); }
});
