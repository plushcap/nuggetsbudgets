/**
 * Nuggets Application Security Validator
 * 
 * This module provides comprehensive security validation for the Nuggets
 * budget tracking application. It validates environment configurations,
 * secrets, and security settings to ensure production-grade security.
 */

import { createLogger } from './logger.js';
import { bcryptRounds } from './passwords.js';
import { config as settings } from '../config.js';
import { ProductionConfigError } from './productionConfig.js';
import { envSecret } from './docker-secrets.js';

const logger = createLogger({ service: 'SecurityValidator' });

export interface SecurityValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  summary: {
    jwtSecurityLevel: 'insecure' | 'basic' | 'production';
    databaseSecurityLevel: 'insecure' | 'basic' | 'production';
    overallSecurityLevel: 'insecure' | 'basic' | 'production';
  };
}

/** Each is unset (absent or undefined) when its variable is. */
export interface SecurityConfig {
  jwtSecret?: string | undefined;
  dbPassword?: string | undefined;
  dbHost?: string | undefined;
  nodeEnv?: string | undefined;
  clientUrl?: string | undefined;
  bcryptSaltRounds?: string | undefined;
  rateLimitMaxRequests?: string | undefined;
  rateLimitWindowMs?: string | undefined;
}

/**
 * Known insecure default values that should never be used in any environment
 */
const INSECURE_DEFAULTS = [
  'your-secret-key-here',
  'change-me',
  'default-secret',
  'insecure-key',
  'test-secret',
  'development-key',
  'nuggets-secret',
  '123456',
  'password',
  'secret',
  'your_jwt_secret_here',
  'your_database_password_here'
];

/**
 * Validates JWT secret configuration
 */
function validateJWTSecret(jwtSecret?: string): { isValid: boolean; errors: string[]; warnings: string[]; level: 'insecure' | 'basic' | 'production' } {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  if (!jwtSecret) {
    errors.push('JWT_SECRET is required but not provided');
    return { isValid: false, errors, warnings, level: 'insecure' };
  }

  // Check for insecure defaults
  if (INSECURE_DEFAULTS.some(defaultVal => 
    jwtSecret.toLowerCase().includes(defaultVal.toLowerCase())
  )) {
    errors.push('JWT_SECRET contains insecure default values and must be changed');
    return { isValid: false, errors, warnings, level: 'insecure' };
  }

  // Length validation
  if (jwtSecret.length < 32) {
    errors.push('JWT_SECRET must be at least 32 characters long for security');
    return { isValid: false, errors, warnings, level: 'insecure' };
  }

  if (jwtSecret.length < 64) {
    warnings.push('JWT_SECRET should be at least 64 characters for production use');
    return { isValid: true, errors, warnings, level: 'basic' };
  }

  // Entropy validation (check for sufficient randomness)
  const entropy = calculateEntropy(jwtSecret);
  if (entropy < 3.5) {
    warnings.push('JWT_SECRET appears to have low entropy. Consider using a cryptographically secure random string');
    return { isValid: true, errors, warnings, level: 'basic' };
  }

  return { isValid: true, errors, warnings, level: 'production' };
}

/**
 * Validates database password configuration
 */
function validateDatabasePassword(dbPassword?: string, isProduction?: boolean): { isValid: boolean; errors: string[]; warnings: string[]; level: 'insecure' | 'basic' | 'production' } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!dbPassword) {
    if (isProduction) {
      errors.push('DB_PASSWORD is required in production environments');
      return { isValid: false, errors, warnings, level: 'insecure' };
    } else {
      warnings.push('DB_PASSWORD not set - consider using a password even in development');
      return { isValid: true, errors, warnings, level: 'basic' };
    }
  }

  // Check for insecure defaults
  if (INSECURE_DEFAULTS.some(defaultVal => 
    dbPassword.toLowerCase().includes(defaultVal.toLowerCase())
  )) {
    errors.push('DB_PASSWORD contains insecure default values and must be changed');
    return { isValid: false, errors, warnings, level: 'insecure' };
  }

  // Length and complexity validation
  if (dbPassword.length < 12) {
    errors.push('DB_PASSWORD must be at least 12 characters long');
    return { isValid: false, errors, warnings, level: 'insecure' };
  }

  if (dbPassword.length < 16) {
    warnings.push('DB_PASSWORD should be at least 16 characters for production use');
  }

  // Check for character diversity
  const hasLowerCase = /[a-z]/.test(dbPassword);
  const hasUpperCase = /[A-Z]/.test(dbPassword);
  const hasNumbers = /\d/.test(dbPassword);
  const hasSpecialChars = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>?]/.test(dbPassword);

  const characterTypes = [hasLowerCase, hasUpperCase, hasNumbers, hasSpecialChars].filter(Boolean).length;

  if (characterTypes < 3) {
    if (isProduction) {
      errors.push('DB_PASSWORD must contain at least 3 different character types (lowercase, uppercase, numbers, special characters)');
      return { isValid: false, errors, warnings, level: 'insecure' };
    } else {
      warnings.push('DB_PASSWORD should contain multiple character types for better security');
    }
  }

  const level = dbPassword.length >= 16 && characterTypes >= 3 ? 'production' : 'basic';
  return { isValid: true, errors, warnings, level };
}

