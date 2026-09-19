"use client";

import { use } from "react";

import { ChatView } from "@/features/chat/components/chat-view";

export default function ConversationPage({ params }: PageProps<"/chat/[conversationId]">) {
  const { conversationId } = use(params);
  return <ChatView conversationId={conversationId} />;
}
