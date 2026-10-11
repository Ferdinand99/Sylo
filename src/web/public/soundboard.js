(() => {
  const root = document.getElementById('soundboard');
  if (!root || root.dataset.initialized) return;
  root.dataset.initialized = 'true';
  const base = root.dataset.base;
  const channel = root.querySelector('#sb-channel');
  const status = root.querySelector('#sb-status');
  const key = `sylo:soundboard:${base}:channel`;
  try {
    channel.value = localStorage.getItem(key) || '';
  } catch {
    /* Storage may be disabled by the browser. */
  }
  channel.addEventListener('change', () => {
    try {
      localStorage.setItem(key, channel.value);
    } catch {
      /* Storage may be disabled by the browser. */
    }
  });
  const notice = (text, error = false) => {
    status.textContent = text;
    status.dataset.error = String(error);
  };
  async function request(path, body, raw = false) {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': raw ? 'application/octet-stream' : 'application/json',
        'x-csrf-token': document.querySelector('meta[name="csrf-token"]')?.content || '',
      },
      body: raw ? body : JSON.stringify(body || {}),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        result.error || 'Nie udało się wykonać operacji. Odśwież stronę i sprawdź uprawnienia.'
      );
    return result;
  }
  root.querySelectorAll('[data-play]').forEach((button) =>
    button.addEventListener('click', async () => {
      if (!channel.value) return notice('Najpierw wybierz kanał głosowy.', true);
      notice('Bot dołącza i odtwarza klip…');
      button.disabled = true;
      try {
        await request(`/${button.closest('[data-id]').dataset.id}/play`, { channelId: channel.value });
        notice('Zakończono odtwarzanie. Bot się rozłączył.');
      } catch (error) {
        notice(error.message, true);
      } finally {
        button.disabled = false;
      }
    })
  );
  root.querySelector('#sb-stop').addEventListener('click', async () => {
    try {
      await request('/stop');
      notice('Zatrzymano odtwarzanie.');
    } catch (error) {
      notice(error.message, true);
    }
  });
  root.querySelectorAll('[data-delete]').forEach((button) =>
    button.addEventListener('click', async () => {
      if (!confirm('Usunąć ten klip?')) return;
      try {
        await request(`/${button.closest('[data-id]').dataset.id}/delete`);
        location.reload();
      } catch (error) {
        notice(error.message, true);
      }
    })
  );
  root.querySelector('#sb-upload').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      file = form.elements.audio.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) return notice('Plik jest za duży. Limit wynosi 8 MB.', true);
    const button = form.querySelector('button');
    button.disabled = true;
    notice('Przesyłanie i przygotowywanie klipu…');
    try {
      await request(
        `/upload?${new URLSearchParams({ name: form.elements.name.value, filename: file.name })}`,
        file,
        true
      );
      location.reload();
    } catch (error) {
      notice(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
})();
