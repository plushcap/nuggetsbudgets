import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  defaultNotificationRules,
  notificationRulesSchema,
  sendsBy,
  type NotificationPreferences,
  type NotificationRule,
  type NotificationRules,
  type SetNotificationPreferencesRequest,
} from '@nuggets/shared';
import { getDb, globalDb, withTenant } from '../../db/withTenant.js';
import { DomainError, defaultErrorCode } from '../domainErrors.js';
import { deriveKey, DOMAIN } from '../../utils/crypto-envelope.js';
import { readDataEncryptionSecret } from '../../utils/data-encryption-secret.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger({ service: 'NotificationRuleService' });

/**
 * A person's channels for one rule. A rule they never changed follows their
 * row for `defaultRuleKey` when they have one (someone who opted out of all
 * email under the old per-user settings has email off there), else both on.
 */
export interface Choice {
  email: boolean;
  push: boolean;
}

const bothChannels: Choice = { email: true, push: true };

/** The preference row that applies to every rule a person hasn't set; not a valid rule key, so no request can name it. */
export const defaultRuleKey = '*';

// Every query here also runs under RLS; naming the tenant as well keeps a role
// that bypasses RLS (the CI database role is a superuser) from mixing tenants.
const currentTenant = sql<number>`current_setting('app.current_tenant_id', true)::int`;

/** A request that names a rule the tenant doesn't have, or an unsubscribe link that doesn't work: answered `{ error, code, message }` with its status. */
export class NotificationRuleError extends DomainError {
  constructor(message: string, status: 400 | 404) {
    super(status, defaultErrorCode(status), message);
  }
}

const unsubscribeLifetimeSeconds = 60 * 86_400;
const unsubscribePayloadSchema = z.object({ u: z.uuid(), t: z.uuid(), r: z.string(), e: z.int() });
const brokenLink = 'This link has expired or doesn’t work. Choose what you get in My Profile.';

/**
 * The active tenant's notification rules, each person's choice of which they
 * get by email and push, and the signed links in emails that stop one rule's
 * email. Tenant data goes through getDb(); unsubscribing, which has no session,
 * opens its own tenant transaction from the link.
 */
export class NotificationRuleService {
  constructor(private readonly readSecret: () => Promise<string> = readDataEncryptionSecret) {}

  /**
   * The tenant's rules: its saved ones, the defaults when it never saved any,
   * or none at all (`fits: false`) when the saved JSON no longer validates —
   * sending nothing beats guessing what a damaged rule meant.
   */
  async readRules(): Promise<{ rules: NotificationRules; fits: boolean }> {
    const row = await getDb()
      .selectFrom('notification_rule_sets')
      .select('rules')
      .where('tenant_id', '=', currentTenant)
      .executeTakeFirst();
    if (!row) return { rules: defaultNotificationRules, fits: true };
    const parsed = notificationRulesSchema.safeParse(row.rules);
    if (parsed.success) return { rules: parsed.data, fits: true };
    logger.error({ issues: parsed.error.issues }, 'Stored notification rules do not validate; sending none');
    return { rules: { rules: [] }, fits: false };
  }

  /**
   * Replace the tenant's rules (already parsed with notificationRulesSchema).
   * A removed rule stops at once; people's choices for it are kept, so a rule
   * re-added under the same key keeps them.
   */
  async saveRules(rules: NotificationRules, userId: number): Promise<NotificationRules> {
    await getDb()
      .insertInto('notification_rule_sets')
      .values({ rules: JSON.stringify(rules), updated_by_user_id: userId })
      .onConflict((oc) => oc.column('tenant_id').doUpdateSet({
        rules: JSON.stringify(rules),
        updated_by_user_id: userId,
      }))
      .execute();
    logger.info({ userId, rules: rules.rules.map(({ key, enabled }) => ({ key, enabled })) }, 'Notification rules saved');
    return (await this.readRules()).rules;
  }

  /** Every choice of `userId` in this tenant, as `${userId}:${ruleKey}` (see {@link choiceFor}). */
  async choicesOf(userId: number): Promise<Map<string, Choice>> {
    return this.loadChoices(userId);
  }

  /** Every member's choices in this tenant, as `${userId}:${ruleKey}`. */
  async allChoices(): Promise<Map<string, Choice>> {
    return this.loadChoices();
  }

  private async loadChoices(userId?: number): Promise<Map<string, Choice>> {
    let query = getDb()
      .selectFrom('notification_preferences')
      .select(['user_id', 'rule_key', 'email', 'push'])
      .where('tenant_id', '=', currentTenant);
    if (userId !== undefined) query = query.where('user_id', '=', userId);
    const rows = await query.execute();
    return new Map(rows.map((row) => [`${row.user_id}:${row.rule_key}`, { email: row.email, push: row.push }]));
  }

  /** What `userId` chose for a rule: their row for it, else their default row, else both channels. */
  static choiceFor(choices: Map<string, Choice>, userId: number, ruleKey: string): Choice {
    return choices.get(`${userId}:${ruleKey}`) ?? choices.get(`${userId}:${defaultRuleKey}`) ?? bothChannels;
  }

  /** How `rule` actually reaches `userId`: their choice, within the channels the rule sends by. */
  static channelsFor(choices: Map<string, Choice>, userId: number, rule: NotificationRule): Choice {
    const choice = NotificationRuleService.choiceFor(choices, userId, rule.key);
    return {
      email: choice.email && sendsBy(rule.sendBy, 'email'),
      push: choice.push && sendsBy(rule.sendBy, 'push'),
    };
  }

