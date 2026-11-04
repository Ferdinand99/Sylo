// The verify page: the Verify button stays off until Cloudflare's check has passed (and goes off
// again if the check expires or fails). A plain file, not inline, because the page's
// Content-Security-Policy allows no inline script. Without this script the form still works: the
// button is only switched off here.
(function () {
  var button = document.getElementById('verify-submit');
  if (!button) return;
  button.disabled = true;
  window.syloTurnstileDone = function () {
    button.disabled = false;
  };
  window.syloTurnstileReset = function () {
    button.disabled = true;
  };
})();
