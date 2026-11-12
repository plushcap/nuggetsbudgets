import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { updateOwnProfile } from '../services/UserService.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';
import { png } from '../test/imageFixtures.js';

/**
 * Your own profile's picture and the rest of it are saved together or not at all.
 * The picture (a user_profile_images row) was written, or deleted, on its own before
 * the profile's update: when the update then failed, a new picture stayed with no profile
 * naming it, and a removed one left the profile naming a picture that was gone. Here the
 * update fails (a first name longer than the column, which the route's schema would refuse
 * first: the service is called directly) after the picture was written.
 */
describe('updateOwnProfile', () => {
  let tenant: TestTenant;
  const tooLong = 'x'.repeat(101);

  beforeAll(async () => {
    tenant = await createTestTenant('Own profile, one transaction');
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  const state = async () => ({
    profileImage: (await tenant.pool.query<{ profile_image: string | null }>('SELECT profile_image FROM users WHERE id = $1', [tenant.userId])).rows[0]!.profile_image,
    pictures: (await tenant.pool.query<{ uuid: string }>('SELECT uuid FROM user_profile_images WHERE user_id = $1', [tenant.userId])).rows.map((r) => r.uuid),
  });
  const failure = (promise: Promise<unknown>) => promise.then(() => null, (err: { code?: string }) => err.code ?? 'no code');

  it('keeps no new picture when the profile update fails', async () => {
    const before = await state();
    expect(await failure(updateOwnProfile(tenant.userId, { first_name: tooLong }, { mimeType: 'image/png', data: png() }))).toBe('22001');
    expect(await state()).toEqual(before);
  });

  it('keeps the picture when the profile update that removes it fails', async () => {
    const saved = await updateOwnProfile(tenant.userId, { first_name: 'Pat' }, { mimeType: 'image/png', data: png() });
    const withPicture = await state();
    expect(withPicture.pictures).toHaveLength(1);
    expect(saved?.profile_image).toBe(`/api/images/${withPicture.pictures[0]}`);

    expect(await failure(updateOwnProfile(tenant.userId, { first_name: tooLong, remove_profile_image: 'true' }, undefined))).toBe('22001');
    expect(await state()).toEqual(withPicture);

    // And both go together when it succeeds.
    await updateOwnProfile(tenant.userId, { first_name: 'Pat', remove_profile_image: 'true' }, undefined);
    expect(await state()).toEqual({ profileImage: null, pictures: [] });
  });
});
