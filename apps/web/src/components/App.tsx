/**
 * App Root Component
 *
 * Simple gate: if the user is authenticated (via Zustand persisted auth store),
 * render ChatRoute; otherwise render LoginRoute.
 *
 * The auth store is populated either by:
 * - seedDemoSession() from LoginRoute (demo mode, fake token)
 * - apiRequest() login/register responses (real server mode, persisted to localStorage)
 *
 * Related Modules:
 * - LoginRoute: seedDemoSession, API login/register
 * - ChatRoute: the main application shell
 */
import { useAuthStore } from "../stores/domain.js";
import LoginRoute from "./LoginRoute.js";
import ChatRoute from "./ChatRoute.js";

export { ChannelList } from "./ChannelList.js";
export { MessageRow } from "./MessageRow.js";

export const App = () => {
  const user = useAuthStore((state) => state.user);

  return user ? <ChatRoute /> : <LoginRoute />;
};
