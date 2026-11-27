// The small "Powered by Sylo" link at the bottom of every public page. Always shown and not configurable: a
// server's look (accent colour, background; see publicLook.js) never reaches it.
export default function PoweredBy() {
  return (
    <footer className="v2-powered">
      <a href="https://sylobot.com" rel="noopener noreferrer">
        Powered by Sylo
      </a>
    </footer>
  );
}
