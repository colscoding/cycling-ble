import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { noopLogger } from '../src/logger.js';

describe('noopLogger', () => {
    it('accepts every level without throwing', () => {
        assert.doesNotThrow(() => {
            noopLogger.debug('a');
            noopLogger.info('b', 1);
            noopLogger.warn('c', new Error('x'));
            noopLogger.error('d', { k: 1 }, 2);
        });
    });

    it('returns undefined from every level', () => {
        assert.equal(noopLogger.debug('a'), undefined);
        assert.equal(noopLogger.info('a'), undefined);
        assert.equal(noopLogger.warn('a'), undefined);
        assert.equal(noopLogger.error('a'), undefined);
    });
});
