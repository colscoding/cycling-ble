/**
 * A set of subscribers where one listener that throws cannot starve the rest.
 *
 * Listener code belongs to the caller, so its errors are handed back rather
 * than handled here: what to do with them depends on who triggered delivery.
 */
export interface Listeners<T> {
    /** Subscribe. Returns an unsubscribe function. */
    add(listener: (value: T) => void): () => void;
    /** Call every listener, then return whatever they threw, in order. */
    emit(value: T): unknown[];
}

export function createListeners<T>(): Listeners<T> {
    const listeners = new Set<(value: T) => void>();
    return {
        add(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        emit(value) {
            const errors: unknown[] = [];
            // Iterate a copy: a listener may unsubscribe itself mid-delivery.
            for (const listener of [...listeners]) {
                try {
                    listener(value);
                } catch (error) {
                    errors.push(error);
                }
            }
            return errors;
        },
    };
}

/**
 * Report an error with no caller to return it to, the way a browser reports
 * one thrown by an event listener: visibly, and without interrupting anything.
 *
 * `reportError` does exactly that where it exists. Elsewhere (Node) the error
 * is rethrown on a later tick, so it surfaces as uncaught instead of vanishing.
 */
export function reportError(error: unknown): void {
    const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
    if (typeof report === 'function') {
        report(error);
        return;
    }
    setTimeout(() => {
        throw error;
    }, 0);
}
