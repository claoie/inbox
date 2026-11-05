/**
 * PostgreSQL Database Module
 *
 * Provides data access layer for the mail application.
 * Uses flattened column structure with JSONB for complex nested objects
 * (addresses, attachments, insights).
 *
 * Architecture:
 * - models/: Schema definitions and model classes with validation
 * - repositories/: CRUD operations using models
 * - database.ts: Generic query helpers
 * - client.ts: Connection pool
 * - initialize.ts: Table creation
 */

export * from "./client";
export * from "./initialize";
export * from "./database";
export * from "./models";
export * from "./repositories";
