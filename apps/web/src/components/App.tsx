/**
 * App Root Component
 *
 * Simple gate: if the user is authenticated (via Zustand persisted auth store),
 * render ChatRoute; otherwise render LoginRoute.
 *
 * Related Modules:
 * - LoginRoute: API login/register
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
