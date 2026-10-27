// src/modules/workspace/constants.ts — shared, client-safe pagination sizes.
//
// Previously hosted in modules/admin (the platform panel, removed in Change 6).
// Kept in a client-safe module so server components can import them without
// pulling a client reference (the old NaN-page bug, feature 07/09 notes).

export const CUSTOMERS_PAGE_SIZE = 20;
export const PROJECTS_PAGE_SIZE = 20;
export const INVOICES_PAGE_SIZE = 20;
export const PAYMENTS_PAGE_SIZE = 20;