/**
 * Validates production-specific security requirements
 */
function validateProductionSecurity(config: SecurityConfig): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (config.nodeEnv === 'production') {
    // Kept alongside checkProductionConfig's address check, which allows http on any
    // loopback address and normalizes the scheme's case: this one refuses those too.
    if (config.clientUrl && !config.clientUrl.startsWith('https://') && !config.clientUrl.includes('localhost')) {
      errors.push('CLIENT_URL must use HTTPS in production environment');
    }

    // Validate rate limiting is configured for production
    const maxRequests = parseInt(config.rateLimitMaxRequests || '100');
    if (maxRequests > 1000) {
      warnings.push('RATE_LIMIT_MAX_REQUESTS is set quite high for production. Consider lowering for better security.');
    }

    // The bcrypt cost new password hashes use (BCRYPT_ROUNDS, utils/passwords.ts). A
    // warning, not an error: the setting was once ignored, so a deployment may
    // carry a lower value it never ran with.
    const saltRounds = bcryptRounds(config.bcryptSaltRounds); // the cost actually used
    if (saltRounds < 12) {
      warnings.push('BCRYPT_ROUNDS is below 12; use at least 12 in production');
    }
  }

  return { errors, warnings };
}

/**
 * Calculate entropy of a string (measure of randomness)
 */
function calculateEntropy(str: string): number {
  const frequencies: { [key: string]: number } = {};
  
  // Count character frequencies
  for (const char of str) {
    frequencies[char] = (frequencies[char] || 0) + 1;
  }
  
  // Calculate entropy using Shannon formula
  let entropy = 0;
  const length = str.length;
  
  for (const count of Object.values(frequencies)) {
    const probability = count / length;
    entropy -= probability * Math.log2(probability);
  }
  
  return entropy;
}

/**
 * Main security validation function
 */
export function validateNuggetsSecurityConfig(config?: SecurityConfig): SecurityValidationResult {
  const current = settings();
  const securityConfig: SecurityConfig = config || {
    // Secrets: index.ts copies the Docker secrets into these when USE_DOCKER_SECRETS=true.
    jwtSecret: envSecret('JWT_SECRET'),
    dbPassword: envSecret('DB_PASSWORD'),
    dbHost: current.DB_HOST,
    nodeEnv: current.NODE_ENV,
    clientUrl: current.CLIENT_URL,
    bcryptSaltRounds: current.BCRYPT_ROUNDS,
    rateLimitMaxRequests: String(current.RATE_LIMIT_MAX_REQUESTS),
    rateLimitWindowMs: String(current.RATE_LIMIT_WINDOW_MS),
  };

  const isProduction = securityConfig.nodeEnv === 'production';
  const allErrors: string[] = [];
  const allWarnings: string[] = [];

  // Validate JWT Secret
  const jwtValidation = validateJWTSecret(securityConfig.jwtSecret);
  allErrors.push(...jwtValidation.errors);
  allWarnings.push(...jwtValidation.warnings);

  // Validate Database Password
  const dbValidation = validateDatabasePassword(securityConfig.dbPassword, isProduction);
  allErrors.push(...dbValidation.errors);
  allWarnings.push(...dbValidation.warnings);

  // Validate production-specific requirements
  const productionValidation = validateProductionSecurity(securityConfig);
  allErrors.push(...productionValidation.errors);
  allWarnings.push(...productionValidation.warnings);

  // Determine overall security level
  const levels = [jwtValidation.level, dbValidation.level];
  let overallSecurityLevel: 'insecure' | 'basic' | 'production' = 'production';

  if (levels.includes('insecure')) {
    overallSecurityLevel = 'insecure';
  } else if (levels.includes('basic')) {
    overallSecurityLevel = 'basic';
  }

  const result: SecurityValidationResult = {
    isValid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
    summary: {
      jwtSecurityLevel: jwtValidation.level,
      databaseSecurityLevel: dbValidation.level,
      overallSecurityLevel
    }
  };

  return result;
}

/**
 * The secret checks for the startup check (index.ts, with validateStartupConfig): logs the
 * levels and warnings, and throws ProductionConfigError listing the errors, which stop the
 * server as they always did. Never logs a secret's value.
 */
export function checkSecretsForStartup(): void {
  const validation = validateNuggetsSecurityConfig();
  logger.info({
    overallSecurityLevel: validation.summary.overallSecurityLevel,
    jwtSecurityLevel: validation.summary.jwtSecurityLevel,
    databaseSecurityLevel: validation.summary.databaseSecurityLevel,
    warningCount: validation.warnings.length,
    errorCount: validation.errors.length
  }, 'Security validation results');
  if (validation.warnings.length > 0) {
    logger.warn({ warnings: validation.warnings }, 'Security warnings detected');
  }
  if (validation.errors.length > 0) {
    // The fix command, on the secret errors only (CLIENT_URL's isn't one).
    throw new ProductionConfigError(
      validation.errors.map((e) => (/^(JWT_SECRET|DB_PASSWORD) /.test(e) ? `${e} (npm run security:generate makes new secrets)` : e))
    );
  }
}
