import { useAuthStore } from "../stores/domain.js";
import LoginRoute from "./LoginRoute.js";
import ChatRoute from "./ChatRoute.js";

export { ChannelList } from "./ChannelList.js";
export { MessageRow } from "./MessageRow.js";

export const App = () => {
  const user = useAuthStore((state) => state.user);

  return user ? <ChatRoute /> : <LoginRoute />;
};
