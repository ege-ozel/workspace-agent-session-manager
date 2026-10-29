// Follow new content only while the reader is near the end. Percentages grow too large in long sessions.
function followConversation(chat, contents) {
  let following = true;
  const nearBottom = () => chat.scrollHeight - chat.scrollTop - chat.clientHeight <= 48;
  const bottom = () => { chat.scrollTop = chat.scrollHeight; };
  chat.addEventListener('scroll', () => { following = nearBottom(); }, { passive: true });
  // Images, expanded code, the header and the message box can all change the viewport after a message arrives.
  const resize = new ResizeObserver(() => { if (following) bottom(); });
  for (const node of [chat, ...contents]) resize.observe(node);
  return {
    update(change, prepend = false) {
      const top = chat.scrollTop, height = chat.scrollHeight;
      if (prepend) following = false;
      change();
      if (prepend) chat.scrollTop = top + chat.scrollHeight - height;
      else if (following) bottom();
    },
    toBottom() { following = true; bottom(); },
    pause() { following = false; },
  };
}
