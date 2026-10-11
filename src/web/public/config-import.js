// File contents are sent to the authenticated import route, never persisted locally.
(() => {
  const form = document.querySelector('[data-config-import]');
  if (!form || form.dataset.bound) return;
  form.dataset.bound = '1';
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = form.querySelector('[data-import-status]');
    const button = form.querySelector('button');
    const file = form.querySelector('input[type=file]').files[0];
    if (!file) return;
    button.disabled = true;
    status.textContent = 'Wczytywanie konfiguracji…';
    try {
      if (file.size > 3 * 1024 * 1024) throw new Error('Plik jest za duży (maksymalnie 3 MB).');
      let backup;
      try {
        backup = JSON.parse(await file.text());
      } catch {
        throw new Error('Plik nie zawiera poprawnego JSON.');
      }
      const body = JSON.stringify({ backup });
      if (new TextEncoder().encode(body).length > 3 * 1024 * 1024 + 1024)
        throw new Error('Plik jest za duży.');
      const response = await fetch(form.action, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': document.querySelector('meta[name="csrf-token"]')?.content || '',
        },
        body,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Nie udało się przywrócić konfiguracji.');
      status.textContent = result.message;
      form.querySelector('input[type=file]').value = '';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
})();
