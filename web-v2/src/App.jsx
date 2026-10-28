import {
  createBrowserRouter,
  createRoutesFromElements,
  RouterProvider,
  Route,
  Navigate,
  useParams,
} from 'react-router-dom';
import { lazy } from 'react';
import Shell from './components/Shell.jsx';
import RouteError from './components/RouteError.jsx';
import GuildPicker from './pages/GuildPicker.jsx';
import Overview from './pages/Overview.jsx';
const Leaderboard = lazy(() => import('./pages/Leaderboard.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const Personalizer = lazy(() => import('./pages/Personalizer.jsx'));
const Account = lazy(() => import('./pages/Account.jsx'));
const Health = lazy(() => import('./pages/Health.jsx'));
const Stats = lazy(() => import('./pages/Stats.jsx'));
const CommandList = lazy(() => import('./pages/CommandList.jsx'));
const Roadmap = lazy(() => import('./pages/Roadmap.jsx'));
const RoadmapAdmin = lazy(() => import('./pages/RoadmapAdmin.jsx'));
const ModulePage = lazy(() => import('./pages/ModulePage.jsx'));
const Messages = lazy(() => import('./pages/Messages.jsx'));
const MessageBuilder = lazy(() => import('./pages/MessageBuilder.jsx'));
const Insights = lazy(() => import('./pages/Insights.jsx'));
const AppealsReview = lazy(() => import('./pages/AppealsReview.jsx'));
const TicketsInbox = lazy(() => import('./pages/TicketsInbox.jsx'));
const TicketView = lazy(() => import('./pages/TicketView.jsx'));
const ModerationHub = lazy(() => import('./pages/ModerationHub.jsx'));
const AuditLog = lazy(() => import('./pages/AuditLog.jsx'));
const Changelog = lazy(() => import('./pages/Changelog.jsx'));
const MemberData = lazy(() => import('./pages/MemberData.jsx'));

// Old addresses for pages that are now tabs on the Moderation page.
function ToModerationTab({ tab }) {
  const { guildId } = useParams();
  return <Navigate to={`/guilds/${guildId}/moderation/${tab}`} replace />;
}

// A data router (not <BrowserRouter>) so pages can use useBlocker — the
// unsaved-changes guard in components/useUnsavedChangesGuard.js. Pages other
// than the picker and Overview load on first visit (Shell wraps the outlet in
// Suspense). RouteError catches a page that throws — or a page chunk that no
// longer exists after a deploy — inside the Shell, so the sidebar stays.
const router = createBrowserRouter(
  createRoutesFromElements(
    <Route element={<Shell />} errorElement={<RouteError />}>
      <Route errorElement={<RouteError />}>
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
        <Route path="commands" element={<CommandList />} />
        <Route path="roadmap" element={<Roadmap />} />
        <Route path="changelog" element={<Changelog />} />
        <Route path="roadmap/admin" element={<RoadmapAdmin />} />
        <Route path="health" element={<Health />} />
        <Route path="stats" element={<Stats />} />
      </Route>
    </Route>
  ),
  { basename: '/v2' }
);

export default function App() {
  return <RouterProvider router={router} />;
}
