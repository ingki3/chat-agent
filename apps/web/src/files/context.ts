import { createContext, useContext } from "react";
import { fileViewPath, type FileLocator } from "@agentlee/shared";

/**
 * The conversation whose files the messages on screen name (#24): file citations and file chips link to the viewer
 * of that conversation (`/c/:id/files/:fileId?loc=`). Null where there is none (an artifact share): no links then.
 * The server decides what opens — the viewer's every read goes through the share projection (#29).
 */
export const FileViewContext = createContext<string | null>(null);

/** The viewer's address for a file (at a locator), or null without a conversation. */
export function useFileViewHref(): (fileId: string, locator?: FileLocator) => string | null {
  const conversationId = useContext(FileViewContext);
  return (fileId, locator) => (conversationId ? fileViewPath(conversationId, fileId, locator) : null);
}
