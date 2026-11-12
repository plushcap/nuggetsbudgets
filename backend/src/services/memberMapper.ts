import type { MemberDto } from '@nuggets/shared';

/**
 * The flat row shape both member lists (tenant_users / organization_users joined
 * to users) project, mapped to the camelCase {@link MemberDto} the API returns.
 */
export interface MemberRow {
  uuid: string;
  is_admin: boolean;
  created_at: Date | string | null;
  userUuid: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  profile_image: string | null;
  is_locked: boolean;
  login_disabled: boolean;
}

export function toMemberDto(r: MemberRow): MemberDto {
  return {
    uuid: r.uuid,
    isAdmin: r.is_admin,
    createdAt: r.created_at == null ? null : new Date(r.created_at).toISOString(),
    user: {
      uuid: r.userUuid,
      email: r.email,
      firstName: r.first_name,
      lastName: r.last_name,
      profileImage: r.profile_image,
      isLocked: r.is_locked,
      loginDisabled: r.login_disabled,
    },
  };
}
