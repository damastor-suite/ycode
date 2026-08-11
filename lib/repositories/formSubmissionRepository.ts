import { getDb } from '@/lib/platform/db';
import {
  addTenantIdToRow,
  applyTenantFilter,
  normalizeRow,
  normalizeRows,
} from './knex-repository-utils';
import type {
  FormSubmission,
  FormSummary,
  CreateFormSubmissionData,
  UpdateFormSubmissionData,
  FormSubmissionStatus,
} from '@/types';

/**
 * Form Submission Repository
 *
 * Handles CRUD operations for form submissions.
 */

export async function getAllFormSubmissions(
  formId?: string,
  status?: FormSubmissionStatus
): Promise<FormSubmission[]> {
  const knex = await getDb();
  let query = knex('form_submissions')
    .select('*')
    .orderBy('created_at', 'desc');

  if (formId) {
    query = query.where('form_id', formId);
  }

  if (status) {
    query = query.where('status', status);
  }

  query = await applyTenantFilter(knex, query, 'form_submissions');

  try {
    return normalizeRows(await query) as FormSubmission[];
  } catch (error) {
    throw new Error(
      `Failed to fetch form submissions: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getFormSubmissionById(id: string): Promise<FormSubmission | null> {
  const knex = await getDb();
  let query = knex('form_submissions')
    .select('*')
    .where('id', id);
  query = await applyTenantFilter(knex, query, 'form_submissions');

  try {
    const row = await query.first();
    return row ? normalizeRow(row) as FormSubmission : null;
  } catch (error) {
    throw new Error(
      `Failed to fetch form submission: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getFormSummaries(): Promise<FormSummary[]> {
  const knex = await getDb();
  let query = knex('form_submissions')
    .select('form_id', 'status', 'created_at')
    .orderBy('created_at', 'desc');
  query = await applyTenantFilter(knex, query, 'form_submissions');

  try {
    const submissions = normalizeRows(await query) as FormSubmission[];
    const formMap = new Map<string, FormSummary>();

    for (const submission of submissions) {
      const existing = formMap.get(submission.form_id);
      if (existing) {
        existing.submission_count += 1;
        if (submission.status === 'new') {
          existing.new_count += 1;
        }
        continue;
      }

      formMap.set(submission.form_id, {
        form_id: submission.form_id,
        submission_count: 1,
        new_count: submission.status === 'new' ? 1 : 0,
        latest_submission: submission.created_at,
      });
    }

    return Array.from(formMap.values());
  } catch (error) {
    throw new Error(
      `Failed to fetch form summaries: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function createFormSubmission(
  submissionData: CreateFormSubmissionData
): Promise<FormSubmission> {
  const knex = await getDb();
  const row = await addTenantIdToRow(knex, 'form_submissions', {
    form_id: submissionData.form_id,
    payload: submissionData.payload,
    metadata: submissionData.metadata ?? null,
    status: 'new',
    created_at: new Date().toISOString(),
  });

  try {
    const [data] = await knex('form_submissions')
      .insert(row)
      .returning('*');
    return normalizeRow(data) as FormSubmission;
  } catch (error) {
    throw new Error(
      `Failed to create form submission: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function updateFormSubmission(
  id: string,
  submissionData: UpdateFormSubmissionData
): Promise<FormSubmission> {
  const knex = await getDb();
  let query = knex('form_submissions')
    .where('id', id)
    .update(submissionData)
    .returning('*');
  query = await applyTenantFilter(knex, query, 'form_submissions');

  try {
    const [data] = await query;
    if (!data) {
      throw new Error('Form submission not found');
    }
    return normalizeRow(data) as FormSubmission;
  } catch (error) {
    throw new Error(
      `Failed to update form submission: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function deleteFormSubmission(id: string): Promise<void> {
  const knex = await getDb();
  let query = knex('form_submissions').where('id', id).del();
  query = await applyTenantFilter(knex, query, 'form_submissions');

  try {
    await query;
  } catch (error) {
    throw new Error(
      `Failed to delete form submission: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function bulkDeleteFormSubmissions(ids: string[]): Promise<void> {
  if (ids.length === 0) return;

  const knex = await getDb();
  let query = knex('form_submissions').whereIn('id', ids).del();
  query = await applyTenantFilter(knex, query, 'form_submissions');

  try {
    await query;
  } catch (error) {
    throw new Error(
      `Failed to bulk delete form submissions: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function deleteFormSubmissionsByFormId(formId: string): Promise<void> {
  const knex = await getDb();
  let query = knex('form_submissions').where('form_id', formId).del();
  query = await applyTenantFilter(knex, query, 'form_submissions');

  try {
    await query;
  } catch (error) {
    throw new Error(
      `Failed to delete form submissions: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function markAllAsRead(formId: string): Promise<void> {
  const knex = await getDb();
  let query = knex('form_submissions')
    .where('form_id', formId)
    .where('status', 'new')
    .update({ status: 'read' });
  query = await applyTenantFilter(knex, query, 'form_submissions');

  try {
    await query;
  } catch (error) {
    throw new Error(
      `Failed to mark submissions as read: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
