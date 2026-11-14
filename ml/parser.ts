import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';
import type { DatasetDomain, MmashWindowMode, ZipEntryInfo } from './types.ts';

export interface ParsedTable {
  headers: string[];
  rows: Record<string, string>[];
  fileType: 'csv' | 'zip';
  zipManifest?: ZipEntryInfo[];
  notes: string[];
  mmashWindowModeUsed?: MmashWindowMode;
  mmashWindowSeconds?: number;
}

export interface ParseUploadOptions {
  mmashWindowMode?: MmashWindowMode;
  windowSeconds?: number;
}

export interface ParsedNumericCell {
  value: number | null;
  censor: 'none' | 'left' | 'right' | 'missing';
  boundValue?: number | null;
  rawToken?: string;
}

const MISSING_TOKENS = new Set([
  '',
  'na',
  'n/a',
  'nan',
  'null',
  'none',
  'nil',
  '.',
  '-',
  'nd',
  'missing',
]);

export function isMissingValue(val: unknown): boolean {
  if (val === null || val === undefined) return true;
  const s = String(val).trim().toLowerCase();
  return MISSING_TOKENS.has(s);
}

export function parseNumericWithCensor(val: unknown): ParsedNumericCell {
  if (isMissingValue(val)) {
    return { value: null, censor: 'missing' };
  }
  let s = String(val).trim();
  const clean = s.replace(/,/g, '');

  // Explicit OOR / BLQ / LOD / ULOQ tokens without numeric value
  if (/^(?:oor\s*<|blq|lod|<\s*lod|<\s*lloq|<\s*dl|below\s*(?:lod|dl|range))$/i.test(clean)) {
    return { value: null, censor: 'left', boundValue: null, rawToken: s };
  }
  if (/^(?:oor\s*>|>\s*uloq|above\s*(?:uloq|range)|alr)$/i.test(clean)) {
    return { value: null, censor: 'right', boundValue: null, rawToken: s };
  }

  // Left-censored numeric bound e.g. "<0.14", "<= 0.5", "OOR < 0.14"
  const leftMatch = clean.match(/^(?:oor\s*)?<=?\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i);
  if (leftMatch) {
    const bound = Number(leftMatch[1]);
    if (Number.isFinite(bound)) {
      return {
        value: Number((bound * 0.5).toFixed(6)),
        censor: 'left',
        boundValue: bound,
        rawToken: s,
      };
    }
  }

  // Right-censored numeric bound e.g. ">10000", ">= 5000", "OOR > 10000"
  const rightMatch = clean.match(/^(?:oor\s*)?>=?\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i);
  if (rightMatch) {
    const bound = Number(rightMatch[1]);
    if (Number.isFinite(bound)) {
      return {
        value: bound,
        censor: 'right',
        boundValue: bound,
        rawToken: s,
      };
    }
  }

  // Trailing asterisk / qualifier on numeric values (e.g., "12.4*")
  const stripped = clean.replace(/\*+$/, '');
  const num = Number(stripped);
  if (Number.isFinite(num)) {
    return { value: num, censor: 'none' };
  }

  return { value: null, censor: 'missing' };
}

export function parseNumericValue(val: unknown): number | null {
  const cell = parseNumericWithCensor(val);
  if (cell.censor === 'none') return cell.value;
  return null;
}

export function extractUnitFromHeader(header: string): string | null {
  const parenMatch = header.match(/\(([^)]+)\)\s*$/);
  if (parenMatch) return parenMatch[1].trim();
  const bracketMatch = header.match(/\[([^\]]+)\]\s*$/);
  if (bracketMatch) return bracketMatch[1].trim();
  return null;
}

function parseCsvBuffer(buffer: Buffer): { headers: string[]; rows: Record<string, string>[] } {
  const text = buffer.toString('utf-8').replace(/^\uFEFF/, '');
  if (!text.trim()) {
    return { headers: [], rows: [] };
  }
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) || '';
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semiCount = (firstLine.match(/;/g) || []).length;
  const tabCount = (firstLine.match(/\t/g) || []).length;
  let delimiter = ',';
  if (tabCount > commaCount && tabCount >= semiCount) delimiter = '\t';
  else if (semiCount > commaCount) delimiter = ';';

  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    relax_quotes: true,
    delimiter,
  }) as Record<string, string>[];

  const headers = records.length > 0 ? Object.keys(records[0]).filter((h) => h.trim() !== '') : [];
  return { headers, rows: records };
}

