// The public event page (/events/<token>) writes every time as UTC, so it reads without a script.
// This rewrites each <time datetime="..."> in the visitor's own time zone and language, which is
// what the page promises. Loaded from the page's own origin (the Content-Security-Policy allows no
// other script), and it only reads the page: it sends nothing anywhere.
(function () {
  var format;
  try {
    format = new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch (e) {
    return; // no Intl: the UTC text stays
  }
  var times = document.querySelectorAll('time[datetime]');
  for (var i = 0; i < times.length; i += 1) {
    var date = new Date(times[i].getAttribute('datetime'));
    if (!isNaN(date.getTime())) times[i].textContent = format.format(date);
  }
})();
