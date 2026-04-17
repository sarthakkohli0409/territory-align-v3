/**
 * TerritoryAlign — Database Seed Script
 * Reads your actual Excel file and loads everything into PostgreSQL
 *
 * Usage:
 *   node scripts/seed.js
 *
 * Requires the Excel file to be at: ./data/Sample_Data_Claude_Alignment_Web_v1.xlsx
 * (copy your file into the data/ folder before running)
 */

const { Pool } = require('pg');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Territory colors matching the UI ────────────────────────────────────────
const TERRITORY_COLORS = [
  '#378ADD','#1D9E75','#D85A30','#7F77DD','#EF9F27','#D4537E','#39b54a',
  '#e84393','#00bcd4','#ff5722','#9c27b0','#3f51b5','#009688','#ff9800',
  '#795548','#607d8b','#e91e63','#2196f3','#4caf50','#ff6347','#8bc34a',
  '#00acc1','#ab47bc','#26a69a','#ffa726','#ef5350','#42a5f5','#66bb6a',
  '#ec407a','#7e57c2','#26c6da','#d4e157','#ff7043','#8d6e63','#78909c',
  '#5c6bc0','#29b6f6','#9ccc65','#f06292','#4dd0e1','#aed581','#4db6ac',
  '#f48fb1','#ce93d8','#ffca28','#ff8a65','#a1887f','#90a4ae','#80cbc4','#ffe082'
];

