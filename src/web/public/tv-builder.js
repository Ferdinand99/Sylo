// Temp-voice hub builder: just a live name preview. Role chip-pickers are wired
// by app.js; everything else is plain form fields the server normalises.
(() => {
  const input = document.getElementById('tv-name');
  const preview = document.getElementById('tv-preview');
  if (!input || !preview) return;

  const render = () => {
    const t = input.value.trim() || "#{index} - {username}'s Channel";
    preview.textContent = t.replace(/\{index\}/g, '1').replace(/\{count\}/g, '1').replace(/\{username\}/g, 'ferdinand').replace(/\{user\}/g, 'Ferdinand').slice(0, 100);
  };
  input.addEventListener('input', render);
  render();
})();
