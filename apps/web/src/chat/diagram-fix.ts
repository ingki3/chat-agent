import { createContext } from "react";

/**
 * "다이어그램 고치기" (#182): how a diagram that could not be drawn asks for a fix — the conversation's own send
 * (the composer's path, `conversations.send`). `send` is null while a run is in progress (the button is disabled
 * then). Without a provider (the artifact page, the instruction editor) there is no button.
 */
export type DiagramFix = { send: ((text: string) => void) | null };

export const DiagramFixContext = createContext<DiagramFix | null>(null);
