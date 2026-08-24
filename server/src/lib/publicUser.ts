import { User } from '@prisma/client';
import { isOperatorEmail } from './operator';

// The client-safe projection of a User row — every auth response (register,
// login, /me, org-invite accept, self-serve org creation) building its own
// shape inline meant the shape had quietly drifted (login/`/me` included
// avatarConfig, the other three didn't) instead of being a single decision.

type PublicUserFields = Pick<
  User,
  'id' | 'email' | 'displayName' | 'fullName' | 'accountRole' | 'workspaceRole' | 'timezone' | 'tutorialCompletedAt' | 'preferences'
>;

export function publicUser(user: PublicUserFields) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    fullName: user.fullName,
    accountRole: user.accountRole,
    workspaceRole: user.workspaceRole,
    timezone: user.timezone,
    tutorialCompletedAt: user.tutorialCompletedAt,
    preferences: user.preferences,
    // Every response shape that flows through this helper picks this up
    // automatically — see specs/2026-08-12-operator-org-list-design.md.
    isOperator: isOperatorEmail(user.email),
  };
}

export function publicUserWithAvatar(user: PublicUserFields & Pick<User, 'avatarConfig'>) {
  return { ...publicUser(user), avatarConfig: user.avatarConfig };
}
