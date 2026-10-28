import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getGuildEmojis } from '../api.js';

const COMMON = (
  '😀 😂 😍 😎 🤔 😴 🥳 😢 😡 👍 👎 👌 🙏 👏 🙌 💪 🔥 ✨ ⭐ 🌟 💯 ✅ ❌ ⚠️ ❗ ❓ 💡 🔔 📌 📢 ' +
  '🎮 🕹️ 🎧 🎵 🎬 📷 💻 📱 🖥️ ⌨️ 🛠️ ⚙️ 🔧 🔒 🔑 🚀 🛰️ 🌍 🗺️ 🏆 🥇 🎯 🎲 ♠️ ♥️ ♦️ ♣️ ' +
  '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💖 💗 🎉 🎊 🎁 🍕 🍔 🍟 🌮 🍺 🍻 ☕ 🧊 🐶 🐱 🦊 🐸 🐼 🦁 🐢 🐧'
).split(' ');

// The server's custom emojis are fetched once per server and shared by every picker on the page.
const customByGuild = new Map();
function loadCustom(guildId) {
  if (!customByGuild.has(guildId)) {
    customByGuild.set(
      guildId,
      getGuildEmojis(guildId)
        .then((r) => r.custom || [])
        .catch(() => {
          customByGuild.delete(guildId);
          return [];
        })
    );
  }
  return customByGuild.get(guildId);
}

// A small emoji button for a text field: the server's own emojis first, then a common set.
// Same open/close pattern as ColorPicker.jsx; calls onPick(value) with the text to put in the field.
export default function EmojiPicker({ onPick }) {
  const { guildId } = useParams();
  const detailsRef = useRef(null);
  const [custom, setCustom] = useState([]);

  function close() {
    if (detailsRef.current) detailsRef.current.open = false;
  }

  useEffect(() => {
    function onDocClick(e) {
      if (detailsRef.current?.open && !detailsRef.current.contains(e.target)) close();
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  function onToggle(e) {
    if (e.currentTarget.open) loadCustom(guildId).then(setCustom);
  }

  function pick(value) {
    onPick(value);
    close();
  }

  return (
    <details className="v2-emojipicker" ref={detailsRef} onToggle={onToggle}>
      <summary className="v2-emojipicker-btn" title="Pick an emoji" aria-label="Pick an emoji">
        😀
      </summary>
      <div className="v2-emojipicker-panel">
        {custom.length > 0 ? (
          <>
            <div className="v2-emojipicker-label">Server</div>
            <div className="v2-emojipicker-grid">
              {custom.map((e) => (
                <button
                  key={e.display}
                  type="button"
                  className="v2-emojipicker-cell"
                  title={`:${e.name}:`}
                  aria-label={`Use :${e.name}:`}
                  onClick={() => pick(e.display)}
                >
                  <img src={e.url} alt="" width="22" height="22" />
                </button>
              ))}
            </div>
          </>
        ) : null}
        <div className="v2-emojipicker-label">Emoji</div>
        <div className="v2-emojipicker-grid">
          {COMMON.map((e) => (
            <button key={e} type="button" className="v2-emojipicker-cell" onClick={() => pick(e)}>
              {e}
            </button>
          ))}
        </div>
      </div>
    </details>
  );
}
