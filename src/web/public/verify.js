// The verify page: the Verify button stays off until Cloudflare's check has passed (and goes off
// again if the check expires, times out or fails). A plain file, not inline, because the page's
// Content-Security-Policy allows no inline script.
//
// It is loaded before Cloudflare's script (verify.ejs), so the callbacks exist whenever the widget
// renders, however fast that is. Nothing here looks at the page until it is asked to: the button is
// looked up on each call, and the first pass over the page (DOMContentLoaded) only switches the
// button off if the check has not passed already. Without this script the form still works; the
// button is only ever switched off here.
(function () {
  var passed = false;

  function apply() {
    var button = document.getElementById('verify-submit');
    var hint = document.getElementById('verify-hint');
    if (button) button.disabled = !passed;
    if (hint) hint.hidden = passed;
  }

  window.syloTurnstileDone = function () {
    passed = true;
    apply();
  };
  window.syloTurnstileReset = function () {
    passed = false;
    apply();
  };

  document.addEventListener('DOMContentLoaded', apply);
})();