async function seed() {
  const client = await pool.connect();
  console.log('✓ Connected to database');

  try {
    await client.query('BEGIN');

    // ── 1. Load Excel ──────────────────────────────────────────────────────
    const dataDir = path.join(__dirname, 'data');
    const files = fs.existsSync(dataDir)
      ? fs.readdirSync(dataDir).filter(f => f.endsWith('.xlsx') || f.endsWith('.xls'))
      : [];

    if (files.length === 0) {
      throw new Error(
        '\n\nNo Excel file found in ./data/ folder.\n' +
        'Please copy your Sample_Data_Claude_Alignment_Web_v1.xlsx file into:\n' +
        path.join(__dirname, 'data') + '\n'
      );
    }

    const filePath = path.join(dataDir, files[0]);
    console.log(`✓ Loading Excel file: ${files[0]}`);
    const wb = XLSX.readFile(filePath);

    // ── 2. Read ZTT sheet ─────────────────────────────────────────────────
    const zttSheet = wb.Sheets['ZTT'];
    const zttData = XLSX.utils.sheet_to_json(zttSheet, { header: 0 });
    console.log(`  ZTT rows: ${zttData.length}`);

    // ── 3. Read Roster sheet ──────────────────────────────────────────────
    const rosterSheet = wb.Sheets['Roster'];
    const rosterData = XLSX.utils.sheet_to_json(rosterSheet, { header: 0 });
    console.log(`  Roster rows: ${rosterData.length}`);

    // ── 4. Read Sales Dta sheet ───────────────────────────────────────────
    const salesSheet = wb.Sheets['Sales Dta'];
    const salesData = XLSX.utils.sheet_to_json(salesSheet, { header: 0 });
    console.log(`  Sales rows: ${salesData.length}`);

    // ── 5. Clear existing data (safe re-seed) ─────────────────────────────
    console.log('\n  Clearing existing data...');
    await client.query('DELETE FROM audit_log');
    await client.query('DELETE FROM request_comments');
    await client.query('DELETE FROM requests');
    await client.query('DELETE FROM conflicts');
    await client.query('DELETE FROM hcps');
    await client.query('DELETE FROM zips');
    await client.query('DELETE FROM versions');
    await client.query('DELETE FROM users');
    await client.query('DELETE FROM territories');
    await client.query('DELETE FROM districts');

    // ── 6. Insert districts ───────────────────────────────────────────────
    console.log('\n  Seeding districts...');
    const districtNames = [...new Set(zttData.map(r => r['District Name']).filter(Boolean))];
    districtNames.push('NATION');
    const districtMap = {};
    for (const name of districtNames) {
      const res = await client.query(
        'INSERT INTO districts(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id',
        [name]
      );
      districtMap[name] = res.rows[0].id;
    }
    console.log(`  ✓ ${Object.keys(districtMap).length} districts`);

    // ── 7. Insert territories ─────────────────────────────────────────────
    console.log('  Seeding territories...');
    const territoryNames = [...new Set(zttData.map(r => r['Territory Name']).filter(Boolean))];
    const terrDistrictMap = {};
    zttData.forEach(r => {
      if (r['Territory Name'] && r['District Name']) {
        terrDistrictMap[r['Territory Name']] = r['District Name'];
      }
    });

    const territoryMap = {};
    let colorIdx = 0;
    for (const name of territoryNames.sort()) {
      const distName = terrDistrictMap[name];
      const distId = districtMap[distName] || null;
      const color = TERRITORY_COLORS[colorIdx++ % TERRITORY_COLORS.length];
      const res = await client.query(
        `INSERT INTO territories(name, district_id, color)
         VALUES($1, $2, $3)
         ON CONFLICT(name) DO UPDATE SET district_id=EXCLUDED.district_id RETURNING id`,
        [name, distId, color]
      );
      territoryMap[name] = res.rows[0].id;
    }
    console.log(`  ✓ ${Object.keys(territoryMap).length} territories`);

    // ── 8. Create initial version ─────────────────────────────────────────
    console.log('  Creating initial version...');
    const versionRes = await client.query(
      `INSERT INTO versions(version_label, description, zip_count, hcp_count, territory_count, is_current, upload_mode)
       VALUES($1, $2, $3, $4, $5, TRUE, 'replace') RETURNING id`,
      ['v1.0', 'Initial alignment load from Excel file', zttData.length, salesData.length, territoryNames.length]
    );
    const versionId = versionRes.rows[0].id;
    console.log(`  ✓ Version v1.0 created (id: ${versionId})`);

    // ── 9. Insert ZIPs (batch insert for speed) ───────────────────────────
    console.log('  Seeding ZIPs (this takes ~30 seconds for 41,521 rows)...');
    const BATCH = 500;
    let zipCount = 0;
    for (let i = 0; i < zttData.length; i += BATCH) {
      const batch = zttData.slice(i, i + BATCH);
      const values = [];
      const params = [];
      let p = 1;
      for (const row of batch) {
        const code = String(row['Zip Code ID'] || '').padStart(5, '0');
        const city = row['Zip Code Name'] || null;
        const terrName = row['Territory Name'];
        const distName = row['District Name'];
        const terrId = territoryMap[terrName] || null;
        const distId = districtMap[distName] || null;
        if (!code || code === '00000') continue;
        values.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4})`);
        params.push(code, city, terrId, distId, versionId);
        p += 5;
        zipCount++;
      }
      if (values.length > 0) {
        await client.query(
          `INSERT INTO zips(code,city,territory_id,district_id,version_id) VALUES ${values.join(',')}`,
          params
        );
      }
      if ((i + BATCH) % 5000 === 0 || i + BATCH >= zttData.length) {
        process.stdout.write(`\r  Loading ZIPs... ${Math.min(i + BATCH, zttData.length)}/${zttData.length}`);
      }
    }
    console.log(`\n  ✓ ${zipCount} ZIPs inserted`);

    // ── 10. Build ZIP → Territory lookup for HCP assignment ───────────────
    const zipTerrMap = {};
    zttData.forEach(r => {
      const code = String(r['Zip Code ID'] || '').padStart(5, '0');
      if (code && r['Territory Name']) zipTerrMap[code] = r['Territory Name'];
    });

    // ── 11. Insert HCPs (Sales Dta sheet) ────────────────────────────────
    console.log('  Seeding HCPs...');
    let hcpCount = 0;
    for (let i = 0; i < salesData.length; i += BATCH) {
      const batch = salesData.slice(i, i + BATCH);
      const values = [];
      const params = [];
      let p = 1;
      for (const row of batch) {
        const hcpId = row['Customer ID'];
        if (!hcpId) continue;
        const name    = row['Customer Name'] || null;
        const city    = row['City'] || null;
        const state   = row['State'] || null;
        const zip     = String(row['Zip Code'] || '').padStart(5, '0');
        const tier    = row['Target Tier'] || 'Tier 1';
        // Column layout from your file (0-indexed in raw):
        // 15 = Idx1, 16 = Idx2, 17 = Idx3, 18 = Idx4
        const idx1 = parseFloat(row['Alignment Index 1  (25% ZIP Population + 75% Patient Start Forms)']) || 0;
        const idx2 = parseFloat(row['Alignment Index 2  (50% Patient Prevalence + 50% Patient Start Forms)']) || 0;
        const idx3 = parseFloat(row['Alignment Index 3  (100% Patient Start Forms)']) || 0;
        const idx4 = parseFloat(row['Alignment Index 4  (100% Completed Start Forms)']) || 0;
        const terrName = zipTerrMap[zip];
        const terrId   = terrName ? (territoryMap[terrName] || null) : null;
        const distName = terrName ? terrDistrictMap[terrName] : null;
        const distId   = distName ? (districtMap[distName] || null) : null;
        values.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8},$${p+9},$${p+10},$${p+11})`);
        params.push(hcpId, name, city, state, zip, terrId, distId, tier, idx1, idx2, idx3, idx4);
        p += 12;
        hcpCount++;
      }
      if (values.length > 0) {
        await client.query(
          `INSERT INTO hcps(hcp_id,name,city,state,zip,territory_id,district_id,tier,idx1,idx2,idx3,idx4)
           VALUES ${values.join(',')}
           ON CONFLICT(hcp_id) DO NOTHING`,
          params
        );
      }
      process.stdout.write(`\r  Loading HCPs... ${Math.min(i + BATCH, salesData.length)}/${salesData.length}`);
    }
    console.log(`\n  ✓ ${hcpCount} HCPs inserted`);

    // ── 12. Compute territory aggregates ──────────────────────────────────
    console.log('  Computing territory aggregates...');
    await client.query(`
      UPDATE territories t SET
        hco_count = (SELECT COUNT(*) FROM hcps h WHERE h.territory_id = t.id),
        zip_count = (SELECT COUNT(*) FROM zips z WHERE z.territory_id = t.id),
        idx1 = COALESCE((SELECT SUM(h.idx1) FROM hcps h WHERE h.territory_id = t.id), 0),
        idx2 = COALESCE((SELECT SUM(h.idx2) FROM hcps h WHERE h.territory_id = t.id), 0),
        idx3 = COALESCE((SELECT SUM(h.idx3) FROM hcps h WHERE h.territory_id = t.id), 0),
        idx4 = COALESCE((SELECT SUM(h.idx4) FROM hcps h WHERE h.territory_id = t.id), 0)
    `);
    console.log('  ✓ Territory aggregates computed');

    // ── 13. Update version counts ─────────────────────────────────────────
    await client.query(
      'UPDATE versions SET zip_count=$1, hcp_count=$2 WHERE id=$3',
      [zipCount, hcpCount, versionId]
    );

    // ── 14. Insert users from Roster ──────────────────────────────────────
    console.log('  Seeding users...');
    const defaultPassword = await bcrypt.hash('TerritoryAlign2026!', 10);
    let userCount = 0;
    for (const row of rosterData) {
      const pid    = row['Personnel ID'];
      const name   = row['Name'];
      const role   = row['Job Title'];
      const terr   = row['Assigned Territory/Region/Area Name'];
      if (!pid || !role || !['NSD','DM','OAM'].includes(role)) continue;
      const terrId = territoryMap[terr] || null;
      const distId = districtMap[terr] || null;
      await client.query(
        `INSERT INTO users(personnel_id, name, role, territory_id, district_id, password_hash)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(personnel_id) DO NOTHING`,
        [pid, name, role, terrId, distId, defaultPassword]
      );
      userCount++;
    }
    console.log(`  ✓ ${userCount} users created`);
    console.log('  ℹ Default password for all users: TerritoryAlign2026!');

    // ── 15. Seed sample requests ──────────────────────────────────────────
    console.log('  Seeding sample requests...');
    const nsdUser = await client.query('SELECT id FROM users WHERE personnel_id=$1', ['E056']);
    const rep1    = await client.query('SELECT id FROM users WHERE personnel_id=$1', ['E001']);
    const dm1     = await client.query('SELECT id FROM users WHERE personnel_id=$1', ['E051']);
    const albanySrc  = await client.query("SELECT id FROM territories WHERE name=$1", ['ALBANY, NY']);
    const bostonDst  = await client.query("SELECT id FROM territories WHERE name=$1", ['BOSTON, MA']);

    if (rep1.rows[0] && albanySrc.rows[0]) {
      await client.query(`
        INSERT INTO requests(request_id,type,status,priority,requester_id,src_territory_id,dest_territory_id,
          hcp_zip,reason,comment,before_state,after_state,has_conflict)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT(request_id) DO NOTHING`,
        [
          'REQ-041','Change HCP territory','pending','High',
          rep1.rows[0].id, albanySrc.rows[0].id, bostonDst.rows[0]?.id,
          'HCP00001485','Workload imbalance',
          'ALBANY, NY has 194 HCPs — highest in NORTHEAST. Moving this Tier 3 HCP to BOSTON, MA.',
          JSON.stringify({territory:'ALBANY, NY', hcos:194}),
          JSON.stringify({territory:'BOSTON, MA', hcos:308}),
          false
        ]
      );
    }
    console.log('  ✓ Sample requests seeded');

    // ── 16. Seed conflicts ────────────────────────────────────────────────
    const sacTerr = await client.query("SELECT id FROM territories WHERE name=$1", ['SACRAMENTO, CA']);
    const sfTerr  = await client.query("SELECT id FROM territories WHERE name=$1", ['SAN FRANCISCO, CA']);
    const dallasTerr = await client.query("SELECT id FROM territories WHERE name=$1", ['DALLAS, TX']);
    const jaxTerr = await client.query("SELECT id FROM territories WHERE name=$1", ['JACKSONVILLE, FL']);

    const conflictData = [
      {
        type:'Duplicate ZIP mapping', severity:'high',
        title:'ZIP 89511 mapped to multiple territories',
        description:'ZIP 89511 (Reno, NV) appears in both SACRAMENTO, CA and SAN FRANCISCO, CA territory mappings.',
        territory_ids: [sacTerr.rows[0]?.id, sfTerr.rows[0]?.id].filter(Boolean),
        affected_hcps: 3
      },
      {
        type:'Vacant territory', severity:'med',
        title:'DALLAS, TX territory vacant — 3 months',
        description:'DALLAS, TX has had no assigned OAM since January 2026. 180 HCPs are receiving no rep coverage.',
        territory_ids: [dallasTerr.rows[0]?.id].filter(Boolean),
        affected_hcps: 180
      },
      {
        type:'Coverage gap', severity:'low',
        title:'JACKSONVILLE, FL HCP count below district average',
        description:'JACKSONVILLE, FL has 90 HCPs — the lowest in SOUTHEAST district (avg 122).',
        territory_ids: [jaxTerr.rows[0]?.id].filter(Boolean),
        affected_hcps: 90
      }
    ];

    for (const c of conflictData) {
      await client.query(
        `INSERT INTO conflicts(type,severity,title,description,territory_ids,affected_hcps)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [c.type, c.severity, c.title, c.description, c.territory_ids, c.affected_hcps]
      );
    }
    console.log('  ✓ Conflicts seeded');

    // ── 17. Audit log entry ───────────────────────────────────────────────
    if (nsdUser.rows[0]) {
      await client.query(
        `INSERT INTO audit_log(user_id,action,detail,before_state,after_state,district,version_id)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          nsdUser.rows[0].id, 'Bulk upload',
          `Initial alignment load — v1.0 (${zipCount} ZIPs, ${hcpCount} HCPs, ${territoryNames.length} territories)`,
          JSON.stringify({state:'empty'}),
          JSON.stringify({version:'v1.0', zips:zipCount, hcps:hcpCount}),
          'NATION', versionId
        ]
      );
    }

    await client.query('COMMIT');

    // ── Summary ───────────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(50));
    console.log('✓ DATABASE SEEDED SUCCESSFULLY');
    console.log('='.repeat(50));
    console.log(`  Districts  : ${Object.keys(districtMap).length}`);
    console.log(`  Territories: ${Object.keys(territoryMap).length}`);
    console.log(`  ZIPs       : ${zipCount}`);
    console.log(`  HCPs       : ${hcpCount}`);
    console.log(`  Users      : ${userCount}`);
    console.log(`  Version    : v1.0`);
    console.log('');
    console.log('  Login credentials (all users):');
    console.log('  Password: TerritoryAlign2026!');
    console.log('  NSD:  personnel_id = E056');
    console.log('  DM:   personnel_id = E051');
    console.log('  OAM:  personnel_id = E001');
    console.log('='.repeat(50));

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n✗ Seed failed:', err.message);
    if (err.detail) console.error('  Detail:', err.detail);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
