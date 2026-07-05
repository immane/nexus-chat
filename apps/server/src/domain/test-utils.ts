import { store } from "./store.js";

export const resetStore = () => {
  store.users.clear();
  store.usersByEmail.clear();
  store.workspaces.clear();
  store.workspaceMembers.clear();
  store.channels.clear();
  store.channelMembers.clear();
  store.messages.clear();
  store.messagesByClientId.clear();
  store.messageReactions.clear();
  store.savedMessages.clear();
  store.readReceipts.clear();
  store.pendingReadReceipts.length = 0;
  store.messageEvents.length = 0;
  store.messageAttachments.clear();
  store.files.clear();
  store.uploadSessions.clear();
  store.refreshSessions.clear();
  store.bots.clear();
  store.signalBundles.clear();
  store.oneTimePreKeys.clear();
  store.signalSessions.clear();
  store.auditLogs.length = 0;
};