function inferSubjectFromPath(entryPath: string): string | null {
  const match = entryPath.match(
    /(user[_-]?\d+|subject[_-]?\d+|sub[_-]?\d+|participant[_-]?\d+|s\d{1,3})/i
  );
  return match ? match[1] : null;
}

function isNumericColumnSample(rows: Record<string, string>[], col: string): boolean {
  let valid = 0;
  let numeric = 0;
  const limit = Math.min(rows.length, 100);
  for (let i = 0; i < limit; i++) {
    const raw = rows[i][col];
    if (!isMissingValue(raw)) {
      valid++;
      if (parseNumericValue(raw) !== null) numeric++;
    }
  }
  return valid > 0 && numeric / valid >= 0.7;
}

function computeHrvStats(ibiSeconds: number[]): {
  hrMeanBpm: number;
  sdnnMs: number;
  rmssdMs: number;
} | null {
  const validMs = ibiSeconds
    .map((v) => (v < 10 ? v * 1000 : v)) // handle seconds vs milliseconds safely
    .filter((ms) => ms >= 250 && ms <= 2500);
  if (validMs.length < 2) return null;

  const meanMs = validMs.reduce((a, b) => a + b, 0) / validMs.length;
  const hrMeanBpm = 60000 / meanMs;
  const variance =
    validMs.reduce((a, b) => a + (b - meanMs) ** 2, 0) / (validMs.length - 1);
  const sdnnMs = Math.sqrt(variance);

  let diffSqSum = 0;
  for (let i = 1; i < validMs.length; i++) {
    const d = validMs[i] - validMs[i - 1];
    diffSqSum += d * d;
  }
  const rmssdMs = Math.sqrt(diffSqSum / (validMs.length - 1));
  return {
    hrMeanBpm: Number(hrMeanBpm.toFixed(3)),
    sdnnMs: Number(sdnnMs.toFixed(3)),
    rmssdMs: Number(rmssdMs.toFixed(3)),
  };
}

function parseTimeOfDaySeconds(raw: string): number | null {
  const s = raw.trim();
  const hms = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/);
  if (hms) {
    const hh = Number(hms[1]);
    const mm = Number(hms[2]);
    const ss = hms[3] !== undefined ? Number(hms[3]) : 0;
    if (hh >= 0 && hh < 48 && mm >= 0 && mm < 60 && ss >= 0 && ss < 60) {
      return hh * 3600 + mm * 60 + ss;
    }
  }
  // Full datetime string with space or T
  if (/[-/:T]/.test(s) && !/^\d+(\.\d+)?$/.test(s)) {
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) {
      return ms / 1000;
    }
  }
  return null;
}

function formatChronologicalLabel(bucketSec: number, isEpochTimestamp: boolean): string {
  if (isEpochTimestamp) {
    return new Date(bucketSec * 1000).toISOString().replace('T', ' ').slice(0, 19);
  }
  const day = Math.floor(bucketSec / 86400) + 1;
  const rem = Math.max(0, Math.floor(bucketSec % 86400));
  const hh = String(Math.floor(rem / 3600)).padStart(2, '0');
  const mm = String(Math.floor((rem % 3600) / 60)).padStart(2, '0');
  const ss = String(rem % 60).padStart(2, '0');
  return `D${day} ${hh}:${mm}:${ss}`;
}

