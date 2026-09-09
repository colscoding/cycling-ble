import type { Logger } from './types.js';

/** A logger that discards everything. The default for every connect function. */
export const noopLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
};
