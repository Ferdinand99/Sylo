(() => {
  const root = document.getElementById('soundboard');
  if (!root || root.dataset.initialized) return;
  root.dataset.initialized = 'true';
  const base = root.dataset.base;
  const channel = root.querySelector('#sb-channel');
  const status = root.querySelector('#sb-status');
  const stay = root.querySelector('#sb-stay');
  const key = `sylo:soundboard:${base}:channel`;
  try {
    channel.value = localStorage.getItem(key) || '';
    stay.checked = localStorage.getItem(key + ':stay') === 'true';
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
  stay.addEventListener('change', () => {
    try {
      localStorage.setItem(key + ':stay', String(stay.checked));
    } catch {
      /* Storage may be disabled. */
    }
  });
  const notice = (text, error = false) => {
    status.textContent = text;
    status.dataset.error = String(error);
  };
  fetch(base + '/status')
    .then((response) => (response.ok ? response.json() : null))
    .then((state) => {
      if (!state?.connected || status.textContent) return;
      channel.value = state.channelId;
      notice(
        state.playing
          ? 'Bot odtwarza klip na VC.'
          : 'Bot pozostaje na VC. Kliknij klip lub „Zatrzymaj i rozłącz”.'
      );
    })
    .catch(() => {
      /* Controls remain usable if the initial status check fails. */
    });
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
        const result = await request(`/${button.closest('[data-id]').dataset.id}/play`, {
          channelId: channel.value,
          keepConnected: stay.checked,
        });
        notice(
          result.connected
            ? 'Zakończono odtwarzanie. Bot pozostaje na VC.'
            : 'Zakończono odtwarzanie. Bot się rozłączył.'
        );
      } catch (error) {
        notice(error.message, true);
      } finally {
        button.disabled = false;
      }
    })
  );
  root.querySelector('#sb-join').addEventListener('click', async (event) => {
    if (!channel.value) return notice('Najpierw wybierz kanał głosowy.', true);
    event.currentTarget.disabled = true;
    const button = event.currentTarget;
    notice('Bot dołącza do kanału…');
    try {
      await request('/join', { channelId: channel.value });
      stay.checked = true;
      stay.dispatchEvent(new Event('change'));
      notice('Bot pozostaje na VC. Możesz puszczać kolejne klipy lub kliknąć „Zatrzymaj i rozłącz”.');
    } catch (error) {
      notice(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
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