  /** The tenant's enabled rules with `userId`'s choice for each. */
  async getPreferences(userId: number, emailAvailable: boolean): Promise<NotificationPreferences> {
    const { rules } = await this.readRules();
    const choices = await this.choicesOf(userId);
    return {
      emailAvailable,
      rules: rules.rules
        .filter((rule) => rule.enabled)
        .map((rule) => ({
          rule: rule.key,
          label: rule.label,
          kind: rule.kind,
          sendBy: rule.sendBy,
          ...NotificationRuleService.choiceFor(choices, userId, rule.key),
        })),
    };
  }

  /**
   * Change some of `userId`'s choices. Every rule named must be one of the
   * tenant's (on or off); a channel left out keeps its current value.
   */
  async setPreferences(userId: number, request: SetNotificationPreferencesRequest, emailAvailable: boolean): Promise<NotificationPreferences> {
    const { rules } = await this.readRules();
    const keys = new Set(rules.rules.map((rule) => rule.key));
    const unknown = request.rules.find((change) => !keys.has(change.rule));
    if (unknown) throw new NotificationRuleError(`There is no notification “${unknown.rule}”.`, 400);

    const asBoolean = (value: boolean | string | undefined) => (value === undefined ? null : value === true || value === 'true');
    for (const change of request.rules) {
      await this.choose(userId, change.rule, { email: asBoolean(change.email), push: asBoolean(change.push) });
    }
    logger.info({ userId, rules: request.rules }, 'Notification preferences changed');
    return this.getPreferences(userId, emailAvailable);
  }

  /**
   * Set the channels given (null leaves one as it is) in a single statement:
   * a read-then-write would let two quick changes to one rule (email, then
   * push) overwrite each other. A new row starts from the person's default.
   */
  private async choose(userId: number, ruleKey: string, change: { email: boolean | null; push: boolean | null }): Promise<void> {
    await sql`
      INSERT INTO notification_preferences (user_id, rule_key, email, push)
      SELECT ${userId}, ${ruleKey},
             COALESCE(${change.email}::boolean, d.email, true),
             COALESCE(${change.push}::boolean, d.push, true)
        FROM (SELECT 1) AS one
        LEFT JOIN notification_preferences d
          ON d.tenant_id = ${currentTenant} AND d.user_id = ${userId} AND d.rule_key = ${defaultRuleKey}
      ON CONFLICT ON CONSTRAINT notification_preferences_person_rule_key DO UPDATE
         SET email = COALESCE(${change.email}::boolean, notification_preferences.email),
             push = COALESCE(${change.push}::boolean, notification_preferences.push),
             updated_at = CURRENT_TIMESTAMP
    `.execute(getDb());
  }

  private async signingKey(): Promise<Buffer> {
    return deriveKey(await this.readSecret(), DOMAIN.unsubscribe);
  }

  /**
   * A link token that stops `rule`'s email for one person in one tenant, good
   * for 60 days from `now`. Nothing is stored: the HMAC is the proof.
   */
  async unsubscribeToken(userUuid: string, tenantUuid: string, rule: string, now = new Date()): Promise<string> {
    const expires = Math.floor(now.getTime() / 1000) + unsubscribeLifetimeSeconds;
    const payload = Buffer.from(JSON.stringify({ u: userUuid, t: tenantUuid, r: rule, e: expires })).toString('base64url');
    const signature = createHmac('sha256', await this.signingKey()).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  /**
   * Check a token and find what it names. Every failure — bad signature,
   * expired, a person, tenant or rule that's gone — is the same 404, so the
   * response says nothing about which part was wrong.
   */
  private async readLink(token: string, now: Date): Promise<{ userId: number; tenantId: number; rule: NotificationRule }> {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) throw new NotificationRuleError(brokenLink, 404);

    const expected = createHmac('sha256', await this.signingKey()).update(payload).digest();
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new NotificationRuleError(brokenLink, 404);
    }

    let claims: z.infer<typeof unsubscribePayloadSchema>;
    try {
      claims = unsubscribePayloadSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    } catch {
      throw new NotificationRuleError(brokenLink, 404);
    }
    if (claims.e < now.getTime() / 1000) throw new NotificationRuleError(brokenLink, 404);

    const user = await globalDb.selectFrom('users').select('id').where('uuid', '=', claims.u).executeTakeFirst();
    const tenant = await globalDb.selectFrom('tenants').select('id').where('uuid', '=', claims.t).where('status', '=', 'active').executeTakeFirst();
    if (!user || !tenant) throw new NotificationRuleError(brokenLink, 404);
    const member = await globalDb
      .selectFrom('tenant_users')
      .select('id')
      .where('tenant_id', '=', tenant.id)
      .where('user_id', '=', user.id)
      .executeTakeFirst();
    if (!member) throw new NotificationRuleError(brokenLink, 404);

    const rule = await withTenant(tenant.id, async () =>
      (await this.readRules()).rules.rules.find((candidate) => candidate.key === claims.r)
    );
    if (!rule) throw new NotificationRuleError(brokenLink, 404);
    return { userId: user.id, tenantId: tenant.id, rule };
  }

  /** What a link would stop, without stopping it (the page asks first, so a mail scanner opening links stops nothing). */
  async inspectUnsubscribeLink(token: string, now = new Date()): Promise<{ label: string }> {
    const { rule } = await this.readLink(token, now);
    return { label: rule.label };
  }

  /** Stop the link's rule reaching its person by email. Push stays as it was. */
  async unsubscribe(token: string, now = new Date()): Promise<{ label: string }> {
    const { userId, tenantId, rule } = await this.readLink(token, now);
    await withTenant(tenantId, () => this.choose(userId, rule.key, { email: false, push: null }));
    logger.info({ userId, tenantId, rule: rule.key }, 'Unsubscribed from a notification rule by email link');
    return { label: rule.label };
  }
}
