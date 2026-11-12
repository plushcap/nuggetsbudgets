import mjml2html from 'mjml';
import Handlebars from 'handlebars';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { readSystemSetting } from './systemSettings.js';
import { inTenantTransaction, withSavepoint } from '../db/withTenant.js';
import { createLogger } from '../utils/logger.js';
import { getDirname } from '../utils/esm-compat.js';
import { isCalendarDate } from '../utils/calendarDate.js';
import { formatMoney, type MoneyFormat } from '@nuggets/shared';

const __dirname = getDirname(import.meta.url);
const logger = createLogger({ service: 'EmailTemplateService' });

/** The values a template reads. `subject` is the email's subject line. */
type TemplateData = Record<string, unknown> & { subject?: string };

/**
 * The email templates: each one's MJML file (under email-templates/) and the fields its
 * data must have. Every notification is sent as the one rule message (these were
 * rows of notification_templates_registry, which also counted each template's use, a
 * count nothing read).
 */
const TEMPLATES: Readonly<Record<string, { file: string; required: readonly string[] }>> = {
  rule_message: {
    file: 'rule-message.mjml',
    required: ['subject', 'heading', 'paragraphs', 'buttonUrl', 'buttonText', 'unsubscribeUrl'],
  },
};

/**
 * EmailTemplateService
 *
 * Handles email template rendering:
 * - Loads MJML template files from filesystem
 * - Compiles MJML → HTML
 * - Injects dynamic data using Handlebars
 * - Generates plain text version
 * - Checks the template's data has the fields it needs
 */
export class EmailTemplateService {
  private templateCache: Map<string, Handlebars.TemplateDelegate> = new Map();
  private templatesDir: string;

  constructor() {
    this.templatesDir = join(__dirname, '..', 'email-templates');
  }

  /**
   * Render an email template
   *
   * @param templateKey - Template key (e.g., 'rule_message')
   * @param data - Data to inject into template
   * @returns Object with HTML and plain text versions
   */
  async renderTemplate(
    templateKey: string,
    data: TemplateData
  ): Promise<{ html: string; text: string; subject: string }> {
    try {
      const template = Object.hasOwn(TEMPLATES, templateKey) ? TEMPLATES[templateKey] : undefined;
      if (!template) {
        throw new Error(`Template '${templateKey}' not found`);
      }
      this.validateTemplateData(data, template.required);

      // Load logo URL from system settings
      const logoUrl = await this.getLogoUrl();

      // Add logo URL and current year to template data
      const templateData = {
        ...data,
        logoUrl,
        year: new Date().getFullYear(),
      };

      // Load and compile MJML template
      const mjmlTemplate = this.loadMJMLTemplate(template.file);

      // Load partials
      const mjmlWithPartials = this.loadPartials(mjmlTemplate);

      // Inject data using Handlebars
      const mjmlWithData = this.injectData(mjmlWithPartials, templateData);

      // Compile MJML → HTML. mjml 5's mjml2html is async — it returns a Promise
      // resolving to { html, errors, json } — so we await it.
      const { html, errors } = await mjml2html(mjmlWithData, {
        keepComments: false,
        validationLevel: 'soft',
      });

      if (errors.length > 0) {
        logger.warn({ errors, templateKey }, 'MJML compilation warnings');
      }

      // Generate plain text version
      const text = this.htmlToPlainText(html);

      // Every template requires a subject (TEMPLATES).
      const subject = String(data.subject);

      logger.debug({ templateKey, dataKeys: Object.keys(data) }, 'Template rendered successfully');

      return { html, text, subject };

    } catch (error) {
      logger.error({ err: error, templateKey }, 'Failed to render template');
      throw error;
    }
  }

  /**
   * Load MJML template file from filesystem
   */
  private loadMJMLTemplate(templateFile: string): string {
    const templatePath = join(this.templatesDir, templateFile);

    if (!existsSync(templatePath)) {
      throw new Error(`Template file not found: ${templatePath}`);
    }

    try {
      const content = readFileSync(templatePath, 'utf8');
      logger.debug({ templateFile, templatePath }, 'MJML template loaded');
      return content;
    } catch (error) {
      logger.error({ err: error, templateFile }, 'Failed to read template file');
      throw error;
    }
  }

  /**
   * Inject dynamic data into template using Handlebars
   */
  private injectData(mjmlTemplate: string, data: Record<string, unknown>): string {
    try {
      // Get or compile Handlebars template
      const cacheKey = mjmlTemplate.substring(0, 100); // Use first 100 chars as cache key
      let template = this.templateCache.get(cacheKey);

      if (!template) {
        template = Handlebars.compile(mjmlTemplate);
        this.templateCache.set(cacheKey, template);
      }

      // Inject data
      return template(data);

    } catch (error) {
      logger.error({ err: error }, 'Handlebars compilation/injection failed');
      throw error;
    }
  }

