/**
 * API Module Index - Central Export Point
 * 
 * Re-exports all API functions from modular files for convenient importing.
 * 
 * Usage:
 *   import { getAccounts, createTransaction, getBudgetItems } from '../services/api';
 */

// Export all base utilities
export { API_BASE_URL, getAuthHeaders, handleResponse } from './base';

// Re-export all types
export * from './types';

// Re-export all account operations
export * from './accounts';

// Re-export all institution operations
export * from './institutions';

// Re-export all transaction operations
export * from './transactions';

// Re-export all category operations
export * from './categories';

// Re-export all budget operations
export * from './budgets';

// Re-export all merchant operations
export * from './merchants';

// Re-export all attachment operations
export * from './attachments';

// Re-export all user operations
export * from './users';

// Re-export all profile operations
export * from './profile';

// Re-export all settings operations
export * from './settings';

// Re-export all backup operations
export * from './backup';

// Re-export all scheduler operations
export * from './schedulers';

// Re-export all import operations
export * from './import';

// Re-export all SimpleFin operations
export * from './simplefin';

// Re-export all goal operations
export * from './goals';

// Re-export all net worth operations
export * from './networth';

// Re-export all close-out operations
export * from './closeout';

// Re-export all admin operations
export * from './admin';

// Re-export all pre-auth setup operations
export * from './auth';

// Re-export all MCP access-token operations
export * from './mcp';

// Re-export all passkey operations
export * from './passkeys';

// Re-export step-up re-authentication
export * from './reauth';

// Re-export all Web Push operations
export * from './push';

// Re-export all tag operations
export * from './tags';
export * from './notifications';
export * from './bills';

// Re-export all export operations
export * from './export';

// Re-export all reports operations
export * from './reports';


// Re-export all multi-tenant management operations
export * from './tenants';
export * from './organizations';

// One-request detail-page summaries
export * from './detailSummaries';
