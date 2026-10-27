const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const postgres = require('postgres');
const {maximumAutoNumber} = require('./auto-sequence.cjs');

const digest = (value) => createHash('sha256').update(value).digest('hex');
function pairs(collection) {
  const employeeRecords = new Map(collection.employeeRecords.map((record) => [record.record_id, record]));
  if (employeeRecords.size !== collection.records.length) throw new Error('Source namespaces have different record counts');
  const directory = new Map();
  const personFields = collection.fields.filter((field) => ['11', '1003', '1004'].includes(field.type));
  for (const record of collection.records) {
    const employeeRecord = employeeRecords.get(record.record_id);
    if (!employeeRecord) throw new Error('Source record missing from employee namespace');
    for (const field of collection.fields) {
      if (['11', '1003', '1004'].includes(field.type)) continue;
      if (JSON.stringify(record.fields[field.name]) !== JSON.stringify(employeeRecord.fields[field.name])) {
        throw new Error('Source changed during export; repeat the rehearsal export');
      }
    }
    for (const field of personFields) {
      const sourceOpen = record.fields[field.name];
      const sourceEmployees = employeeRecord.fields[field.name];
      const open = sourceOpen ? (Array.isArray(sourceOpen) ? sourceOpen : [sourceOpen]) : [];
      const employees = sourceEmployees ? (Array.isArray(sourceEmployees) ? sourceEmployees : [sourceEmployees]) : [];
      if (!Array.isArray(open) || !Array.isArray(employees) || open.length !== employees.length) {
        throw new Error('Source person cell mismatch');
      }
      open.forEach((person, index) => {
        const employee = employees[index];
        if (!person.id || person.name !== employee.name) throw new Error('Person mapping cannot be verified');
        if (!employee.id && field.type === '11') throw new Error('Collaborator mapping cannot be verified');
        const previous = directory.get(person.id);
        if (previous?.employee_id && employee.id && previous.employee_id !== employee.id) throw new Error('Person mapping conflict');
        if (previous?.employee_id && !employee.id) return;
        directory.set(person.id, { open_id: person.id, employee_id: employee.id || null, name: person.name || '' });
      });
    }
  }
  return [...directory.values()];
}

async function readSnapshot(directory) {
  const root = await fs.realpath(directory);
  const manifestText = await fs.readFile(path.join(root, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const expected = ['requirements', 'iterations', 'comments', 'acceptance', 'relations', 'collaboration', 'bindings', 'operations'];
  if (manifest.version !== 1 || JSON.stringify(manifest.collections.map((entry) => entry.kind).sort()) !==
    JSON.stringify(expected.sort())) throw new Error('Incomplete manifest');
  const collections = [];
  for (const entry of manifest.collections) {
    if (!/^[a-z]+\.json$/.test(entry.file)) throw new Error('Invalid snapshot path');
    const file = await fs.realpath(path.join(root, entry.file));
    if (path.dirname(file) !== root) throw new Error('Snapshot path escaped its directory');
    const text = await fs.readFile(file, 'utf8');
    if (digest(text) !== entry.sha256) throw new Error('Snapshot checksum mismatch');
    const collection = JSON.parse(text);
    if (collection.id !== entry.id || collection.kind !== entry.kind || collection.records.length !== entry.records) {
      throw new Error('Snapshot manifest does not match content');
    }
    if (new Set(collection.records.map((record) => record.record_id)).size !== collection.records.length) {
      throw new Error('Duplicate source record IDs');
    }
    collections.push({ ...collection, directory: pairs(collection) });
  }
  return { manifest, sha: digest(manifestText), collections };
}

async function importBase(directory) {
  const snapshot = await readSnapshot(directory); // All validation before database mutations.
  if (!process.env.MAKIT_MIGRATION_DATABASE_URL) throw new Error('Missing migration database URL');
  const sql = postgres(process.env.MAKIT_MIGRATION_DATABASE_URL, { max: 1 });
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(11020261017)`;
      const sourceId = snapshot.collections.map((collection) => collection.id).sort().join(':');
      const [existing] = await tx`SELECT manifest_sha256 FROM makit_migration_import WHERE source_id = ${sourceId}`;
      if (existing) {
        if (existing.manifest_sha256 !== snapshot.sha) throw new Error('Target already imported from a different snapshot');
        return { duplicate: true };
      }
      const [count] = await tx`SELECT count(*)::int AS value FROM makit_record`;
      if (count.value) throw new Error('Target must be empty; never overwrite application writes');
      // Import already contains both directions of every historical link. The
      // migration owner temporarily suspends only our own trigger in this
      // transaction, avoiding dependence on collection import order.
      await tx.unsafe('ALTER TABLE makit_record DISABLE TRIGGER makit_record_reverse_links');
      const counts = {};
      for (const collection of snapshot.collections) {
        const autoFields = collection.fields.filter((field) => field.type === '1005');
        const maximum = Math.max(0,...autoFields.map((field)=>maximumAutoNumber(field,collection.records)));
        await tx`INSERT INTO makit_collection (id, kind, fields, next_number)
          VALUES (${collection.id}, ${collection.kind}, ${tx.json(collection.fields)}, ${maximum + 1})`;
        for (const person of collection.directory) {
          if (!person.employee_id) {
            await tx`INSERT INTO makit_audit_principal (open_id, name) VALUES (${person.open_id}, ${person.name})
              ON CONFLICT (open_id) DO NOTHING`;
            continue;
          }
          const [previous] = await tx`SELECT open_id FROM makit_directory WHERE employee_id = ${person.employee_id}`;
          if (previous && previous.open_id !== person.open_id) throw new Error('Cross-collection directory mismatch');
          await tx`INSERT INTO makit_directory (employee_id, open_id, name)
            VALUES (${person.employee_id}, ${person.open_id}, ${person.name}) ON CONFLICT (employee_id) DO NOTHING`;
        }
        for (const record of collection.records) {
          await tx`INSERT INTO makit_record (collection_id, record_id, fields)
            VALUES (${collection.id}, ${record.record_id}, ${tx.json(record.fields)})`;
        }
        counts[collection.kind] = collection.records.length;
      }
      await tx`INSERT INTO makit_migration_import (source_id, manifest_sha256, counts)
        VALUES (${sourceId}, ${snapshot.sha}, ${tx.json(counts)})`;
      await tx.unsafe('ALTER TABLE makit_record ENABLE TRIGGER makit_record_reverse_links');
      return { duplicate: false, counts };
    });
  } finally { await sql.end(); }
}
module.exports = { readSnapshot, importBase };
if (require.main === module) importBase(path.resolve(process.argv[2] || '.local/source-base')).then(console.log).catch((error) => {
  console.error(error.message); process.exitCode = 1;
});
