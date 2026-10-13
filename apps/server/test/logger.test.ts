import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { t } from '../src/i18n.js';
import { logger } from '../src/logger.js';

describe('logger', () => {
  logger.minLevel = 'error';

  it('iki dilli metni Türkçe ve İngilizce alanlarla kaydeder', () => {
    logger.log('info', 'test', t('Giriş başarılı', 'Signed in'));
    const entry = logger.recent('test').at(-1)!;
    assert.equal(entry.message, 'Giriş başarılı');
    assert.equal(entry.messageEn, 'Signed in');
  });

  it('dile bağlı olmayan metni iki alana da yazar', () => {
    logger.log('error', 'test', 'AccessDenied');
    const entry = logger.recent('test').at(-1)!;
    assert.equal(entry.message, 'AccessDenied');
    assert.equal(entry.messageEn, 'AccessDenied');
  });
});
