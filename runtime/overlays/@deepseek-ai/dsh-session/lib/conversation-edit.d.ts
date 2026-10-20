import type {SessionEvent} from './types/types.js';
export declare const CONVERSATION_EDIT: 'conversation/edit';
export declare function deletionOnly(before: string, after: string): boolean;
export declare function collectConversationEdits(events: readonly SessionEvent[], candidate?: SessionEvent): {deleted: Set<number>; texts: Map<string,string>; affected: Set<number>; versions: Map<number,number>};
export declare function projectConversationEntries<T extends {event: SessionEvent}>(entries: readonly T[]): T[];
