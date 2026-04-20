// Global registry for undo notifications - Y entities are singletons anyway
import type * as Y from "yjs";

// Using `any` for the event type because callers pass both YEvent and YMapEvent,
// and TypeScript's function contravariance makes a union type not work correctly.
export const undoManagerNotifications = new WeakMap<Y.AbstractType<any>, (event: any) => void>();
