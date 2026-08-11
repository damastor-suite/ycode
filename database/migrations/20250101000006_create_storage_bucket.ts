/**
 * Migration: Create Storage Bucket
 *
 * Storage is managed at the app/platform layer now.
 */

export async function up(): Promise<void> {
  // No-op: asset storage buckets are provisioned by app-level storage.
}

export async function down(): Promise<void> {
  // No-op: asset storage buckets are provisioned by app-level storage.
}