function summarizeFileEpochs(
  entryPath: string,
  headers: string[],
  rows: Record<string, string>[],
  mode: MmashWindowMode,
  windowSeconds = 60,
  numEpochs = 20
): { epochRows: Record<string, string>[]; isSummaryFile: boolean; bucketKeys?: number[] } {
  const numericCols = headers.filter(
    (h) => !/^(day|unnamed|index)$/i.test(h.trim()) && isNumericColumnSample(rows, h)
  );
  const timeCol =
    headers.find((h) => /^(time|timestamp|datetime|date_time|start)$/i.test(h.trim())) || null;
  const dayCol = headers.find((h) => /^(day|day_index)$/i.test(h.trim())) || null;
  const baseName = entryPath.split('/').pop()?.replace(/\.csv$/i, '') || 'file';

  // Small per-subject summary files (e.g. sleep.csv, saliva.csv, user_info.csv) -> single subject summary row
  if (rows.length <= 25) {
    const summary: Record<string, string> = {};
    for (const col of numericCols) {
      const vals: number[] = [];
      for (const r of rows) {
        const v = parseNumericValue(r[col]);
        if (v !== null) vals.push(v);
      }
      if (vals.length > 0) {
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        summary[`${baseName}_${col}`] = mean.toFixed(4);
      }
    }
    return { epochRows: [summary], isSummaryFile: true };
  }

  const ibiCol = numericCols.find((c) => /ibi|rr/i.test(c));

  const buildWindowRow = (
    slice: Record<string, string>[],
    windowIdx: number,
    explicitTimestamp?: string
  ): Record<string, string> => {
    const out: Record<string, string> = {
      epoch_index: String(windowIdx + 1),
    };
    if (explicitTimestamp) {
      out[`${baseName}_time`] = explicitTimestamp;
    } else if (timeCol && slice[0]?.[timeCol]) {
      out[`${baseName}_time`] = slice[0][timeCol];
    }

    for (const col of numericCols) {
      let sum = 0;
      let count = 0;
      for (const r of slice) {
        const v = parseNumericValue(r[col]);
        if (v !== null) {
          sum += v;
          count++;
        }
      }
      if (count > 0) {
        out[`${baseName}_${col}_mean`] = (sum / count).toFixed(4);
      }
    }

    if (ibiCol) {
      const ibis: number[] = [];
      for (const r of slice) {
        const v = parseNumericValue(r[ibiCol]);
        if (v !== null) ibis.push(v);
      }
      const hrv = computeHrvStats(ibis);
      if (hrv) {
        out[`${baseName}_HR_bpm_mean`] = String(hrv.hrMeanBpm);
        out[`${baseName}_SDNN_ms`] = String(hrv.sdnnMs);
        out[`${baseName}_RMSSD_ms`] = String(hrv.rmssdMs);
      }
    }
    return out;
  };

  if (mode === 'window_60s') {
    const buckets = new Map<number, Record<string, string>[]>();
    let dayRollover = 0;
    let prevHms: number | null = null;
    let cumulativeIbiSec = 0;
    let isFullEpochMode = false;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      let bucketNum: number | null = null;

      if (timeCol && r[timeCol]) {
        const parsedSec = parseTimeOfDaySeconds(r[timeCol]);
        if (parsedSec !== null) {
          if (parsedSec > 1e8) {
            // Full epoch datetime timestamp
            isFullEpochMode = true;
            bucketNum = Math.floor(parsedSec / windowSeconds);
          } else {
            let dayOffset = 0;
            if (dayCol && r[dayCol] !== undefined) {
              const dVal = parseNumericValue(r[dayCol]);
              if (dVal !== null && dVal >= 1) {
                dayOffset = Math.floor(dVal) - 1;
              }
            } else {
              if (prevHms !== null && parsedSec < prevHms - 43200) {
                dayRollover += 1;
              }
              dayOffset = dayRollover;
              prevHms = parsedSec;
            }
            const totalSec = dayOffset * 86400 + parsedSec;
            bucketNum = Math.floor(totalSec / windowSeconds);
          }
        }
      }

      if (bucketNum === null) {
        if (ibiCol) {
          const ibiVal = parseNumericValue(r[ibiCol]);
          const ibiSec = ibiVal !== null ? (ibiVal > 10 ? ibiVal / 1000 : ibiVal) : 0.8;
          bucketNum = Math.floor(cumulativeIbiSec / windowSeconds);
          cumulativeIbiSec += ibiSec;
        } else {
          // 1 Hz Actigraph row cadence fallback
          bucketNum = Math.floor(i / windowSeconds);
        }
      }

      const arr = buckets.get(bucketNum) || [];
      arr.push(r);
      buckets.set(bucketNum, arr);
    }

    const sortedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
    const epochRows: Record<string, string>[] = [];
    for (let idx = 0; idx < sortedKeys.length; idx++) {
      const bKey = sortedKeys[idx];
      const slice = buckets.get(bKey)!;
      const label =
        timeCol && slice[0]?.[timeCol]
          ? formatChronologicalLabel(bKey * windowSeconds, isFullEpochMode)
          : formatChronologicalLabel(bKey * windowSeconds, false);
      epochRows.push(buildWindowRow(slice, idx, label));
    }

    return { epochRows, isSummaryFile: false, bucketKeys: sortedKeys };
  }

  // Legacy 'epoch_20' chronological binning
  const effectiveWindows = Math.min(numEpochs, rows.length);
  const windowSize = Math.ceil(rows.length / effectiveWindows);
  const epochRows: Record<string, string>[] = [];
  const bucketKeys: number[] = [];

  for (let w = 0; w < effectiveWindows; w++) {
    const start = w * windowSize;
    const end = Math.min(rows.length, start + windowSize);
    if (start >= rows.length) break;
    const slice = rows.slice(start, end);
    epochRows.push(buildWindowRow(slice, w));
    bucketKeys.push(w + 1);
  }

  return { epochRows, isSummaryFile: false, bucketKeys };
}

