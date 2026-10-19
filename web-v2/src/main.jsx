import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
// Inter with the opsz axis (optical sizing), like sylobot.com. Self-hosted
// through the build — no font CDN.
import '@fontsource-variable/inter/opsz.css';
import './styles.css';
import './forms.css';
import './pages.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
