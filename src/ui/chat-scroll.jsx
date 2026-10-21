import { useLayoutEffect, useRef } from "react";

// Keep reading positions in this tab, independently for each conversation.
const storageKey = (id) => "harness.chat-scroll.v1:" + id;
function readPosition(id) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey(id)) ?? "null");
    return saved && Number.isFinite(saved.top) && saved.top >= 0 ? saved : null;
  } catch {
    return null;
  }
}

export function useChatScroll(chat) {
  const messages = useRef(null),
    following = useRef(false);
  const id = chat?.id;
  useLayoutEffect(() => {
    const element = messages.current;
    if (!id || !element) return;
    let position = readPosition(id);
    following.current = position
      ? position.bottom === true
      : !!chat.activeRun || element.scrollHeight <= element.clientHeight;

    const restore = () => {
      if (following.current) element.scrollTop = element.scrollHeight;
      else if (position) {
        const anchor = Array.from(element.children).find(
          (child) => child.id && child.id === position.messageId,
        );
        // A message anchor also survives text reflow after a viewport change.
        element.scrollTop =
          anchor && position.top > 0 && Number.isFinite(position.offset)
            ? element.scrollTop +
              anchor.getBoundingClientRect().top -
              element.getBoundingClientRect().top -
              position.offset
            : position.top;
      }
    };
    const remember = () => {
      const top = element.getBoundingClientRect().top;
      const anchor = Array.from(element.children).find(
        (child) =>
          child.classList.contains("message") &&
          child.getBoundingClientRect().bottom > top,
      );
      following.current =
        element.scrollHeight - element.clientHeight - element.scrollTop <= 32;
      position = {
        top: element.scrollTop,
        bottom: following.current,
        messageId: anchor?.id,
        offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
      };
      try {
        sessionStorage.setItem(storageKey(id), JSON.stringify(position));
      } catch {
        // A browser with storage disabled can still scroll and follow replies.
      }
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") remember();
    };
    restore();
    // The bundled fonts can swap in after the first layout and reflow the text.
    document.fonts?.ready.then(() => element.isConnected && restore());
    element.addEventListener("scroll", remember, { passive: true });
    // Pagehide catches a refresh even before the last scroll event is delivered.
    window.addEventListener("pagehide", remember);
    document.addEventListener("visibilitychange", hidden);
    const resized = new ResizeObserver(restore);
    resized.observe(element);
    element.addEventListener("load", restore, true);
    return () => {
      remember();
      resized.disconnect();
      element.removeEventListener("load", restore, true);
      element.removeEventListener("scroll", remember);
      window.removeEventListener("pagehide", remember);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [id]);

  // Streaming only follows the end when the reader is already there. In
  // particular, mounting an active chat must not override a restored position.
  useLayoutEffect(() => {
    if (chat?.activeRun && following.current && messages.current)
      messages.current.scrollTop = messages.current.scrollHeight;
  }, [id, chat?.activeRun, chat?.messages?.at(-1)?.content]);
  return messages;
}
