import { hasComposerDraft } from "./drafts.mjs";
import { readPending } from "./outbox.mjs";

// A new chat with nothing typed and no message yet is dropped when its pane
// closes. Composer text, attachments, or an unconfirmed send keep it as a draft.
export function unusedClosedChats(
  previousOpen,
  nextOpen,
  conversation,
  storage,
) {
  const open = new Set(nextOpen.filter(Boolean));
  return previousOpen.filter((id) => {
    if (!id || open.has(id)) return false;
    if (hasComposerDraft(id, storage) || readPending(id, storage)) return false;
    const chat = conversation(id);
    if (!chat || chat.pinned_at || chat.archived_at) return false;
    if (chat.messages?.length) return false;
    return true;
  });
}
