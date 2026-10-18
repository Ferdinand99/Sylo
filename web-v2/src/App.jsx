import {
  createBrowserRouter,
  createRoutesFromElements,
  RouterProvider,
  Route,
  Navigate,
  useParams,
} from 'react-router-dom';
import Shell from './components/Shell.jsx';
import GuildPicker from './pages/GuildPicker.jsx';
import Overview from './pages/Overview.jsx';
import Leaderboard from './pages/Leaderboard.jsx';
import Settings from './pages/Settings.jsx';
import Personalizer from './pages/Personalizer.jsx';
import Account from './pages/Account.jsx';
import Health from './pages/Health.jsx';
import Roadmap from './pages/Roadmap.jsx';
import RoadmapAdmin from './pages/RoadmapAdmin.jsx';
import ModulePage from './pages/ModulePage.jsx';
import Messages from './pages/Messages.jsx';
import MessageBuilder from './pages/MessageBuilder.jsx';
import Insights from './pages/Insights.jsx';
import AppealsReview from './pages/AppealsReview.jsx';
import TicketsInbox from './pages/TicketsInbox.jsx';
import TicketView from './pages/TicketView.jsx';
import ModerationHub from './pages/ModerationHub.jsx';
import AuditLog from './pages/AuditLog.jsx';
import MemberData from './pages/MemberData.jsx';

// Old addresses for pages that are now tabs on the Moderation page.
function ToModerationTab({ tab }) {
  const { guildId } = useParams();
  return <Navigate to={`/guilds/${guildId}/moderation/${tab}`} replace />;
}

// A data router (not <BrowserRouter>) so pages can use useBlocker — the
// unsaved-changes guard in components/useUnsavedChangesGuard.js. The route
// tree itself is unchanged.
const router = createBrowserRouter(
  createRoutesFromElements(
    <Route element={<Shell />}>
      <Route index element={<GuildPicker />} />
      <Route path="guilds/:guildId" element={<Overview />} />
      <Route path="guilds/:guildId/leaderboard" element={<Leaderboard />} />
      <Route path="guilds/:guildId/settings" element={<Settings />} />
      <Route path="guilds/:guildId/audit" element={<AuditLog />} />
      <Route path="guilds/:guildId/member-data" element={<MemberData />} />
      <Route path="guilds/:guildId/m/:moduleId" element={<ModulePage />} />
      <Route path="guilds/:guildId/messages" element={<Messages />} />
      <Route path="guilds/:guildId/messages/:id" element={<MessageBuilder />} />
      <Route path="guilds/:guildId/insights" element={<Insights />} />
      <Route path="guilds/:guildId/commands" element={<ToModerationTab tab="commands" />} />
      <Route path="guilds/:guildId/m/automod" element={<ToModerationTab tab="automod" />} />
      <Route path="guilds/:guildId/m/moderation" element={<ToModerationTab tab="actions" />} />
      <Route path="guilds/:guildId/m/logging" element={<ToModerationTab tab="logging" />} />
      <Route path="guilds/:guildId/appeals" element={<AppealsReview />} />
      <Route path="guilds/:guildId/tickets" element={<TicketsInbox />} />
      <Route path="guilds/:guildId/tickets/:ticketId" element={<TicketView />} />
      <Route path="guilds/:guildId/moderation/:tab?" element={<ModerationHub />} />
      <Route path="account" element={<Account />} />
      <Route path="settings" element={<Personalizer />} />
      <Route path="roadmap" element={<Roadmap />} />
      <Route path="roadmap/admin" element={<RoadmapAdmin />} />
      <Route path="health" element={<Health />} />
    </Route>
  ),
  { basename: '/v2' }
);

export default function App() {
  return <RouterProvider router={router} />;
}
