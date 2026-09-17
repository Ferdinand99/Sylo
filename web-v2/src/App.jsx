import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Shell from './components/Shell.jsx';
import GuildPicker from './pages/GuildPicker.jsx';
import Overview from './pages/Overview.jsx';
import Leaderboard from './pages/Leaderboard.jsx';
import Settings from './pages/Settings.jsx';
import Personalizer from './pages/Personalizer.jsx';
import Health from './pages/Health.jsx';

export default function App() {
  return (
    <BrowserRouter basename="/v2">
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<GuildPicker />} />
          <Route path="guilds/:guildId" element={<Overview />} />
          <Route path="guilds/:guildId/leaderboard" element={<Leaderboard />} />
          <Route path="guilds/:guildId/settings" element={<Settings />} />
          <Route path="settings" element={<Personalizer />} />
          <Route path="health" element={<Health />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
