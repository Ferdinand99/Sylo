import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
// Inter with the opsz axis (optical sizing), like sylobot.com. Self-hosted
// through the build — no font CDN.
import '@fontsource-variable/inter/opsz.css';
import './styles.css';
import './forms.css';
import './pages.css';
import './dashux.css';
// The stylesheets of the pages and components that are loaded on demand. Some of their rules reach every page
// (a field row, a tab row), so they come with the entry and a page looks the same whichever one was opened first.
import './styles/mention-mirror.css';
import './styles/palette.css';
import './styles/wp1-members.css';
import './styles/wp2-alerts.css';
import './styles/wp4-inbox.css';
import './styles/wp5-lists.css';
import './styles/access.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
