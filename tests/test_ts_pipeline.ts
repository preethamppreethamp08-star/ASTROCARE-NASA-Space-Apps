import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { parseUploadedFile } from '../ml/parser.ts';
import { preprocessDataset } from '../ml/preprocessing.ts';
import { runDomainMLAnalysis } from '../ml/isolationForest.ts';

function buildSyntheticMmashZip(): Buffer {
  const zip = new AdmZip();
  for (const subj of ['user_1', 'user_2']) {
    const actRows: string[] = [];
    const rrRows: string[] = [];
    for (let sec = 0; sec < 300; sec++) {
      const hh = String(9 + Math.floor(sec / 3600)).padStart(2, '0');
      const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      const tStr = `${hh}:${mm}:${ss}`;
      actRows.push(
        `${10 + (sec % 5)},${12 + (sec % 4)},${15 + (sec % 6)},${sec % 3 === 0 ? 1 : 0},${72 + (sec % 8)},0,1,0,0,28.5,1,${tStr}`
      );
      if (sec % 2 === 0) {
        const base = subj === 'user_1' ? 0.82 : 0.74;
        const jitter = (((sec + (subj === 'user_1' ? 1 : 3)) % 7) - 3) * (0.012 + Math.floor(sec / 60) * 0.004);
        rrRows.push(`${(base + jitter).toFixed(4)},1,${tStr}`);
      }
    }
    zip.addFile(
      `DataPaper/${subj}/Actigraph.csv`,
      Buffer.from(
        'Axis1,Axis2,Axis3,Steps,HR,Inclinometer Off,Inclinometer Standing,Inclinometer Sitting,Inclinometer Lying,Vector Magnitude,day,time\n' +
          actRows.join('\n')
      )
    );
    zip.addFile(`DataPaper/${subj}/RR.csv`, Buffer.from('ibi_s,day,time\n' + rrRows.join('\n')));
    zip.addFile(
      `DataPaper/${subj}/sleep.csv`,
      Buffer.from('In Bed Date,Out Bed Date,Onset Date,Efficiency,Total Sleep Time (TST)\n2,2,2,88.5,410\n')
    );
  }
  return zip.toBuffer();
}

// 1. MMASH 60s vs 20-epoch parity test
{
  const zipBuf = buildSyntheticMmashZip();
  const parsed60 = parseUploadedFile(zipBuf, 'MMASH_test.zip', 'physiological', {
    mmashWindowMode: 'window_60s',
    windowSeconds: 60,
  });
  assert.equal(parsed60.rows.length, 10, 'Expected 2 subjects * 5 60s windows = 10 rows');
  const ds60 = preprocessDataset({
    id: 'test_60',
    domain: 'physiological',
    filename: 'MMASH_test.zip',
    fileType: 'zip',
    headers: parsed60.headers,
    rows: parsed60.rows,
    zipManifest: parsed60.zipManifest,
    mmashWindowMode: 'window_60s',
  });
  assert.ok(ds60.featureColumns.includes('RR_HR_bpm_mean'), 'Expected derived HRV HR_bpm_mean');
  assert.ok(ds60.featureColumns.includes('RR_SDNN_ms'), 'Expected derived SDNN_ms');
  assert.ok(!ds60.featureColumns.includes('epoch_index'), 'epoch_index must be excluded');
  assert.ok(!ds60.featureColumns.includes('sleep_In Bed Date'), 'sleep date must be excluded');
  const ml60 = runDomainMLAnalysis(ds60, 0.05);
  assert.equal(ml60.sampleCount, 10);
  assert.equal(ml60.supervisedStatus.hasValidLabels, false);

  const parsed20 = parseUploadedFile(zipBuf, 'MMASH_test.zip', 'physiological', {
    mmashWindowMode: 'epoch_20',
  });
  assert.equal(parsed20.rows.length, 40, 'Expected 2 subjects * 20 epochs = 40 rows');
}

