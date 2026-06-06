import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ImportPage } from './ImportPage';
import * as duckdb from '../duckdb/duckdbClient';
import { publishCurrentDataToRepoRoot } from '../publish/publishToRepo';

// Mock dependencies
vi.mock('../duckdb/duckdbClient', () => ({
    importCsv: vi.fn(),
    saveDb: vi.fn(),
    exportDbBlob: vi.fn(),
    importJsonData: vi.fn(),
    exportAardvarkJsonZip: vi.fn(),
    importDuckDbFile: vi.fn()
}));

vi.mock('../publish/publishToRepo', () => ({
    publishCurrentDataToRepoRoot: vi.fn(),
}));

vi.mock('../config/parquetArtifacts', () => ({
    DEFAULT_RESOURCES_PARQUET: 'resources.parquet',
    PARQUET_ARTIFACTS: {
        resources: 'published-resources.parquet',
        distributions: 'published-distributions.parquet',
    },
    usingDefaultResourceStarter: vi.fn(() => false),
}));

vi.mock('./GithubImport', () => ({
    GithubImport: () => <div data-testid="github-import">Github Import Component</div>
}));

// Mock URL.createObjectURL
global.URL.createObjectURL = vi.fn(() => 'blob:url');
global.URL.revokeObjectURL = vi.fn();

