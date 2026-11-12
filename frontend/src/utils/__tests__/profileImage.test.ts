import { describe, it, expect } from 'vitest';
import { profileImageUrl } from '../profileImage';

describe('profileImageUrl', () => {
  it('returns null when there is no path (callers fall back to an initial/icon)', () => {
    expect(profileImageUrl(null)).toBeNull();
    expect(profileImageUrl(undefined)).toBeNull();
    expect(profileImageUrl('')).toBeNull();
  });

  it("loads a stored path from the app's own origin, in every environment", () => {
    // The backend sends Cross-Origin-Resource-Policy: same-origin, so a URL on its own
    // port (the old dev-only http://localhost:5000) would not load from the app on :3000.
    expect(profileImageUrl('/uploads/abc.png')).toBe('/uploads/abc.png');
  });
});
