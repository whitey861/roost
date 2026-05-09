import { describe, expect, it } from 'vitest';
import { resolveWorkerId } from '../src/main.js';

describe('resolveWorkerId', () => {
  it('falls back when env var is undefined', () => {
    expect(resolveWorkerId(undefined)).toMatch(/^worker-/);
  });

  it('falls back when env var is empty', () => {
    expect(resolveWorkerId('')).toMatch(/^worker-/);
  });

  it('falls back when env var looks like an unresolved DO bindable', () => {
    expect(resolveWorkerId('${APP_INSTANCE_ID}')).toMatch(/^worker-/);
    expect(resolveWorkerId('${APP_DOMAIN}')).toMatch(/^worker-/);
  });

  it('passes through a real value', () => {
    expect(resolveWorkerId('worker-prod-7')).toBe('worker-prod-7');
  });

  it('does not strip a value that merely contains a brace', () => {
    expect(resolveWorkerId('worker-${weird}-suffix')).toBe('worker-${weird}-suffix');
  });
});