export function parseUploadedFile(
  buffer: Buffer,
  filename: string,
  domain: DatasetDomain,
  options?: ParseUploadOptions
): ParsedTable {
  const lower = filename.toLowerCase();
  const notes: string[] = [];
  const windowMode: MmashWindowMode = options?.mmashWindowMode ?? 'window_60s';
  const windowSeconds = Math.max(10, Math.min(3600, options?.windowSeconds ?? 60));

  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
    const { headers, rows } = parseCsvBuffer(buffer);
    if (headers.length === 0 || rows.length === 0) {
      throw new Error(`Uploaded file "${filename}" contains no valid tabular rows.`);
    }
    notes.push(
      `Parsed CSV file "${filename}" with ${rows.length} raw rows and ${headers.length} columns.`
    );
    return { headers, rows, fileType: 'csv', notes };
  }

  if (lower.endsWith('.zip')) {
    let zip: AdmZip;
    try {
      zip = new AdmZip(buffer);
    } catch (err) {
      throw new Error(
        `Unable to open ZIP archive "${filename}": ${err instanceof Error ? err.message : 'invalid ZIP structure'}.`
      );
    }

    const entries = zip.getEntries().filter((e) => {
      if (e.isDirectory) return false;
      const name = e.entryName;
      if (name.includes('__MACOSX') || name.split('/').pop()?.startsWith('.')) return false;
      return name.toLowerCase().endsWith('.csv');
    });

    if (entries.length === 0) {
      throw new Error(`ZIP archive "${filename}" does not contain any readable .csv files.`);
    }

    const zipManifest: ZipEntryInfo[] = [];
    const bySubject = new Map<
      string,
      {
        epochBuckets: Map<number, Record<string, string>>;
        summaryCols: Record<string, string>;
        flatRows: Record<string, string>[];
      }
    >();

    let parsedCsvCount = 0;
    for (const entry of entries) {
      let headers: string[] = [];
      let rows: Record<string, string>[] = [];
      try {
        const content = entry.getData();
        const parsed = parseCsvBuffer(content);
        headers = parsed.headers;
        rows = parsed.rows;
      } catch (err) {
        notes.push(
          `Skipped malformed CSV "${entry.entryName}": ${err instanceof Error ? err.message : 'parse error'}.`
        );
        continue;
      }

      const inferredSub = inferSubjectFromPath(entry.entryName);
      zipManifest.push({
        path: entry.entryName,
        sizeBytes: entry.header.size,
        rowCount: rows.length,
        columns: headers,
        inferredSubjectId: inferredSub,
      });

      if (rows.length === 0 || headers.length === 0) continue;
      parsedCsvCount++;

      const fname = entry.entryName.toLowerCase();
      if (domain === 'physiological' && (fname.includes('user_info') || fname.includes('questionnaire'))) {
        continue;
      }

      const subj = inferredSub || entry.entryName.split('/').slice(-2, -1)[0] || 'cohort';
      if (!bySubject.has(subj)) {
        bySubject.set(subj, {
          epochBuckets: new Map(),
          summaryCols: {},
          flatRows: [],
        });
      }
      const subjData = bySubject.get(subj)!;

      // Single-table ZIPs without per-subject folders keep their rows intact
      if (!inferredSub && entries.length <= 3 && rows.length <= 2000) {
        for (const r of rows) {
          subjData.flatRows.push({ subject_id: subj, ...r });
        }
        continue;
      }

      const { epochRows, isSummaryFile, bucketKeys } = summarizeFileEpochs(
        entry.entryName,
        headers,
        rows,
        windowMode,
        windowSeconds,
        20
      );
      if (isSummaryFile) {
        Object.assign(subjData.summaryCols, epochRows[0]);
      } else {
        epochRows.forEach((ep, idx) => {
          const bKey = bucketKeys ? bucketKeys[idx] : idx + 1;
          const existing = subjData.epochBuckets.get(bKey) || {
            subject_id: subj,
            epoch_index: String(subjData.epochBuckets.size + 1),
          };
          Object.assign(existing, ep);
          subjData.epochBuckets.set(bKey, existing);
        });
      }
    }

    const alignedRows: Record<string, string>[] = [];
    const allHeaderSet = new Set<string>();

    // Sort subjects naturally (user_1, user_2, ..., user_22) for deterministic chronological ordering
    const sortedSubjects = Array.from(bySubject.entries()).sort((a, b) =>
      a[0].localeCompare(b[0], undefined, { numeric: true })
    );

    for (const [subj, data] of sortedSubjects) {
      if (data.flatRows.length > 0) {
        for (const r of data.flatRows) {
          Object.keys(r).forEach((k) => allHeaderSet.add(k));
          alignedRows.push(r);
        }
      }
      if (data.epochBuckets.size > 0) {
        const sortedEpochs = Array.from(data.epochBuckets.entries()).sort((a, b) => a[0] - b[0]);
        let seqIdx = 1;
        for (const [, row] of sortedEpochs) {
          const merged: Record<string, string> = {
            ...row,
            ...data.summaryCols,
            epoch_index: String(seqIdx++),
          };
          const timeKey =
            Object.keys(merged).find((k) => k.endsWith('_time') && merged[k]) ||
            Object.keys(merged).find((k) => k.endsWith('_time'));
          if (timeKey && !merged.timestamp) {
            merged.timestamp = merged[timeKey];
          }
          Object.keys(merged).forEach((k) => allHeaderSet.add(k));
          alignedRows.push(merged);
        }
      } else if (Object.keys(data.summaryCols).length > 0) {
        const merged = { subject_id: subj, ...data.summaryCols };
        Object.keys(merged).forEach((k) => allHeaderSet.add(k));
        alignedRows.push(merged);
      }
    }

    if (alignedRows.length === 0) {
      throw new Error(
        `Extracted ${entries.length} CSV file(s) from "${filename}", but none produced valid numeric observations.`
      );
    }

    const headers = Array.from(allHeaderSet);
    const normalizedRows = alignedRows.map((r) => {
      const out: Record<string, string> = {};
      for (const h of headers) out[h] = r[h] ?? '';
      return out;
    });

    const subjectCount = new Set(normalizedRows.map((r) => r.subject_id)).size;
    notes.push(
      `Extracted ZIP archive "${filename}" (${windowMode === 'window_60s' ? `${windowSeconds}s physiological windows` : '20-epoch overview aggregation'}): parsed ${parsedCsvCount} of ${entries.length} CSV file(s), aligned ${normalizedRows.length} chronological observation windows across ${subjectCount} participant(s).`
    );

    return {
      headers,
      rows: normalizedRows,
      fileType: 'zip',
      zipManifest,
      notes,
      mmashWindowModeUsed: windowMode,
      mmashWindowSeconds: windowSeconds,
    };
  }

  throw new Error(
    `Unsupported file format for "${filename}". Please upload a .csv, .tsv, or .zip archive.`
  );
}
