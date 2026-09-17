import type { ExportValidationError } from '../aardvark/validation';
import { createPortal } from 'react-dom';

interface ExportValidationReportProps {
  error: ExportValidationError;
  onClose: () => void;
  onEdit?: (id: string) => void;
}

export function ExportValidationReport({
  error,
  onClose,
  onEdit,
}: ExportValidationReportProps) {
  const grouped = new Map<string, typeof error.failures>();
  for (const failure of error.failures) {
    const key = failure.recordId || '';
    grouped.set(key, [...(grouped.get(key) ?? []), failure]);
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-validation-title"
    >
      <section className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-slate-900">
        <header className="flex items-start justify-between gap-4 border-b border-red-200 bg-red-50 p-5 dark:border-red-900 dark:bg-red-950/40">
          <div>
            <h2
              id="export-validation-title"
              className="text-lg font-semibold text-red-900 dark:text-red-100"
            >
              Export needs metadata corrections
            </h2>
            <p className="mt-1 text-sm text-red-700 dark:text-red-300">
              No files were generated. Correct the issues below and run the
              export again.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-red-700 hover:bg-red-100 dark:text-red-300 dark:hover:bg-red-900/50"
            aria-label="Close validation report"
          >
            Close
          </button>
        </header>

        <div className="overflow-y-auto p-5">
          <p className="mb-4 text-sm text-slate-600 dark:text-slate-300">
            {error.failures.length}{' '}
            {error.failures.length === 1 ? 'issue' : 'issues'} in {grouped.size}{' '}
            {grouped.size === 1 ? 'record' : 'records'}
          </p>
          <div className="space-y-4">
            {Array.from(grouped.entries()).map(([recordId, failures]) => (
              <article
                key={recordId || 'missing-id'}
                className="rounded-lg border border-slate-200 p-4 dark:border-slate-700"
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <code className="break-all text-sm font-semibold text-slate-900 dark:text-white">
                    {recordId || '(missing id)'}
                  </code>
                  {recordId && onEdit && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onEdit(recordId);
                      }}
                      className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
                    >
                      Edit record
                    </button>
                  )}
                </div>
                <ul className="space-y-2">
                  {failures.map(({ issue }, index) => (
                    <li
                      key={`${issue.profile}-${issue.field}-${issue.code}-${index}`}
                      className="text-sm text-slate-700 dark:text-slate-200"
                    >
                      <span className="mr-2 inline-block rounded bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                        {issue.field}
                      </span>
                      {issue.message}
                      <span className="ml-2 text-xs text-slate-400">
                        {issue.profile}
                      </span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </section>
    </div>,
    document.body
  );
}