describe('ImportPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders welcome message when resourceCount is 0', () => {
        render(<ImportPage resourceCount={0} />);
        expect(screen.getByText(/Welcome to OpenGeoMetadata Studio/)).toBeDefined();
    });

    it('does not render welcome message when resources exist', () => {
        render(<ImportPage resourceCount={5} />);
        expect(screen.queryByText(/Welcome to OpenGeoMetadata Studio/)).toBeNull();
    });

    it('switches tabs', () => {
        render(<ImportPage />);

        // Default Local
        expect(screen.getByText('1. CSV / JSON / DuckDB Import')).toBeDefined();

        // Switch to Github
        fireEvent.click(screen.getByText('GitHub Import'));
        expect(screen.getByTestId('github-import')).toBeDefined();
        expect(screen.queryByText('1. CSV / JSON / DuckDB Import')).toBeNull();

        // Switch back
        fireEvent.click(screen.getByText('Local File Upload'));
        expect(screen.getByText('1. CSV / JSON / DuckDB Import')).toBeDefined();
    });

    it('handles JSON import', async () => {
        vi.mocked(duckdb.importJsonData).mockResolvedValue(10);

        const { container } = render(<ImportPage />);

        const input = container.querySelector('input[type="file"]');
        expect(input).toBeDefined();

        const file = new File(['{"id":"1"}'], 'test.json', { type: 'application/json' });
        // Mock text() method as it might not be implemented in jsdom perfectly or standard File ctor
        Object.defineProperty(file, 'text', {
            value: vi.fn().mockResolvedValue('{"id":"1"}')
        });

        fireEvent.change(input!, { target: { files: [file] } });

        await waitFor(() => {
            expect(duckdb.importJsonData).toHaveBeenCalled();
            expect(screen.getByText(/Import complete! Loaded 10 resources/)).toBeDefined();
        });
    });

    it('handles CSV import', async () => {
        vi.mocked(duckdb.importCsv).mockResolvedValue({ success: true, message: 'Imported 5 resources', count: 5 });

        const { container } = render(<ImportPage />);

        const input = container.querySelector('input[type="file"]');
        expect(input).toBeDefined();

        const file = new File(['id,title'], 'test.csv', { type: 'text/csv' });
        fireEvent.change(input!, { target: { files: [file] } });

        await waitFor(() => {
            expect(duckdb.importCsv).toHaveBeenCalled();
            expect(screen.getByText(/Import complete! Loaded 5 resources/)).toBeDefined();
        });
    });

    it('handles export JSON zip', async () => {
        vi.mocked(duckdb.exportAardvarkJsonZip).mockResolvedValue(new Blob(['zip data']));

        render(<ImportPage />);

        const btn = screen.getByText('Download JSON Zip');
        fireEvent.click(btn);

        await waitFor(() => {
            expect(duckdb.exportAardvarkJsonZip).toHaveBeenCalled();
            expect(screen.getByText('JSON OGM Export downloaded.')).toBeDefined();
        });
    });

    it('handles save DB', async () => {
        vi.mocked(duckdb.exportDbBlob).mockResolvedValue(new Blob(['db data']));

        render(<ImportPage />);

        const btn = screen.getByText('Download records.duckdb');
        fireEvent.click(btn);

        await waitFor(() => {
            expect(duckdb.saveDb).toHaveBeenCalled();
            expect(duckdb.exportDbBlob).toHaveBeenCalled();
            expect(screen.getByText(/Database downloaded/)).toBeDefined();
        });
    });

    it('handles unavailable DuckDB downloads after saving to IndexedDB', async () => {
        vi.mocked(duckdb.exportDbBlob).mockResolvedValue(null);

        render(<ImportPage />);

        fireEvent.click(screen.getByText('Download records.duckdb'));

        await waitFor(() => {
            expect(screen.getByText('Browser snapshot saved to IndexedDB. DuckDB file download is not available in this deployment.')).toBeDefined();
        });
    });

    it('handles DuckDB restore imports and invokes refresh callbacks', async () => {
        const onImported = vi.fn();
        vi.mocked(duckdb.importDuckDbFile).mockResolvedValue({ success: true, message: 'ok', count: 12 } as any);
        const { container } = render(<ImportPage onImported={onImported} />);

        const input = container.querySelector('input[type="file"]');
        const file = new File(['duck'], 'records.duckdb');
        fireEvent.change(input!, { target: { files: [file] } });

        await waitFor(() => {
            expect(duckdb.importDuckDbFile).toHaveBeenCalledWith(file);
            expect(screen.getByText('Database restored. Loaded 12 items.')).toBeDefined();
            expect(onImported).toHaveBeenCalled();
        });
    });

    it('chooses a repository folder and publishes generated metadata files', async () => {
        vi.stubGlobal('alert', vi.fn());
        const repoHandle = { name: 'metadata-repo' };
        vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(repoHandle));
        vi.mocked(publishCurrentDataToRepoRoot).mockResolvedValue({
            resourceCount: 2,
            distributionCount: 3,
            publicDirPath: 'web/public',
            resourceFileName: 'published-resources.parquet',
            distributionsFileName: 'published-distributions.parquet',
            duckdbFileName: 'records.duckdb',
        } as any);

        render(<ImportPage resourceCount={2} />);

        fireEvent.click(screen.getByText('Choose Repo Folder'));
        await waitFor(() => expect(screen.getByText('Selected: metadata-repo')).toBeDefined());

        fireEvent.click(screen.getByText('Prepare Parquet files for commit'));

        await waitFor(() => {
            expect(publishCurrentDataToRepoRoot).toHaveBeenCalledWith(repoHandle);
            expect(screen.getByText(/Publish ready. Wrote 2 records/)).toBeDefined();
            expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Publish ready'));
        });
    });

    it('reports export and publish setup failures', async () => {
        vi.mocked(duckdb.exportAardvarkJsonZip).mockRejectedValueOnce(new Error('zip failed'));
        vi.stubGlobal('showDirectoryPicker', vi.fn().mockRejectedValueOnce(new Error('picker failed')));

        render(<ImportPage resourceCount={2} />);

        fireEvent.click(screen.getByText('Download JSON Zip'));
        await waitFor(() => expect(screen.getByText('Export failed: zip failed')).toBeDefined());

        fireEvent.click(screen.getByText('Choose Repo Folder'));
        await waitFor(() => expect(screen.getByText('Publish setup failed: picker failed')).toBeDefined());
    });

    it('handles errors during import', async () => {
        vi.mocked(duckdb.importCsv).mockResolvedValue({ success: false, message: 'Invalid CSV' });

        const { container } = render(<ImportPage />);

        const input = container.querySelector('input[type="file"]');
        const file = new File(['bad'], 'bad.csv', { type: 'text/csv' });
        fireEvent.change(input!, { target: { files: [file] } });

        await waitFor(() => {
            expect(screen.getByText(/Error:/)).toBeDefined();
            expect(screen.getByText(/Invalid CSV/)).toBeDefined();
        });
    });
});