// 2. Immune per-analyte, censored values, and wide pivot
{
  const headers = ['ID', 'Timepoint', 'Analyte', 'Unit', 'Concentration', 'Percent'];
  const rows: Record<string, string>[] = [];
  for (const s of ['C001', 'C002', 'C003', 'C004']) {
    for (const tp of ['L-92', 'R+3']) {
      rows.push({
        ID: s,
        Timepoint: tp,
        Analyte: 'IL-6',
        Unit: 'pg/mL',
        Concentration: s === 'C001' && tp === 'L-92' ? '<0.14' : s === 'C004' && tp === 'R+3' ? '5.8' : '0.45',
        Percent: '100',
      });
      rows.push({
        ID: s,
        Timepoint: tp,
        Analyte: 'MCP-1',
        Unit: 'pg/mL',
        Concentration: s === 'C002' && tp === 'R+3' ? '>30000' : '22000',
        Percent: '105',
      });
    }
  }
  const dsNorm = preprocessDataset({
    id: 'test_imm_norm',
    domain: 'immune',
    filename: 'immune_test.csv',
    fileType: 'csv',
    headers,
    rows,
    immuneProcessingMode: 'per_analyte',
  });
  assert.deepEqual(dsNorm.featureColumns, ['Concentration_analyte_z', 'Percent_analyte_z']);
  assert.equal(dsNorm.metadata.dataQualityAudit.immuneAudit?.censoredValuesSummary.leftCensoredCount, 1);
  assert.equal(dsNorm.metadata.dataQualityAudit.immuneAudit?.censoredValuesSummary.rightCensoredCount, 1);

  const dsWide = preprocessDataset({
    id: 'test_imm_wide',
    domain: 'immune',
    filename: 'immune_test.csv',
    fileType: 'csv',
    headers,
    rows,
    immuneProcessingMode: 'wide_pivot',
  });
  assert.equal(dsWide.metadata.rowCount, 8);
  assert.deepEqual(dsWide.featureColumns.sort(), ['IL-6', 'MCP-1']);
}

// 3. CBC integrity with vs without suspect record
{
  const headers = [
    'Sample Name',
    'white_blood_cell_count_value_thousand_per_microliter',
    'neutrophils_value_percent',
    'lymphocytes_value_percent',
    'absolute_neutrophils_value_cells_per_microliter',
    'absolute_lymphocytes_value_cells_per_microliter',
    'platelet_count_value_thousand_per_microliter',
    'mpv_value_femtoliter',
    'rdw_value_percent',
    'hematocrit_range_min_percent',
    'hematocrit_range_max_percent',
  ];
  const rows: Record<string, string>[] = [];
  for (let i = 1; i <= 9; i++) {
    rows.push({
      'Sample Name': `S0${i}`,
      white_blood_cell_count_value_thousand_per_microliter: '7.0',
      neutrophils_value_percent: '60',
      lymphocytes_value_percent: '30',
      absolute_neutrophils_value_cells_per_microliter: '4200',
      absolute_lymphocytes_value_cells_per_microliter: '2100',
      platelet_count_value_thousand_per_microliter: String(240 + i),
      mpv_value_femtoliter: '10.2',
      rdw_value_percent: '12.5',
      hematocrit_range_min_percent: '37',
      hematocrit_range_max_percent: '48',
    });
  }
  rows.push({
    'Sample Name': 'S_SUSPECT',
    white_blood_cell_count_value_thousand_per_microliter: '9.6',
    neutrophils_value_percent: '71.1',
    lymphocytes_value_percent: '20.8',
    absolute_neutrophils_value_cells_per_microliter: '10.1',
    absolute_lymphocytes_value_cells_per_microliter: '6826',
    platelet_count_value_thousand_per_microliter: '12.9',
    mpv_value_femtoliter: '330',
    rdw_value_percent: '32.4',
    hematocrit_range_min_percent: '37',
    hematocrit_range_max_percent: '48',
  });

  const withSus = preprocessDataset({
    id: 'cbc_with',
    domain: 'cbc',
    filename: 'cbc_test.csv',
    fileType: 'csv',
    headers,
    rows,
    cbcExcludeSuspectRows: false,
  });
  assert.equal(withSus.metadata.rowCount, 10);
  assert.ok(!withSus.featureColumns.includes('hematocrit_range_min_percent'));
  assert.ok(withSus.featureColumns.includes('NLR_engineered'));
  assert.equal(withSus.integrityStatuses?.[9], 'suspected_corrupted');

  const noSus = preprocessDataset({
    id: 'cbc_without',
    domain: 'cbc',
    filename: 'cbc_test.csv',
    fileType: 'csv',
    headers,
    rows,
    cbcExcludeSuspectRows: true,
  });
  assert.equal(noSus.metadata.rowCount, 9);
  assert.equal(noSus.metadata.dataQualityAudit.cbcConsistencyFindings.length, 1);
}

console.log('ALL TypeScript Priority 1-4 pipeline tests passed.');
