-- Messenger migration, step 1b: attachment reads become per-conversation.
--
-- GET /api/uploads/:filename now resolves a file back to the message that
-- carries it, to decide whether the caller is allowed to read that
-- conversation. That lookup runs on every image load, so it needs this index
-- rather than a sequential scan of ChatMessage.

-- CreateIndex
CREATE INDEX "ChatMessage_attachmentUrl_idx" ON "ChatMessage"("attachmentUrl");