  /**
   * Convert HTML to plain text
   * Simple implementation - strips HTML tags and decodes entities
   */
  private htmlToPlainText(html: string): string {
    return html
      // Remove script and style tags and their content
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      // Convert <br> to newlines
      .replace(/<br\s*\/?>/gi, '\n')
      // Convert </p> and </div> to double newlines
      .replace(/<\/(p|div)>/gi, '\n\n')
      // Remove all remaining HTML tags
      .replace(/<[^>]+>/g, '')
      // Decode common HTML entities
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Clean up multiple newlines
      .replace(/\n{3,}/g, '\n\n')
      // Trim whitespace
      .trim();
  }

  /** Refuse data without one of the fields the template needs (null counts as missing). */
  private validateTemplateData(data: Record<string, unknown>, required: readonly string[]): void {
    const missing: string[] = [];
    for (const field of required) {
      if (!(field in data) || data[field] === null || data[field] === undefined) {
        missing.push(field);
      }
    }

    if (missing.length > 0) {
      throw new Error(`Template data missing required fields: ${missing.join(', ')}`);
    }

    logger.debug({ requiredFields: required }, 'Template data validation passed');
  }

  /**
   * The logo URL from the system settings, or none when it can't be read: the email goes
   * without it. In the caller's transaction the read runs in a savepoint: a failed
   * statement aborts the transaction, so carrying on after it without one failed every
   * statement after it, and the request with them.
   */
  private async getLogoUrl(): Promise<string> {
    try {
      const read = () => readSystemSetting('notification_logo_url');
      return (await (inTenantTransaction() ? withSavepoint(read) : read())) || '';
    } catch (error) {
      logger.warn({ err: error }, 'Failed to load logo URL from settings');
      return '';
    }
  }

  /**
   * Load and inject partials into MJML template
   */
  private loadPartials(mjmlTemplate: string): string {
    // Replace {{> partialName}} with actual partial content
    // Note: [\w-]+ matches word characters and hyphens (e.g., button-cta)
    const partialRegex = /\{\{>\s*([\w-]+)\s*\}\}/g;

    return mjmlTemplate.replace(partialRegex, (match, partialName) => {
      try {
        const partialPath = join(this.templatesDir, 'partials', `${partialName}.mjml`);
        if (existsSync(partialPath)) {
          const partialContent = readFileSync(partialPath, 'utf8');
          logger.debug({ partialName }, 'Loaded partial');
          return partialContent;
        } else {
          logger.warn({ partialName }, 'Partial not found');
          return match; // Return original if partial not found
        }
      } catch (error) {
        logger.error({ err: error, partialName }, 'Failed to load partial');
        return match;
      }
    });
  }

  /**
   * Register Handlebars helpers
   * Can be extended with custom helpers for formatting, etc.
   */
  registerHelpers(): void {
    // Currency formatting helper, in the ledger's money format: the template's data names it
    // as `money` ({ currency, locale }, readTenantMoneyFormat), or the call does
    // ({{currency amount currency="EUR" locale="de-DE"}}); USD in en-US otherwise. It reads
    // the NUMERIC strings PostgreSQL returns, and renders a missing or non-numeric amount as
    // an empty string instead of the misleading "$NaN".
    Handlebars.registerHelper('currency', (amount: number | string, options?: Handlebars.HelperOptions) => {
      const root = (options?.data as { root?: { money?: Partial<MoneyFormat> } } | undefined)?.root;
      const hash = (options?.hash ?? {}) as Partial<MoneyFormat>;
      return formatMoney(amount, {
        currency: hash.currency ?? root?.money?.currency ?? null,
        locale: hash.locale ?? root?.money?.locale ?? null,
        fallback: '',
      });
    });

    // Date formatting helper.
    // A missing or invalid date renders as an empty string rather than throwing:
    // a notification payload that omits a date field must not blow up the entire
    // email render (which would otherwise fail silently inside the delivery
    // circuit breaker, and no email would be sent).
    Handlebars.registerHelper('formatDate', (date: string | Date) => {
      if (date === null || date === undefined || date === '') {
        return '';
      }
      // A calendar date ('YYYY-MM-DD') is that day wherever the server runs: read
      // as a Date it is UTC midnight, so render it in UTC.
      const calendarDay = isCalendarDate(date);
      const d = date instanceof Date ? date : new Date(calendarDay ? `${date}T00:00:00Z` : date);
      if (isNaN(d.getTime())) {
        return '';
      }
      return d.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        ...(calendarDay ? { timeZone: 'UTC' } : {}),
      });
    });

    // Pluralize helper
    Handlebars.registerHelper('pluralize', (count: number, singular: string, plural: string) => {
      return count === 1 ? singular : plural;
    });

    logger.info('Handlebars helpers registered');
  }
}
