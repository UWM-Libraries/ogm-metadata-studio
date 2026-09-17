import React, { useState } from 'react';
import { GithubService } from '../services/GithubService';
import {
  importJsonData,
  rebuildFromJsonData,
  saveDb,
} from '../duckdb/duckdbClient';
import { gbl1ToAardvark } from '../aardvark/gbl1_to_aardvark';
import { useGithubScanner } from '../hooks/useGithubScanner';
import { ScanForm } from './import/ScanForm';
import { ImportProgress } from './import/ImportProgress';

interface GithubImportProps {
  onDatabaseChanged?: () => void | Promise<void>;
}

export const GithubImport: React.FC<GithubImportProps> = ({
  onDatabaseChanged,
}) => {
  // Use the hook
  const {
    repoUrl,
    setRepoUrl,
    branch,
    setBranch,
    token,
    setToken,
    isScanning,
    scanError,
    foundFiles,
    schemaMode,
    scan,
    parseRepoUrl,
  } = useGithubScanner();

  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState({
    current: 0,
    total: 0,
    successes: 0,
    failures: 0,
  });
  const [errorLogs, setErrorLogs] = useState<{ path: string; error: string }[]>(
    []
  );
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  const handleImport = async (replaceAll = false) => {
    if (foundFiles.length === 0) return;
    if (
      replaceAll &&
      !window.confirm(
        `Replace the current Studio database with ${foundFiles.length} repository JSON files? Local working-state records and caches will be removed.`
      )
    )
      return;

    setIsImporting(true);
    setResultMessage(null);
    setErrorLogs([]);
    setImportProgress({
      current: 0,
      total: foundFiles.length,
      successes: 0,
      failures: 0,
    });

    const repoRef = parseRepoUrl(repoUrl);
    if (!repoRef) {
      setIsImporting(false);
      return;
    }

    const client = new GithubService({ token: token || undefined });

    const CHUNK_SIZE = 50;
    let successes = 0;
    let failures = 0;
    const downloaded: unknown[] = new Array(foundFiles.length);

    for (let i = 0; i < foundFiles.length; i += CHUNK_SIZE) {
      const chunk = foundFiles.slice(i, i + CHUNK_SIZE);

      await Promise.all(
        chunk.map(async (file, chunkIndex) => {
          try {
            let json = await client.fetchPublicJson(
              { ...repoRef, branch },
              file.path
            );

            // GBL v1 Handling
            if (schemaMode === 'gbl1') {
              // Check for double-encoded string (e.g. Harvard)
              if (typeof json === 'string') {
                try {
                  json = JSON.parse(json);
                } catch (e) {
                  // Maybe it was just a string? Unlikely for metadata
                  throw new Error('Failed to parse double-encoded JSON string');
                }
              }

              // Crosswalk
              json = gbl1ToAardvark(json);
            }

            if (
              typeof json !== 'object' ||
              json === null ||
              Array.isArray(json) ||
              !('id' in json) ||
              !json.id
            ) {
              failures++;
              setErrorLogs((prev) => [
                ...prev.slice(-99),
                { path: file.path, error: 'No Resource ID found' },
              ]);
            } else {
              downloaded[i + chunkIndex] = json;
              successes++;
            }
          } catch (e: any) {
            console.error(`Failed to import ${file.path}`, e);
            failures++;
            setErrorLogs((prev) => [
              ...prev.slice(-99),
              { path: file.path, error: e.message || String(e) },
            ]);
          }
        })
      );

      setImportProgress((prev) => ({
        ...prev,
        current: Math.min(i + CHUNK_SIZE, foundFiles.length),
        successes,
        failures,
      }));
    }

    try {
      if (replaceAll) {
        if (failures > 0) {
          setResultMessage(
            `Rebuild canceled: ${failures} of ${foundFiles.length} source files could not be prepared. The existing database was not changed.`
          );
          return;
        }
        const result = await rebuildFromJsonData(downloaded);
        await onDatabaseChanged?.();
        setResultMessage(
          `Rebuild complete. Replaced the Studio database with ${result.imported} repository JSON records.`
        );
      } else {
        for (const json of downloaded) {
          if (json !== undefined)
            await importJsonData(json, { skipSave: true });
        }
        await saveDb();
        await onDatabaseChanged?.();
        setResultMessage(
          `Import complete. Imported ${successes} files; ${failures} failed.`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorLogs((prev) => [
        ...prev.slice(-99),
        { path: 'database', error: message },
      ]);
      setResultMessage(
        `${replaceAll ? 'Rebuild' : 'Import'} failed. ${replaceAll ? 'The existing database was preserved.' : ''}`.trim()
      );
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <ScanForm
        repoUrl={repoUrl}
        setRepoUrl={setRepoUrl}
        branch={branch}
        setBranch={setBranch}
        token={token}
        setToken={setToken}
        onScan={scan}
        isScanning={isScanning || isImporting}
        scanError={scanError}
      />

      <ImportProgress
        foundFiles={foundFiles}
        schemaMode={schemaMode}
        isImporting={isImporting}
        onImport={() => handleImport(false)}
        onRebuild={
          schemaMode === 'aardvark' ? () => handleImport(true) : undefined
        }
        progress={importProgress}
        errorLogs={errorLogs}
        resultMessage={resultMessage}
      />
    </div>
  );
};
