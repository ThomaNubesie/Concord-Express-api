const {
  isProd, exposeDevCodeAllowed, devBypassAllowed, isMasterBypass, DEFAULT_MASTER_CODE,
} = require('../src/lib/authPolicy');

describe('authPolicy.isProd', () => {
  it('is true only for exactly "production"', () => {
    expect(isProd('production')).toBe(true);
    expect(isProd('development')).toBe(false);
    expect(isProd('staging')).toBe(false);
    expect(isProd(undefined)).toBe(false);
    expect(isProd('')).toBe(false);
  });
});

describe('authPolicy dev-code / bypass gating', () => {
  it('never exposes the code or allows bypass in production', () => {
    expect(exposeDevCodeAllowed('production')).toBe(false);
    expect(devBypassAllowed('production')).toBe(false);
  });

  it('allows both in non-production', () => {
    for (const env of ['development', 'test', undefined]) {
      expect(exposeDevCodeAllowed(env)).toBe(true);
      expect(devBypassAllowed(env)).toBe(true);
    }
  });
});

describe('authPolicy.isMasterBypass', () => {
  it('NEVER authenticates the master code in production', () => {
    expect(isMasterBypass('000000', 'production')).toBe(false);
    expect(isMasterBypass(DEFAULT_MASTER_CODE, 'production', '000000')).toBe(false);
  });

  it('authenticates only the exact master code in dev', () => {
    expect(isMasterBypass('000000', 'development', '000000')).toBe(true);
    expect(isMasterBypass('123456', 'development', '000000')).toBe(false);
  });

  it('respects a custom master code (DEV_OTP override)', () => {
    expect(isMasterBypass('999999', 'development', '999999')).toBe(true);
    expect(isMasterBypass('000000', 'development', '999999')).toBe(false);
  });

  it('defaults the master code to 000000', () => {
    expect(DEFAULT_MASTER_CODE).toBe('000000');
  });
});
